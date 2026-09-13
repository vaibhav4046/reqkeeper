/**
 * The third reader of a CONFLICT_OURS verdict consults the human's review like the other two.
 *
 * The propose gate and the operator release both clear a conflicting transaction a person has
 * read and named (`store.reviewedConflicts`). The worker's preflight observation read the same
 * verdict, never asked, and escalated a REVIEWED conflict into EVIDENCE_CONFLICT with zero jobs
 * owed -- a state the operator door refused on sight and re-proposal answered ALREADY_DISPATCHED.
 * A stranger's one-wei log plus one ordinary rate limit was a permanent wedge, and the trigger was
 * the system's own advice to call `resolve_pending`. Reproduced by a red-team pass in both
 * orderings: review before the worker ran, and after.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PaymentSighting } from "../src/chain.ts";
import { obligationId } from "../src/identity.ts";
import { NAMESPACE } from "../src/plan.ts";
import { Store } from "../src/store.ts";
import { drainOnce } from "../src/worker.ts";

const REQUEST_ID = "01worker-reviewed-conflict";
const OID = obligationId(NAMESPACE, REQUEST_ID);
const REFERENCE = "0x0056a1b2c3d4e5f6";
const JUNK_TX = `0x${"7b".repeat(32)}`;

/** Our payee, our token, our reference, one wei: CONFLICT_OURS by construction. */
const GRIEF: PaymentSighting = {
  found: false,
  truncated: false,
  negativeCorroborations: 2,
  conflicts: [`${JUNK_TX}: moves 1, the invoice is 1000000000000000000`],
  conflictingLogs: [{ txHash: JUNK_TX, kinds: ["amount"] }],
};

function waitingOnADryRun(): Store {
  const store = new Store();
  store.importObligation({
    obligationId: OID,
    namespace: NAMESPACE,
    requestId: REQUEST_ID,
    sourceFactsJson: JSON.stringify({
      invoiceBaseUnits: "1000000000000000000",
      payee: "0xc43d766CB7c48B9B198db87441b97c09e81717A1",
      tokenAddress: "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C",
      feeBaseUnits: "0",
      feeRecipient: `0x${"0".repeat(40)}`,
    }),
    sourceFactsHash: "h",
    paymentReference: REFERENCE,
    now: 1,
  });
  for (const s of ["VALIDATING", "AWAITING_APPROVAL", "APPROVED"] as const) store.setState(OID, s, 1);
  // A dry run that never came back: the observation job is what the worker will run.
  store.beginPreflight(OID, "f".repeat(64), 1, 11_691_000, undefined);
  return store;
}

async function observe(store: Store) {
  return drainOnce(
    {
      store,
      provider: { receipt: async (hash: string) => ({ hash, verified: false, receiptStatus: "not_found" as const, gasUsed: "0" }) },
      sourceSaysPaid: async () => false,
      sightPayment: async () => GRIEF,
    } as never,
    { now: 1_000_000, lookaheadMs: 60_000 },
  );
}

describe("a reviewed conflict does not escalate", () => {
  test("without a review, the worker escalates -- the control", async () => {
    const store = waitingOnADryRun();
    await observe(store);
    assert.equal(store.obligationForRecovery(OID)?.state, "EVIDENCE_CONFLICT");
    store.close();
  });

  test("with the transaction reviewed first, the worker leaves the obligation releasable", async () => {
    const store = waitingOnADryRun();
    store.recordConflictReview(OID, [JUNK_TX], "owner@reqkeeper.local");

    await observe(store);

    // Not escalated. With no payer configured the leak cannot be excluded either, so the honest
    // place for it is still PAYMENT_PREFLIGHT, where the operator door can reach it.
    assert.equal(store.obligationForRecovery(OID)?.state, "PAYMENT_PREFLIGHT");
    assert.ok(
      store.auditTrail(OID).some((r) => r.action === "CONFLICT_CLEARED_BY_REVIEW"),
      "the worker did not record that the review is what cleared the conflict",
    );
    store.close();
  });

  test("a review of a DIFFERENT transaction clears nothing", async () => {
    const store = waitingOnADryRun();
    store.recordConflictReview(OID, [`0x${"5c".repeat(32)}`], "owner@reqkeeper.local");
    await observe(store);
    assert.equal(store.obligationForRecovery(OID)?.state, "EVIDENCE_CONFLICT");
    store.close();
  });
});
