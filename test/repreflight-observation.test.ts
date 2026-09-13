/**
 * A second preflight of the same plan needs its own observation.
 *
 * `beginPreflight` queues an `OBSERVE_PREFLIGHT` job whose dedupe key was the plan hash alone,
 * inserted with `INSERT OR IGNORE`. A retry after a failed dry run re-preflights the SAME plan —
 * that is what a retry is — so the second insert collided with the first job's key and was
 * silently dropped. The obligation then sat in `PAYMENT_PREFLIGHT` with nothing queued to look at
 * the chain and nothing able to release it: wedged permanently, at zero sends.
 *
 * Safe, and never recovered — the same shape as every liveness failure in this project. What has
 * to be deduped is two observations of the same attempt, not two attempts, so the key carries the
 * preflight's timestamp and the two places that retire it match on the plan-hash prefix.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { obligationId } from "../src/identity.ts";
import { NAMESPACE } from "../src/plan.ts";
import { Store } from "../src/store.ts";

const OID = obligationId(NAMESPACE, "01req-repreflight");
const PLAN = "d".repeat(64);

function approved(): Store {
  const store = new Store();
  store.importObligation({
    obligationId: OID,
    namespace: NAMESPACE,
    requestId: "01req-repreflight",
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

describe("re-preflighting the same plan queues a new observation", () => {
  test("the second preflight is observed, not silently dropped", () => {
    const store = approved();

    store.beginPreflight(OID, PLAN, 1_000, 11_700_000);
    assert.ok(store.pendingJobKinds().includes("OBSERVE_PREFLIGHT"));

    // The dry run failed. The observation runs, concludes nothing paid, and the obligation is
    // released — so the job is retired and the debt is payable again.
    store.endPreflight(PLAN);
    assert.ok(!store.pendingJobKinds().includes("OBSERVE_PREFLIGHT"), "the first observation is done");

    store.setState(OID, "SIMULATION_BLOCKED", 2_000);
    store.replan(OID, 2_000);
    store.setState(OID, "AWAITING_APPROVAL", 2_000);
    store.setState(OID, "APPROVED", 2_000);

    // The retry. Same plan hash, and this is where the job used to vanish.
    store.beginPreflight(OID, PLAN, 2_000, 11_700_100);
    assert.ok(
      store.pendingJobKinds().includes("OBSERVE_PREFLIGHT"),
      "the retry must be observable too, or it is wedged for ever at zero sends",
    );
    store.close();
  });

  test("ending the preflight still retires every observation for that plan", () => {
    // The property the dedupe key must not break: once the dry run has answered, nothing should
    // keep looking. Both preflights' jobs are closed by the plan-hash prefix.
    const store = approved();
    store.beginPreflight(OID, PLAN, 1_000, 11_700_000);
    store.endPreflight(PLAN);
    store.setState(OID, "SIMULATION_BLOCKED", 2_000);
    store.replan(OID, 2_000);
    store.setState(OID, "AWAITING_APPROVAL", 2_000);
    store.setState(OID, "APPROVED", 2_000);
    store.beginPreflight(OID, PLAN, 2_000, 11_700_100);

    store.endPreflight(PLAN);
    assert.ok(!store.pendingJobKinds().includes("OBSERVE_PREFLIGHT"));
    store.close();
  });
});
