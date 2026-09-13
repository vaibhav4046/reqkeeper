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
