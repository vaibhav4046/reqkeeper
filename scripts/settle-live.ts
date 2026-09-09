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
 * Usage: node --experimental-strip-types scripts/settle-live.ts
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { encodeCall } from "../src/abi.ts";
import { obligationId } from "../src/identity.ts";
import { keccak256Hex } from "../src/keccak.ts";
import { KeeperHubProvider } from "../src/keeperhub.ts";
import type { Policy, SourceFacts } from "../src/policy.ts";
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
    console.error(`\nmissing ${name} in .env — run the invoice creation step first.\n`);
    process.exit(2);
  }
  return v;
}

const KH_KEY = need("KEEPERHUB_API_KEY");
const REQUEST_ID = need("REQUEST_ID");
const REFERENCE = need("PAYMENT_REFERENCE");
const PAYEE = need("PAYEE_BURNER").toLowerCase();
const FEE_ADDRESS = (process.env.FEE_ADDRESS ?? `0x${"0".repeat(40)}`).toLowerCase();
const FEE_AMOUNT = process.env.FEE_AMOUNT ?? "0";
const AMOUNT = "1000000000000000000"; // 1 FAU, matching the invoice

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
  // 2 FAU ceiling on the TOTAL debit. The invoice is 1 FAU with a zero fee.
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
  hasBeenPaid: false,
};

// The calldata is built once, here, and is what the approval sentence describes.
const calldata = encodeCall(PAY_SIG, [FAU, PAYEE, AMOUNT, REFERENCE, FEE_AMOUNT, FEE_ADDRESS]);

const steps = [{ kind: "PAY", to: PROXY, data: calldata, value: "0" }];

if (!existsSync(".data")) mkdirSync(".data");
const store = new Store(".data/live.sqlite");
const provider = new KeeperHubProvider({ apiKey: KH_KEY, chainId: SEPOLIA, rpcUrl: RPC });

const startBlock = Number(BigInt((await rpc("eth_blockNumber", [])) as string)) - 200;

console.log("\nLive settlement — one Request obligation, through the real protocol\n");
console.log(`requestId        : ${REQUEST_ID}`);
console.log(`paymentReference : ${REFERENCE}`);
console.log(`payee            : ${PAYEE}`);
console.log(`amount           : ${AMOUNT} base units (1 FAU)`);
console.log(`calldata         : ${calldata.slice(0, 42)}… (${(calldata.length - 2) / 2} bytes)`);

const oid = obligationId(NS, REQUEST_ID);
console.log(`obligationId     : ${oid}`);

const before = await proxySawPayment(startBlock);
console.log(`\nproxy log before : ${before.found ? `ALREADY PAID in ${before.txHash}` : "no payment seen"}`);

const outcome = await settleObligation(
  {
    store,
    provider,
    policy,
    // Independent reconciliation: the chain's own record, not a provider status string.
    sourceSaysPaid: async () => (await proxySawPayment(startBlock)).found,
  },
  {
    namespace: NS,
    requestId: REQUEST_ID,
    obligationId: oid,
    facts,
    steps,
    approval: { approver: "owner@reqkeeper.local", decision: "APPROVED" },
    now: Math.floor(Date.now() / 1000),
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

// ---- independent confirmation --------------------------------------------

if (outcome.txHash) {
  const receipt = await provider.receipt(outcome.txHash);
  console.log(`\nchain receipt    : ${receipt.receiptStatus}, verified=${receipt.verified}, gasUsed=${receipt.gasUsed}`);
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
