/**
 * Every evidence-derived number in README.md and docs/SUBMISSION.md, checked against the
 * evidence.
 *
 * The failure this exists to catch is not a wrong number — it is a number that was right when
 * it was typed. docs/SUBMISSION.md claimed 239 unit tests for as long as the suite had 239; the
 * suite grew and the claim stayed, because nothing re-read it. A public number with no command
 * behind it is a claim, and a deadline is exactly when nobody re-reads claims.
 *
 * Two rules make the check hard to fool:
 *
 * 1. Facts come from `docs/evidence/verify.json`, which recomputes them from rows, and from a
 *    real `npm test` run. Nothing here re-implements a count that `verify:all` already derives;
 *    a second implementation of the same arithmetic is a second thing that can be wrong.
 * 2. A claim whose pattern matches nothing FAILS. A check that silently stops checking when the
 *    prose is reworded is worse than no check, because it still reports green.
 *
 *   node --experimental-strip-types scripts/readme-numbers.ts          # print the facts
 *   node --experimental-strip-types scripts/readme-numbers.ts --check  # verify the documents
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CHECK = process.argv.includes("--check");
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const json = (p: string) => JSON.parse(read(p));

const verify = json("docs/evidence/verify.json");

// A green tally over stale inputs is the most confident way to be wrong, so the freshness of
// verify.json is checked before a single number is taken from it.
if (verify.totals.failed !== 0 || verify.totals.blocked !== 0) {
  console.error(
    `verify.json reports ${verify.totals.failed} failed, ${verify.totals.blocked} blocked — run \`npm run verify:all\` and fix those first`,
  );
  process.exit(1);
}
const verifiedAt = Date.parse(verify.generatedAt);
for (const artifact of ["race.json", "race-live.json", "crash.json", "mcp-settlements.json"]) {
  const generatedAt = Date.parse(json(`docs/evidence/${artifact}`).generatedAt);
  if (generatedAt > verifiedAt) {
    console.error(`docs/evidence/${artifact} is newer than verify.json — run \`npm run verify:all\``);
    process.exit(1);
  }
}

/** Pulls a number out of the check `verify:all` recomputed, never out of a summary field. */
function fromCheck(id: string, re: RegExp): number {
  const check = verify.checks.find((c: { id: string }) => c.id === id);
  if (!check) throw new Error(`verify.json has no check "${id}" — it was renamed or removed`);
  const m = re.exec(check.detail);
  if (!m) throw new Error(`check "${id}" now reads "${check.detail}", which does not match ${re}`);
  return Number(m[1]);
}

function testCount(): number {
  // The TAP reporter, for the same reason tools/web/build.mjs uses it: the default reporter
  // prints a human summary that changes shape between Node versions, and a count parsed out of
  // prose is a count that breaks quietly.
  const out = execFileSync("node", ["--experimental-strip-types", "--test", "--test-reporter=tap"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 32 * 1024 * 1024,
  });
  const pass = /^# pass (\d+)$/m.exec(out);
  const fail = /^# fail (\d+)$/m.exec(out);
  if (!pass) throw new Error("no pass count in the TAP output");
  if (fail && fail[1] !== "0") throw new Error(`${fail[1]} test(s) failing — no document should claim otherwise`);
  return Number(pass[1]);
}

const facts = {
  settlements: fromCheck("live.one-send-per-settlement", /^(\d+) settled/),
  physicalSends: fromCheck("live.one-send-per-settlement", /(\d+) physical send/),
  replays: fromCheck("live.replays-cost-nothing", /^(\d+) replays/),
  replaySends: fromCheck("live.replays-cost-nothing", /(\d+) send/),
  refusals: fromCheck("live.refused-before-write", /^(\d+) row/),
  rows: json("docs/refusals-live.json").rows.length,
  derivations: fromCheck("request.derivation", /^(\d+)\//),
  raceWorkers: json("docs/evidence/race.json").workers,
  raceBroadcasts: fromCheck("race.exactly-once", /^(\d+) broadcast/),
  liveWorkers: json("docs/evidence/race-live.json").workers,
  livePayments: fromCheck("race.live", /^(\d+) payment/),
  liveDuplicates: fromCheck("race.live", /(\d+) duplicate/),
  crashCheckpoints: fromCheck("crash.no-duplicates", /^(\d+) checkpoint/),
  mcpSettlements: fromCheck("keeperhub.mcp", /^(\d+) settlement/),
  tests: CHECK ? testCount() : Number.NaN,
};

/**
 * One row per public number. `re` must capture the number as the document writes it; a row that
 * matches nothing fails, so rewording the sentence around a number is caught as well.
 */
const claims: Array<{ file: string; what: string; re: RegExp; expected: number }> = [
  { file: "README.md", what: "unit tests", re: /(\d+) tests\b/, expected: facts.tests },
  { file: "README.md", what: "race workers (headline)", re: /(\d+) workers\. 1 payment/, expected: facts.raceWorkers },
  { file: "README.md", what: "race workers (command)", re: /npm run race +# (\d+) processes/, expected: facts.raceWorkers },
  { file: "README.md", what: "REST settlements", re: /(\d+) settlements through the REST/, expected: facts.settlements },
  { file: "README.md", what: "MCP settlements", re: /\*\*(\d+) through KeeperHub's own MCP/, expected: facts.mcpSettlements },
  { file: "README.md", what: "references re-derived", re: /\*\*(\d+) of \d+\*\* recorded payment references/, expected: facts.derivations },
  { file: "docs/SUBMISSION.md", what: "unit tests", re: /(\d+) unit tests/, expected: facts.tests },
  { file: "docs/SUBMISSION.md", what: "settlements", re: /\*\*(\d+) real payments on Sepolia/, expected: facts.settlements },
  { file: "docs/SUBMISSION.md", what: "replays refused", re: /(\d+) replays refused/, expected: facts.replays },
  { file: "docs/SUBMISSION.md", what: "sends by those replays", re: /(\d+) sends by those replays/, expected: facts.replaySends },
  { file: "docs/SUBMISSION.md", what: "refusals before write", re: /\*\*(\d+) live refusals before any provider write/, expected: facts.refusals },
  { file: "docs/SUBMISSION.md", what: "rows in total", re: /(\d+) rows in total/, expected: facts.rows },
  { file: "docs/SUBMISSION.md", what: "REST settlements", re: /(\d+) settlements, `docs\/refusals-live\.json`/, expected: facts.settlements },
  { file: "docs/SUBMISSION.md", what: "MCP settlements", re: /(\d+) settlements, `docs\/evidence\/mcp-settlements\.json`/, expected: facts.mcpSettlements },
  { file: "docs/SUBMISSION.md", what: "race workers", re: /(\d+) concurrent worker processes/, expected: facts.raceWorkers },
  { file: "docs/SUBMISSION.md", what: "live race workers", re: /(\d+) workers against real KeeperHub/, expected: facts.liveWorkers },
  { file: "docs/SUBMISSION.md", what: "crash checkpoints", re: /(\d+) crash checkpoints/, expected: facts.crashCheckpoints },
  { file: "docs/SUBMISSION.md", what: "references re-derived", re: /(\d+) of \d+ payment references/, expected: facts.derivations },
];

if (!CHECK) {
  console.log("facts derived from docs/evidence (run with --check to verify the documents):\n");
  for (const [k, v] of Object.entries(facts)) {
    if (!Number.isNaN(v)) console.log(`  ${k.padEnd(18)} ${v}`);
  }
  console.log("  tests              (counted by running the suite, --check only)\n");
  process.exit(0);
}

const failures: string[] = [];
for (const claim of claims) {
  const lines = read(claim.file).split("\n");
  const hits = lines
    .map((line, i) => ({ line, m: claim.re.exec(line), lineNo: i + 1 }))
    .filter((h) => h.m !== null);
  if (hits.length === 0) {
    failures.push(
      `${claim.file}: nothing states "${claim.what}" any more (pattern ${claim.re}) — the document dropped a claim this check was watching`,
    );
    continue;
  }
  for (const hit of hits) {
    const found = Number(hit.m![1]);
    if (found !== claim.expected) {
      failures.push(`${claim.file}:${hit.lineNo}: ${claim.what} says ${found}, the evidence says ${claim.expected}\n          ${hit.line.trim()}`);
    }
  }
}

for (const f of failures) console.error(`  FAIL  ${f}`);
console.log(`\n  ${claims.length - failures.length} of ${claims.length} documented numbers match the evidence\n`);
process.exit(failures.length === 0 ? 0 : 1);
