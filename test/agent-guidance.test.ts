/**
 * Every answer an agent can receive tells it what to do next — especially the ones that are not
 * refusals.
 *
 * `agentGuidance` was keyed off `outcome.refusal` alone, so every state that carries no refusal
 * fell through to `null`. That is fine for SETTLED. It was not fine for `RECONCILIATION_PENDING`,
 * which is the single state where the money has already moved and the outcome is not confirmed —
 * the one state where calling the tool again pays twice. An agent reaching it was handed no
 * instruction at all, while the correct sentence sat three hundred lines above, unreachable.
 *
 * Two properties, because one of them cannot be tested by example:
 *
 *   1. no state in which a provider write was issued answers with `null` guidance;
 *   2. the two guidance maps — the local surface's and the hosted one's — cover the same codes,
 *      because both tools promise to list "every code this system can answer with" and neither
 *      had a test. They had drifted by three codes each way.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { ALL_STATES, TERMINAL, type State } from "../src/machine.ts";
import { TERMINAL_FOR_AGENTS } from "../src/mcp.ts";
import { RETRY_GUIDANCE } from "../src/mcp-public.ts";

describe("no agent is left without an instruction where it matters", () => {
  test("every state a payment can be left in has guidance", () => {
    // The states where something has happened and the caller has to decide what to do. SETTLED
    // needs nothing; the rest need a sentence, and the dangerous ones need it most.
    const afterSomethingHappened: State[] = [
      "RECONCILIATION_PENDING",
      "EXECUTION_OUTCOME_UNKNOWN",
      "CHAIN_PENDING",
      "EVIDENCE_CONFLICT",
      "PAYMENT_PREFLIGHT",
      "AWAITING_APPROVAL",
    ];
    const silent = afterSomethingHappened.filter((s) => !TERMINAL_FOR_AGENTS[s]);
    assert.deepEqual(
      silent,
      [],
      `these states answer an agent with no guidance: ${silent.join(", ")} — and they are the ones where it has to be told not to retry`,
    );
  });

  test("the guidance for a state where money moved never suggests retrying", () => {
    for (const state of ["RECONCILIATION_PENDING", "EXECUTION_OUTCOME_UNKNOWN"] as const) {
      const text = TERMINAL_FOR_AGENTS[state];
      assert.ok(text, state);
      // An INSTRUCTION to retry, not the word. "A retry would pay twice" is the warning, and a
      // check that cannot tell a warning from an instruction fails on the correct text.
      assert.doesNotMatch(
        text,
        /\b(retry|call settle_obligation again|try again|send it again)\b(?![^.]*\b(would|will|is refused|cannot|never|pays? twice)\b)/i,
        `${state} tells an agent to retry, and a retry there is a second payment: ${text}`,
      );
      assert.match(text, /resolve_pending|human/i, `${state} must say what to do instead: ${text}`);
    }
  });

  test("the local and hosted surfaces answer for the same codes", () => {
    // Both tools say they list every code this system can answer with. They each carried three
    // the other lacked, and nothing compared them. The duplication itself is deliberate -- the
    // hosted bundle must not import the store or the provider -- so the fix is a test, not a
    // shared constant.
    // Refusal CODES only. The local map also keys a few machine STATES, which the read-only
    // hosted surface cannot return and should not describe -- it has no store and no obligation.
    const states = new Set<string>(ALL_STATES);
    const local = new Set(Object.keys(TERMINAL_FOR_AGENTS).filter((k) => !states.has(k)));
    const hosted = new Set(Object.keys(RETRY_GUIDANCE).filter((k) => !states.has(k)));
    const onlyLocal = [...local].filter((k) => !hosted.has(k));
    const onlyHosted = [...hosted].filter((k) => !local.has(k));
    assert.deepEqual(
      { onlyLocal, onlyHosted },
      { onlyLocal: [], onlyHosted: [] },
      "the two guidance tables have drifted, and both claim to be complete",
    );
  });

  test("every refusal code the source can emit has guidance", () => {
    // Read from the code rather than from a list somebody maintains: a refusal added with no
    // entry falls back to "report this to a human", which is safe and says nothing useful.
    const sources = ["src/mcp.ts", "src/settle.ts", "src/policy.ts", "src/request.ts", "src/worker.ts"]
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    // Two spellings, because the first alone let four codes through: the pre-write helper, and
    // the `refusal:` field of an outcome returned directly. IDEMPOTENCY_CONFLICT, NO_HASH,
    // OBLIGATION_ID_MISMATCH and REFERENCE_UNRECORDED were all returned that way, none had an
    // entry, and this test was green the whole time.
    const emitted = new Set([
      ...[...sources.matchAll(/refusedBeforeWrite\(\s*\w+,\s*"([A-Z_]+)"/g)].map((m) => m[1] as string),
      ...[...sources.matchAll(/refusal: "([A-Z_]+)"/g)].map((m) => m[1] as string),
    ]);
    assert.ok(emitted.size > 0, "no refusal codes found, so this test is watching nothing");
    const unguided = [...emitted].filter((c) => !TERMINAL_FOR_AGENTS[c]);
    assert.deepEqual(unguided, [], `these refusals answer an agent with the generic fallback: ${unguided.join(", ")}`);
  });

  test("and every terminal state either has guidance or needs none", () => {
    // The control on the first test: TERMINAL is where an obligation stops, and an agent that
    // reaches one must not be told to keep trying.
    for (const state of TERMINAL) {
      const text = TERMINAL_FOR_AGENTS[state];
      if (!text) continue;
      assert.doesNotMatch(text, /\btry again shortly\b/i, `${state} is terminal but suggests waiting: ${text}`);
    }
  });
});
