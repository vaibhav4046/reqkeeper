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
  "EXECUTION_REVERTED",
  "CANCELLED_BEFORE_PAYMENT",
];

const TRANSITIONS: Readonly<Record<State, readonly State[]>> = {
  IMPORTED: ["VALIDATING", "SOURCE_ALREADY_PAID", "OBLIGATION_RESERVED"],
  VALIDATING: ["AWAITING_APPROVAL", "POLICY_DENIED", "SOURCE_ALREADY_PAID", "CALLDATA_MISMATCH"],
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
  PAYMENT_PREFLIGHT: ["PAYMENT_EXECUTING", "SIMULATION_BLOCKED", "PLAN_EXPIRED", "PLAN_CHANGED"],

  PAYMENT_EXECUTING: ["CHAIN_PENDING", "EXECUTION_OUTCOME_UNKNOWN"],
  CHAIN_PENDING: ["CHAIN_CONFIRMED", "EXECUTION_REVERTED", "EXECUTION_OUTCOME_UNKNOWN"],

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

  EVIDENCE_CONFLICT: ["RECONCILING", "SETTLED"],

  SETTLED: [],
  POLICY_DENIED: [],
  SOURCE_ALREADY_PAID: [],
  OBLIGATION_RESERVED: [],
  REVIEW_REJECTED: [],
  PLAN_EXPIRED: [],
  PLAN_CHANGED: [],
  CALLDATA_MISMATCH: [],
  SIMULATION_BLOCKED: [],
  EXECUTION_REVERTED: [],
  CANCELLED_BEFORE_PAYMENT: [],
};

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
