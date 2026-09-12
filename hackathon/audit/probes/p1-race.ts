/**
 * ATTACK 1 — two concurrent proposers for the same obligation.
 * Part A: store-level test-and-set atomicity (deterministic).
 * Part B: two OS processes racing full settleObligation on one sqlite file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Store } from "../../../src/store.ts";
import { idempotencyKey, obligationId } from "../../../src/identity.ts";
import { NAMESPACE } from "../../../src/plan.ts";

const dir = mkdtempSync(join(tmpdir(), "rk-p1-"));
const db = join(dir, "race.sqlite");

// ---- Part A: is "read firstSendAt, then markSent" atomic? ----------------
{
  const s = new Store(db);
  const oid = obligationId(NAMESPACE, "01req-race-A");
  s.importObligation({
    obligationId: oid, namespace: NAMESPACE, requestId: "01req-race-A",
    sourceFactsJson: "{}", sourceFactsHash: "h", paymentReference: "0xaa01", now: 1,
  });
  const planHash = "a".repeat(64);
  const { attemptId } = s.openAttempt({
    obligationId: oid, planHash, stepIndex: 0,
    idempotencyKey: idempotencyKey(oid, planHash, 0),
    endpoint: "/api/execute/contract-call", bodyJson: "{}", now: 1,
  });

  // Exactly what settle.ts section 8 does, run by two callers.
  const aSees = s.getAttempt(attemptId)!.firstSendAt;   // caller A reads
  const bSees = s.getAttempt(attemptId)!.firstSendAt;   // caller B reads (A has not marked yet)
  s.markSent(attemptId, 100);                            // A marks and sends
  s.markSent(attemptId, 200);                            // B marks and sends

  console.log("PART A store-level test-and-set");
  console.log("  A read firstSendAt =", aSees, "-> A would send:", aSees === null);
  console.log("  B read firstSendAt =", bSees, "-> B would send:", bSees === null);
  console.log("  both callers passed the guard:", aSees === null && bSees === null);
  console.log("  first_send_at after both:", s.getAttempt(attemptId)!.firstSendAt, "(COALESCE keeps the first)");
  console.log("  same idempotency key for both:", s.getAttempt(attemptId)!.idempotencyKey.slice(0, 16) + "…");
  s.close();
}

// ---- Part B: two processes, full settleObligation, barrier-synced --------
const TRIALS = Number(process.argv[2] ?? 30);
let bothExecuted = 0;
let trialsRun = 0;
const outcomes = new Map<string, number>();

for (let t = 0; t < TRIALS; t++) {
  const trialDb = join(dir, `t${t}.sqlite`);
  const startAt = Date.now() + 350;
  const child = (tag: string) =>
    new Promise<string>((resolve) => {
      const p = spawn(process.execPath,
        ["--experimental-strip-types", join(import.meta.dirname, "p1-child.ts"), trialDb, String(startAt), tag],
        { stdio: ["ignore", "pipe", "pipe"] });
      let buf = "";
      p.stdout.on("data", (d: Buffer) => (buf += d));
      p.stderr.on("data", (d: Buffer) => (buf += d));
      p.on("close", () => resolve(buf.trim()));
    });
  const [a, b] = await Promise.all([child("A"), child("B")]);
  trialsRun++;
  const parse = (s: string) => {
    try { return JSON.parse(s.split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}"); }
    catch { return { error: s.slice(0, 200) }; }
  };
  const ra = parse(a), rb = parse(b);
  const executes = (ra.executeCalls ?? 0) + (rb.executeCalls ?? 0);
  const k = `${ra.state ?? "NO_JSON"}${ra.error ? "(" + ra.error + ")" : ""}|${rb.state ?? "NO_JSON"}${rb.error ? "(" + rb.error + ")" : ""}|execs=${executes}`;
  outcomes.set(k, (outcomes.get(k) ?? 0) + 1);
  if (executes > 1) bothExecuted++;
}

console.log("\nPART B two-process race, trials =", trialsRun);
for (const [k, n] of [...outcomes].sort((x, y) => y[1] - x[1])) console.log(`  x${n}  ${k}`);
console.log("  trials where BOTH processes called provider.execute():", bothExecuted);

rmSync(dir, { recursive: true, force: true });
