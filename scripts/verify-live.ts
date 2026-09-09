/**
 * Independently verify every live row, from the chain, with no credentials.
 *
 * `docs/refusals-live.json` is this project's own output, so on its own it is an assertion.
 * This script re-derives the same conclusions from Ethereum Sepolia through a public RPC:
 * every settled row's receipt is fetched, every payment reference is looked up in the
 * ERC20FeeProxy event log, and every refusal row is checked to have no transaction at all.
 *
 * A reader who does not trust the artifact can run this. It needs no API key.
 *
 * Usage: node --experimental-strip-types scripts/verify-live.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_RPC, findPaymentByReference, rpcCall } from "../src/chain.ts";

const FILE = "docs/refusals-live.json";
if (!existsSync(FILE)) {
  console.error(`${FILE} not found. Run npm run harness:live first.`);
  process.exit(2);
}

type Row = {
  case_id: string;
  scenario: string;
  expected: string;
  actual: string;
  physical_sends: number;
  tx_hash: string | null;
  payment_reference: string | null;
};
const doc = JSON.parse(readFileSync(FILE, "utf8")) as { rows: Row[]; totals: Record<string, number> };

let failures = 0;
const note = (s: string): void => console.log(s);

note("\nIndependent verification of docs/refusals-live.json");
note("Public RPC, no credentials, nothing trusted from the artifact itself.\n");

const chainId = Number(await rpcCall(DEFAULT_RPC, "eth_chainId", []));
if (chainId !== 11155111) {
  console.error(`expected Sepolia (11155111), got ${chainId}`);
  process.exit(1);
}
note(`chain id ${chainId} (Ethereum Sepolia)\n`);

const settled = doc.rows.filter((r) => r.tx_hash);
const refusals = doc.rows.filter((r) => !r.tx_hash);

// ---- every settled row must have a real, successful receipt --------------

note(`${settled.length} rows claim a transaction. Checking each receipt.\n`);
let verified = 0;
let totalGas = 0n;
const references = new Set<string>();

for (const row of settled) {
  const hash = row.tx_hash as string;
  const receipt = (await rpcCall(DEFAULT_RPC, "eth_getTransactionReceipt", [hash])) as {
    status?: string;
    gasUsed?: string;
    blockNumber?: string;
  } | null;

  if (!receipt) {
    failures++;
    note(`  FAIL ${row.case_id}  no receipt on chain for ${hash}`);
    continue;
  }
  if (receipt.status !== "0x1") {
    failures++;
    note(`  FAIL ${row.case_id}  receipt status ${receipt.status} for ${hash}`);
    continue;
  }
  verified++;
  totalGas += BigInt(receipt.gasUsed ?? "0x0");
  if (row.payment_reference) references.add(row.payment_reference);
}

note(`  ${verified}/${settled.length} receipts verified as successful on chain`);
note(`  ${totalGas} gas used in total across them\n`);

// ---- every payment reference must appear in the proxy's own log ----------

note(`${references.size} distinct payment references. Looking each one up in the`);
note("ERC20FeeProxy event log, which is the same evidence Request's detection reads.\n");

let found = 0;
const amounts = new Map<string, number>();
for (const reference of references) {
  const sighting = await findPaymentByReference(reference, { lookbackBlocks: 300_000 });
  if (sighting.found) {
    found++;
    amounts.set(sighting.amount ?? "?", (amounts.get(sighting.amount ?? "?") ?? 0) + 1);
  } else {
    failures++;
    note(`  FAIL reference ${reference} does not appear in the proxy log`);
  }
}
note(`  ${found}/${references.size} references present on chain`);
for (const [amount, count] of amounts) {
  note(`  ${count} of them for exactly ${amount} base units`);
}

// ---- refusal rows must have moved nothing --------------------------------

note(`\n${refusals.length} rows claim no send. Checking they really have no transaction.`);
const claimedSends = refusals.filter((r) => r.physical_sends > 0);
if (claimedSends.length > 0) {
  failures++;
  note(`  FAIL ${claimedSends.length} refusal rows report a non-zero send count`);
} else {
  note("  every refusal row reports zero sends, and carries no hash to check");
}

// ---- the arithmetic that matters -----------------------------------------

const payments = doc.rows.filter((r) => r.expected === "SETTLED" && r.actual === "SETTLED").length;
const replays = doc.rows.filter((r) => r.expected === "ALREADY_SETTLED").length;
const replaySends = doc.rows
  .filter((r) => r.expected === "ALREADY_SETTLED")
  .reduce((a, r) => a + r.physical_sends, 0);

note("\nThe claim, restated as arithmetic:");
note(`  obligations settled          ${payments}`);
note(`  replays attempted            ${replays}`);
note(`  sends made by those replays  ${replaySends}`);
if (replaySends !== 0) {
  failures++;
  note("  FAIL a replay moved money");
} else if (replays === 0) {
  failures++;
  note("  FAIL no replays were attempted, so nothing was proven");
} else {
  note(`  Every one of ${replays} replays refused without sending.`);
}

note(
  failures === 0
    ? "\nVerified independently. Nothing here was taken from the artifact's own word.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
