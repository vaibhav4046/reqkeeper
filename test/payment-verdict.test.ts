/**
 * One verdict for the chain read, because five call sites each combined the same booleans a
 * different way and every combination was wrong somewhere.
 *
 * `PaymentSighting` carries `found`, `truncated`, `corroborated` and `conflicts`. Read directly,
 * they produced:
 *
 *   - `found === true` alone → a forged log paying somebody else read as settlement
 *   - `found === false` alone → "I could not look" read as "not paid"
 *   - `truncated !== true` → an absent flag read as a covered window
 *   - `found || truncated !== true` → the permissive inverse, on the hosted surface
 *   - conflicts discarded → a log paying the wrong amount read as no payment at all
 *
 * The dry-run path had the same shape and was fixed with a union and an exhaustive switch. That
 * fix was not carried across to the chain-read path, and every instance since has been found
 * there. `verdictFor` is the same repair applied to the same class in the place it survived.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { verdictFor, type PaymentSighting } from "../src/chain.ts";

const TX = `0x${"ab".repeat(32)}`;

describe("verdictFor turns a sighting into one of four answers", () => {
  test("a corroborated positive is PAID", () => {
    const v = verdictFor({ found: true, txHash: TX, corroborated: true }, { requireCorroboration: true });
    assert.equal(v.kind, "PAID");
    assert.equal(v.kind === "PAID" ? v.txHash : null, TX);
  });

  test("a positive no second endpoint could confirm is UNKNOWN, not PAID", () => {
    // The watcher read this as settlement and suppressed the invoice for ever. The primary
    // endpoint had already said no; one fallback said yes. That is a question, not an answer.
    const v = verdictFor({ found: true, txHash: TX, corroborated: false }, { requireCorroboration: true });
    assert.equal(v.kind, "UNKNOWN");
    assert.equal(v.kind === "UNKNOWN" ? v.reason : null, "UNCORROBORATED");
  });

  test("the same sighting is PAID for a caller only reporting what is on chain", () => {
    // Corroboration is required to SETTLE, not to describe. A read-only surface saying "a log
    // exists" is honest; the money paths pass requireCorroboration and get UNKNOWN.
    const v = verdictFor({ found: true, txHash: TX, corroborated: false });
    assert.equal(v.kind, "PAID");
  });

  test("a log that paid OUR payee for the wrong fee is CONFLICT_OURS, never NOT_PAID", () => {
    // The one that paid an invoice twice: same payee, same token, same amount, different FEE --
    // and the fee is chosen by the paying client. Dropping `conflicts` made it "no payment".
    const v = verdictFor({
      found: false,
      truncated: false,
      conflicts: ["0xdead: pays a fee of 1, the plan fee is 0"],
      conflictingLogs: [["fee"]],
      negativeCorroborations: 2,
    } as PaymentSighting);
    assert.equal(v.kind, "CONFLICT_OURS");
    assert.deepEqual(v.kind === "CONFLICT_OURS" ? v.conflictingLogs.map((l) => [...l]) : null, [["fee"]]);
  });

  test("a log that paid SOMEBODY ELSE is NOT_PAID, with the log reported alongside", () => {
    // The mirror, and it costs availability rather than money. Payment references are public --
    // they derive from data anchored openly -- so anyone who can read one can emit a log against
    // it. Treating any conflicting log as inconclusive let a stranger wedge an invoice for ever
    // with one junk transfer, while a log paying somebody else plainly is not payment of this
    // invoice. It is reported, because it is either an attack or a misconfiguration, and it is
    // not decisive.
    const v = verdictFor({
      found: false,
      truncated: false,
      conflicts: ["0xdead: pays 0xdeadbeef, not our payee"],
      conflictingLogs: [["to"]],
      negativeCorroborations: 2,
    } as PaymentSighting);
    assert.equal(v.kind, "NOT_PAID");
    assert.equal(v.kind === "NOT_PAID" ? v.conflicts?.length : null, 1);
  });

  test("a negative that never said what conflicting logs it saw is UNKNOWN", () => {
    // Absent is not empty. A reader that never populated `conflictingLogs` did not look, and this
    // exact sighting used to come back NOT_PAID from `verdictFor` while the worker and the
    // operator release both refused it -- one object, three readings, and the weakest of them
    // was the one guarding the money.
    const v = verdictFor({ found: false, truncated: false, negativeCorroborations: 2 });
    assert.equal(v.kind, "UNKNOWN");
    assert.equal(v.kind === "UNKNOWN" ? v.reason : null, "CONFLICTS_NOT_STATED");
  });

  test("a negative no second endpoint confirmed is UNKNOWN", () => {
    // publicnode returns an empty `eth_getLogs` for a fee-proxy log this project can point at on
    // chain, with no error. One endpoint's silence is not absence, and the already-paid gate is
    // the one place where believing it means paying an invoice a second time.
    const v = verdictFor({ found: false, truncated: false, conflictingLogs: [] });
    assert.equal(v.kind, "UNKNOWN");
    assert.equal(v.kind === "UNKNOWN" ? v.reason : null, "UNCORROBORATED");
  });

  test("a truncated negative is UNKNOWN", () => {
    const v = verdictFor({ found: false, truncated: true });
    assert.equal(v.kind, "UNKNOWN");
    assert.equal(v.kind === "UNKNOWN" ? v.reason : null, "TRUNCATED");
  });

  test("a negative that does not say whether it was truncated is UNKNOWN", () => {
    // Absent is not false. This is the assumption that has cost the most in this project.
    const v = verdictFor({ found: false });
    assert.equal(v.kind, "UNKNOWN");
    assert.equal(v.kind === "UNKNOWN" ? v.reason : null, "TRUNCATED");
  });

  test("only a covered window with nothing in it is NOT_PAID", () => {
    const v = verdictFor({ found: false, truncated: false,
    conflictingLogs: [],
    negativeCorroborations: 2, scannedFrom: 100, scannedTo: 200 });
    assert.equal(v.kind, "NOT_PAID");
  });

  test("no sighting at all is UNKNOWN, not NOT_PAID", () => {
    assert.equal(verdictFor(null).kind, "UNKNOWN");
    assert.equal(verdictFor(undefined).kind, "UNKNOWN");
  });

  test("every answer is one of exactly three kinds", () => {
    // The property the union exists for: a caller that switches on `kind` cannot silently fall
    // through into treating an unknown as a no, which is what a boolean let every caller do.
    const cases: Array<PaymentSighting | null> = [
      { found: true, txHash: TX, corroborated: true },
      { found: true, txHash: TX, corroborated: false },
      { found: false, truncated: false },
      { found: false, truncated: true },
      { found: false },
      { found: false, truncated: false,
    conflictingLogs: [],
    negativeCorroborations: 2, conflicts: ["x"] } as PaymentSighting,
      { found: false, truncated: false, conflictingLogs: [["amount"]], negativeCorroborations: 2 } as PaymentSighting,
      { found: false, truncated: false, negativeCorroborations: 2 },
      null,
    ];
    for (const c of cases) {
      assert.ok(
        ["PAID", "NOT_PAID", "CONFLICT_OURS", "UNKNOWN"].includes(verdictFor(c, { requireCorroboration: true }).kind),
      );
    }
  });
});

describe("one stranger's log cannot speak for ours", () => {
  /**
   * The sixteenth instance of the class, found by two independent reviewers on the same day.
   *
   * `conflictKinds` used to be one flat array accumulated across every log in the scan, and
   * `conflictVerdict` read it as though it described a single log:
   *
   *     wrongCounterparty = kinds.includes("to") || ...
   *     wrongValue        = kinds.includes("amount") || ...
   *     return wrongValue && !wrongCounterparty ? "OURS_AND_WRONG" : "NOT_OURS"
   *
   * A set cannot say which kind came from which log. So a log that really had paid OUR payee, in
   * OUR token, under our reference, for the wrong amount -- the #1959 leak executing with
   * different fields, the exact shape the escalation exists for -- was reclassified NOT_OURS the
   * moment any other log in the window contributed a `to`. NOT_OURS is the release answer: the
   * worker moves to PREFLIGHT_UNAVAILABLE and the debt is proposed and paid again.
   *
   * Payment references are public: they derive from data anchored openly on Sepolia, and this
   * codebase says so. So the masking log cost an attacker one unit of a testnet token.
   *
   * The repair is the shape. One entry per log, and "was ANY log ours and wrong" is answerable
   * again -- a flattened list cannot even be passed in.
   */
  const OURS_WRONG_AMOUNT = ["amount"] as const;
  const A_STRANGERS_LOG = ["to"] as const;

  test("a junk log paying somebody else does not downgrade our own money moving wrongly", () => {
    const v = verdictFor({
      found: false,
      truncated: false,
      negativeCorroborations: 2,
      conflicts: ["0xleak: pays 1 wei, the invoice is 1 FAU", "0xjunk: pays 0xdeadbeef, not our payee"],
      conflictingLogs: [[...OURS_WRONG_AMOUNT], [...A_STRANGERS_LOG]],
    } as PaymentSighting);
    assert.equal(v.kind, "CONFLICT_OURS", "a stranger's log masked our own");
  });

  test("order does not matter either", () => {
    const v = verdictFor({
      found: false,
      truncated: false,
      negativeCorroborations: 2,
      conflictingLogs: [[...A_STRANGERS_LOG], [...OURS_WRONG_AMOUNT]],
    } as PaymentSighting);
    assert.equal(v.kind, "CONFLICT_OURS");
  });

  test("and one log that is wrong about BOTH counterparty and value is still a stranger's", () => {
    // The control that stops the fix over-escalating. A log paying a different payee for a
    // different amount is somebody else's transfer, however many fields disagree -- and treating
    // every conflicting log as ours would let one junk transfer wedge any invoice for ever.
    const v = verdictFor({
      found: false,
      truncated: false,
      negativeCorroborations: 2,
      conflictingLogs: [["to", "amount"]],
    } as PaymentSighting);
    assert.equal(v.kind, "NOT_PAID");
  });

  test("many stranger logs stay NOT_PAID, however many there are", () => {
    const v = verdictFor({
      found: false,
      truncated: false,
      negativeCorroborations: 2,
      conflictingLogs: [["to"], ["token"], ["emitter"], ["to", "amount"]],
    } as PaymentSighting);
    assert.equal(v.kind, "NOT_PAID");
  });
});
