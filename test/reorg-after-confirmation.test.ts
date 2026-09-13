/**
 * A confirmed transaction can stop being one, and the debt survives that.
 *
 * `RECONCILE_SOURCE` re-reads the chain deliberately: between the send and that job a transaction
 * can be reorged out or found reverted, and "the source says paid" against "the receipt says
 * reverted" must never produce SETTLED. The re-read was right. Both of its failure branches then
 * called `move()` into states the transition table did not allow from `CHAIN_CONFIRMED`, so the
 * move threw, the worker's catch-all deferred the job, and the obligation sat there for ever:
 *
 *   - never SETTLED, never refused
 *   - not replannable, so it could never be proposed again
 *   - no operator door, which only accepts PAYMENT_PREFLIGHT
 *   - no audit row, so nothing anywhere said why
 *
 * And the money had not moved, so the debt still stood. Nobody has to attack this; they wait for
 * it. A reviewer drove 25 drains and watched the state never change.
 *
 * Both branches are exits now. The reachability test in `test/liveness-and-flags.test.ts` could
 * not catch this: it proves the transition GRAPH has no dead ends, and this was a dead end in the
 * worker, which never took the edge the graph offered.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { obligationId } from "../src/identity.ts";
import { canTransition } from "../src/machine.ts";
import { NAMESPACE } from "../src/plan.ts";
import type { Receipt } from "../src/provider.ts";
import { Store } from "../src/store.ts";
import { drainUntilQuiet } from "../src/worker.ts";

const REQUEST_ID = "01reorg-after-confirmation";
const OID = obligationId(NAMESPACE, REQUEST_ID);
const REFERENCE = "0x0056a1b2c3d4e5f6";
const TX = `0x${"7e".repeat(32)}`;
const PLAN = "c".repeat(64);

/** An obligation that reached CHAIN_CONFIRMED, with the reconcile job still owed. */
function confirmed(): Store {
  const store = new Store();
  store.importObligation({
    obligationId: OID,
    namespace: NAMESPACE,
    requestId: REQUEST_ID,
    sourceFactsJson: "{}",
    sourceFactsHash: "h",
    paymentReference: REFERENCE,
    now: 1,
  });
  for (const state of ["VALIDATING", "AWAITING_APPROVAL", "APPROVED"] as const) store.setState(OID, state, 1);
  store.beginPreflight(OID, PLAN, 1, 11_000_000, 42);
  const { attemptId } = store.openAttempt({
    obligationId: OID,
    planHash: PLAN,
    stepIndex: 0,
    idempotencyKey: "key-reorg",
    endpoint: "https://fixture.invalid/execute",
    bodyJson: "{}",
    now: 1,
  });
  store.markSent(attemptId, 1);
  store.setState(OID, "PAYMENT_EXECUTING", 1);
  store.recordOutcome(attemptId, { outcome: "SENT", txHash: TX, now: 1 });
  store.setState(OID, "CHAIN_PENDING", 1);
  store.setState(OID, "CHAIN_CONFIRMED", 1);
  store.enqueue({
    kind: "RECONCILE_SOURCE",
    dedupeKey: `reconcile:${PLAN}`,
    obligationId: OID,
    attemptId,
    dueAt: 1,
  });
  return store;
}

function drain(store: Store, receipt: Receipt) {
  return drainUntilQuiet(
    {
      store,
      provider: { receipt: async () => receipt },
      sourceSaysPaid: async () => true,
      sightPayment: async () => ({ found: false, truncated: false, conflictingLogs: [], negativeCorroborations: 2 }),
    },
    { now: 2_000_000, maxPasses: 5, lookaheadMs: 120_000 },
  );
}

describe("a confirmation that stops being true reaches a human", () => {
  test("the transition table allows what the worker actually does", () => {
    // The root cause, asserted directly: the worker called these and the machine refused them,
    // so the failure was an exception swallowed by a catch-all rather than a decision.
    assert.equal(canTransition("CHAIN_CONFIRMED", "EVIDENCE_CONFLICT"), true);
    assert.equal(canTransition("CHAIN_CONFIRMED", "EXECUTION_REVERTED"), true);
  });

  test("a transaction that reverted after confirmation ends in EXECUTION_REVERTED", async () => {
    const store = confirmed();
    await drain(store, { hash: TX, verified: true, receiptStatus: "reverted", gasUsed: "21000" } as Receipt);
    const state = store.getObligation(OID)?.state;
    assert.equal(state, "EXECUTION_REVERTED", `it stopped at ${state}`);
    store.close();
  });

  test("a transaction that is GONE ends in EVIDENCE_CONFLICT, with the reason recorded", async () => {
    // `not_found` for a transaction this obligation had already confirmed is a reorg, not a
    // pending answer -- and re-asking for ever is how an obligation waits on an answer that will
    // never come.
    const store = confirmed();
    await drain(store, { hash: TX, verified: false, receiptStatus: "not_found", gasUsed: "0" } as Receipt);
    assert.equal(store.getObligation(OID)?.state, "EVIDENCE_CONFLICT");
    assert.ok(
      store.auditTrail(OID).some((r) => r.action === "CONFIRMED_TRANSACTION_VANISHED"),
      "an obligation that loses its transaction must say so in the audit trail, not just stop",
    );
    store.close();
  });

  test("neither leaves the job owed for ever", async () => {
    // The shape of the bug was an infinite defer with no cap, so the absence of pending work is
    // the property, not the state name.
    for (const receipt of [
      { hash: TX, verified: true, receiptStatus: "reverted", gasUsed: "21000" },
      { hash: TX, verified: false, receiptStatus: "not_found", gasUsed: "0" },
    ] as Receipt[]) {
      const store = confirmed();
      await drain(store, receipt);
      assert.equal(store.pendingJobCount(), 0, `${receipt.receiptStatus} left work owed for ever`);
      store.close();
    }
  });

  test("a receipt that is merely not deep enough still waits, because that one does resolve", async () => {
    // The control. Turning every unfinished read into an incident would be the opposite failure:
    // a transaction one block deep is not a reorg, it is a transaction one block deep.
    const store = confirmed();
    await drain(store, { hash: TX, verified: true, receiptStatus: "success", gasUsed: "21000", confirmations: 0 } as Receipt);
    assert.notEqual(store.getObligation(OID)?.state, "EVIDENCE_CONFLICT");
    store.close();
  });
});
