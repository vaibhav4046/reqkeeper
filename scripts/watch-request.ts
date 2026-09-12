/**
 * The trigger. An unpaid Request invoice starts the work, with nobody typing a command.
 *
 * Every other entry point in this repository is somebody asking for a payment. This one asks
 * Request — through a public RPC, with no credentials — which invoices the chain has never
 * seen paid, and proposes exactly those. What lands is a plan waiting on a human, and the
 * command that human runs next. Request's own state is what caused the proposal to exist.
 *
 * Nothing here can pay. `src/watch.ts` passes no approval and runs with a provider that
 * throws on every write, so a proposal stops at `AWAITING_APPROVAL` and the send counter
 * stays at zero however long this loops. See the header of that file.
 *
 * Usage:
 *   node --experimental-strip-types scripts/watch-request.ts --once
 *   node --experimental-strip-types scripts/watch-request.ts [--interval=60] [--db=.data/live.sqlite]
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { DEFAULT_RPC, findPaymentByReference, type PaymentExpectation } from "../src/chain.ts";
import { describeStandingPolicy, loadStandingPolicy } from "../src/standing-policy.ts";
import { Store } from "../src/store.ts";
import { watchPass, type WatchInvoice, type WatchRow } from "../src/watch.ts";

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

const once = args.has("once");
const dbPath = args.get("db") ?? ".data/live.sqlite";
const intervalMs = Math.max(1, Number(args.get("interval") ?? 60)) * 1000;
const rpcUrl = process.env.SEPOLIA_RPC ?? DEFAULT_RPC;

const INVOICES = "docs/live-invoices.json";
if (!existsSync(INVOICES)) {
  console.error(`\n${INVOICES} not found. There is nothing for this deployment to watch.\n`);
  process.exit(2);
}
const invoices = (
  JSON.parse(readFileSync(INVOICES, "utf8")) as { invoices: WatchInvoice[] }
).invoices;

// The store is the same one the settle path uses, so an invoice this deployment already
// proposed is recognised as the obligation it already is. A separate database here would
// re-propose everything on every pass and, worse, hand a human an approval command for a
// plan that some other database's guards know nothing about.
if (!existsSync(".data")) mkdirSync(".data");
const store = new Store(dbPath);
const standing = loadStandingPolicy();

const deps = {
  store,
  standing,
  dbPath,
  // `expect` is forwarded, so a log that carries the reference but pays another token, payee,
  // amount or fee is skipped by the scan rather than returned as this invoice's payment.
  findPayment: (reference: string, expect: PaymentExpectation) =>
    findPaymentByReference(reference, { rpcUrl, expect }),
};

function report(rows: readonly WatchRow[]): void {
  console.log(`\n${new Date().toISOString()}  ${rows.length} invoices`);
  console.log(
    `${"request id".padEnd(68)}${"reference".padEnd(20)}${"chain".padEnd(9)}state`,
  );
  console.log("-".repeat(126));
  for (const r of rows) {
    console.log(
      r.requestId.padEnd(68) +
        r.paymentReference.padEnd(20) +
        (r.chainSaysPaid ? "paid" : "unpaid").padEnd(9) +
        (r.refusal ?? r.state),
    );
  }

  const paid = rows.filter((r) => r.chainSaysPaid);
  const waiting = rows.filter((r) => r.approvalCommand !== null);
  const refused = rows.filter((r) => !r.chainSaysPaid && r.approvalCommand === null);
  const writes = rows.filter((r) => r.providerWriteIssued).length;

  console.log(
    `\n${paid.length} already paid, ${waiting.length} proposed and waiting on a human, ` +
      `${refused.length} refused. ${writes} provider writes.`,
  );
  // A watcher that issued a provider write did not watch anything. Said out loud rather than
  // left for someone to notice in the state column.
  if (writes > 0) console.log("MISMATCH: this loop is not supposed to be able to write.");

  for (const r of refused) {
    console.log(`\n  REFUSED ${r.requestId}\n    ${r.refusal ?? r.state}: ${r.detail}`);
  }

  if (waiting.length > 0) {
    console.log("\nApprove any of these by hand. Nothing moves until you do:\n");
    for (const r of waiting) console.log(`  ${r.approvalCommand}`);
  }
  console.log("");
}

// SIGINT stops after the pass in flight rather than mid-settle: a proposal interrupted
// between its plan row and its reservation is a plan nothing holds, which reads to the next
// pass as a rival plan racing the same obligation. A second Ctrl-C gives up on that courtesy.
let stopping = false;
let wake: (() => void) | null = null;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\nstopping after this pass. Press Ctrl-C again to stop now.");
  wake?.();
});

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

console.log(`\nwatching ${invoices.length} Request invoices from ${INVOICES}`);
console.log(`store    : ${dbPath}`);
console.log(`rpc      : ${rpcUrl}`);
console.log(`policy   : ${describeStandingPolicy(standing)}`);
console.log(once ? "mode     : single pass" : `mode     : every ${intervalMs / 1000}s, Ctrl-C to stop`);

if (once) {
  report(await watchPass(deps, invoices));
} else {
  while (!stopping) {
    try {
      report(await watchPass(deps, invoices));
    } catch (e) {
      // A public RPC having a bad minute must not end a poller whose entire job is to keep
      // asking. The next pass re-reads the chain from scratch, so nothing is carried over.
      console.error(`pass failed: ${(e as Error).message}`);
    }
    if (stopping) break;
    await sleep(intervalMs);
  }
}

store.close();
