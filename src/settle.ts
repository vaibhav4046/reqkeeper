/**
 * The dispatch protocol. One function owns the order of checks, because the order IS the
 * safety property: everything that can refuse must refuse before the attempt is committed,
 * and nothing may reach the provider without a durable attempt row behind it.
 */

import { assertTransition, type State } from "./machine.ts";
import { idempotencyKey, planHash as hashPlan, policyHash as hashPolicy, sourceFactsHash } from "./identity.ts";
import { checkPolicy, type Policy, type SourceFacts } from "./policy.ts";
import { toHuman } from "./money.ts";
import type { ExecutionProvider } from "./provider.ts";
import { ProviderError } from "./provider.ts";
import type { Store } from "./store.ts";

export interface SettleInput {
  readonly namespace: string;
  readonly requestId: string;
  readonly obligationId: string;
  readonly facts: SourceFacts;
  readonly steps: ReadonlyArray<{ kind: string; to: string; data: string; value: string }>;
  /** Human decision, supplied out of band. Absent means nobody has approved yet. */
  readonly approval?: { approver: string; decision: "APPROVED" | "REJECTED"; reason?: string };
  readonly now: number;
  /** Facts as they are at dispatch time; a change since planning invalidates the plan. */
  readonly factsAtDispatch?: SourceFacts;
}

export interface SettleOutcome {
  readonly state: State;
  readonly refusal?: string;
  readonly detail: string;
  /** True if any provider write was issued. A correct refusal must leave this false. */
  readonly providerWriteIssued: boolean;
  readonly txHash?: string;
  readonly planHash?: string;
  readonly restatement?: string;
}

export interface SettleDeps {
  readonly store: Store;
  readonly provider: ExecutionProvider;
  readonly policy: Policy;
  /** Independent reconciliation: Request's own verdict. */
  readonly sourceSaysPaid: (requestId: string, txHash: string) => Promise<boolean>;
}

function out(o: SettleOutcome): SettleOutcome {
  return o;
}

/**
 * A sentence a human can check against reality, bound into the approval record.
 *
 * The Lobstar transfer ($4 intended, $441,780 sent) would have been caught by reading one
 * line like this, because the human-readable figure and the base units are derived from the
 * same value at the same moment.
 */
export function restate(policy: Policy, facts: SourceFacts, totalDebitBaseUnits: string): string {
  const d = policy.token.decimals;
  return (
    `Pay ${toHuman(BigInt(facts.invoiceBaseUnits), d)} ${policy.token.symbol} to ${facts.payee}` +
    ` on chain ${policy.chainId}, plus ${toHuman(BigInt(facts.feeBaseUnits), d)} fee.` +
    ` Total leaving the wallet: ${toHuman(BigInt(totalDebitBaseUnits), d)} ${policy.token.symbol}` +
    ` (${totalDebitBaseUnits} base units).`
  );
}

export async function settleObligation(deps: SettleDeps, input: SettleInput): Promise<SettleOutcome> {
  const { store, provider, policy } = deps;
  const factsHash = sourceFactsHash(input.facts);

  store.importObligation({
    obligationId: input.obligationId,
    namespace: input.namespace,
    requestId: input.requestId,
    sourceFactsJson: JSON.stringify(input.facts),
    sourceFactsHash: factsHash,
    now: input.now,
  });
  store.audit(input.obligationId, "agent", "PROPOSED", { requestId: input.requestId });

  // --- 1. policy, before anything else can cost money ---------------------
  store.setState(input.obligationId, "VALIDATING", input.now);
  const decision = checkPolicy(policy, input.facts);
  if (!decision.ok) {
    const state: State = decision.code === "SOURCE_ALREADY_PAID" ? "SOURCE_ALREADY_PAID" : "POLICY_DENIED";
    store.setState(input.obligationId, state, input.now);
    store.audit(input.obligationId, "system", "REFUSED", { code: decision.code });
    return out({ state, refusal: decision.code, detail: decision.detail, providerWriteIssued: false });
  }

  // --- 2. immutable plan --------------------------------------------------
  const planBody = {
    obligationId: input.obligationId,
    chainId: policy.chainId,
    token: policy.token.address.toLowerCase(),
    decimals: policy.token.decimals,
    payee: input.facts.payee.toLowerCase(),
    invoiceBaseUnits: input.facts.invoiceBaseUnits,
    feeBaseUnits: input.facts.feeBaseUnits,
    totalDebitBaseUnits: decision.totalDebitBaseUnits,
    steps: input.steps,
    sourceFactsHash: factsHash,
    policyHash: hashPolicy(policy),
  };
  const planHash = hashPlan(planBody);
  const expiresAt = input.now + policy.planTtlSeconds * 1000;
  store.savePlan({
    planHash,
    obligationId: input.obligationId,
    version: policy.version,
    policyHash: planBody.policyHash,
    sourceFactsHash: factsHash,
    planJson: JSON.stringify(planBody),
    totalDebitBaseUnits: decision.totalDebitBaseUnits,
    expiresAt,
    now: input.now,
  });
  const restatement = restate(policy, input.facts, decision.totalDebitBaseUnits);

  // --- 3. exclusive ownership --------------------------------------------
  const reservation = store.reserveObligation(input.obligationId, planHash);
  if (!reservation.ok) {
    store.setState(input.obligationId, "OBLIGATION_RESERVED", input.now);
    store.audit(input.obligationId, "system", "REFUSED", { code: "OBLIGATION_RESERVED" });
    return out({
      state: "OBLIGATION_RESERVED",
      refusal: "OBLIGATION_RESERVED",
      // Deliberately reveals only that another plan holds it, never that plan's contents.
      detail: `already reserved by plan ${reservation.heldBy.slice(0, 12)}…`,
      providerWriteIssued: false,
      planHash,
    });
  }

  // --- 4. human authority -------------------------------------------------
  store.setState(input.obligationId, "AWAITING_APPROVAL", input.now);
  if (!input.approval) {
    return out({
      state: "AWAITING_APPROVAL",
      detail: "waiting for a human decision",
      providerWriteIssued: false,
      planHash,
      restatement,
    });
  }
  store.recordApproval({
    planHash,
    obligationId: input.obligationId,
    approver: input.approval.approver,
    decision: input.approval.decision,
    restatement,
    reason: input.approval.reason,
    now: input.now,
  });
  if (input.approval.decision === "REJECTED") {
    store.setState(input.obligationId, "REVIEW_REJECTED", input.now);
    return out({
      state: "REVIEW_REJECTED",
      refusal: "REVIEW_REJECTED",
      detail: input.approval.reason ?? "rejected by reviewer",
      providerWriteIssued: false,
      planHash,
    });
  }
  store.setState(input.obligationId, "APPROVED", input.now);

  // --- 5. re-check at the dispatch boundary -------------------------------
  const plan = store.getPlan(planHash);
  if (!plan || input.now > plan.expiresAt) {
    store.setState(input.obligationId, "PLAN_EXPIRED", input.now);
    return out({ state: "PLAN_EXPIRED", refusal: "PLAN_EXPIRED", detail: "approval expired before dispatch", providerWriteIssued: false, planHash });
  }
  if (input.factsAtDispatch) {
    const nowHash = sourceFactsHash(input.factsAtDispatch);
    if (nowHash !== plan.sourceFactsHash) {
      store.setState(input.obligationId, "PLAN_CHANGED", input.now);
      return out({ state: "PLAN_CHANGED", refusal: "PLAN_CHANGED", detail: "source facts changed after approval", providerWriteIssued: false, planHash });
    }
  }

  // --- 6. simulate. NOT a safety boundary (#1959) ------------------------
  const stepIndex = input.steps.length - 1;
  const body = { chainId: policy.chainId, ...input.steps[stepIndex] };
  store.setState(input.obligationId, "PAYMENT_PREFLIGHT", input.now);
  try {
    const sim = await provider.simulate({ ...body, simulate: true });
    if (sim.transactionHash) {
      // A dry run returned a hash: it really executed. Treat as a real send, never retry.
      store.setState(input.obligationId, "EVIDENCE_CONFLICT", input.now);
      store.audit(input.obligationId, "system", "SIMULATE_LEAKED_EXECUTION", { hash: sim.transactionHash });
      return out({
        state: "EVIDENCE_CONFLICT",
        refusal: "SIMULATE_EXECUTED",
        detail: `dry run returned tx ${sim.transactionHash} — the platform executed a simulate call (#1959)`,
        providerWriteIssued: true,
        txHash: sim.transactionHash,
        planHash,
      });
    }
    if (sim.wouldRevert) {
      store.setState(input.obligationId, "SIMULATION_BLOCKED", input.now);
      return out({ state: "SIMULATION_BLOCKED", refusal: "SIMULATION_BLOCKED", detail: "payment would revert", providerWriteIssued: false, planHash });
    }
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : "simulate_failed";
    store.setState(input.obligationId, "SIMULATION_BLOCKED", input.now);
    return out({ state: "SIMULATION_BLOCKED", refusal: code, detail: `preflight unavailable: ${code}`, providerWriteIssued: false, planHash });
  }

  // --- 7. commit the attempt BEFORE sending -------------------------------
  const key = idempotencyKey(input.obligationId, planHash, stepIndex);
  const { attemptId } = store.openAttempt({
    obligationId: input.obligationId,
    planHash,
    stepIndex,
    idempotencyKey: key,
    endpoint: "/api/execute/contract-call",
    bodyJson: JSON.stringify(body),
    now: input.now,
  });

  // --- 8. send, but only if this attempt has never been sent --------------
  //
  // The load-bearing guard. Without it, a still-valid plan whose provider idempotency cache
  // has lapsed (>24h) re-enters here, reuses the same attempt row, calls execute() again,
  // and the provider — having forgotten the key — pays a second time. Local durable state,
  // not the provider's cache, is what makes this exactly-once.
  const priorAttempt = store.getAttempt(attemptId);
  if (priorAttempt && priorAttempt.firstSendAt !== null) {
    store.enqueue({
      kind: "OBSERVE_EXECUTION",
      dedupeKey: `observe:${planHash}:${stepIndex}`,
      obligationId: input.obligationId,
      attemptId,
      dueAt: input.now + 5_000,
    });
    store.audit(input.obligationId, "system", "REFUSED_RESEND", {
      attemptId,
      firstSendAt: priorAttempt.firstSendAt,
      outcome: priorAttempt.outcome,
    });
    return out({
      state: "EXECUTION_OUTCOME_UNKNOWN",
      refusal: "ALREADY_DISPATCHED",
      detail:
        `step ${stepIndex} of this plan was already dispatched at ${priorAttempt.firstSendAt}` +
        ` (execution ${priorAttempt.executionId ?? "unknown"}); checking that execution,` +
        " no new payment submitted",
      providerWriteIssued: false,
      txHash: priorAttempt.txHash ?? undefined,
      planHash,
    });
  }

  store.setState(input.obligationId, "PAYMENT_EXECUTING", input.now);
  store.markSent(attemptId, input.now);
  let executed;
  try {
    executed = await provider.execute(body, key);
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : "unknown";
    if (code === "idempotency_conflict") {
      // Same key, different body. An integrity incident: never rotate the key to succeed.
      store.recordOutcome(attemptId, { outcome: "INTEGRITY_CONFLICT" });
      store.setState(input.obligationId, "EVIDENCE_CONFLICT", input.now);
      return out({ state: "EVIDENCE_CONFLICT", refusal: "IDEMPOTENCY_CONFLICT", detail: "provider holds a different body for this key", providerWriteIssued: true, planHash });
    }
    store.recordOutcome(attemptId, { outcome: "UNKNOWN" });
    store.setState(input.obligationId, "EXECUTION_OUTCOME_UNKNOWN", input.now);
    store.enqueue({ kind: "OBSERVE_EXECUTION", dedupeKey: `observe:${planHash}:${stepIndex}`, obligationId: input.obligationId, attemptId, dueAt: input.now + 5_000 });
    return out({
      state: "EXECUTION_OUTCOME_UNKNOWN",
      refusal: "EXECUTION_OUTCOME_UNKNOWN",
      detail: `no confirmation from provider (${code}); checking the existing execution, no new payment submitted`,
      providerWriteIssued: true,
      planHash,
    });
  }

  if (executed.status === "failed") {
    // #1840: a cached failure replays forever. A new payment needs a new approved plan.
    store.recordOutcome(attemptId, { outcome: "FAILED", executionId: executed.executionId });
    store.setState(input.obligationId, "EXECUTION_OUTCOME_UNKNOWN", input.now);
    return out({
      state: "EXECUTION_OUTCOME_UNKNOWN",
      refusal: executed.idempotentReplay ? "CACHED_FAILURE" : "EXECUTION_FAILED",
      detail: executed.idempotentReplay
        ? "provider is replaying a cached failure for this key (#1840); a retry cannot succeed and the key must not be rotated"
        : "provider reported failure",
      providerWriteIssued: true,
      planHash,
    });
  }

  store.recordOutcome(attemptId, { outcome: "SENT", executionId: executed.executionId, txHash: executed.transactionHash });
  store.setState(input.obligationId, "CHAIN_PENDING", input.now);

  // --- 9. independent chain evidence -------------------------------------
  if (!executed.transactionHash) {
    store.setState(input.obligationId, "EXECUTION_OUTCOME_UNKNOWN", input.now);
    return out({ state: "EXECUTION_OUTCOME_UNKNOWN", refusal: "NO_HASH", detail: "provider reported success without a hash", providerWriteIssued: true, planHash });
  }
  const receipt = await deps.provider.receipt(executed.transactionHash);
  if (receipt.receiptStatus === "reverted") {
    store.setState(input.obligationId, "EXECUTION_REVERTED", input.now);
    return out({ state: "EXECUTION_REVERTED", refusal: "EXECUTION_REVERTED", detail: "receipt says reverted", providerWriteIssued: true, txHash: receipt.hash, planHash });
  }
  if (!receipt.verified || receipt.receiptStatus !== "success") {
    // Provider claims completion the chain does not corroborate. Not settled.
    store.setState(input.obligationId, "EVIDENCE_CONFLICT", input.now);
    return out({ state: "EVIDENCE_CONFLICT", refusal: "EVIDENCE_CONFLICT", detail: `provider says ${executed.status} but receipt is ${receipt.receiptStatus}`, providerWriteIssued: true, txHash: receipt.hash, planHash });
  }
  assertTransition("CHAIN_PENDING", "CHAIN_CONFIRMED");
  store.setState(input.obligationId, "CHAIN_CONFIRMED", input.now);

  // --- 10. reconcile with Request itself ---------------------------------
  store.setState(input.obligationId, "RECONCILING", input.now);
  const paid = await deps.sourceSaysPaid(input.requestId, receipt.hash);
  if (!paid) {
    store.setState(input.obligationId, "RECONCILIATION_PENDING", input.now);
    store.enqueue({ kind: "RECONCILE_SOURCE", dedupeKey: `reconcile:${planHash}`, obligationId: input.obligationId, dueAt: input.now + 15_000 });
    return out({ state: "RECONCILIATION_PENDING", detail: "paid on chain, Request has not indexed it yet", providerWriteIssued: true, txHash: receipt.hash, planHash });
  }

  store.setState(input.obligationId, "SETTLED", input.now);
  store.audit(input.obligationId, "system", "SETTLED", { txHash: receipt.hash });
  return out({ state: "SETTLED", detail: "chain receipt and Request reconciliation agree", providerWriteIssued: true, txHash: receipt.hash, planHash, restatement });
}
