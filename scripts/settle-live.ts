/**
 * The live settlement. One real Request obligation, paid once, through the same `settle()`
 * protocol that produces the 24 refusals — not a bypass written for the demo.
 *
 * Run it twice. The first run settles. The second must refuse with `ALREADY_DISPATCHED`
 * and leave the send count where it was. That pair is the whole thesis, and the durable
 * store under .data/ is what makes the second run's refusal survive a process restart,
 * a rotated key, and the provider's 24-hour idempotency window expiring.
 *
 * Reconciliation is deliberately zero-dependency: rather than asking Request's API whether
 * it thinks the invoice is paid, this reads the ERC20FeeProxy event log off the chain and
 * matches the payment reference — the same evidence Request's own detection uses.
 *
 * Both KeeperHub surfaces are the same settlement. `KEEPERHUB_TRANSPORT=mcp` dispatches
 * through KeeperHub's own MCP server instead of its REST API; `settle()`, the policy, the
 * calldata gate and the refusal table are untouched by the choice. Default is `rest`, so
 * every existing caller behaves exactly as before.
 *
 * Usage: node --experimental-strip-types scripts/settle-live.ts
 *        KEEPERHUB_TRANSPORT=mcp node --experimental-strip-types scripts/settle-live.ts
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { encodeCall } from "../src/abi.ts";
import { obligationId } from "../src/identity.ts";
import { keccak256Hex } from "../src/keccak.ts";
import { KeeperHubProvider } from "../src/keeperhub.ts";
import { KeeperHubMcpProvider } from "../src/keeperhub-mcp.ts";
import type { ExecutionProvider } from "../src/provider.ts";
import type { Policy, SourceFacts } from "../src/policy.ts";
import { fetchInvoiceChecked, RequestError } from "../src/request.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";

const SEPOLIA = 11155111;
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const PROXY = "0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE";
const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PAY_SIG = "transferFromWithReferenceAndFee(address,address,uint256,bytes,uint256,address)";
const NS = "request-network:sepolia";

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    // Naming the step that supplies THIS variable. The generic version told someone whose
    // KEEPERHUB_API_KEY was missing to go and create an invoice.
    const where =
      name === "KEEPERHUB_API_KEY"
        ? "get one from KeeperHub and put it in .env"
        : "run the invoice creation step first (docs/RUNBOOK.md)";
    console.error(`\nmissing ${name} in .env — ${where}.\n`);
    process.exit(2);
  }
  return v;
}

const KH_KEY = need("KEEPERHUB_API_KEY");
const REQUEST_ID = need("REQUEST_ID");

/**
 * The facts come from Request, and `.env` gets one job: naming which invoice.
 *
 * This used to read the reference, payee, fee and fee recipient straight out of `.env` and
 * hardcode the amount — the exact hazard src/request.ts exists to remove. Every guard
 * downstream of here protects whatever reference it is handed, so a `.env` a hand could edit
 * decided which debt this script paid. Now the invoice decides, and anything still present in
 * `.env` is a claim that has to agree with it or the run is refused before the store is
 * opened, before a provider exists, at zero sends.
 */
async function readInvoice() {
  try {
    return await fetchInvoiceChecked(REQUEST_ID, {
      paymentReference: process.env.PAYMENT_REFERENCE,
      payee: process.env.PAYEE_BURNER,
      feeAddress: process.env.FEE_ADDRESS,
      feeAmount: process.env.FEE_AMOUNT,
      // Not from the environment: the token this deployment settles in, checked against the
      // token the invoice is denominated in. The calldata below pays FAU regardless, so an
      // invoice in another token has to stop here rather than be paid in the wrong one.
      tokenAddress: FAU,
    });
  } catch (e) {
    const code = e instanceof RequestError ? e.code : "UNREADABLE_INVOICE";
    console.error(`\nREFUSED before any write (${code}): ${e instanceof Error ? e.message : String(e)}\n`);
    return process.exit(2);
  }
}
const invoice = await readInvoice();

const REFERENCE = invoice.paymentReference;
const PAYEE = invoice.payee.toLowerCase();
const FEE_ADDRESS = invoice.feeRecipient.toLowerCase();
const FEE_AMOUNT = invoice.feeBaseUnits;
const AMOUNT = invoice.invoiceBaseUnits;

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/**
 * Request's payment detection, reimplemented as a chain read.
 *
 * `paymentReference` is an INDEXED bytes parameter, so the topic is the keccak hash of the
 * reference bytes rather than the bytes themselves — a detail that silently returns zero
 * logs if you get it wrong.
 */
const EVENT_TOPIC = keccak256Hex("TransferWithReferenceAndFee(address,address,uint256,bytes,uint256,address)");
const REFERENCE_TOPIC = keccak256Hex(Uint8Array.from(Buffer.from(REFERENCE.slice(2), "hex")));

async function proxySawPayment(fromBlock: number): Promise<{ found: boolean; txHash?: string; amount?: string }> {
  const logs = (await rpc("eth_getLogs", [
    { address: PROXY, topics: [EVENT_TOPIC, REFERENCE_TOPIC], fromBlock: `0x${fromBlock.toString(16)}`, toBlock: "latest" },
  ])) as Array<{ data: string; transactionHash: string }>;
  if (logs.length === 0) return { found: false };
  // data = tokenAddress, to, amount, <offset>, feeAmount, feeAddress, then the bytes tail
  const d = logs[0].data.slice(2);
  const amount = BigInt(`0x${d.slice(128, 192)}`).toString(10);
  return { found: true, txHash: logs[0].transactionHash, amount };
}

// ---- the plan -------------------------------------------------------------

const policy: Policy = {
  version: 1,
  chainId: SEPOLIA,
  token: { address: FAU, decimals: 18, symbol: "FAU" },
  allowedPayees: [PAYEE],
  // 2 FAU ceiling on the TOTAL debit. The human's number, not the invoice's: an invoice that
  // asks for more than this is refused rather than paid.
  maxTotalDebitBaseUnits: "2000000000000000000",
  allowedFeeRecipients: [FEE_ADDRESS],
  maxFeeBaseUnits: "0",
  planTtlSeconds: 3600,
};

const facts: SourceFacts = {
  chainId: SEPOLIA,
  tokenAddress: FAU,
  tokenDecimals: 18,
  payee: PAYEE,
  invoiceBaseUnits: AMOUNT,
  feeBaseUnits: FEE_AMOUNT,
  feeRecipient: FEE_ADDRESS,
  // Not a typed-in assertion any more: these facts are only ever consumed by the settle call
  // below, which is now unreachable if the fee proxy already carries a payment for this
  // reference -- the script exits 2 before it. The residual is stated rather than hidden: a
  // reference-only sighting is not proof THIS invoice was paid by us, which is why the exit
  // sends a human to `npm run resolve` instead of deciding. Request's own SDK verdict, if you
  // want it before running this, is `node tools/invoice/check-paid.mjs`.
  hasBeenPaid: false,
};

// The calldata is built once, here, and is what the approval sentence describes.
const calldata = encodeCall(PAY_SIG, [FAU, PAYEE, AMOUNT, REFERENCE, FEE_AMOUNT, FEE_ADDRESS]);

const steps = [{ kind: "PAY", to: PROXY, data: calldata, value: "0" }];

if (!existsSync(".data")) mkdirSync(".data");
const store = new Store(".data/live.sqlite");

// An unrecognised value is refused rather than silently defaulted: "MCP", "grpc" or a typo
// quietly falling back to REST would put the wrong transport in the evidence file.
const TRANSPORT = (process.env.KEEPERHUB_TRANSPORT ?? "rest").toLowerCase();
if (TRANSPORT !== "rest" && TRANSPORT !== "mcp") {
  console.error(`\nKEEPERHUB_TRANSPORT must be "rest" or "mcp", got "${TRANSPORT}".\n`);
  process.exit(2);
}
const provider: ExecutionProvider =
  TRANSPORT === "mcp"
    ? new KeeperHubMcpProvider({ apiKey: KH_KEY, chainId: SEPOLIA, rpcUrl: RPC })
    : new KeeperHubProvider({ apiKey: KH_KEY, chainId: SEPOLIA, rpcUrl: RPC });

const startBlock = Number(BigInt((await rpc("eth_blockNumber", [])) as string)) - 200;

console.log("\nLive settlement — one Request obligation, through the real protocol\n");
console.log(`transport        : KeeperHub ${TRANSPORT.toUpperCase()}`);
console.log(`requestId        : ${REQUEST_ID}`);
console.log(`paymentReference : ${REFERENCE}`);
console.log(`payee            : ${PAYEE}`);
console.log(`amount           : ${AMOUNT} base units, fee ${FEE_AMOUNT} (read from Request)`);
console.log(`calldata         : ${calldata.slice(0, 42)}… (${(calldata.length - 2) / 2} bytes)`);

const oid = obligationId(NS, REQUEST_ID);
console.log(`obligationId     : ${oid}`);

const before = await proxySawPayment(startBlock);
console.log(`\nproxy log before : ${before.found ? `ALREADY PAID in ${before.txHash}` : "no payment seen"}`);

// And then it used to settle anyway. Printing "ALREADY PAID" and proceeding is the duplicate
// payment this whole project exists to refuse, written into the script that moves real money.
// The fee proxy is permissionless, so a sighting is not proof this invoice was paid by us --
// but it is more than enough reason to stop and make a human look.
if (before.found) {
  console.error(
    `\nREFUSED before any write: the fee proxy already carries a payment for ${REFERENCE} ` +
      `in ${before.txHash}.\nIf that payment is this invoice's, the debt is settled and there is ` +
      `nothing to do. If it is not, reconcile it before paying: npm run resolve\n`,
  );
  store.close();
  process.exit(2);
}

const outcome = await settleObligation(
  {
    store,
    provider,
    policy,
    // Independent reconciliation: the chain's own record, not a provider status string.
    //
    // Three questions, the same three every other caller asks (src/mcp.ts:221,
    // scripts/resolve.ts:77, scripts/live-harness.ts:202): our reference, our
    // transaction, our amount. Answering only the first — `.found` alone — accepts a
    // different transaction's log as proof that THIS obligation settled, which is the
    // exact defect the SettleDeps contract documents at src/settle.ts:55-58. This is
    // the live-money path, so it is the last place that shortcut belongs.
    sourceSaysPaid: async (_requestId: string, txHash: string) => {
      const seen = await proxySawPayment(startBlock);
      return (
        seen.found &&
        seen.txHash?.toLowerCase() === txHash.toLowerCase() &&
        seen.amount === AMOUNT
      );
    },
  },
  {
    namespace: NS,
    requestId: REQUEST_ID,
    paymentReference: REFERENCE,
    obligationId: oid,
    facts,
    steps,
    approval: { approver: "owner@reqkeeper.local", decision: "APPROVED" },
    // Milliseconds. planTtlSeconds is multiplied by 1000 downstream, so passing seconds here
    // would stretch a one-hour approval into roughly 41 days.
    now: Date.now(),
    factsAtDispatch: facts,
  },
);

console.log("\n--- settle() outcome ---");
console.log(`state            : ${outcome.state}`);
console.log(`refusal          : ${outcome.refusal ?? "(none)"}`);
console.log(`detail           : ${outcome.detail}`);
console.log(`providerWrite    : ${outcome.providerWriteIssued}`);
console.log(`txHash           : ${outcome.txHash ?? "(none)"}`);
if (outcome.restatement) console.log(`\napproval said    : ${outcome.restatement}`);

// The provider's own identifier for what it did, read back out of the durable record rather
// than off the response — the attempt row is what survives a crash, and it is the field the
// console's proof strip has been showing a dash for.
const attempt = store.sentAttemptFor(oid);
console.log(`executionId      : ${attempt?.executionId ?? "(none)"}`);
if (attempt?.executionId) {
  try {
    const observed = await provider.observe(attempt.executionId);
    console.log(`observe          : status=${observed.status} tx=${observed.transactionHash ?? "(none)"}`);
  } catch (e) {
    // A read that failed is worth saying out loud, and is not a reason to call the settlement
    // into question — the chain read below is the evidence, not this.
    console.log(`observe          : unavailable (${String(e).slice(0, 120)})`);
  }
}

// ---- independent confirmation --------------------------------------------

if (outcome.txHash) {
  const receipt = await provider.receipt(outcome.txHash);
  console.log(
    `\nchain receipt    : ${receipt.receiptStatus}, verified=${receipt.verified}, gasUsed=${receipt.gasUsed}, ` +
      `block=${receipt.blockNumber ?? "?"}, confirmations=${receipt.confirmations ?? "?"}`,
  );
  console.log(`etherscan        : https://sepolia.etherscan.io/tx/${outcome.txHash}`);
}

const after = await proxySawPayment(startBlock);
console.log(`\nproxy log after  : ${after.found ? `reference seen, amount ${after.amount} in ${after.txHash}` : "NOT SEEN"}`);
console.log(
  after.found && after.amount === AMOUNT
    ? "\nThe reference is on-chain for the exact invoice amount. Request's detection reads this same log.\n"
    : "\nPayment not confirmed on-chain.\n",
);

store.close();
