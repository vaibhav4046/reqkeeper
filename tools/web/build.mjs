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

function env(name, fallback = "") {
  if (!existsSync(path(".env"))) return fallback;
  for (const line of readFileSync(path(".env"), "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  return fallback;
}

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

const payee = (env("PAYEE_BURNER") || "0x0000000000000000000000000000000000000000").toLowerCase();

const data = {
  builtAt: new Date().toISOString(),
  tests,
  refusals,
  live,
  race,
  crash,
  scripts: scriptNames(),
  settlement: {
    requestId: env("REQUEST_ID", "(not settled yet)"),
    paymentReference: env("PAYMENT_REFERENCE", "-"),
    obligationId: "3a79273eb6cab086a787cf5bbee3864982acda2e61b44875fdc6562e6e662f8d",
    amountBaseUnits: "1000000000000000000",
    txHash: "0x134f352dc69843105a01d1b9d6cc9799b660bd28e08920144bb67cb3852bfeff",
    restatement:
      `Pay 1 FAU to ${payee} on chain 11155111, plus 0 fee.\n` +
      "Total leaving the wallet: 1 FAU (1000000000000000000 base units).",
  },
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
    `${tests} tests`,
);
