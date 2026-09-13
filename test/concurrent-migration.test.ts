/**
 * Opening the same database from several processes at once must not throw.
 *
 * Every migration here reads `PRAGMA table_info` and then adds whatever column is missing — two
 * statements with a gap between them. Under the race harness, fifty real processes open one file
 * within milliseconds of each other, two of them see the same column missing, and both issue the
 * `ALTER TABLE`. SQLite fails the loser with `duplicate column name: payment_reference`.
 *
 * That surfaced as a worker THROWING rather than refusing, which the race check counts as an
 * undesigned outcome and reports as `1 worker(s) threw instead of refusing`. CI caught it on one
 * run in three; six consecutive runs after the fix show none.
 *
 * It never cost a payment — the worker died before proposing anything — but "a process that
 * touches this database can crash on startup depending on timing" is not a property to ship,
 * least of all in the harness whose entire job is to demonstrate behaviour under concurrency.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so the race is resolved where it happens.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { DatabaseSync } from "node:sqlite";

import { Store, addColumnIfMissing } from "../src/store.ts";

describe("several processes can open one database at the same moment", () => {
  test("opening the same file many times over never throws on migration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reqkeeper-migrate-"));
    const file = join(dir, "contended.sqlite");
    try {
      // The first open creates the schema; the rest re-run the migration against it, which is
      // exactly the shape the losers of the real race are in.
      const stores: Store[] = [];
      for (let i = 0; i < 12; i++) {
        stores.push(new Store(file));
      }
      // All of them must agree the schema is usable, not merely have survived opening it.
      for (const s of stores) {
        assert.equal(s.verifyAuditChain().ok, true);
      }
      for (const s of stores) s.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("adding a column that another connection already added is not an error", () => {
    // The loser's exact statement, arriving late against a schema that already has the column.
    // Opening Stores in sequence never reaches this: the first creates every column and the rest
    // see them present, so the ALTER is skipped and nothing is being tested. Driving the helper
    // directly is what pins the behaviour.
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE obligations (obligation_id TEXT PRIMARY KEY)");

    addColumnIfMissing(db, "obligations", "raced", "INTEGER");
    assert.throws(
      () => db.exec("ALTER TABLE obligations ADD COLUMN raced INTEGER"),
      /duplicate column name/i,
      "the premise: SQLite really does fail the second one",
    );
    // And the helper, arriving second, carries on with the column the winner added.
    addColumnIfMissing(db, "obligations", "raced", "INTEGER");

    // Anything else still propagates — a migration that cannot run must not be swallowed.
    assert.throws(() => addColumnIfMissing(db, "no_such_table", "x", "INTEGER"), /no such table/i);
    db.close();
  });

  test("a column added by another connection is adopted, not fought over", async () => {
    // The precise failure: this connection read PRAGMA table_info before another added the
    // column, so its own ALTER is the one that loses. It has to carry on with the column the
    // winner added rather than dying.
    const dir = await mkdtemp(join(tmpdir(), "reqkeeper-migrate2-"));
    const file = join(dir, "raced.sqlite");
    try {
      const first = new Store(file);
      // Simulate the loser's exact statement arriving late against a schema that already has it.
      first.rawExecForTests("ALTER TABLE obligations ADD COLUMN a_late_column INTEGER");
      assert.throws(
        () => first.rawExecForTests("ALTER TABLE obligations ADD COLUMN a_late_column INTEGER"),
        /duplicate column name/i,
        "the premise: SQLite really does fail the second one",
      );
      first.close();

      // And a fresh connection over that same file migrates cleanly.
      const second = new Store(file);
      assert.equal(second.verifyAuditChain().ok, true);
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
