/**
 * Drain the outbox against the real chain. The operational half of settlement.
 *
 * `settle` gets a payment sent and durably recorded. It cannot finish the job on its own:
 * a transaction that has not been mined yet, or a log this deployment has not matched to the obligation yet,
 * leaves the obligation in RECONCILIATION_PENDING or EXECUTION_OUTCOME_UNKNOWN. Those are
 * honest states, not failures — but something has to come back and look, or they are
 * permanent. This is that something.
 *
 * It has no write path to the provider at all. It reads chain receipts and the fee-proxy
 * event log, and it moves state. The worst a bug in here can do is fail to advance an
 * obligation; it cannot pay anything.
 *
 * Usage:
 *   node --experimental-strip-types scripts/resolve.ts [--passes=5] [--db=.data/live.sqlite]
 */

import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_RPC, findPaymentByReference, readReceipt, rpcCall, type PaymentExpectation } from "../src/chain.ts";
import { obligationId } from "../src/identity.ts";
import { NAMESPACE } from "../src/plan.ts";
import { Store } from "../src/store.ts";
import { drainUntilQuiet } from "../src/worker.ts";
import type { Receipt } from "../src/provider.ts";

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([a-zA-Z]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1], m[2] ?? "true");
}

const dbPath = args.get("db") ?? ".data/live.sqlite";
const passes = Number(args.get("passes") ?? 5);
const rpcUrl = process.env.SEPOLIA_RPC ?? DEFAULT_RPC;

if (!existsSync(dbPath)) {
  console.error(`\nno settlement database at ${dbPath}. Nothing has been settled from here.\n`);
  process.exit(1);
}

/**
 * A receipt read straight from a public node. No credentials, no provider.
 *
 * `verified` is only true when the node returned a receipt with a status we understand;
 * anything else stays unverified, which keeps the obligation short of SETTLED rather than
 * letting a transport hiccup look like confirmation.
 *
 * This was a private copy that returned `{hash, verified, receiptStatus, gasUsed}` and nothing
 * else -- no `blockNumber`, no `confirmations`, no `to`, no `logs`. The worker's depth gate reads
 * `confirmations`, so in `npm run resolve` it could never fire: the resolver would move an
 * obligation to SETTLED, which is terminal, on a receipt one block deep. `sourceSaysPaid` below
 * reads `eth_getLogs`, which sees a log at one confirmation too, so nothing else imposed depth
 * either.
 *
 * `src/chain.ts` says of its reader: "One reader, shared with the MCP transport and with every
 * script. There were four private copies of this and each one had to learn separately..." This
 * was the copy that consolidation missed, and it was the last one left in a path that can settle.
 */
const receipt = (hash: string): Promise<Receipt> => readReceipt(rpcUrl, hash);

const store = new Store(dbPath);

/**
 * Request's own view, read from the fee proxy's event log rather than an API.
 *
 * It must confirm THIS transaction. A boolean over the reference alone would accept some
 * other transaction's evidence, which is how a duplicate obligation once reported itself
 * settled using the first payment's log entry.
 */
async function sourceSaysPaid(requestId: string, txHash: string): Promise<boolean> {
  const obligation = store.obligationForRecovery(obligationId(NAMESPACE, requestId));
  const reference = obligation?.paymentReference;
  if (!reference) return false;
  const sighting = await findPaymentByReference(reference, {
    lookbackBlocks: 300_000,
    rpcUrl,
    // Token, payee and fee as well as the reference, from the facts stored at import.
    expect: obligation.expectation ?? undefined,
  });
  return (
    sighting.found === true &&
    sighting.txHash?.toLowerCase() === txHash.toLowerCase() &&
    (obligation.invoiceBaseUnits === null || sighting.amount === obligation.invoiceBaseUnits)
  );
}

/** Recovery for an attempt that was sent but never recorded. Read-only, like everything here. */
async function findPaidReference(reference: string, expect?: PaymentExpectation) {
  const seen = await findPaymentByReference(reference, { lookbackBlocks: 300_000, rpcUrl, expect });
  return seen.found && seen.txHash ? { txHash: seen.txHash, amount: seen.amount } : null;
}

/**
 * The same read, with its uncertainty intact.
 *
 * `findPaidReference` collapses "the chain says no" and "I could not tell" into null, which is
 * safe for recovering a hash and not safe for deciding whether a dead simulation executed.
 */
// The anchor is what lets a silence mean "not paid" rather than "not seen": a payment for an
// invoice cannot predate the invoice. Without it the scan floor is arbitrary, every negative is
// truncated, and this resolver can never release an obligation it was run to release.
const sightPayment = (reference: string, expect?: PaymentExpectation, anchorBlock?: number) =>
  findPaymentByReference(reference, { lookbackBlocks: 300_000, rpcUrl, expect, anchorBlock });

const results = await drainUntilQuiet(
  { store, provider: { receipt }, sourceSaysPaid, findPaidReference, sightPayment },
  // Run by hand, this is an operator asking, not a timer polling: look past the retry
  // backoff rather than reporting "nothing moved" for work that is scheduled a moment out.
  { now: Date.now(), maxPasses: passes, stepMs: 0, lookaheadMs: 60_000 },
);

const claimed = results.reduce((n, r) => n + r.claimed, 0);
const completed = results.reduce((n, r) => n + r.completed, 0);
const deferred = results.reduce((n, r) => n + r.deferred, 0);
const advanced = results.flatMap((r) => r.advanced);

console.log(`\nresolve: ${claimed} jobs claimed, ${completed} completed, ${deferred} deferred\n`);
for (const a of advanced) {
  console.log(`  ${a.obligationId.slice(0, 14)}…  ${a.from} -> ${a.to}`);
}
if (advanced.length === 0) console.log("  nothing moved.");
console.log(`\n${store.pendingJobCount()} jobs still owed work.\n`);

store.close();
