/**
 * A moved nonce only proves anything about the slot the leak actually took.
 *
 * The first version of this released an obligation whenever the payer's mined nonce had advanced
 * past the number read before the dry run. The argument sounded complete — a nonce is spent once,
 * so a slot mined by another transaction kills anything pending in it — and it was wrong about
 * WHICH slot.
 *
 * `eth_getTransactionCount(payer, "latest")` counts MINED transactions. A new broadcast takes the
 * PENDING slot. On an account with anything in flight those are different numbers, so the leak
 * lands above the baseline, and any one of the already-queued transactions mining moves the mined
 * count past the baseline while the leak is still perfectly mineable. The gate then declares it
 * dead and the debt is proposed again: one obligation, two physical payments.
 *
 * A reviewer put real numbers on it. Every settlement in this repository was relayed by one shared
 * address whose mined nonce went from 25786 to 30078 during this project, so on that account "the
 * nonce moved" is a near-certain automatic yes — the gate would have released essentially always.
 *
 * Two things are needed and neither is inferable, so both are asked for and their absence refuses:
 * the account must be one nothing else broadcasts from, and it must have had nothing queued when
 * the dry run ran, which is the only moment the next slot is knowable.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { excludeByNonce, payerIsDedicated } from "../src/exclusion.ts";

const PAYER = "0x809d8252aa4f9b8f7d9be7213855b289fe7d0444";

/** A reading with no queue: mined and pending agree, so the next broadcast's slot is known. */
const unqueued = (nonce: number, head: number) => ({ payer: PAYER, nonce, pending: nonce, head });

describe("a nonce proof needs the leak's own slot, not just movement", () => {
  test("THE EXPLOIT: a shared payer's nonce moving is not a proof", () => {
    // Mined 100, five queued, so a broadcast now takes slot 105. One of those five mines, the
    // mined count becomes 101, and the leak at 105 has not been touched.
    const d = excludeByNonce({
      reading: { payer: PAYER, nonce: 101, pending: 106, head: 5_010 },
      preflightNonce: 100,
      scannedTo: 5_010,
      payerConfigured: true,
      payerIsDedicated: false,
    });
    assert.equal(d.kind, "NOT_PROVEN", "a shared account's counter says nothing about our slot");
    assert.equal(d.kind === "NOT_PROVEN" ? d.code : "", "PAYER_NOT_DEDICATED");
  });

  test("even on a dedicated account, a nonce that has not moved proves nothing", () => {
    const d = excludeByNonce({
      reading: unqueued(100, 5_010),
      preflightNonce: 100,
      scannedTo: 5_010,
      payerConfigured: true,
      payerIsDedicated: true,
    });
    assert.equal(d.kind === "NOT_PROVEN" ? d.code : "", "NONCE_UNCHANGED");
  });

  test("a slot that could not be pinned down at preflight refuses", () => {
    // `null` is what settle records when the account had a queue: there is no baseline to compare
    // against, and inventing one is what the exploit above turns into money.
    const d = excludeByNonce({
      reading: unqueued(101, 5_010),
      preflightNonce: null,
      scannedTo: 5_010,
      payerConfigured: true,
      payerIsDedicated: true,
    });
    assert.equal(d.kind === "NOT_PROVEN" ? d.code : "", "NO_PREFLIGHT_NONCE");
  });

  test("a scan that stopped short of the proof refuses", () => {
    const d = excludeByNonce({
      reading: unqueued(101, 5_010),
      preflightNonce: 100,
      scannedTo: 5_000,
      payerConfigured: true,
      payerIsDedicated: true,
    });
    assert.equal(d.kind === "NOT_PROVEN" ? d.code : "", "SCAN_BEHIND_PROOF");
  });

  test("a dedicated account whose known slot was mined by something else releases", () => {
    // The control, and the only shape that is actually a proof: nothing else broadcasts from this
    // account, it had no queue when the dry run ran so the leak's slot was exactly 100, that slot
    // has since been mined, and the scan covered the block where that became true.
    const d = excludeByNonce({
      reading: unqueued(101, 5_010),
      preflightNonce: 100,
      scannedTo: 5_010,
      payerConfigured: true,
      payerIsDedicated: true,
    });
    assert.equal(d.kind, "NONCE_CONSUMED");
  });

  test("dedication is asserted, never assumed", () => {
    assert.equal(payerIsDedicated({}), false, "silence is not a yes");
    assert.equal(payerIsDedicated({ REQKEEPER_PAYER_IS_DEDICATED: "false" }), false);
    assert.equal(payerIsDedicated({ REQKEEPER_PAYER_IS_DEDICATED: "yes" }), false, "only an explicit true");
    assert.equal(payerIsDedicated({ REQKEEPER_PAYER_IS_DEDICATED: "TRUE" }), true);
  });
});
