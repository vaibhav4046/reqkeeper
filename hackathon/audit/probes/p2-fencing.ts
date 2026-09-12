/**
 * ATTACK 2 — a worker whose lease expired. Is fencing enforced on the WRITE path,
 * or only on the job row?
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/store.ts";
import { drainOnce } from "../../../src/worker.ts";
import { obligationId, idempotencyKey } from "../../../src/identity.ts";
import { NAMESPACE } from "../../../src/plan.ts";
import type { Receipt } from "../../../src/provider.ts";

const dir = mkdtempSync(join(tmpdir(), "rk-p2-"));
const db = join(dir, "fence.sqlite");
const store = new Store(db);
const oid = obligationId(NAMESPACE, "01req-fence");
const planHash = "b".repeat(64);

store.importObligation({
  obligationId: oid, namespace: NAMESPACE, requestId: "01req-fence",
  sourceFactsJson: JSON.stringify({ invoiceBaseUnits: "1000" }),
  sourceFactsHash: "h", paymentReference: "0xbb01", now: 1,
});
const { attemptId } = store.openAttempt({
  obligationId: oid, planHash, stepIndex: 0,
  idempotencyKey: idempotencyKey(oid, planHash, 0),
  endpoint: "/api/execute/contract-call", bodyJson: "{}", now: 1,
});
// Walk to PAYMENT_EXECUTING the legal way, and mark the attempt sent-but-unrecorded.
for (const s of ["VALIDATING", "AWAITING_APPROVAL", "APPROVED", "PAYMENT_PREFLIGHT", "PAYMENT_EXECUTING"] as const) {
  store.setState(oid, s, 1);
}
store.markSent(attemptId, 1);

// Worker 1 claims the DISPATCH_STEP job (generation 1) and then stalls.
const j1 = store.claimJobs({ limit: 5, now: 1000, leaseMs: 30_000 })[0];
console.log("worker1 claimed job", j1.id, "generation", j1.fencingGeneration);

// Lease expires. Worker 2 runs the real drain loop, which re-claims (generation 2)
// and finishes the recovery. worker1's generation 1 is now stale.
const receipt = async (hash: string): Promise<Receipt> =>
  ({ hash, verified: true, receiptStatus: "success", gasUsed: "1" });
await drainOnce(
  {
    store, provider: { receipt },
    sourceSaysPaid: async () => false,
    findPaidReference: async () => ({ txHash: "0x" + "11".repeat(32), amount: "1000" }),
  },
  { now: 1000 + 31_000, lookaheadMs: 60_000 },
);
console.log("after worker2: state =", store.obligationForRecovery(oid)!.state,
            "outcome =", store.getAttempt(attemptId)!.outcome,
            "txHash =", store.getAttempt(attemptId)!.txHash?.slice(0, 10));

// Now worker1 wakes up holding generation 1 and replays exactly the writes
// src/worker.ts resolveJob performs, in order, with its stale generation.
console.log("\n-- worker1 (stale generation 1) now attempts its writes --");
const before = { state: store.obligationForRecovery(oid)!.state, outcome: store.getAttempt(attemptId)!.outcome };
let wrote: string[] = [];
try { store.recordOutcome(attemptId, { outcome: "CLOBBERED_BY_ZOMBIE", txHash: "0x" + "99".repeat(32) }); wrote.push("recordOutcome"); }
catch (e) { console.log("  recordOutcome REJECTED:", (e as Error).message); }
try { store.enqueue({ kind: "OBSERVE_EXECUTION", dedupeKey: "zombie:1", obligationId: oid, attemptId, dueAt: 1 }); wrote.push("enqueue"); }
catch (e) { console.log("  enqueue REJECTED:", (e as Error).message); }
try { store.setState(oid, "EXECUTION_OUTCOME_UNKNOWN", 2_000_000); wrote.push("setState"); }
catch (e) { console.log("  setState REJECTED:", (e as Error).message); }
try { store.completeJob(j1.id, j1.fencingGeneration); wrote.push("completeJob"); }
catch (e) { console.log("  completeJob REJECTED:", (e as Error).message); }
try { store.deferJob(j1.id, 1, "ZOMBIE", j1.fencingGeneration); wrote.push("deferJob"); }
catch (e) { console.log("  deferJob REJECTED:", (e as Error).message); }

console.log("  writes that LANDED despite the stale fence:", wrote.join(", ") || "(none)");
console.log("  attempt.outcome:", before.outcome, "->", store.getAttempt(attemptId)!.outcome);
console.log("  attempt.txHash :", store.getAttempt(attemptId)!.txHash?.slice(0, 10), "<- worker2 recorded 0x11111111; COALESCE(?,col) is LAST-WRITE-WINS");
console.log("  state          :", before.state, "->", store.obligationForRecovery(oid)!.state);

store.close();
rmSync(dir, { recursive: true, force: true });
