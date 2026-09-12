/**
 * Fencing on the write path, not just on the job row.
 *
 * `completeJob` and `deferJob` always put the generation in their WHERE clause, and that half
 * held under adversarial probing. The domain writes did not. A red-team probe
 * (`hackathon/audit/probes/p2-fencing.ts`) stalled a worker past its lease, let a second worker
 * finish the recovery, then replayed the first worker's writes with its stale generation:
 *
 *     completeJob REJECTED: stale fencing generation for job 1: held 1
 *     deferJob    REJECTED: stale fencing generation for job 1: held 1
 *     writes that LANDED despite the stale fence: recordOutcome, enqueue, setState
 *
 * A zombie could not finish a job it no longer owned, but it could rewrite the obligation's
 * state and the attempt's recorded evidence — which is the part that becomes a public claim.
 *
 * Two things are tested here, and they are different claims. The first group is the store
 * contract: a stale fence rejects the write and leaves nothing behind. The second is the one
 * that matters in production: the real worker loses its lease MID-FLIGHT, while awaiting the
 * receipt, and its writes are refused when it resumes.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { idempotencyKey, obligationId } from "../src/identity.ts";
import { NAMESPACE } from "../src/plan.ts";
import type { Receipt } from "../src/provider.ts";
import { Store } from "../src/store.ts";
import { drainOnce } from "../src/worker.ts";

const PLAN_HASH = "b".repeat(64);
const WORKER_HASH = `0x${"11".repeat(32)}`;
const ZOMBIE_HASH = `0x${"99".repeat(32)}`;

/** An obligation walked to PAYMENT_EXECUTING with an attempt that was sent but not recorded. */
function sentButUnrecorded(requestId: string) {
  const store = new Store();
  const oid = obligationId(NAMESPACE, requestId);
  store.importObligation({
    obligationId: oid,
    namespace: NAMESPACE,
    requestId,
    sourceFactsJson: JSON.stringify({ invoiceBaseUnits: "1000" }),
    sourceFactsHash: "h",
    paymentReference: `0xbb${requestId.length.toString(16).padStart(2, "0")}`,
    now: 1,
  });
  const { attemptId } = store.openAttempt({
    obligationId: oid,
    planHash: PLAN_HASH,
    stepIndex: 0,
    idempotencyKey: idempotencyKey(oid, PLAN_HASH, 0),
    endpoint: "/api/execute/contract-call",
    bodyJson: "{}",
    now: 1,
  });
  for (const s of ["VALIDATING", "AWAITING_APPROVAL", "APPROVED", "PAYMENT_PREFLIGHT", "PAYMENT_EXECUTING"] as const) {
    store.setState(oid, s, 1);
  }
  assert.equal(store.markSent(attemptId, 1), true, "the first claim on an unsent attempt must succeed");
  return { store, oid, attemptId };
}

const okReceipt = async (hash: string): Promise<Receipt> => ({
  hash,
  verified: true,
  receiptStatus: "success",
  gasUsed: "1",
});

describe("a stale fence writes nothing", () => {
  test("setState with a stale generation is refused and the state does not move", () => {
    const { store, oid } = sentButUnrecorded("01req-fence-state");
    const job = store.claimJobs({ limit: 5, now: 1_000, leaseMs: 30_000 })[0];
    const stale = { jobId: job.id, generation: job.fencingGeneration };

    // Another claimer takes the job: the generation moves on and `stale` is now a zombie's.
    store.claimJobs({ limit: 5, now: 1_000 + 31_000, leaseMs: 30_000 });

    assert.throws(
      () => store.setState(oid, "EXECUTION_OUTCOME_UNKNOWN", 2_000_000, stale),
      (e: Error & { code?: string }) => e.code === "STALE_FENCE",
    );
    assert.equal(store.obligationForRecovery(oid)?.state, "PAYMENT_EXECUTING", "the refused write must leave no trace");
    store.close();
  });

  test("recordOutcome with a stale generation is refused and the evidence does not move", () => {
    const { store, attemptId } = sentButUnrecorded("01req-fence-outcome");
    store.recordOutcome(attemptId, { outcome: "SENT", txHash: WORKER_HASH, now: 1 });
    const job = store.claimJobs({ limit: 5, now: 1_000, leaseMs: 30_000 })[0];
    const stale = { jobId: job.id, generation: job.fencingGeneration };
    store.claimJobs({ limit: 5, now: 1_000 + 31_000, leaseMs: 30_000 });

    assert.throws(
      () => store.recordOutcome(attemptId, { outcome: "CLOBBERED_BY_ZOMBIE", now: 2, fence: stale }),
      (e: Error & { code?: string }) => e.code === "STALE_FENCE",
    );
    assert.equal(store.getAttempt(attemptId)?.outcome, "SENT");
    assert.equal(store.getAttempt(attemptId)?.txHash, WORKER_HASH);
    store.close();
  });

  test("enqueue with a stale generation is refused and no job appears", () => {
    const { store, oid, attemptId } = sentButUnrecorded("01req-fence-enqueue");
    const job = store.claimJobs({ limit: 5, now: 1_000, leaseMs: 30_000 })[0];
    const stale = { jobId: job.id, generation: job.fencingGeneration };
    store.claimJobs({ limit: 5, now: 1_000 + 31_000, leaseMs: 30_000 });
    const before = store.pendingJobCount();

    assert.throws(
      () => store.enqueue({ kind: "OBSERVE_EXECUTION", dedupeKey: "zombie:1", obligationId: oid, attemptId, dueAt: 1, fence: stale }),
      (e: Error & { code?: string }) => e.code === "STALE_FENCE",
    );
    assert.equal(store.pendingJobCount(), before);
    store.close();
  });

  test("the same writes succeed for the generation that actually holds the lease", () => {
    const { store, oid, attemptId } = sentButUnrecorded("01req-fence-control");
    const job = store.claimJobs({ limit: 5, now: 1_000, leaseMs: 30_000 })[0];
    const held = { jobId: job.id, generation: job.fencingGeneration };

    store.recordOutcome(attemptId, { outcome: "SENT", txHash: WORKER_HASH, now: 1, fence: held });
    store.setState(oid, "CHAIN_PENDING", 2, held);

    assert.equal(store.getAttempt(attemptId)?.txHash, WORKER_HASH);
    assert.equal(store.obligationForRecovery(oid)?.state, "CHAIN_PENDING");
    store.close();
  });
});

describe("the real worker is fenced, not just the store", () => {
  test("a worker that loses its lease mid-flight cannot write when it resumes", async () => {
    const { store, oid, attemptId } = sentButUnrecorded("01req-fence-midflight");

    // The lease is lost while the worker is awaiting the chain — the realistic shape, because
    // that await is the only place a worker is slow enough to be overtaken. For a dispatch job
    // whose attempt was sent but never recorded, that await is `findPaidReference`.
    let stolen = false;
    const lookupThatStealsTheLease = async (): Promise<{ txHash: string; amount: string }> => {
      if (!stolen) {
        stolen = true;
        // Some other claimer takes the job. The in-flight worker's generation is now stale.
        store.claimJobs({ limit: 5, now: 10_000_000, leaseMs: 30_000 });
      }
      return { txHash: WORKER_HASH, amount: "1000" };
    };

    const result = await drainOnce(
      {
        store,
        provider: { receipt: okReceipt },
        sourceSaysPaid: async () => true,
        findPaidReference: lookupThatStealsTheLease,
      },
      { now: 1_000, lookaheadMs: 60_000 },
    );

    assert.ok(stolen, "the test must actually have taken the lease away mid-flight");
    assert.equal(result.advanced.length, 0, "a worker that lost its lease must advance nothing");
    assert.equal(
      store.obligationForRecovery(oid)?.state,
      "PAYMENT_EXECUTING",
      "the obligation must be exactly where the losing worker found it",
    );
    assert.notEqual(store.getAttempt(attemptId)?.txHash, ZOMBIE_HASH);
    store.close();
  });

  test("the same worker, keeping its lease, does advance the obligation", async () => {
    const { store, oid } = sentButUnrecorded("01req-fence-midflight-control");

    const result = await drainOnce(
      {
        store,
        provider: { receipt: okReceipt },
        sourceSaysPaid: async () => true,
        findPaidReference: async () => ({ txHash: WORKER_HASH, amount: "1000" }),
      },
      { now: 1_000, lookaheadMs: 60_000 },
    );

    assert.ok(result.advanced.length > 0, "the control must move, or the test above proves nothing");
    assert.notEqual(store.obligationForRecovery(oid)?.state, "PAYMENT_EXECUTING");
    store.close();
  });
});
