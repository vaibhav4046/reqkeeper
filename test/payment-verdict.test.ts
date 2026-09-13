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

describe("verdictFor turns a sighting into one of three answers", () => {
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

  test("a negative carrying conflicts is UNKNOWN, never NOT_PAID", () => {
    // The one that paid an invoice twice: same payee, same token, same amount, different FEE --
    // and the fee is chosen by the paying client. Dropping `conflicts` made it "no payment".
    const v = verdictFor({
      found: false,
      truncated: false,
      conflicts: ["0xdead: pays a fee of 1, the plan fee is 0"],
      conflictKinds: ["fee"],
    } as PaymentSighting);
    assert.equal(v.kind, "UNKNOWN");
    assert.equal(v.kind === "UNKNOWN" ? v.reason : null, "CONFLICTS");
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
    const v = verdictFor({ found: false, truncated: false, scannedFrom: 100, scannedTo: 200 });
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
      { found: false, truncated: false, conflicts: ["x"] } as PaymentSighting,
      null,
    ];
    for (const c of cases) {
      assert.ok(["PAID", "NOT_PAID", "UNKNOWN"].includes(verdictFor(c, { requireCorroboration: true }).kind));
    }
  });
});
