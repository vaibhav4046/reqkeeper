/**
 * Two properties nothing was checking, both of which this project has already been bitten by.
 *
 * **Every non-terminal state can reach a terminal one.** A state with no way out is a debt that is
 * never paid and never refused, and "safe, and never recovered" is the failure mode found here
 * once per round: the wedged preflight, the permanently dead plan hash, the stranded attempt with
 * an empty outbox, the anchor that could never be learned. Reachability over the transition table
 * is mechanical and catches the shape at its source rather than one instance at a time.
 *
 * **Every command-line flag the documentation prints actually parses.** This is the one that
 * would have mattered most. `docs/RUNBOOK.md` printed
 *
 *     npm run resolve -- --release-preflight <obligationId> --operator alice@finance
 *
 * as the only way out of a wedged obligation, and the parser's pattern was
 * `/^--([a-zA-Z]+)(?:=(.*))?$/` — no hyphen in the character class. The flag never matched, the
 * command took the ordinary path, printed "nothing moved" and exited 0. Two independent reviewers
 * hit it. An escape that reports success without opening is worse than no escape: it is the wedge
 * with a green tick on it.
 *
 * So this reads the pattern out of the script's own source and runs every documented flag through
 * it. Not a copy of the pattern — the pattern, whatever it currently is.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { TERMINAL, canTransition, type State } from "../src/machine.ts";

const ALL_STATES: State[] = [
  "IMPORTED",
  "VALIDATING",
  "AWAITING_APPROVAL",
  "APPROVED",
  "ALLOWANCE_EXECUTING",
  "PAYMENT_PREFLIGHT",
  "PAYMENT_EXECUTING",
  "CHAIN_PENDING",
  "CHAIN_CONFIRMED",
  "RECONCILING",
  "RECONCILIATION_PENDING",
  "EXECUTION_OUTCOME_UNKNOWN",
  "EVIDENCE_CONFLICT",
  "SETTLED",
  "POLICY_DENIED",
  "SOURCE_ALREADY_PAID",
  "OBLIGATION_RESERVED",
  "REVIEW_REJECTED",
  "PLAN_EXPIRED",
  "PLAN_CHANGED",
  "CALLDATA_MISMATCH",
  "SIMULATION_BLOCKED",
  "PREFLIGHT_UNAVAILABLE",
  "EXECUTION_REVERTED",
  "CANCELLED_BEFORE_PAYMENT",
];

describe("no state is a dead end", () => {
  test("every state is either terminal or can reach a terminal one", () => {
    const terminal = new Set<string>(TERMINAL);
    const reaches = (from: State): boolean => {
      const seen = new Set<string>([from]);
      const queue: State[] = [from];
      while (queue.length > 0) {
        const at = queue.shift() as State;
        if (terminal.has(at)) return true;
        for (const next of ALL_STATES) {
          if (seen.has(next) || !canTransition(at, next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
      return false;
    };

    const stranded = ALL_STATES.filter((s) => !terminal.has(s) && !reaches(s));
    assert.deepEqual(stranded, [], `these states cannot reach any terminal state: ${stranded.join(", ")}`);
  });

  test("the state list here is the whole state list", () => {
    // A state added to the machine and not to this file would be silently exempt from the check
    // above — the check would still pass, over a smaller world. So the enumeration is pinned
    // against the source rather than trusted.
    const source = readFileSync("src/machine.ts", "utf8");
    const declared = [...source.matchAll(/^\s{2}\| "([A-Z_]+)"$|^\s{2}"([A-Z_]+)"$/gm)]
      .map((m) => m[1] ?? m[2])
      .filter(Boolean);
    for (const state of new Set(declared)) {
      assert.ok(
        ALL_STATES.includes(state as State),
        `src/machine.ts declares ${state}, which this test does not know about — add it`,
      );
    }
  });
});

describe("every flag the documentation prints is a flag the script can parse", () => {
  /** The pattern the script really uses, read out of its own source. */
  function flagPatternOf(script: string): RegExp {
    const source = readFileSync(script, "utf8");
    // The pattern that is EXECUTED, not the first one that appears. `resolve.ts` quotes its old
    // broken pattern in a comment explaining why it changed, and matching that instead reported a
    // bug that had already been fixed — a checker reading source has to be told which occurrence
    // is the live one.
    const m = /(\/\^--\([^)]*\)[^/]*\/)\s*\.exec\(/.exec(source);
    assert.ok(m, `${script} has no executed --flag pattern to check against`);
    const body = /^\/\^--\(([^)]*)\)([^/]*)\/$/.exec(m[1]);
    assert.ok(body, `could not read the pattern ${m[1]}`);
    return new RegExp(`^--(${body[1]})${body[2]}`);
  }

  test("resolve.ts parses every flag docs/RUNBOOK.md tells an operator to type", () => {
    const pattern = flagPatternOf("scripts/resolve.ts");
    const runbook = readFileSync("docs/RUNBOOK.md", "utf8");

    // Only the flags printed against this command, not every `--` in the document.
    const documented = new Set<string>();
    for (const line of runbook.split("\n")) {
      if (!/npm run resolve/.test(line)) continue;
      for (const m of line.matchAll(/--[a-z][a-z0-9-]*/g)) documented.add(m[0]);
    }

    assert.ok(documented.size > 0, "docs/RUNBOOK.md prints no resolve flags at all, which is its own problem");
    assert.ok(
      documented.has("--release-preflight"),
      "the documented escape is missing from the runbook; that is how it stopped being tested",
    );

    const unparsed = [...documented].filter((f) => !pattern.test(f));
    assert.deepEqual(
      unparsed,
      [],
      `docs/RUNBOOK.md tells an operator to type ${unparsed.join(", ")}, and ${pattern} does not match it`,
    );
  });

  test("and every flag it reads is one it can parse", () => {
    // The other direction: a flag the code looks for but the pattern cannot produce is dead code
    // that will never fire, which is exactly what --release-preflight was.
    const source = readFileSync("scripts/resolve.ts", "utf8");
    const pattern = flagPatternOf("scripts/resolve.ts");
    const read = [...source.matchAll(/args\.get\("([a-z][a-z0-9-]*)"\)/g)].map((m) => m[1]);

    assert.ok(read.length > 0, "resolve.ts reads no flags, so this check is watching nothing");
    const unreachable = read.filter((f) => !pattern.test(`--${f}`));
    assert.deepEqual(unreachable, [], `resolve.ts reads --${unreachable.join(", --")}, which its own parser cannot match`);
  });
});
