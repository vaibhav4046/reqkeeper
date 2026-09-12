/**
 * One invoice. N workers. One payment.
 *
 *   npm run race                 10 workers, fixture mode
 *   npm run race -- --workers 50
 *   npm run race -- --json       artifact only, for scripting
 *
 * N independent Node processes — own process, own SQLite connection, no shared memory — all
 * settle the SAME Request obligation against one database file, released from a barrier onto
 * the same millisecond. Success is exactly one payment.
 *
 * What this proves, precisely, because the distinction is the whole point:
 *
 * The idempotency key is `sha256("reqkeeper.step.v1:" + obligationId:planHash:stepIndex)`. It
 * has no session, clock or random input, so every worker computes the SAME key. If this run
 * only ever demonstrated that KeeperHub refuses a duplicate key, it would prove KeeperHub's
 * cache works and say nothing about ReqKeeper. So the fixture counts EVERY non-simulate POST
 * that arrives, whatever key it carries, and reports the deduplicated ones separately:
 *
 *   posts        calls that reached the provider at all
 *   dedupedByKey calls the provider recognised as a replay and answered from cache
 *   broadcasts   posts - dedupedByKey, the ones that would have moved money
 *
 * `broadcasts: 1` is the claim. `posts: 1` is the stronger result this design is going for:
 * the losing workers never reached the provider, because the reservation and the compare-and-set
 * stopped them locally. A run where `posts` equals the worker count and `dedupedByKey` carries
 * the difference would mean exactly-once was KeeperHub's doing, not ours — and the artifact
 * would show it rather than hide it.
 *
 * The second wave re-runs every worker after the first has fully exited, against the same
 * database. Nothing is retried, nothing is sent, and the obligation is already settled: the
 * expected result is `sends: 0`, which is the 24-hour-window claim in miniature — the defence
 * is durable local state, not a provider cache that eventually forgets.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_RPC, findPaymentByReference } from "../src/chain.ts";
import { fetchInvoice } from "../src/request.ts";
import { KeeperHubFixture, type FixtureCounters } from "./fixture-keeperhub.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};
const SPLIT_LINES = new RegExp(String.fromCharCode(13) + "?" + String.fromCharCode(10));
const LIVE = argv.includes("--live");

// `.env` is read only for a live run, and only for the credential. The fixture path must stay
// runnable on a clean clone with no file and no key — that is what makes it the CI mode.
if (LIVE && existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(SPLIT_LINES)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
// Fewer workers live, deliberately. If the invariant ever failed, every extra worker is another
// real payment, so the blast radius of a bug is bounded by the smallest N that still races.
const WORKERS = flag("workers", LIVE ? 3 : 10);
const JSON_ONLY = argv.includes("--json");
const OUT = LIVE ? "docs/evidence/race-live.json" : "docs/evidence/race.json";

const PAYEE = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const AMOUNT = "1000000000000000000";
const CHILD = new URL("race-child.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

interface WorkerLine {
  pid: number;
  startOrder: number;
  state: string;
  refusal: string | null;
  providerWriteIssued: boolean;
  txHash: string | null;
  planHash?: string | null;
}

function runWorker(db: string, fx: KeeperHubFixture, requestId: string, reference: string, startAt: number, order: number): Promise<WorkerLine> {
  return new Promise((resolve) => {
    const kid = spawn(
      process.execPath,
      ["--experimental-strip-types", CHILD, db, LIVE ? "LIVE" : fx.baseUrl, LIVE ? DEFAULT_RPC : fx.rpcUrl, requestId, reference, payee, AMOUNT, String(startAt), String(order)],
      { env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    let out = "";
    kid.stdout.on("data", (c) => (out += c));
    kid.on("close", () => {
      const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
      try {
        resolve(JSON.parse(line) as WorkerLine);
      } catch {
        // A worker that produced no parseable line still has to appear in the artifact. A run
        // that silently drops workers can report "one payment" by losing the evidence.
        resolve({ pid: -1, startOrder: order, state: "NO_OUTPUT", refusal: out.slice(0, 140) || null, providerWriteIssued: false, txHash: null });
      }
    });
  });
}

async function wave(db: string, fx: KeeperHubFixture, requestId: string, reference: string, label: string): Promise<{ label: string; workers: WorkerLine[]; counters: FixtureCounters }> {
  const before = fx.counters();
  // Every worker is spawned first and only then released, so "concurrent" is a fact about the
  // run rather than a hope. Spawning them one at a time measures nothing.
  const startAt = Date.now() + 400 + WORKERS * 12;
  const workers = await Promise.all(
    Array.from({ length: WORKERS }, (_, i) => runWorker(db, fx, requestId, reference, startAt, i)),
  );
  const after = fx.counters();
  return {
    label,
    workers: workers.sort((a, b) => a.startOrder - b.startOrder),
    counters: {
      posts: after.posts - before.posts,
      dedupedByKey: after.dedupedByKey - before.dedupedByKey,
      broadcasts: after.broadcasts - before.broadcasts,
      simulates: after.simulates - before.simulates,
      distinctKeys: after.distinctKeys,
    },
  };
}

const fx = new KeeperHubFixture();
await fx.start();

const dir = mkdtempSync(join(tmpdir(), "rk-race-"));
const db = join(dir, "race.sqlite");

let requestId: string;
let reference: string;
let payee = PAYEE;

if (LIVE) {
  // --- the live run, and the four things it refuses to do without --------------
  //
  // This spends. Every precondition below is checked against Request and against the chain
  // rather than against a file, because the file being wrong is precisely the failure this
  // project exists to catch, and "the artifact said it was unpaid" is not a reason to pay.
  if (!process.env.KEEPERHUB_API_KEY) {
    console.error("--live needs KEEPERHUB_API_KEY.");
    process.exit(2);
  }
  const wanted = argv[argv.indexOf("--request-id") + 1];
  if (!wanted || wanted.startsWith("--")) {
    console.error("--live needs --request-id <id>.");
    console.error("It will not pick an invoice for you.");
    process.exit(2);
  }

  // 1. the invoice is real, and its reference is DERIVED, not taken from anywhere
  const invoice = await fetchInvoice(wanted);
  requestId = invoice.requestId;
  reference = invoice.paymentReference;
  payee = invoice.payee;
  if (invoice.invoiceBaseUnits !== AMOUNT) {
    console.error(`refusing: invoice is ${invoice.invoiceBaseUnits}, not ${AMOUNT}.`);
    process.exit(2);
  }

  // 2. it is UNPAID, scanned from its own anchor block — an invoice cannot have been paid
  //    before it existed, so that window is complete for this question.
  const from = (invoice.anchor?.blockNumber ?? 0) - 10;
  const seen = await findPaymentByReference(reference, { fromBlock: from > 0 ? from : undefined });
  if (seen.found) {
    console.error(`refusing: ${reference} already paid by ${seen.txHash}.`);
    process.exit(2);
  }

  console.log(`
  LIVE — real KeeperHub, real Sepolia, real money.`);
  console.log(`  invoice   ${requestId.slice(0, 30)}…`);
  console.log(`  reference ${reference}  (derived from the invoice, not read from a file)`);
  console.log(`  payee     ${payee}`);
  console.log(`  unpaid    scanned ${seen.scannedBlocks} blocks from its anchor, no payment found`);
  console.log(`  workers   ${WORKERS} — if the invariant fails, that is ${WORKERS} FAU, not ${WORKERS * 10}
`);
} else {
  const stamp = Date.now().toString(16);
  requestId = `01race${stamp}`;
  reference = `0x${stamp.padStart(16, "0").slice(-16)}`;
}

const first = await wave(db, fx, requestId, reference, "first wave");
const second = await wave(db, fx, requestId, reference, "second wave");

const settled = first.workers.filter((w) => w.state === "SETTLED" && w.refusal === null).length;
const hashes = new Set(first.workers.map((w) => w.txHash).filter(Boolean) as string[]);
const totalBroadcasts = first.counters.broadcasts + second.counters.broadcasts;

const artifact = {
  generatedAt: new Date().toISOString(),
  mode: "FIXTURE" as const,
  chainId: 11155111,
  note:
    "N independent processes, one SQLite file, one Request obligation, released from a barrier. " +
    "The fixture counts every non-simulate POST regardless of idempotency key, and reports the " +
    "deduplicated ones separately, so the result cannot be KeeperHub's cache taking the credit.",
  workers: WORKERS,
  totals: {
    broadcasts: totalBroadcasts,
    postsReachingTheProvider: first.counters.posts + second.counters.posts,
    dedupedByKey: first.counters.dedupedByKey + second.counters.dedupedByKey,
    settled,
    distinctTransactions: hashes.size,
    duplicates: Math.max(0, totalBroadcasts - 1),
    secondWaveBroadcasts: second.counters.broadcasts,
  },
  waves: [first, second],
  executions: fx.executions,
};

mkdirSync("docs/evidence", { recursive: true });
writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
await fx.stop();
rmSync(dir, { recursive: true, force: true });

if (JSON_ONLY) {
  console.log(JSON.stringify(artifact.totals));
} else {
  const t = artifact.totals;
  console.log(`\n  1 invoice. ${WORKERS} workers. ${t.broadcasts} payment${t.broadcasts === 1 ? "" : "s"}.\n`);
  const row = (k: string, v: string | number, why: string) =>
    console.log(`  ${k.padEnd(30)} ${String(v).padStart(4)}   ${why}`);
  row("payments broadcast", t.broadcasts, "calls that would have moved money");
  row("posts reaching the provider", t.postsReachingTheProvider, "the losers never got this far");
  row("deduped by idempotency key", t.dedupedByKey, "KeeperHub's cache was not what stopped them");
  row("workers reporting SETTLED", t.settled, `of ${WORKERS}`);
  row("distinct transactions", t.distinctTransactions, "one debt, one transaction");
  row("duplicate payments", t.duplicates, "the number this project exists to keep at zero");
  row("second wave broadcasts", t.secondWaveBroadcasts, "same plan, same key, after every process exited");

  const tally = new Map<string, number>();
  for (const w of [...first.workers, ...second.workers]) {
    const k = `${w.state}${w.refusal ? ` / ${w.refusal.split(":")[0]}` : ""}`;
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  console.log("\n  how each worker finished");
  for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    x${String(n).padStart(3)}  ${k}`);
  }
  console.log(`\n  written to ${OUT}\n`);
}

// The exit code is the gate. A run that cannot say "one payment" must not be green.
const ok = artifact.totals.broadcasts === 1 && artifact.totals.duplicates === 0 && artifact.totals.secondWaveBroadcasts === 0;
if (!ok) {
  console.error(
    `RACE FAILED: broadcasts=${artifact.totals.broadcasts} duplicates=${artifact.totals.duplicates} ` +
      `secondWave=${artifact.totals.secondWaveBroadcasts}\n`,
  );
}
process.exit(ok ? 0 : 1);
