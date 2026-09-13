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

import { operatorReleaseDecision, type LeakExclusion } from "../src/exclusion.ts";

const conclusiveNegative = { found: false, truncated: false, conflictingLogs: [], negativeCorroborations: 2 };

/**
 * The leak is proven dead: another transaction is mined at the nonce the dry run would have used.
 *
 * Supplied to every case below that is about the SIGHTING, so the sighting is what decides them.
 * The cases about the leak itself pass `notProven` instead.
 */
const proven: LeakExclusion = {
  kind: "NONCE_CONSUMED",
  payer: "0x00000000000000000000000000000000000ce111",
  preflightNonce: 42,
  observedNonce: 43,
  provenThroughBlock: 11_000_010,
};
const notProven: LeakExclusion = {
  kind: "NOT_PROVEN",
  code: "PAYER_NOT_DEDICATED",
  detail: "the payer account is shared, so a moved nonce proves nothing about this transaction",
};

describe("an operator may release a wedged preflight, but not over a payment", () => {
  test("a conclusive negative on a waiting obligation releases", () => {
    const d = operatorReleaseDecision({ state: "PAYMENT_PREFLIGHT", exclusion: proven, sighting: conclusiveNegative });
    assert.equal(d.kind, "RELEASE");
  });

  test("a payment that is on chain refuses, and says which transaction", () => {
    // The operator asked to release an invoice that is already paid. Doing it authorises paying
    // it twice, and being certain does not change that.
    const d = operatorReleaseDecision({
      state: "PAYMENT_PREFLIGHT",
      exclusion: proven,
      sighting: { found: true, truncated: false,
    conflictingLogs: [],
    negativeCorroborations: 2, txHash: "0xabc" },
    });
    assert.equal(d.kind, "REFUSE_PAID");
    assert.equal(d.kind === "REFUSE_PAID" ? d.txHash : undefined, "0xabc");
  });

  test("a payment found by a scan that could NOT see the whole window still refuses", () => {
    // Found is found. A short scan makes a negative worthless, never a positive.
    const d = operatorReleaseDecision({
      state: "PAYMENT_PREFLIGHT",
      exclusion: proven,
      sighting: { found: true, truncated: true, txHash: "0xabc" },
    });
    assert.equal(d.kind, "REFUSE_PAID");
  });

  test("a truncated scan refuses: it cannot say the invoice is unpaid", () => {
    const d = operatorReleaseDecision({ state: "PAYMENT_PREFLIGHT", exclusion: proven, sighting: { found: false, truncated: true } });
    assert.equal(d.kind, "REFUSE_INCONCLUSIVE");
  });

  test("a scan that does not state truncation refuses too", () => {
    // Undefined is a reader that did not say, and a reader that did not say is not one that said
    // no. This is the whole defect class in one line, so it is pinned in the one place a human
    // can override the machine.
    const d = operatorReleaseDecision({ state: "PAYMENT_PREFLIGHT", exclusion: proven, sighting: { found: false } });
    assert.equal(d.kind, "REFUSE_INCONCLUSIVE");
  });

  test("a log disagreeing about amount or fee refuses, even though nothing was 'found'", () => {
    // The worker escalates this shape to EVIDENCE_CONFLICT: a log paying this invoice's token and
    // payee but the wrong value is this deployment's own money moving in a plan nobody made. It
    // arrived here as a clean negative — `found` false, `truncated` false — and released, after
    // which resolve.ts wrote "no payment for this reference on chain" into the audit trail.
    const d = operatorReleaseDecision({
      state: "PAYMENT_PREFLIGHT",
      exclusion: proven,
      sighting: { found: false, truncated: false, conflictingLogs: [["amount"]] },
    });
    assert.equal(d.kind, "REFUSE_CONFLICT");
  });

  test("a conflict about the counterparty is somebody else's payment, and still releases", () => {
    // The control. A stranger paying a different payee under our public reference does not make
    // our invoice paid, and treating every conflict as ours would let one junk log wedge any
    // invoice for ever. This is the same split the worker draws, from the same function.
    const d = operatorReleaseDecision({
      state: "PAYMENT_PREFLIGHT",
      exclusion: proven,
      sighting: { found: false, truncated: false, conflictingLogs: [["to", "amount"]], negativeCorroborations: 2 },
    });
    assert.equal(d.kind, "RELEASE");
  });

  test("a sighting that never says what conflicting logs it saw has not concluded", () => {
    // `conflictingLogs` absent used to take the same branch as `conflictingLogs: []` — "no conflict"
    // — and released. Both readings are now distinct: a reader that concluded states the list,
    // even when it is empty, and one that did not leaves it off. Same shape as `truncated` and
    // `confirmations`, which cost this project three separate duplicate-payment findings.
    const d = operatorReleaseDecision({
      state: "PAYMENT_PREFLIGHT",
      exclusion: proven,
      sighting: { found: false, truncated: false },
    });
    assert.equal(d.kind, "REFUSE_INCONCLUSIVE");
  });

  test("a negative only one endpoint returned is not evidence of absence", () => {
    // publicnode has been observed returning an empty log query for a fee-proxy payment that
    // demonstrably exists and that other endpoints return, with no error — which is why a negative
    // is re-asked at all. What was never recorded is whether anyone ANSWERED: "two fallbacks
    // agreed" and "both fallbacks' sockets were destroyed" came back byte-identical, so silence
    // authorised a payment.
    const d = operatorReleaseDecision({
      state: "PAYMENT_PREFLIGHT",
      exclusion: proven,
      sighting: { found: false, truncated: false, conflictingLogs: [], negativeCorroborations: 0 },
    });
    assert.equal(d.kind, "REFUSE_UNCORROBORATED");

    // And an absent count is not a zero that happens to be safe — it is a reader that did not say.
    assert.equal(
      operatorReleaseDecision({
        state: "PAYMENT_PREFLIGHT",
        exclusion: proven,
        sighting: { found: false, truncated: false, conflictingLogs: [] },
      }).kind,
      "REFUSE_UNCORROBORATED",
    );
  });

  test("an obligation that is not waiting on a dry run is refused by state", () => {
    for (const state of ["SETTLED", "PAYMENT_EXECUTING", "EVIDENCE_CONFLICT", "IMPORTED"]) {
      const d = operatorReleaseDecision({ state, exclusion: proven, sighting: conclusiveNegative });
      assert.equal(d.kind, "REFUSE_STATE", `${state} must not be releasable this way`);
    }
  });
});

describe("a scan cannot see the mempool, and the door has to say so", () => {
  /**
   * The finding this suite existed to prevent, found in this suite's own subject.
   *
   * The worker will not release on a clean chain negative alone: `eth_getLogs` reads blocks, a
   * leaked dry run sitting unmined is in no block, and a transaction can sit pending with no
   * bound at all. So it demands a spent nonce as well. This door applied only the first half --
   * and on a deployment whose payer is KeeperHub's shared relayer the nonce proof can never be
   * made, so the automatic path never releases and this door is the ONLY exit. The stricter test
   * was therefore never applied to anything.
   *
   * The sequence it costs: a dry run executes and the reply is lost, the leak sits in the
   * mempool, an operator runs the documented line, the scan truthfully reports no payment, the
   * obligation is released and paid again, and then the leak mines. Two physical payments on one
   * human approval.
   */
  test("a clean negative does NOT release while the leak is unexcluded", () => {
    const d = operatorReleaseDecision({
      state: "PAYMENT_PREFLIGHT",
      exclusion: notProven,
      sighting: conclusiveNegative,
    });
    assert.equal(d.kind, "REFUSE_LEAK_NOT_EXCLUDED");
    assert.equal(d.kind === "REFUSE_LEAK_NOT_EXCLUDED" ? d.code : null, "PAYER_NOT_DEDICATED");
  });

  test("a named human may take that risk explicitly, and only explicitly", () => {
    // The alternative to this is wedging the obligation for ever, because nobody can prove a
    // transaction will never be mined. So the risk is transferable -- to a person, by name, in
    // writing -- and never assumed. `false` and absent both refuse.
    const base = { state: "PAYMENT_PREFLIGHT", exclusion: notProven, sighting: conclusiveNegative } as const;
    assert.equal(operatorReleaseDecision({ ...base, acknowledgedMempoolRisk: true }).kind, "RELEASE");
    assert.equal(operatorReleaseDecision({ ...base, acknowledgedMempoolRisk: false }).kind, "REFUSE_LEAK_NOT_EXCLUDED");
    assert.equal(operatorReleaseDecision(base).kind, "REFUSE_LEAK_NOT_EXCLUDED");
  });

  test("the acknowledgement buys nothing else: a payment on chain still refuses", () => {
    // It is permission to accept an UNPROVABLE risk, not permission to ignore evidence. Every
    // other refusal outranks it.
    const paid = { found: true, truncated: false, conflictingLogs: [], negativeCorroborations: 2, txHash: "0xabc" };
    for (const sighting of [paid, { found: false, truncated: true }, { found: false, truncated: false, conflictingLogs: [["fee" as const]], negativeCorroborations: 2 }]) {
      const d = operatorReleaseDecision({
        state: "PAYMENT_PREFLIGHT",
        exclusion: notProven,
        sighting,
        acknowledgedMempoolRisk: true,
      });
      assert.notEqual(d.kind, "RELEASE", `acknowledging the mempool risk released on ${JSON.stringify(sighting)}`);
    }
  });

  test("and when the nonce IS spent, no acknowledgement is asked for", () => {
    // The machine proves it whenever it can. Asking a human to accept a risk that has already
    // been excluded teaches them to click through the ones that have not.
    const d = operatorReleaseDecision({ state: "PAYMENT_PREFLIGHT", exclusion: proven, sighting: conclusiveNegative });
    assert.equal(d.kind, "RELEASE");
  });
});
