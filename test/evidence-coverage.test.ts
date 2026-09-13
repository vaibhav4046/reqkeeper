/**
 * Two properties that were claimed in prose and checked nowhere.
 *
 * 1. A refusal artifact's summary says what its own rows say. `docs/refusals.json` stated
 *    `refusedBeforeAnyProviderWrite: 18` while nineteen of its rows carried
 *    `refused_before_provider_write: true`, and the identically named field in the sibling
 *    artifact `docs/refusals-live.json` IS the plain count of rows carrying that flag —
 *    including its own "no human decision recorded" row (L081), the live twin of the fixture
 *    row (C12) the fixture total left out. One field name, two arithmetics, and the number the
 *    README points a reader at was the smaller one.
 *
 *    `npm run verify:all` now recomputes this over every artifact under `docs/`, but that runs
 *    after `npm run harness` in CI and the harness REWRITES this file. Pinning it here fails on
 *    `npm test` instead, next to the generator that produces it.
 *
 * 2. `scripts/verify-seam.ts` cannot reach a live KeeperHub execute route. It used to POST
 *    finished calldata to four of them, gated on nothing but the API key being present, while
 *    `src/provider.ts:12-15` records that `simulate: true` is ignored on exactly those routes
 *    and the transaction really executes (#1959/#1929). README:126 says nothing named
 *    `verify:*` can spend; this is that sentence, as a test.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const ROOT = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");

interface RefusalArtifact {
  totals: { refusedBeforeAnyProviderWrite: number };
  rows: Array<{ case_id: string; refused_before_provider_write: boolean }>;
}

describe("a refusal artifact's summary matches its own rows", () => {
  for (const file of ["docs/refusals.json", "docs/refusals-live.json"]) {
    test(`${file} states the number of rows that actually refused before a provider write`, () => {
      const artifact = JSON.parse(read(file)) as RefusalArtifact;
      const refusedInRows = artifact.rows.filter((r) => r.refused_before_provider_write === true);
      assert.equal(
        artifact.totals.refusedBeforeAnyProviderWrite,
        refusedInRows.length,
        `${file}: the summary says ${artifact.totals.refusedBeforeAnyProviderWrite}, the rows say ${refusedInRows.length}` +
          ` (${refusedInRows.map((r) => r.case_id).join(", ")}).` +
          " If this is docs/refusals.json and it says 18, the generator put it back: scripts/harness.ts:326" +
          " drops `expected === \"AWAITING_APPROVAL\"` from the refusal universe, so C12 (0 sends, flag true)" +
          " falls out of both totals. docs/refusals-live.json keeps its identical row (L081) in both. Fix the" +
          " filter, not this file — a hand-edited artifact is overwritten by the next `npm run harness`.",
      );
    });
  }
});

describe("scripts/verify-seam.ts cannot reach a live execute route", () => {
  const source = read("scripts/verify-seam.ts");

  test("it makes no HTTP request of its own", () => {
    assert.equal(
      /\bfetch\s*\(/.test(source),
      false,
      "verify-seam.ts calls fetch. The routes it used to POST to execute for real even with simulate: true (#1959).",
    );
  });

  test("the only provider it builds is pointed at an unroutable host", () => {
    const constructions = source.match(/new KeeperHubProvider\(\{[^}]*\}\)/g) ?? [];
    assert.equal(constructions.length, 1, "expected exactly one provider in this script");
    assert.match(constructions[0], /baseUrl:\s*UNROUTABLE/);
    assert.match(source, /const UNROUTABLE = "http:\/\/127\.0\.0\.1:1\/api";/);
  });

  test("it still passes with fetch and every socket blocked", async () => {
    // The runtime half of the claim: source greps prove no `fetch` token, this proves no call.
    // A credential in .env is deliberately left in place — the old code needed only that to
    // start POSTing finished calldata, so the credential being present is the interesting case.
    const block =
      "globalThis.fetch = () => { throw new Error('NETWORK_BLOCKED') };" +
      " const net = await import('node:net');" +
      " net.Socket.prototype.connect = function () { throw new Error('NETWORK_BLOCKED') };";
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--import", `data:text/javascript,${encodeURIComponent(block)}`, "scripts/verify-seam.ts"],
      { cwd: new URL(".", ROOT), stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));

    assert.equal(code, 0, `verify:seam exited ${code} with sockets blocked:\n${out}`);
    assert.match(out, /Seam holds\./);
    assert.doesNotMatch(out, /NETWORK_BLOCKED/, "something in verify:seam tried to open a connection");
  });
});
