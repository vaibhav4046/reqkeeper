/**
 * A hash chain proves what it still contains, and nothing about its own length.
 *
 * `verifyAuditChain` walked the rows, checked each `prev_hash` against the previous `row_hash`,
 * and recomputed each row's hash from its contents. That catches an edited row and a row removed
 * from the middle. It does not catch truncation: delete the last three rows and every remaining
 * link is intact, so the check returned `ok: true` on a log somebody had cut the end off — and
 * the end is where a settlement's evidence lives.
 *
 * The fix is that something outside the chain remembers where the end was. `audit_head` records
 * the tip hash and the row count in the same transaction as the append, so a shortened log
 * disagrees with it on both.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../src/store.ts";

function withRows(n: number): Store {
  const store = new Store();
  for (let i = 0; i < n; i++) {
    store.audit(`01obligation-${i}`, "system", "PROPOSED", { i });
  }
  return store;
}

/** The only way to do this is behind the API, which is the point: it models a tampered file. */
function deleteLastRows(store: Store, n: number): void {
  store.rawExecForTests(`DELETE FROM audit WHERE id IN (SELECT id FROM audit ORDER BY id DESC LIMIT ${n})`);
}

/** Deleting the tip record is one more statement at the same privilege as deleting rows. */
function deleteHead(store: Store): void {
  store.rawExecForTests("DELETE FROM audit_head");
}

describe("the tip record cannot be deleted to hide a truncation", () => {
  // The chain is only evidence of what it still contains, so the tip is recorded separately and
  // checked against it. That check was written as `if (head && ...)`: no head, no check. An
  // attacker who can DELETE audit rows can DELETE FROM audit_head in the same transaction, at the
  // same privilege, and the log then verified clean over whatever was left.
  //
  // Absence read as "nothing to check" — the same defect as the duplicate-payment class, aimed at
  // the audit trail. The lenient branch existed for databases whose rows predated the table, so
  // the fix is to remove that legitimate case: the migration backfills the tip, and after that a
  // missing head with rows present can only be tampering.

  test("truncating the log AND deleting the head is caught", () => {
    const store = withRows(6);
    deleteLastRows(store, 3);
    deleteHead(store);
    const v = store.verifyAuditChain();
    assert.equal(v.ok, false, "deleting the tip record must not launder a truncation");
    assert.equal(v.rows, 3);
    store.close();
  });

  test("emptying the log AND deleting the head is caught by the obligations that remain", () => {
    // Inside the audit tables this is indistinguishable from a fresh database — there is no link
    // left to break. The contradiction is with the rest of the file: these obligations exist, and
    // an obligation exists only because it was proposed, which writes a row.
    const store = new Store();
    store.importObligation({
      obligationId: "0".repeat(64),
      namespace: "reqkeeper",
      requestId: "01req-erased",
      sourceFactsJson: "{}",
      sourceFactsHash: "h",
      paymentReference: "0x0056a1b2c3d4e5f6",
      now: 1,
    });
    store.audit("0".repeat(64), "agent", "PROPOSED", {});
    store.rawExecForTests("DELETE FROM audit");
    deleteHead(store);

    const v = store.verifyAuditChain();
    assert.equal(v.ok, false, "an erased log is not a clean log while its obligations are still here");
    assert.match(v.reason ?? "", /erased/);
    store.close();
  });

  test("deleting the head alone, leaving every row, is caught", () => {
    const store = withRows(6);
    deleteHead(store);
    const v = store.verifyAuditChain();
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /head is missing/);
    store.close();
  });

  test("a database whose rows predate the tip table is backfilled, not accused", async () => {
    // The reason the missing-head check is safe to make strict. A file written before audit_head
    // existed has rows and no tip; without the backfill, opening it would report tampering on an
    // honest database, and the pressure would be to make the check lenient again — which is the
    // hole. Nothing pinned this until a mutation run showed the backfill could be deleted with
    // every test still green.
    const dir = await mkdtemp(join(tmpdir(), "reqkeeper-audit-"));
    const file = join(dir, "legacy.sqlite");
    try {
      const first = new Store(file);
      for (let i = 0; i < 4; i++) first.audit(`01obligation-${i}`, "system", "PROPOSED", { i });
      // Make it look like a file from before the table existed.
      first.rawExecForTests("DROP TABLE audit_head");
      first.close();

      const reopened = new Store(file);
      const v = reopened.verifyAuditChain();
      assert.equal(v.ok, true, `an honest legacy file must verify, and said: ${v.reason}`);
      assert.equal(v.rows, 4);

      // And the backfilled tip is a real tip: truncation is caught from here on.
      reopened.rawExecForTests("DELETE FROM audit WHERE id = (SELECT MAX(id) FROM audit)");
      assert.equal(reopened.verifyAuditChain().ok, false, "the backfilled tip must actually protect");
      reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a fresh database with no rows and no head still verifies", () => {
    // The control. A store that has never written an audit row has nothing to be missing, and
    // failing it would make the check useless on first run.
    const store = new Store();
    assert.equal(store.verifyAuditChain().ok, true);
    store.close();
  });
});

describe("the audit log cannot be shortened without saying so", () => {
  test("an intact log verifies", () => {
    const store = withRows(6);
    const v = store.verifyAuditChain();
    assert.equal(v.ok, true);
    assert.equal(v.rows, 6);
    store.close();
  });

  test("deleting the last three rows is caught", () => {
    const store = withRows(6);
    deleteLastRows(store, 3);

    const v = store.verifyAuditChain();
    assert.equal(v.ok, false, "every remaining link is intact, which is exactly why this needed a tip");
    assert.match(v.reason ?? "", /removed from the end/);
    store.close();
  });

  test("deleting the last row alone is caught", () => {
    const store = withRows(4);
    deleteLastRows(store, 1);
    assert.equal(store.verifyAuditChain().ok, false);
    store.close();
  });

  test("emptying the log entirely is caught", () => {
    const store = withRows(3);
    deleteLastRows(store, 3);
    const v = store.verifyAuditChain();
    assert.equal(v.ok, false, "an empty log with a recorded tip is the most complete tampering, not the least");
    store.close();
  });

  test("a row edited in the middle is still caught", () => {
    // The property that already worked, kept: adding the tip must not replace the link check.
    const store = withRows(5);
    store.rawExecForTests("UPDATE audit SET actor = 'tampered' WHERE id = (SELECT MIN(id) FROM audit)");
    const v = store.verifyAuditChain();
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /contents were edited/);
    store.close();
  });
});
