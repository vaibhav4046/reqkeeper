/**
 * The crash lottery. Kill the settlement at nine points, restart, count the payments.
 *
 *   npm run crash
 *   npm run crash -- --json      artifact only, for scripting
 *
 * The claim under test is the one this project is built around: the system may be temporarily
 * uncertain, but it never resolves uncertainty by paying again. So each checkpoint gets its
 * own obligation, its own database and its own child process, and that child is really killed
 * — process.kill(pid, "SIGKILL") — at the chosen moment. Then the parent does what an operator
 * does on Monday morning: reopen the database, drain the outbox with the shipped worker, and
 * let the agent retry settleObligation the way a retrying agent would.
 *
 * Sends are counted by KeeperHubFixture, which lives in THIS process and speaks KeeperHub's
 * contract over real HTTP. That is not decoration. The whole question is what a dead process
 * did before it died, and an in-process provider stub dies with the process it was counting.
 *
 * Two numbers per checkpoint, and they answer different questions:
 *
 *   sendsBeforeRecovery  payments the crashed child had already made
 *   totalBroadcasts      payments for this debt across the crash AND the whole recovery
 *
 * `duplicate` is `totalBroadcasts > 1`, and it is the only cell that must read the same on
 * every row. The rest deliberately do not:
 *
 *   at `after_mark_sent_before_execute` the attempt row and `first_send_at` are committed but
 *   the provider was never called. Local state alone cannot tell whether a payment is in
 *   flight, and the fixture confirms none was: sends 0. The honest end state is
 *   EXECUTION_OUTCOME_UNKNOWN — never resent, left open for reconciliation and a human.
 *   Forcing that row to SETTLED would be inventing a payment; reading it as "unpaid, go
 *   ahead" is exactly the mistake that pays twice.
 *
 *   at `after_execute_before_receipt` and `while_polling` the money did move, and recovery
 *   converges to SETTLED off the payment that already exists — one send, start to finish.
 *
 * Convergence is reported where convergence is honest. Zero duplicates is required everywhere.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PaymentSighting } from "../src/chain.ts";
import { obligationId } from "../src/identity.ts";
import { KeeperHubProvider } from "../src/keeperhub.ts";
import { buildPolicy, buildSourceFacts, buildSteps, NAMESPACE, type InvoiceFacts } from "../src/plan.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";
import { drainUntilQuiet } from "../src/worker.ts";

import { KeeperHubFixture } from "./fixture-keeperhub.ts";

const argv = process.argv.slice(2);
const JSON_ONLY = argv.includes("--json");
const OUT = "docs/evidence/crash.json";

const PAYEE = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const AMOUNT = "1000000000000000000";
const CHILD = new URL("crash-child.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * Nine moments, in the order settlement reaches them. Each is a different answer to "what
 * does local state know, what does the chain know, and do the two agree?"
 */
const CHECKPOINTS = [
  "before_reservation",
  "after_reservation",
  "after_approval",
  "after_open_attempt",
  "after_mark_sent_before_execute",
  "after_execute_before_receipt",
  "while_polling",
  "after_receipt_before_reconcile",
  "after_reconcile",
] as const;

type Checkpoint = (typeof CHECKPOINTS)[number];

interface Row {
  readonly checkpoint: Checkpoint;
  /** Did the child really die here? A checkpoint that was never reached proves nothing. */
  readonly reached: boolean;
  readonly childSaid: string;
  readonly sendsBeforeRecovery: number;
  readonly stateAfterWorker: string;
  readonly pendingJobs: number;
  readonly agentRetryResult: string;
  readonly finalState: string;
  readonly totalBroadcasts: number;
  readonly duplicate: boolean;
  readonly proof: string;
}

function facts(requestId: string, reference: string): InvoiceFacts {
  return {
    requestId,
    paymentReference: reference,
    payee: PAYEE,
    amountBaseUnits: AMOUNT,
    maxTotalDebitBaseUnits: AMOUNT,
    feeAmount: "0",
    feeAddress: `0x${"0".repeat(40)}`,
    hasBeenPaid: false,
  };
}

function runChild(
  db: string,
  fxt: KeeperHubFixture,
  requestId: string,
  reference: string,
  at: Checkpoint,
): Promise<string> {
  return new Promise((resolve) => {
    const kid = spawn(
      process.execPath,
      ["--experimental-strip-types", CHILD, db, fxt.baseUrl, fxt.rpcUrl, requestId, reference, PAYEE, AMOUNT],
      {
        env: { ...process.env, NODE_NO_WARNINGS: "1", REQKEEPER_CRASH_AT: at },
        // A child that somehow outlives its own SIGKILL has to be reaped rather than waited
        // on forever: a harness that can hang is a harness that gets switched off.
        timeout: 60_000,
        killSignal: "SIGKILL",
      },
    );
    let out = "";
    kid.stdout.on("data", (c) => (out += c));
    kid.stderr.on("data", (c) => (out += c));
    kid.on("close", () => resolve(out.trim()));
  });
}

const fx = new KeeperHubFixture();
await fx.start();
const origin = fx.rpcUrl.replace(/\/rpc$/, "");
const chain = new KeeperHubProvider({ apiKey: "kh_fixture", chainId: 11155111, rpcUrl: fx.rpcUrl, baseUrl: fx.baseUrl });

const dir = mkdtempSync(join(tmpdir(), "rk-crash-"));
const rows: Row[] = [];

for (const checkpoint of CHECKPOINTS) {
  const stamp = `${Date.now().toString(16)}${rows.length}`;
  const requestId = `01crash${stamp}`;
  const reference = `0x${stamp.padStart(16, "0").slice(-16)}`;
  const db = join(dir, `${checkpoint}.sqlite`);
  const oid = obligationId(NAMESPACE, requestId);
  const f = facts(requestId, reference);

  const before = fx.counters();
  const raw = await runChild(db, fx, requestId, reference, checkpoint);
  const afterChild = fx.counters();
  const sendsBeforeRecovery = afterChild.broadcasts - before.broadcasts;

  const lastLine = raw.split("\n").filter((l) => l.trim()).pop() ?? "";
  let said: { crashedAt?: string | null; state?: string; refusal?: string | null } = {};
  try {
    said = JSON.parse(lastLine) as typeof said;
  } catch {
    said = {};
  }
  const reached = said.crashedAt === checkpoint;
  const childSaid = reached
    ? `CRASH@${checkpoint}`
    : said.state
      ? `${said.state}${said.refusal ? `/${said.refusal.split(":")[0]}` : ""}`
      : `NO_OUTPUT(${lastLine.slice(0, 40)})`;

  // --- restart. All an operator has is the database file and the chain. ------------------
  const store = new Store(db);

  /** The three read-only questions recovery may ask. None of them can send. */
  const ask = {
    sourceSaysPaid: async (_requestId: string, txHash: string): Promise<boolean> => {
      const res = await fetch(
        `${origin}/paid?reference=${encodeURIComponent(reference)}&txHash=${encodeURIComponent(txHash)}`,
      );
      const body = (await res.json()) as { paid?: boolean; amount?: string };
      return body.paid === true && body.amount === AMOUNT;
    },
    findPaidReference: async (ref: string): Promise<{ txHash?: string; amount?: string } | null> => {
      const res = await fetch(`${origin}/paid?reference=${encodeURIComponent(ref)}`);
      const body = (await res.json()) as { paid?: boolean; txHash?: string | null; amount?: string | null };
      if (body.paid !== true || !body.txHash) return null;
      return { txHash: body.txHash, amount: body.amount ?? undefined };
    },
    /**
     * A sighting carries its own uncertainty. `truncated: true` means "could not tell", and
     * the worker must never read that as "nothing happened" — that reading is how a second
     * payment gets authorised. The fixture holds the entire ledger in memory, so a negative
     * here really is a negative and says so.
     */
    sightPayment: async (ref: string): Promise<PaymentSighting> => {
      const res = await fetch(`${origin}/paid?reference=${encodeURIComponent(ref)}`);
      const body = (await res.json()) as { paid?: boolean; txHash?: string | null; amount?: string | null };
      return {
        found: body.paid === true,
        txHash: body.txHash ?? undefined,
        amount: body.amount ?? undefined,
        truncated: false,
        scannedBlocks: 1,
      };
    },
  };

  await drainUntilQuiet(
    { store, provider: { receipt: (hash: string) => chain.receipt(hash) }, ...ask },
    { now: Date.now(), maxPasses: 8, stepMs: 0, lookaheadMs: 120_000 },
  );
  const stateAfterWorker = store.obligationForRecovery(oid)?.state ?? "(no row)";
  const pendingJobs = store.pendingJobCount();

  // --- and then the agent tries again, which is what agents do --------------------------
  //
  // The retry gets the REAL provider pointed at the fixture, not a stub that throws on the
  // second send. A stub would prove the harness noticed; the real provider proves a second
  // send would have reached KeeperHub and been counted, which is the number this file is for.
  let agentRetryResult: string;
  try {
    const r = await settleObligation(
      { store, provider: chain, policy: buildPolicy(f), sourceSaysPaid: ask.sourceSaysPaid },
      {
        namespace: NAMESPACE,
        requestId,
        paymentReference: reference,
        obligationId: oid,
        facts: buildSourceFacts(f),
        steps: buildSteps(f),
        approval: { approver: "human:owner", decision: "APPROVED" },
        now: Date.now(),
      },
    );
    agentRetryResult = `${r.state}/${r.refusal ?? "-"}`;
  } catch (e) {
    agentRetryResult = `THREW:${(e as Error).message.slice(0, 60)}`;
  }

  const finalState = store.obligationForRecovery(oid)?.state ?? "(no row)";
  store.close();

  const totalBroadcasts = fx.counters().broadcasts - before.broadcasts;
  const duplicate = totalBroadcasts > 1;

  // Every word of this is derived from the numbers beside it, so a row cannot claim something
  // the run did not measure.
  const proof = duplicate
    ? `DUPLICATE: ${totalBroadcasts} payments for one obligation after a crash at ${checkpoint}`
    : !reached
      ? `checkpoint not reached (child said ${childSaid}); this row demonstrates nothing`
      : totalBroadcasts === 0
        ? `killed at ${checkpoint}; the provider was never called and nothing was ever sent. Recovery ` +
          `ended at ${finalState} and the retry answered ${agentRetryResult} — uncertain, held open for ` +
          `reconciliation and a human, and never resolved by sending`
        : sendsBeforeRecovery === 0
          ? `killed at ${checkpoint} before anything reached the provider; the debt was still owed, the ` +
            `retry answered ${agentRetryResult} and it was paid exactly ${totalBroadcasts} time`
          : `killed at ${checkpoint} with the payment already on the record; recovery reached ${finalState} ` +
            `off that payment and the retry answered ${agentRetryResult} — still ${totalBroadcasts} payment`;

  rows.push({
    checkpoint,
    reached,
    childSaid,
    sendsBeforeRecovery,
    stateAfterWorker,
    pendingJobs,
    agentRetryResult,
    finalState,
    totalBroadcasts,
    duplicate,
    proof,
  });
}

const totals = {
  checkpoints: rows.length,
  reached: rows.filter((r) => r.reached).length,
  duplicates: rows.filter((r) => r.duplicate).length,
  broadcasts: rows.reduce((n, r) => n + r.totalBroadcasts, 0),
  settledAfterRecovery: rows.filter((r) => r.finalState === "SETTLED").length,
  heldOpenForAHuman: rows.filter((r) => r.finalState !== "SETTLED").length,
  maxBroadcastsForOneObligation: rows.reduce((n, r) => Math.max(n, r.totalBroadcasts), 0),
};

const artifact = {
  generatedAt: new Date().toISOString(),
  mode: "FIXTURE" as const,
  chainId: 11155111,
  note:
    "One obligation and one database per checkpoint. The child is killed with a real SIGKILL " +
    "at the named moment, then the outbox is drained by the shipped worker and the agent " +
    "retries settlement with the real provider. Sends are counted by an out-of-process " +
    "KeeperHub fixture, so the count survives the kill. End states differ by checkpoint and " +
    "that is the result, not a defect; `duplicate` is the cell that must be false on every row.",
  checkpoints: CHECKPOINTS,
  totals,
  rows,
  executions: fx.executions,
};

mkdirSync("docs/evidence", { recursive: true });
writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
await fx.stop();
rmSync(dir, { recursive: true, force: true });

if (JSON_ONLY) {
  console.log(JSON.stringify(totals));
} else {
  console.log(
    `\n  ${totals.checkpoints} crash points. 1 obligation each. ` +
      `${totals.duplicates} duplicate payment${totals.duplicates === 1 ? "" : "s"}.\n`,
  );
  const head = ["crash point", "hit", "child said", "sends", "after worker", "jobs", "agent retry", "final", "total", "dup"];
  const body = rows.map((r) => [
    r.checkpoint,
    r.reached ? "yes" : "NO",
    r.childSaid,
    String(r.sendsBeforeRecovery),
    r.stateAfterWorker,
    String(r.pendingJobs),
    r.agentRetryResult,
    r.finalState,
    String(r.totalBroadcasts),
    r.duplicate ? "YES" : "no",
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (r: string[]): string => `  ${r.map((c, i) => c.padEnd(w[i])).join("  ")}`;
  console.log(line(head));
  console.log(line(w.map((n) => "-".repeat(n))));
  for (const r of body) console.log(line(r));

  console.log(
    `\n  ${totals.settledAfterRecovery} of ${totals.checkpoints} converged to SETTLED; ` +
      `${totals.heldOpenForAHuman} stayed open for reconciliation and a human.`,
  );
  console.log(
    `  ${totals.broadcasts} payments across ${totals.checkpoints} crashes; ` +
      `no obligation was paid more than ${totals.maxBroadcastsForOneObligation} time(s).`,
  );
  console.log(`\n  written to ${OUT}\n`);
}

// The exit code is the gate. Uncertainty is allowed; a second payment is not.
const offenders = rows.filter((r) => r.duplicate || r.totalBroadcasts > 1);
if (offenders.length > 0) {
  console.error(
    `CRASH LOTTERY FAILED: ${offenders.length} checkpoint(s) paid more than once — ` +
      `${offenders.map((r) => `${r.checkpoint}=${r.totalBroadcasts}`).join(", ")}\n`,
  );
}
process.exit(offenders.length > 0 ? 1 : 0);
