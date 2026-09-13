/**
 * The door out, and what it refuses to open over.
 *
 * A dry run that never comes back leaves an obligation waiting until a spent nonce proves the leak
 * can never be mined. That is the right default — the thing it replaced was a timer, and a timer
 * released obligations whose payment was still sitting in the mempool. But a deployment with no
 * payer address configured can never make that proof, and "waits for a proof that cannot be made"
 * is a permanent wedge at zero payments. This project has fixed that exact shape four times in
 * other disguises, and introducing a fifth while fixing a duplicate payment would be a poor trade.
 *
 * So there is an operator path, and this pins what it is allowed to do. The operator's certainty
 * is not evidence: the chain is read first, and the two refusals below are the ones that matter —
 * a payment that is actually there, and a scan that could not see far enough to say. Both are
 * cases where a human saying "release it" would be authorising a second payment.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { operatorReleaseDecision } from "../src/exclusion.ts";

const conclusiveNegative = { found: false, truncated: false, conflictKinds: [] };

describe("an operator may release a wedged preflight, but not over a payment", () => {
  test("a conclusive negative on a waiting obligation releases", () => {
    const d = operatorReleaseDecision({ state: "PAYMENT_PREFLIGHT", sighting: conclusiveNegative });
    assert.equal(d.kind, "RELEASE");
  });

  test("a payment that is on chain refuses, and says which transaction", () => {
    // The operator asked to release an invoice that is already paid. Doing it authorises paying
    // it twice, and being certain does not change that.
    const d = operatorReleaseDecision({
      state: "PAYMENT_PREFLIGHT",
      sighting: { found: true, truncated: false,
    conflictKinds: [], txHash: "0xabc" },
    });
    assert.equal(d.kind, "REFUSE_PAID");
    assert.equal(d.kind === "REFUSE_PAID" ? d.txHash : undefined, "0xabc");
  });

  test("a payment found by a scan that could NOT see the whole window still refuses", () => {
    // Found is found. A short scan makes a negative worthless, never a positive.
    const d = operatorReleaseDecision({
      state: "PAYMENT_PREFLIGHT",
      sighting: { found: true, truncated: true, txHash: "0xabc" },
    });
    assert.equal(d.kind, "REFUSE_PAID");
  });

  test("a truncated scan refuses: it cannot say the invoice is unpaid", () => {
    const d = operatorReleaseDecision({ state: "PAYMENT_PREFLIGHT", sighting: { found: false, truncated: true } });
    assert.equal(d.kind, "REFUSE_INCONCLUSIVE");
  });

  test("a scan that does not state truncation refuses too", () => {
    // Undefined is a reader that did not say, and a reader that did not say is not one that said
    // no. This is the whole defect class in one line, so it is pinned in the one place a human
    // can override the machine.
    const d = operatorReleaseDecision({ state: "PAYMENT_PREFLIGHT", sighting: { found: false } });
    assert.equal(d.kind, "REFUSE_INCONCLUSIVE");
  });

  test("a log disagreeing about amount or fee refuses, even though nothing was 'found'", () => {
    // The worker escalates this shape to EVIDENCE_CONFLICT: a log paying this invoice's token and
    // payee but the wrong value is this deployment's own money moving in a plan nobody made. It
    // arrived here as a clean negative — `found` false, `truncated` false — and released, after
    // which resolve.ts wrote "no payment for this reference on chain" into the audit trail.
    const d = operatorReleaseDecision({
      state: "PAYMENT_PREFLIGHT",
      sighting: { found: false, truncated: false, conflictKinds: ["amount"] },
    });
    assert.equal(d.kind, "REFUSE_CONFLICT");
  });

  test("a conflict about the counterparty is somebody else's payment, and still releases", () => {
    // The control. A stranger paying a different payee under our public reference does not make
    // our invoice paid, and treating every conflict as ours would let one junk log wedge any
    // invoice for ever. This is the same split the worker draws, from the same function.
    const d = operatorReleaseDecision({
      state: "PAYMENT_PREFLIGHT",
      sighting: { found: false, truncated: false, conflictKinds: ["to", "amount"] },
    });
    assert.equal(d.kind, "RELEASE");
  });

  test("a sighting that never says what conflicting logs it saw has not concluded", () => {
    // `conflictKinds` absent used to take the same branch as `conflictKinds: []` — "no conflict"
    // — and released. Both readings are now distinct: a reader that concluded states the list,
    // even when it is empty, and one that did not leaves it off. Same shape as `truncated` and
    // `confirmations`, which cost this project three separate duplicate-payment findings.
    const d = operatorReleaseDecision({
      state: "PAYMENT_PREFLIGHT",
      sighting: { found: false, truncated: false },
    });
    assert.equal(d.kind, "REFUSE_INCONCLUSIVE");
  });

  test("an obligation that is not waiting on a dry run is refused by state", () => {
    for (const state of ["SETTLED", "PAYMENT_EXECUTING", "EVIDENCE_CONFLICT", "IMPORTED"]) {
      const d = operatorReleaseDecision({ state, sighting: conclusiveNegative });
      assert.equal(d.kind, "REFUSE_STATE", `${state} must not be releasable this way`);
    }
  });
});
