/**
 * The evidence for the settlements dispatched through KeeperHub's MCP transport.
 *
 * Every payment on record before this ran went out over REST. Two provider surfaces were
 * implemented behind one interface and only one of them had ever moved money, which made
 * "both transports pass the same calldata gate" a claim about code rather than about value.
 * This writes the row that closes that, and it writes nothing it did not read.
 *
 *   node --experimental-strip-types scripts/evidence-mcp.ts <requestId> [<requestId> ...]
 *
 * Each row is assembled from three independent places, and disagreement between them is
 * reported rather than smoothed over:
 *
 *   Request's public gateway  the invoice, and the payment reference DERIVED from its own
 *                             salt and payment address — never read out of a local file
 *   the settlement store      final state, the KeeperHub execution id, and how many physical
 *                             sends the obligation actually cost
 *   Sepolia                   exactly one ERC20FeeProxy event carrying that reference, and a
 *                             successful receipt for the transaction the store names
 *
 * `transport` is `mcp` by construction: these rows exist because `settle-live.ts` ran with
 * `KEEPERHUB_TRANSPORT=mcp`, which builds `KeeperHubMcpProvider`. The store records the
 * attempt but not the surface that carried it, so that one field is the operator's statement
 * and not a read-back — stated plainly here rather than dressed up.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  DEFAULT_RPC,
  currentBlock,
  decodePaymentLogFields,
  findPaymentByReference,
  matchPaymentLog,
  readReceipt,
  referenceTopic,
  rpcCall,
  EVENT_TOPIC,
} from "../src/chain.ts";
import { obligationId } from "../src/identity.ts";
import { NAMESPACE } from "../src/plan.ts";
import { derivePaymentReference, fetchInvoice, SEPOLIA_CHAIN_ID } from "../src/request.ts";
import { Store } from "../src/store.ts";

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

const RPC = process.env.SEPOLIA_RPC ?? DEFAULT_RPC;
const DB = process.env.REQKEEPER_DB ?? ".data/live.sqlite";
const OUT = "docs/evidence/mcp-settlements.json";
const PROXY = "0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE";

const requestIds = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (requestIds.length === 0) {
  console.error("\nusage: evidence-mcp.ts <requestId> [<requestId> ...]\n");
  process.exit(2);
}
if (!existsSync(DB)) {
  console.error(`\nno settlement database at ${DB}.\n`);
  process.exit(2);
}

const store = new Store(DB);
// Read-only, alongside the Store: counting an obligation's physical sends is a diagnostic,
// and a diagnostic is not a reason to grow the write surface of the settlement store.
const ro = new DatabaseSync(DB, { readOnly: true });
const countSends = ro.prepare(
  "SELECT COUNT(*) AS n FROM attempts WHERE obligation_id = ? AND first_send_at IS NOT NULL",
);

/**
 * Every fee-proxy log carrying this reference, from the invoice's own anchor block.
 *
 * `findPaymentByReference` stops at the first hit, which answers "was it paid" and not "was
 * it paid once". Exactly-once is the whole claim, so the count is what gets asserted — and
 * the window starts where the obligation began to exist, so a second payment anywhere in its
 * life is inside it.
 */
async function logsForReference(reference: string, fromBlock: number, toBlock: number) {
  const logs = (await rpcCall(RPC, "eth_getLogs", [
    {
      address: PROXY,
      topics: [EVENT_TOPIC, referenceTopic(reference)],
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
    },
  ])) as Array<{ data: string; transactionHash: string; blockNumber: string }>;
  return logs ?? [];
}

const head = await currentBlock(RPC);
const rows: Record<string, unknown>[] = [];
let problems = 0;
const flag = (what: string): void => {
  problems++;
  console.log(`  PROBLEM  ${what}`);
};

for (const requestId of requestIds) {
  console.log(`\n=== ${requestId}`);

  const invoice = await fetchInvoice(requestId);
  const derived = derivePaymentReference(invoice.requestId, invoice.salt, invoice.payee);
  if (derived.toLowerCase() !== invoice.paymentReference.toLowerCase()) {
    flag(`derived reference ${derived} is not the invoice's ${invoice.paymentReference}`);
  }
  console.log(`  reference (derived)  ${derived}`);

  const oid = obligationId(NAMESPACE, requestId);
  const obligation = store.getObligation(oid);
  const attempt = store.sentAttemptFor(oid);
  const sends = Number((countSends.get(oid) as { n: number }).n);
  console.log(`  obligation           ${oid.slice(0, 16)}…  state ${obligation?.state ?? "(absent)"}`);
  console.log(`  keeperhub execution  ${attempt?.executionId ?? "(none)"}`);
  console.log(`  physical sends       ${sends}`);
  if (!attempt?.txHash) flag("the store holds no dispatched transaction for this obligation");
  if (!attempt?.executionId) flag("no KeeperHub execution id was recorded");
  if (sends !== 1) flag(`${sends} physical sends — exactly-once means exactly one`);

  const anchor = invoice.anchor?.blockNumber;
  if (anchor === undefined) flag("the invoice has no anchor block; the scan window is a guess");
  const from = anchor ?? Math.max(0, head - 5_000);

  const logs = await logsForReference(derived, from, head);
  console.log(`  fee-proxy logs       ${logs.length} carrying this reference in blocks ${from}..${head}`);
  if (logs.length !== 1) flag(`expected exactly one fee-proxy event, found ${logs.length}`);

  const log = logs[0];
  const fields = log ? decodePaymentLogFields(log.data) : null;
  if (fields) {
    const m = matchPaymentLog(
      { ...fields, emitter: PROXY },
      {
        tokenAddress: invoice.tokenAddress,
        to: invoice.payee,
        amount: invoice.invoiceBaseUnits,
        feeAmount: invoice.feeBaseUnits,
        feeAddress: invoice.feeRecipient,
      },
    );
    console.log(`  log pays             ${fields.amount} of ${fields.tokenAddress} to ${fields.to}`);
    if (!m.ok) flag(`the log disagrees with the invoice: ${m.conflicts.join("; ")}`);
    if (log.transactionHash.toLowerCase() !== (attempt?.txHash ?? "").toLowerCase()) {
      flag(`the chain's payment is ${log.transactionHash}, the store dispatched ${attempt?.txHash}`);
    }
  }

  // The second opinion, with its own endpoint fallbacks, over the same window.
  const sighting = await findPaymentByReference(derived, {
    fromBlock: from,
    rpcUrl: RPC,
    expect: {
      tokenAddress: invoice.tokenAddress,
      to: invoice.payee,
      amount: invoice.invoiceBaseUnits,
      feeAmount: invoice.feeBaseUnits,
      feeAddress: invoice.feeRecipient,
    },
  });
  console.log(
    `  sighting             found=${sighting.found} corroborated=${sighting.corroborated} ` +
      `block=${sighting.block ?? "?"} tx=${sighting.txHash ?? "-"}`,
  );
  if (!sighting.found) flag("findPaymentByReference does not see this payment");

  const receipt = attempt?.txHash
    ? await readReceipt(RPC, attempt.txHash)
    : { receiptStatus: "not_found" as const, gasUsed: "0", blockNumber: undefined, verified: false };
  console.log(
    `  receipt              ${receipt.receiptStatus} gas ${receipt.gasUsed} block ${receipt.blockNumber ?? "?"}`,
  );
  if (receipt.receiptStatus !== "success") flag(`receipt is ${receipt.receiptStatus}, not success`);

  rows.push({
    requestId,
    paymentReference: derived,
    transport: "mcp",
    keeperhubExecutionId: attempt?.executionId ?? null,
    txHash: attempt?.txHash ?? null,
    block: receipt.blockNumber ?? sighting.block ?? null,
    explorer: attempt?.txHash ? `https://sepolia.etherscan.io/tx/${attempt.txHash}` : null,
    amountBaseUnits: invoice.invoiceBaseUnits,
    token: invoice.tokenAddress,
    payee: invoice.payee,
    finalState: obligation?.state ?? null,
    physicalSends: sends,
    feeProxyEventsForReference: logs.length,
    receiptStatus: receipt.receiptStatus,
    corroborated: sighting.corroborated === true,
    invoiceAnchorBlock: anchor ?? null,
    mode: "LIVE",
  });
}

if (!existsSync("docs/evidence")) mkdirSync("docs/evidence", { recursive: true });
writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      mode: "LIVE",
      chainId: SEPOLIA_CHAIN_ID,
      transport: "mcp",
      note:
        "Settled through KeeperHub's MCP server (src/keeperhub-mcp.ts) rather than its REST API, " +
        "by running scripts/settle-live.ts with KEEPERHUB_TRANSPORT=mcp. settle(), the policy and " +
        "the calldata gate are the same modules the REST rows used; only the transport differs. " +
        "Each row's payment reference is derived from the invoice Request itself serves, and each " +
        "was confirmed by counting ERC20FeeProxy events for that reference from the invoice's own " +
        "anchor block — one event, one send, one transaction.",
      totals: {
        rows: rows.length,
        settled: rows.filter((r) => r.finalState === "SETTLED").length,
        physicalSends: rows.reduce((n, r) => n + Number(r.physicalSends), 0),
        withExecutionId: rows.filter((r) => r.keeperhubExecutionId !== null).length,
      },
      rows,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

store.close();
ro.close();

console.log(`\n${problems === 0 ? "no disagreements" : `${problems} PROBLEM(S)`} — wrote ${OUT}\n`);
process.exit(problems === 0 ? 0 : 1);
