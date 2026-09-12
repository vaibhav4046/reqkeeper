/**
 * Build the console page by injecting real data into the template.
 *
 * The point of a build step rather than hand-written markup: the refusal table on the page is
 * the harness's own output, so the page cannot claim a count the harness does not produce.
 * Change the harness, rebuild, and the page follows. Type the numbers by hand instead and
 * they drift the first time a case is added — which is exactly what happened to the README.
 *
 *   node tools/web/build.mjs   ->  web/index.html
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url);
const path = (p) => new URL(p, ROOT).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// Nothing here reads the environment. The page is a function of the committed evidence and
// nothing else, which is what lets CI assert that the built page matches the commit.

const refusals = JSON.parse(readFileSync(path("docs/refusals.json"), "utf8"));

// The live artifact is the stronger evidence, so the page carries it when it exists rather
// than making a reader go and find it.
const livePath = path("docs/refusals-live.json");
const live = existsSync(livePath) ? JSON.parse(readFileSync(livePath, "utf8")) : null;

/**
 * Evidence files that other harnesses write. A missing one is a fact about this build, not a
 * reason to omit the panel: the page says the file was absent and names the command that
 * writes it, rather than rendering zeros that look like a measured result.
 */
function evidence(name) {
  const p = path(`docs/evidence/${name}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`docs/evidence/${name}.json is present but unreadable: ${e.message}`);
    return null;
  }
}
const race = evidence("race");
const crash = evidence("crash");
// Settlements dispatched through KeeperHub's MCP server rather than its REST API. These are the
// only rows that carry the KeeperHub execution id that produced the payment, so the proof strip
// is built from one of them; the REST artifact records no execution id on any row.
const mcp = evidence("mcp-settlements");

/**
 * Which npm scripts actually exist right now. The verify view lists the commands a judge can
 * run, and a command that is not wired yet must say so instead of being printed as if it
 * worked. package.json belongs to another owner and may be mid-write, hence the try.
 */
function scriptNames() {
  try {
    return Object.keys(JSON.parse(readFileSync(path("package.json"), "utf8")).scripts ?? {});
  } catch {
    return null;
  }
}

/**
 * Test count taken from an actual run, not from counting `test(` with a regex — that
 * undercounted by more than a hundred because it only matched declarations at the start of a
 * line. A number on a page that nobody re-derives is a number that goes stale silently.
 */
function testCount() {
  try {
    const out = execFileSync("node", ["--experimental-strip-types", "--test", "--test-reporter=tap"], {
      cwd: path(""),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    });
    const pass = /^# pass (\d+)$/m.exec(out);
    const fail = /^# fail (\d+)$/m.exec(out);
    if (!pass) throw new Error("could not find a pass count in the TAP output");
    if (fail && fail[1] !== "0") throw new Error(`${fail[1]} test(s) failing; refusing to build a page that claims otherwise`);
    return Number(pass[1]);
  } catch (e) {
    // Better to fail the build than to publish a page asserting a suite state nobody checked.
    console.error(`\ntest count unavailable: ${(e).message}\n`);
    process.exit(1);
  }
}
const tests = testCount();


const data = {
  /**
   * The newest evidence this page was built from — NOT the wall clock.
   *
   * `new Date()` here made every build produce different bytes, so the deployed page could
   * never be byte-identical to any commit. That is precisely the defect the baseline audit
   * raised: a judge could not check out a revision and reproduce what is served. Deriving the
   * stamp from the artifacts makes a rebuild of the same commit deterministic, and says
   * something more useful than when a file was written: how fresh the evidence behind it is.
   */
  builtAt: [live?.generatedAt, refusals?.generatedAt, race?.generatedAt, crash?.generatedAt, mcp?.generatedAt]
    .filter(Boolean)
    .sort()
    .pop() ?? "unknown",
  tests,
  refusals,
  live,
  race,
  crash,
  mcp,
  scripts: scriptNames(),
  // No `settlement` payload. It used to carry a requestId, a payment reference and a payee read
  // from an untracked .env, which made the built page depend on a file no clone has: CI's "the
  // built page must match the commit" step failed, and nobody could rebuild the bytes being
  // served. The template never rendered any of it. A payload that cannot be reproduced and is
  // never read is not evidence, it is a reason the build lies.
};

const template = readFileSync(path("tools/web/template.html"), "utf8");
if (!template.includes("__DATA__")) throw new Error("template lost its __DATA__ placeholder");

// The payload sits in a JSON script tag, so it must not be able to close that tag early.
const payload = JSON.stringify(data).replace(/</g, "\\u003c");
writeFileSync(path("web/index.html"), template.replace("__DATA__", payload), "utf8");

console.log(
  `web/index.html written — ${refusals.rows.length} fixture rows, ` +
    `${live ? `${live.rows.length} live rows, ${live.totals.payments} real payments, ` : "no live artifact, "}` +
    `${race ? `race ${race.workers} workers / ${race.totals.distinctTransactions} transactions, ` : "no race artifact, "}` +
    `${crash ? "crash artifact present, " : "no crash artifact, "}` +
    `${mcp ? `mcp ${mcp.rows.length} settlements / ${mcp.totals.withExecutionId} execution ids, ` : "no mcp artifact, "}` +
    `${tests} tests`,
);
