/**
 * The settlement state machine. One module owns every legal transition, so an impossible
 * move is a conflict and an audit event rather than a silently corrupted row.
 *
 * Two rules the rest of the system leans on:
 *   - CHAIN_CONFIRMED is not SETTLED. Settlement needs an independently read receipt AND
 *     Request's own reconciliation. A provider status string is never sufficient.
 *   - EXECUTION_OUTCOME_UNKNOWN never decays into failure. It resolves only by observing
 *     the work that was already dispatched.
 */

export type State =
  // happy path
  | "IMPORTED"
  | "VALIDATING"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "ALLOWANCE_EXECUTING"
  | "PAYMENT_PREFLIGHT"
  | "PAYMENT_EXECUTING"
  | "CHAIN_PENDING"
  | "CHAIN_CONFIRMED"
  | "RECONCILING"
  | "SETTLED"
  // refusals and faults
  | "POLICY_DENIED"
  | "SOURCE_ALREADY_PAID"
  | "OBLIGATION_RESERVED"
  | "REVIEW_REJECTED"
  | "PLAN_EXPIRED"
  | "PLAN_CHANGED"
  | "CALLDATA_MISMATCH"
  | "SIMULATION_BLOCKED"
  | "PREFLIGHT_UNAVAILABLE"
  | "EXECUTION_OUTCOME_UNKNOWN"
  | "EXECUTION_REVERTED"
  | "RECONCILIATION_PENDING"
  | "EVIDENCE_CONFLICT"
  | "CANCELLED_BEFORE_PAYMENT";

/** Refusals that happen before anything is dispatched. Zero gas burned, by construction. */
export const PRE_DISPATCH_REFUSALS: readonly State[] = [
  "POLICY_DENIED",
  "SOURCE_ALREADY_PAID",
  "OBLIGATION_RESERVED",
  "REVIEW_REJECTED",
  "PLAN_EXPIRED",
  "PLAN_CHANGED",
  "CALLDATA_MISMATCH",
  "SIMULATION_BLOCKED",
  "PREFLIGHT_UNAVAILABLE",
  "CANCELLED_BEFORE_PAYMENT",
];

/**
 * States from which no further transition is legal.
 *
 * EXECUTION_OUTCOME_UNKNOWN, RECONCILIATION_PENDING and EVIDENCE_CONFLICT are deliberately
 * NOT terminal: each one is an open investigation with somewhere to go once evidence lands.
 */
export const TERMINAL: readonly State[] = [
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

const TRANSITIONS: Readonly<Record<State, readonly State[]>> = {
  IMPORTED: ["VALIDATING", "SOURCE_ALREADY_PAID", "OBLIGATION_RESERVED"],
  VALIDATING: [
    "AWAITING_APPROVAL",
    "POLICY_DENIED",
    "SOURCE_ALREADY_PAID",
    "CALLDATA_MISMATCH",
    // The reservation is claimed after validation, so losing it is refused from here.
    "OBLIGATION_RESERVED",
  ],
  AWAITING_APPROVAL: ["APPROVED", "REVIEW_REJECTED", "PLAN_EXPIRED", "PLAN_CHANGED", "CANCELLED_BEFORE_PAYMENT"],

  // Re-checked at the dispatch boundary: facts, policy and plan can all have moved since approval.
  APPROVED: [
    "ALLOWANCE_EXECUTING",
    "PAYMENT_PREFLIGHT",
    "PLAN_EXPIRED",
    "PLAN_CHANGED",
    "POLICY_DENIED",
    "SOURCE_ALREADY_PAID",
    "CANCELLED_BEFORE_PAYMENT",
  ],

  ALLOWANCE_EXECUTING: ["PAYMENT_PREFLIGHT", "EXECUTION_OUTCOME_UNKNOWN", "EXECUTION_REVERTED"],

  // SIMULATION_BLOCKED here is the honest state after an allowance landed but the payment
  // will not simulate. The allowance exists on chain; the UI must say so.
  // EVIDENCE_CONFLICT because a dry run that returns a transaction hash has executed (#1959):
  // the safe reading is that money moved, never that the simulation was harmless.
  // PREFLIGHT_UNAVAILABLE is the platform being busy, not the payment being wrong. It is a
  // separate state from SIMULATION_BLOCKED because their agent guidance is opposite —
  // "this would revert, fix the plan" versus "try again shortly" — and because only one of
  // them is safe to replan from. See REPLANNABLE below for the condition that gates entry.
  PAYMENT_PREFLIGHT: [
    "PAYMENT_EXECUTING",
    "SIMULATION_BLOCKED",
    "PREFLIGHT_UNAVAILABLE",
    "PLAN_EXPIRED",
    "PLAN_CHANGED",
    "EVIDENCE_CONFLICT",
  ],

  // An idempotency conflict mid-send means the provider holds a different body for our key.
  PAYMENT_EXECUTING: ["CHAIN_PENDING", "EXECUTION_OUTCOME_UNKNOWN", "EVIDENCE_CONFLICT"],
  // A receipt that does not corroborate the provider is a conflict, not a failure.
  CHAIN_PENDING: ["CHAIN_CONFIRMED", "EXECUTION_REVERTED", "EXECUTION_OUTCOME_UNKNOWN", "EVIDENCE_CONFLICT"],

  // Cannot jump straight to SETTLED. Reconciliation is a mandatory stop.
  CHAIN_CONFIRMED: ["RECONCILING"],

  RECONCILING: ["SETTLED", "RECONCILIATION_PENDING", "EVIDENCE_CONFLICT"],
  RECONCILIATION_PENDING: ["RECONCILING", "SETTLED", "EVIDENCE_CONFLICT"],

  // An unknown outcome is resolved by observation, never by a fresh payment.
  EXECUTION_OUTCOME_UNKNOWN: [
    "CHAIN_PENDING",
    "CHAIN_CONFIRMED",
    "EXECUTION_REVERTED",
    "RECONCILING",
    "EVIDENCE_CONFLICT",
  ],

  // A conflict is resolved by evidence, and the chain outranks every other source: a
  // receipt that says reverted closes it, whatever the provider or the indexer claim.
  EVIDENCE_CONFLICT: ["RECONCILING", "SETTLED", "EXECUTION_REVERTED"],

  SETTLED: [],
  POLICY_DENIED: [],
  SOURCE_ALREADY_PAID: [],
  OBLIGATION_RESERVED: [],
  REVIEW_REJECTED: [],
  PLAN_EXPIRED: [],
  PLAN_CHANGED: [],
  CALLDATA_MISMATCH: [],
  SIMULATION_BLOCKED: [],
  PREFLIGHT_UNAVAILABLE: [],
  EXECUTION_REVERTED: [],
  CANCELLED_BEFORE_PAYMENT: [],
};

/**
 * States a fresh plan may be proposed from.
 *
 * Replanning is not a transition. A refusal is closed forever; proposing again starts a new
 * settlement over the same debt, which is why it is a separate, audited operation rather
 * than an edge in the table above. The set is exactly "no money moved and the debt still
 * stands": SOURCE_ALREADY_PAID is excluded because there is nothing left to pay, and every
 * state from PAYMENT_EXECUTING onward is excluded because a second plan over a live payment
 * is the exact thing this project exists to refuse.
 *
 * PREFLIGHT_UNAVAILABLE is in this set, and it is the one member whose safety does not follow
 * from the state name alone. PAYMENT_PREFLIGHT is not replannable, and deliberately so: a
 * simulate can TIME OUT, and a timed-out dry run may have executed for real (#1959). The
 * provider's own `retryable` flag cannot separate the two — `rate_limited` and `timeout` are
 * both retryable — so it is not the discriminator. Neither is durable local state, read from
 * inside `settleObligation`: an earlier version of this comment said the transition was gated
 * there on `store.sentAttemptFor`, and that check was vacuous where it stood, because
 * `openAttempt` does not run until after the simulate returns. Two adversarial passes walked
 * through it to a second payment.
 *
 * The discriminator is the chain. This state is entered in exactly one place — `worker.ts`,
 * after `sightPayment` has established across the whole scanned window that nothing carrying
 * this reference paid this invoice. A truncated scan does not qualify. `settleObligation` no
 * longer enters it at all: a simulate that throws leaves the obligation in PAYMENT_PREFLIGHT
 * with the observation still queued, and the test
 * "PREFLIGHT_UNAVAILABLE is unreachable once anything has been sent" pins the invariant.
 */
export const REPLANNABLE: readonly State[] = [
  "IMPORTED",
  "VALIDATING",
  "AWAITING_APPROVAL",
  "APPROVED",
  "POLICY_DENIED",
  "OBLIGATION_RESERVED",
  "REVIEW_REJECTED",
  "PLAN_EXPIRED",
  "PLAN_CHANGED",
  "CALLDATA_MISMATCH",
  "SIMULATION_BLOCKED",
  "PREFLIGHT_UNAVAILABLE",
  "CANCELLED_BEFORE_PAYMENT",
];

export function canReplan(from: State): boolean {
  return REPLANNABLE.includes(from);
}

export class ReplanError extends Error {
  readonly code = "REPLAN_REFUSED";
  readonly from: State;
  constructor(from: State) {
    super(`cannot propose a new plan from ${from}: this settlement is past the point of no return`);
    this.name = "ReplanError";
    this.from = from;
  }
}

export const ALL_STATES: readonly State[] = Object.keys(TRANSITIONS) as State[];

export function isTerminal(state: State): boolean {
  return TERMINAL.includes(state);
}

/** True once both independent signals agree. Nothing else may set this. */
export function isSettled(state: State): boolean {
  return state === "SETTLED";
}

export function canTransition(from: State, to: State): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export class TransitionError extends Error {
  readonly code = "ILLEGAL_TRANSITION";
  readonly from: State;
  readonly to: State;

  constructor(from: State, to: State) {
    super(`illegal transition ${from} -> ${to}`);
    this.name = "TransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: State, to: State): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}

/** States reachable from IMPORTED. Used by a test to prove nothing is stranded. */
export function reachableFrom(start: State): Set<State> {
  const seen = new Set<State>([start]);
  const queue: State[] = [start];
  while (queue.length > 0) {
    const current = queue.shift() as State;
    for (const next of TRANSITIONS[current] ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}
