import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_STATES,
  PRE_DISPATCH_REFUSALS,
  TERMINAL,
  TransitionError,
  assertTransition,
  canTransition,
  isSettled,
  isTerminal,
  reachableFrom,
  type State,
} from "../src/machine.ts";

const EXECUTING: readonly State[] = ["ALLOWANCE_EXECUTING", "PAYMENT_EXECUTING"];

describe("settlement requires both signals", () => {
  test("CHAIN_CONFIRMED cannot become SETTLED directly", () => {
    // A confirmed receipt is one signal. Request's own reconciliation is the other.
    assert.equal(canTransition("CHAIN_CONFIRMED", "SETTLED"), false);
    assert.throws(() => assertTransition("CHAIN_CONFIRMED", "SETTLED"), TransitionError);
  });

  test("the only route to SETTLED passes through RECONCILING", () => {
    const intoSettled = ALL_STATES.filter((s) => canTransition(s, "SETTLED"));
    assert.deepEqual(
      [...intoSettled].sort(),
      ["EVIDENCE_CONFLICT", "RECONCILIATION_PENDING", "RECONCILING"].sort(),
    );
    assert.ok(canTransition("CHAIN_CONFIRMED", "RECONCILING"));
    assert.ok(canTransition("RECONCILING", "SETTLED"));
  });

  test("isSettled is true for exactly one state", () => {
    assert.deepEqual(ALL_STATES.filter(isSettled), ["SETTLED"]);
  });
});

describe("an unknown outcome never becomes a fresh payment", () => {
  test("EXECUTION_OUTCOME_UNKNOWN cannot re-enter an executing state", () => {
    // This is the core safety property: recovery observes existing work, it never dispatches.
    for (const s of EXECUTING) {
      assert.equal(
        canTransition("EXECUTION_OUTCOME_UNKNOWN", s),
        false,
        `EXECUTION_OUTCOME_UNKNOWN must not reach ${s}`,
      );
    }
  });

  test("it is not terminal, because it is an open investigation", () => {
    assert.equal(isTerminal("EXECUTION_OUTCOME_UNKNOWN"), false);
    assert.equal(isTerminal("RECONCILIATION_PENDING"), false);
    assert.equal(isTerminal("EVIDENCE_CONFLICT"), false);
  });

  test("it can only resolve by observation", () => {
    const allowed = ALL_STATES.filter((s) => canTransition("EXECUTION_OUTCOME_UNKNOWN", s));
    assert.deepEqual(
      [...allowed].sort(),
      ["CHAIN_CONFIRMED", "CHAIN_PENDING", "EVIDENCE_CONFLICT", "EXECUTION_REVERTED", "RECONCILING"].sort(),
    );
  });

  test("a reverted receipt does not silently retry either", () => {
    for (const s of EXECUTING) {
      assert.equal(canTransition("EXECUTION_REVERTED", s), false);
    }
    assert.equal(isTerminal("EXECUTION_REVERTED"), true);
  });
});

describe("dispatch is entered from exactly one place", () => {
  test("only PAYMENT_PREFLIGHT may begin a payment", () => {
    const enterers = ALL_STATES.filter((s) => canTransition(s, "PAYMENT_EXECUTING"));
    assert.deepEqual(enterers, ["PAYMENT_PREFLIGHT"]);
  });

  test("only APPROVED may begin an allowance", () => {
    const enterers = ALL_STATES.filter((s) => canTransition(s, "ALLOWANCE_EXECUTING"));
    assert.deepEqual(enterers, ["APPROVED"]);
  });

  test("APPROVED is re-checked, so it can still refuse at the boundary", () => {
    // Facts, policy and plan validity can all move between approval and dispatch.
    for (const s of ["PLAN_EXPIRED", "PLAN_CHANGED", "POLICY_DENIED", "SOURCE_ALREADY_PAID"] as State[]) {
      assert.ok(canTransition("APPROVED", s), `APPROVED should be able to refuse with ${s}`);
    }
  });

  test("a failed payment preflight cannot broadcast", () => {
    assert.equal(canTransition("SIMULATION_BLOCKED", "PAYMENT_EXECUTING"), false);
    assert.equal(isTerminal("SIMULATION_BLOCKED"), true);
  });
});

describe("terminal states are closed", () => {
  test("no terminal state has an outgoing transition", () => {
    for (const s of TERMINAL) {
      const out = ALL_STATES.filter((t) => canTransition(s, t));
      assert.deepEqual(out, [], `${s} should be closed but leads to ${out.join(", ")}`);
    }
  });

  test("isTerminal agrees with the transition table", () => {
    for (const s of ALL_STATES) {
      const hasOut = ALL_STATES.some((t) => canTransition(s, t));
      assert.equal(isTerminal(s), !hasOut, `${s}: isTerminal=${isTerminal(s)} but hasOut=${hasOut}`);
    }
  });
});

describe("pre-dispatch refusals burn no gas", () => {
  test("every one of them is reachable without passing through an executing state", () => {
    // Proves the "0 gas burned" column in the refusal table is structural, not incidental.
    const reachable = reachableFrom("IMPORTED");
    for (const refusal of PRE_DISPATCH_REFUSALS) {
      assert.ok(reachable.has(refusal), `${refusal} unreachable from IMPORTED`);
    }
  });

  test("none of them is entered from an executing state", () => {
    for (const refusal of PRE_DISPATCH_REFUSALS) {
      for (const s of EXECUTING) {
        assert.equal(
          canTransition(s, refusal),
          false,
          `${refusal} must not be reachable from ${s} — gas would already be spent`,
        );
      }
    }
  });
});

describe("the graph is well formed", () => {
  test("every state is reachable from IMPORTED", () => {
    const reachable = reachableFrom("IMPORTED");
    const stranded = ALL_STATES.filter((s) => !reachable.has(s));
    assert.deepEqual(stranded, [], `stranded states: ${stranded.join(", ")}`);
  });

  test("every declared target is a real state", () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (canTransition(from, to)) assert.ok(ALL_STATES.includes(to));
      }
    }
  });

  test("no state transitions to itself", () => {
    for (const s of ALL_STATES) {
      assert.equal(canTransition(s, s), false, `${s} should not self-loop`);
    }
  });

  test("assertTransition reports both ends of an illegal move", () => {
    // `assert.throws`, not try/catch. Written as a try/catch this test hung on one line: the
    // `assert.ok(e instanceof TransitionError)` was the only thing stopping its own
    // `assert.fail("expected a throw")` from being swallowed by the same catch, so deleting that
    // line would have made the test unfailable. A sweep found three tests that had already lost
    // that race; this one was one edit away from joining them.
    assert.throws(
      () => assertTransition("SETTLED", "IMPORTED"),
      (e: unknown) => {
        assert.ok(e instanceof TransitionError);
        assert.equal(e.from, "SETTLED");
        assert.equal(e.to, "IMPORTED");
        assert.equal(e.code, "ILLEGAL_TRANSITION");
        return true;
      },
    );
  });
});
