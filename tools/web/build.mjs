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

/**
 * The evidence the hosted MCP serves, compiled into a module.
 *
 * `src/mcp-public.ts` runs on Vercel with no database and no filesystem it can trust, so its
 * `verify_payment` corroborates a sighting against a table of this project's own settlements
 * that is compiled in at build time. That table was built from `docs/refusals-live.json` ALONE,
 * whose `generatedAt` predates the three MCP-transport settlements by three days — so all three
 * of those references answered `paid: false` on the live deployment while the chain plainly
 * showed the payment. The evidence a surface serves has to be ALL the evidence, or the surface
 * contradicts the repository that hosts it.
 *
 * Everything below is derived from the artifacts, never copied from their summary blocks: a
 * total a build carries forward unchecked is a total that goes stale silently.
 */
function writeCompiledEvidence() {
  if (!live && !mcp) throw new Error("no LIVE artifact to compile: refusing to build a hosted surface that serves nothing");

  const liveRows = (live?.rows ?? []).map((r) => ({
    caseId: r.case_id,
    scenario: r.scenario,
    actual: r.actual,
    transport: "rest",
    physicalSends: r.physical_sends ?? 0,
    txHash: r.tx_hash ?? null,
    requestId: r.request_id ?? null,
    paymentReference: r.payment_reference ?? null,
  }));
  // Case ids are positional and stable: the artifact is append-only and the build must produce
  // the same bytes for the same commit, or nobody can check what is deployed against a revision.
  const mcpRows = (mcp?.rows ?? []).map((r, i) => ({
    caseId: `M${String(i + 1).padStart(3, "0")}`,
    scenario: `settled through KeeperHub's MCP transport (execution ${r.keeperhubExecutionId ?? "unrecorded"})`,
    actual: r.finalState ?? "UNKNOWN",
    transport: r.transport ?? "mcp",
    physicalSends: r.physicalSends ?? 0,
    txHash: r.txHash ?? null,
    requestId: r.requestId ?? null,
    paymentReference: r.paymentReference ?? null,
  }));
  const rows = [...liveRows, ...mcpRows];

  const compiled = {
    // The freshness of the evidence, not the wall clock — same rule as `builtAt` above.
    generatedAt: [live?.generatedAt, mcp?.generatedAt].filter(Boolean).sort().pop() ?? "unknown",
    chainId: live?.chainId ?? mcp?.chainId ?? 11155111,
    totals: {
      rows: rows.length,
      asSpecified:
        (live?.rows ?? []).filter((r) => r.actual === r.expected).length +
        mcpRows.filter((r) => r.actual === "SETTLED").length,
      payments: rows.filter((r) => r.txHash).length,
      physicalSends: rows.reduce((n, r) => n + r.physicalSends, 0),
      refusalRows: rows.filter((r) => !r.txHash && r.physicalSends === 0).length,
      refusedBeforeAnyProviderWrite: (live?.rows ?? []).filter((r) => r.refused_before_provider_write === true).length,
    },
    rows,
  };

  const module = `/**
 * Generated by tools/web/build.mjs from docs/refusals-live.json and
 * docs/evidence/mcp-settlements.json. Do not edit by hand.
 *
 * The hosted surface has no database and no filesystem it can trust, so the evidence it
 * serves is compiled in at build time from the same artifacts the console renders. A number
 * here that nobody re-derives is a number that goes stale silently, so it is derived.
 *
 * Every LIVE settlement belongs here, whichever KeeperHub transport made it: this file once
 * carried the REST rows only, and the hosted verifier answered \`paid: false\` for all three
 * MCP references because they were not in the table it corroborates against.
 */

export interface EvidenceRow {
  readonly caseId: string;
  readonly scenario: string;
  readonly actual: string;
  /** Which KeeperHub surface dispatched it. "rest" for every row recorded before the MCP run. */
  readonly transport: string;
  readonly physicalSends: number;
  readonly txHash: string | null;
  readonly requestId: string | null;
  readonly paymentReference: string | null;
}

export const EVIDENCE: {
  readonly generatedAt: string;
  readonly chainId: number;
  readonly totals: Record<string, number>;
  readonly rows: readonly EvidenceRow[];
} = ${JSON.stringify(compiled, null, 2)} as const;
`;
  writeFileSync(path("src/evidence.generated.ts"), module, "utf8");
  return compiled;
}
const compiledEvidence = writeCompiledEvidence();

/**
 * Every command the page prints has to be a command a reader can actually run.
 *
 * Two Surfaces cards printed `npm run verify:mcp` for months after the script was renamed to
 * `probe:mcp`; a judge who typed it got `npm error Missing script`. Nothing caught it because
 * the page is checked by eye and the eye does not read package.json. So the build reads it:
 * the rendered page is scanned for every `npm run <script>` and the build refuses to write a
 * page naming a script that does not exist.
 *
 * The scan is textual, which is only sound because the page names its commands in full. A
 * template that builds a command by interpolation (`npm run ${cmd}`) hides the script name
 * from this check, so that form is refused outright — put the whole command in the data.
 */
function assertCommandsExist(html) {
  const names = scriptNames();
  if (!names) throw new Error("cannot read package.json scripts: refusing to write a page whose commands nobody checked");
  const known = new Set(names);

  if (html.includes("npm run ${")) {
    throw new Error(
      "the page builds an npm command by interpolation, so the script name cannot be checked.\n" +
        '  Put the whole command in the data ("npm run probe:mcp"), not a bare fragment.',
    );
  }

  // Script names here carry letters, digits, : _ - and . — a trailing full stop belongs to the
  // sentence, not the name ("Run npm run evidence:mcp.").
  const missing = new Map();
  for (const m of html.matchAll(/npm run ([A-Za-z0-9][A-Za-z0-9:._-]*)/g)) {
    const name = m[1].replace(/\.$/, "");
    if (!known.has(name)) missing.set(name, (missing.get(name) ?? 0) + 1);
  }
  if (missing.size) {
    const lines = [...missing].map(([n, c]) => `  npm run ${n}  (${c} occurrence${c === 1 ? "" : "s"})`);
    throw new Error(
      `the console prints ${missing.size} npm command(s) package.json does not define:\n${lines.join("\n")}\n` +
        `  defined scripts: ${names.join(", ")}`,
    );
  }
  return known.size;
}

const template = readFileSync(path("tools/web/template.html"), "utf8");
if (!template.includes("__DATA__")) throw new Error("template lost its __DATA__ placeholder");

// The payload sits in a JSON script tag, so it must not be able to close that tag early.
const payload = JSON.stringify(data).replace(/</g, "\\u003c");
const html = template.replace("__DATA__", payload);
// Checked before it is written: a page naming a command nobody can run must never reach disk.
const knownScripts = assertCommandsExist(html);
writeFileSync(path("web/index.html"), html, "utf8");

console.log(
  `commands checked — every \`npm run\` on the page resolves to one of ${knownScripts} package.json scripts\n` +
    `web/index.html written — ${refusals.rows.length} fixture rows, ` +
    `${live ? `${live.rows.length} live rows, ${live.totals.payments} real payments, ` : "no live artifact, "}` +
    `${race ? `race ${race.workers} workers / ${race.totals.distinctTransactions} transactions, ` : "no race artifact, "}` +
    `${crash ? "crash artifact present, " : "no crash artifact, "}` +
    `${mcp ? `mcp ${mcp.rows.length} settlements / ${mcp.totals.withExecutionId} execution ids, ` : "no mcp artifact, "}` +
    `${tests} tests\n` +
    `src/evidence.generated.ts written — ${compiledEvidence.rows.length} rows, ` +
    `${compiledEvidence.totals.payments} payments the hosted verifier can corroborate against`,
);
