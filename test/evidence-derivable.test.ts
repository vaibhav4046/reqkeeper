/**
 * Every declared derivation still works, and the generators have not quietly dropped theirs.
 *
 * `verify:all` recomputes each summary number from the rows it summarises. Name-matching covers
 * the ones whose key names a row field; the rest are declared by the artifact itself in
 * `totalsFrom`, so that the checklist lives with the data rather than inside the verifier — the
 * arrangement where it lived inside the verifier is how `docs/refusals.json` came to disagree
 * with its own rows for weeks without anything noticing.
 *
 * A declaration is only worth having if it keeps working, and two things rot it:
 *
 *   1. A generator renames a row field. The spec then evaluates over a field nobody writes, and
 *      silently counts zero — a green tick produced by a broken rule, which is worse than no rule.
 *   2. A generator stops emitting `totalsFrom` at all. `verify:all` would report the numbers as
 *      "not recomputed" and still exit 0, because absent coverage is reported rather than failed.
 *
 * This catches both, on every commit, against the artifacts actually in the repository.
 *
 * It does NOT stop someone editing a committed artifact to delete a spec and a lie together. That
 * is detection rather than prevention: `verify:all` names every number it could not recompute, so
 * the deletion is visible in its output and in the diff, but the run still exits 0. Closing it
 * properly means failing on any undeclared total, which today would fail on three artifacts that
 * only a credentialed live run can regenerate. Stated here rather than papered over.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";

import { evaluateSpec, type TotalSpec } from "../src/totals.ts";

const ROWS_KEYS = ["rows", "cases", "checks", "records", "entries", "items"];

/** Artifacts produced by a credential-free command, so CI can always regenerate them. */
const FIXTURE_ARTIFACTS = [
  "docs/evidence/crash.json",
  "docs/evidence/race.json",
  "docs/evidence/verify.json",
  "docs/refusals.json",
];

function jsonFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...jsonFilesUnder(p));
    else if (entry.name.endsWith(".json")) out.push(p);
  }
  return out.sort();
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function rowsOf(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  const arrays = Object.entries(doc).filter((e): e is [string, unknown[]] => Array.isArray(e[1]));
  const preferred = arrays
    .filter(([n]) => ROWS_KEYS.includes(n))
    .sort((a, b) => ROWS_KEYS.indexOf(a[0]) - ROWS_KEYS.indexOf(b[0]))[0];
  const longest = arrays.filter(([, v]) => isRecord(v[0])).sort((a, b) => b[1].length - a[1].length)[0];
  return ((preferred ?? longest)?.[1] ?? []).filter(isRecord);
}

describe("the evidence artifacts keep their derivations honest", () => {
  test("every declared derivation evaluates and agrees with the total it explains", () => {
    const checked: string[] = [];
    for (const file of jsonFilesUnder("docs")) {
      let doc: unknown;
      try {
        doc = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      if (!isRecord(doc) || !isRecord(doc.totalsFrom)) continue;
      const summaryKey = ["totals", "summary"].find((k) => isRecord(doc[k]));
      assert.ok(summaryKey, `${file} declares totalsFrom but has no totals block to explain`);
      const summary = doc[summaryKey] as Record<string, unknown>;
      const rows = rowsOf(doc);

      for (const [key, rawSpec] of Object.entries(doc.totalsFrom)) {
        const stated = summary[key];
        assert.equal(typeof stated, "number", `${file}: totalsFrom.${key} explains a total that is not there`);

        const got = evaluateSpec(rawSpec as TotalSpec, doc, rows);
        // A spec that cannot evaluate is the rotted case: a renamed field makes it count nothing,
        // and nothing compares equal to zero often enough to be noticed.
        assert.ok(got, `${file}: totalsFrom.${key} could not be evaluated — a field it names is gone`);
        assert.equal(
          got.value,
          stated,
          `${file}: totals.${key} says ${stated}, its rows give ${got.value} (${got.how})`,
        );
        checked.push(`${file}:${key}`);
      }
    }
    // Not a magic threshold — that only pins how many derivations happened to exist the day it was
    // written. What matters is that every artifact CI can regenerate actually contributed one, so
    // the loop above cannot silently iterate over nothing.
    for (const file of FIXTURE_ARTIFACTS) {
      assert.ok(
        checked.some((c) => c.startsWith(`${file}:`)),
        `${file} contributed no evaluated derivation — the loop skipped it`,
      );
    }
  });

  test("a spec naming a field no row carries cannot be evaluated, and does not count zero", () => {
    // The tenth instance of this project's recurring defect, and it was inside the machinery built
    // to catch it. `undefined === "SETTLED"` is false for every row, so a spec whose field had
    // been renamed out from under it returned a count of ZERO — and agreed with any summary that
    // happened to state zero, while reporting itself as recomputed.
    const rows = [{ state: "SETTLED" }, { state: "SETTLED" }, { state: "OPEN" }];
    assert.equal(
      evaluateSpec({ count: true, where: { field: "finalState", equals: "SETTLED" } }, {}, rows),
      null,
      "a field nobody writes is 'I cannot tell', never a zero",
    );
    assert.equal(evaluateSpec({ sum: "noSuchNumber" }, {}, rows), null);
    assert.equal(evaluateSpec({ distinct: "noSuchField" }, {}, rows), null);

    // The field that IS there still evaluates, so this is not a blanket refusal.
    assert.deepEqual(
      evaluateSpec({ count: true, where: { field: "state", equals: "SETTLED" } }, {}, rows)?.value,
      2,
    );

    // `present` is the exception: "how many rows carry this field" over rows that carry none is a
    // real question whose answer is zero.
    assert.equal(evaluateSpec({ count: true, where: { field: "absent", present: true } }, {}, rows)?.value, 0);
  });

  test("the credential-free artifacts still declare their derivations", () => {
    // A generator that drops its totalsFrom block would leave verify:all reporting those numbers
    // as "not recomputed" — and still exiting 0, because absent coverage is reported rather than
    // failed. That is precisely the regression nothing else here would catch.
    for (const file of FIXTURE_ARTIFACTS) {
      const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      assert.ok(
        isRecord(doc.totalsFrom) && Object.keys(doc.totalsFrom).length > 0,
        `${file} no longer declares how its totals are derived; regenerate it and check its generator`,
      );
    }
  });
});
