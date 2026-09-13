/**
 * A sent attempt always leaves something queued to look at the chain.
 *
 * `markSent` stamps `first_send_at` BEFORE the provider call, because from that instant the money
 * may have moved and no reply can un-move it. `recordOutcome` then decided whether to queue an
 * observation with `if (o.outcome !== "SENT" && !o.txHash) return;` — keyed on whether the
 * provider handed back a hash.
 *
 * A `{"success": false}` with no hash therefore queued nothing. The attempt was marked sent, the
 * obligation sat in EXECUTION_OUTCOME_UNKNOWN, and the outbox was empty: no job, no observation,
 * nothing that would ever read the chain. Safe, and never recovered — the liveness half of the
 * same defect the send path keeps producing, where a state that means "I do not know" has no path
 * out of itself.
 *
 * A provider's own "failed" is not evidence of anything; it is the provider reporting on itself.
 * The chain is the only thing that knows, and an attempt with no hash is still findable by its
 * payment reference, which is the identifier that survives a lost reply.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { obligationId } from "../src/identity.ts";
import { NAMESPACE } from "../src/plan.ts";
import { Store } from "../src/store.ts";

const OID = obligationId(NAMESPACE, "01req-stranded");
const PLAN = "e".repeat(64);

function sentAttempt(): { store: Store; attemptId: number } {
  const store = new Store();
  store.importObligation({
    obligationId: OID,
    namespace: NAMESPACE,
    requestId: "01req-stranded",
    sourceFactsJson: "{}",
    sourceFactsHash: "h",
    paymentReference: "0x0056a1b2c3d4e5f6",
    now: 1,
  });
  const { attemptId } = store.openAttempt({
    obligationId: OID,
    planHash: PLAN,
    stepIndex: 0,
    idempotencyKey: "k-stranded",
    endpoint: "execute/contract-call",
    bodyJson: "{}",
    now: 1,
  });
  // The write is about to be issued. This is the moment after which nothing may conclude that
  // nothing happened.
  assert.equal(store.markSent(attemptId, 2), true);
  return { store, attemptId };
}

describe("an attempt that was sent is never left with an empty outbox", () => {
  test('a "failed" with no transaction hash still queues an observation', () => {
    const { store, attemptId } = sentAttempt();

    store.recordOutcome(attemptId, { outcome: "FAILED", now: 3 });

    assert.ok(
      store.pendingJobKinds().includes("OBSERVE_EXECUTION"),
      "a sent attempt with no hash must still be looked up on chain, or it is stranded for ever",
    );
    store.close();
  });

  test("an UNKNOWN with no hash queues one too", () => {
    const { store, attemptId } = sentAttempt();
    store.recordOutcome(attemptId, { outcome: "UNKNOWN", now: 3 });
    assert.ok(store.pendingJobKinds().includes("OBSERVE_EXECUTION"));
    store.close();
  });

  test("an attempt that was never sent queues nothing", () => {
    // The control. An attempt refused before the provider call has nothing on the chain to find,
    // and queueing an observation for it would have the worker hunting for a payment that was
    // never attempted — noise that teaches an operator to ignore the outbox.
    const store = new Store();
    store.importObligation({
      obligationId: OID,
      namespace: NAMESPACE,
      requestId: "01req-stranded",
      sourceFactsJson: "{}",
      sourceFactsHash: "h",
      paymentReference: "0x0056a1b2c3d4e5f6",
      now: 1,
    });
    const { attemptId } = store.openAttempt({
      obligationId: OID,
      planHash: PLAN,
      stepIndex: 0,
      idempotencyKey: "k-never-sent",
      endpoint: "execute/contract-call",
      bodyJson: "{}",
      now: 1,
    });

    store.recordOutcome(attemptId, { outcome: "REFUSED", now: 3 });

    assert.ok(
      !store.pendingJobKinds().includes("OBSERVE_EXECUTION"),
      "nothing was sent, so there is nothing to observe",
    );
    store.close();
  });
});
