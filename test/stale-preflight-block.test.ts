/**
 * A preflight block from a DIFFERENT attempt is worse than none.
 *
 * `beginPreflight` records the chain head before the risky call so the recovery path can tell a
 * leak still in the mempool from a send that never happened. It wrote that column only when it
 * had a value: "a head we could not read is left undefined, which keeps the observer
 * inconclusive."
 *
 * That sentence was true exactly once per obligation. An obligation that preflighted at a high
 * block, failed, and preflighted again later when the head read was rate-limited kept the FIRST
 * preflight's number. A stale block is always far enough behind the current head that the age
 * gate opens immediately — so the observer concluded "nothing was broadcast" about an attempt it
 * had no reading for at all, released, and the next proposal paid the invoice a second time.
 *
 * The fix is that the column is written unconditionally, NULL included. Unknown has to be
 * recorded as unknown; leaving the previous answer in place is not the same thing.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { obligationId } from "../src/identity.ts";
import { NAMESPACE } from "../src/plan.ts";
import { Store } from "../src/store.ts";

const OID = obligationId(NAMESPACE, "01req-stale-preflight");
const PLAN_A = "a".repeat(64);
const PLAN_B = "b".repeat(64);

/** Walked through the real state machine, because beginPreflight asserts its own transition. */
function approved(): Store {
  const store = new Store();
  store.importObligation({
    obligationId: OID,
    namespace: NAMESPACE,
    requestId: "01req-stale-preflight",
    sourceFactsJson: "{}",
    sourceFactsHash: "h",
    paymentReference: "0x0056a1b2c3d4e5f6",
    now: 1,
  });
  store.setState(OID, "VALIDATING", 1);
  store.setState(OID, "AWAITING_APPROVAL", 1);
  store.setState(OID, "APPROVED", 1);
  return store;
}

/** Back to a state a second preflight can legally start from, the way a real retry gets there. */
function backToApproved(store: Store): void {
  // SIMULATION_BLOCKED is replannable, and `replan` is the route a released obligation really
  // takes back to the start — the same route a retry after a failed dry run takes.
  store.setState(OID, "SIMULATION_BLOCKED", 2);
  store.replan(OID, 2);
  store.setState(OID, "AWAITING_APPROVAL", 2);
  store.setState(OID, "APPROVED", 2);
}

describe("a head that could not be read is recorded as unknown, not left stale", () => {
  test("a later preflight with no head clears the previous one", () => {
    const store = approved();

    store.beginPreflight(OID, PLAN_A, 1, 11_700_000);
    assert.equal(store.obligationForRecovery(OID)?.preflightBlock, 11_700_000);

    // Hours later. The head read is rate-limited, so settle passes undefined.
    backToApproved(store);
    store.beginPreflight(OID, PLAN_B, 2, undefined);

    assert.equal(
      store.obligationForRecovery(OID)?.preflightBlock,
      null,
      "the first attempt's block must not describe the second: stale reads as old, and old opens the age gate",
    );
    store.close();
  });

  test("a later preflight with a head replaces the previous one", () => {
    const store = approved();
    store.beginPreflight(OID, PLAN_A, 1, 11_700_000);
    backToApproved(store);
    store.beginPreflight(OID, PLAN_B, 2, 11_800_000);
    assert.equal(store.obligationForRecovery(OID)?.preflightBlock, 11_800_000);
    store.close();
  });

  test("an obligation that never preflighted has no block", () => {
    const store = approved();
    assert.equal(store.obligationForRecovery(OID)?.preflightBlock, null);
    store.close();
  });
});
