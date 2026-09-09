/**
 * The dispatch protocol. One function owns the order of checks, because the order IS the
 * safety property: everything that can refuse must refuse before the attempt is committed,
 * and nothing may reach the provider without a durable attempt row behind it.
 */

import { canReplan, type State } from "./machine.ts";
import { ERC20_FEE_PROXY, decodeAllowedCall } from "./calldata-gate.ts";
import { idempotencyKey, planHash as hashPlan, policyHash as hashPolicy, sourceFactsHash } from "./identity.ts";
import { checkPolicy, type Policy, type SourceFacts } from "./policy.ts";
import { toHuman } from "./money.ts";
import type { ExecutionProvider } from "./provider.ts";
import { ProviderError } from "./provider.ts";
import type { Store } from "./store.ts";

export interface SettleInput {
  readonly namespace: string;
  readonly requestId: string;
  /**
   * The invoice's payment reference. This, not the request id, is what the chain carries and
   * what makes two proposals the same debt.
   *
   * Required. It used to be optional, and the live settlement script did not pass it — so on
   * the one path that moved real money the partial UNIQUE index (`WHERE payment_reference IS
   * NOT NULL`) never applied and there was no duplicate defence at all. An optional identity
   * is not an identity.
   */
  readonly paymentReference: string;
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
  /**
   * Independent reconciliation. Must confirm THIS transaction paid THIS amount: a boolean
   * over the payment reference alone accepts a different transaction's evidence, which is
   * how a duplicate obligation reported SETTLED using the first payment's log.
   */
  readonly sourceSaysPaid: (requestId: string, txHash: string) => Promise<boolean>;
  /**
   * How many DISTINCT humans must approve before anything is dispatched.
   *
   * One is the honest default for a single operator. A workspace that wants two pairs of eyes
   * sets two, and one person approving twice still counts once — the store counts distinct
   * approvers, not rows.
   */
  readonly quorum?: number;
}


/**
 * Does the calldata mean something other than the invoice policy just cleared?
 *
 * Returns a sentence naming the disagreement, or null when every step's decoded arguments
 * match the facts. This is the seam the whole project is named for: an approval is a
 * sentence about an invoice, a payment is 260 bytes, and until something compares them the
 * approval is only evidence that a human read a summary.
 */
function calldataDisagreesWithFacts(
  steps: ReadonlyArray<{ kind: string; to: string; data: string; value: string }>,
  facts: SourceFacts,
  totalDebitBaseUnits: string,
  paymentReference?: string,
): string | null {
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  // Section 7 dispatches `steps[steps.length - 1]` and nothing else. A plan whose last step is
  // an allowance therefore reports a settled invoice while the payment was never sent, and an
  // empty plan reserves the obligation forever having authorised nothing. Both are refused
  // here rather than left to be discovered by a payee who was not paid.
  if (steps.length === 0) {
    return "this plan has no steps: approving it would authorise nothing and dispatch nothing";
  }
  const names: string[] = [];

  for (const [i, step] of steps.entries()) {
    let call;
    try {
      call = decodeAllowedCall(step);
    } catch (e) {
      return `step ${i}: ${(e as Error).message}`;
    }

    names.push(call.functionName);

    if (call.functionName === "transferFromWithReferenceAndFee") {
      const [token, payee, amount, reference, fee, feeRecipient] = call.args;
      if (!eq(token, facts.tokenAddress)) return `step ${i} pays in token ${token}, the invoice is in ${facts.tokenAddress}`;
      if (!eq(payee, facts.payee)) return `step ${i} pays ${payee}, the invoice is owed to ${facts.payee}`;
      if (amount !== facts.invoiceBaseUnits) return `step ${i} moves ${amount}, the invoice is ${facts.invoiceBaseUnits}`;
      if (fee !== facts.feeBaseUnits) return `step ${i} pays a fee of ${fee}, the invoice fee is ${facts.feeBaseUnits}`;
      if (!eq(feeRecipient, facts.feeRecipient)) return `step ${i} sends the fee to ${feeRecipient}, not ${facts.feeRecipient}`;
      if (paymentReference !== undefined && !eq(reference, paymentReference)) {
        return `step ${i} carries reference ${reference}, this debt is ${paymentReference}`;
      }
      continue;
    }

    if (call.functionName === "approve") {
      const [spender, amount] = call.args;
      if (!eq(spender, ERC20_FEE_PROXY)) return `step ${i} approves ${spender}, not the payment proxy`;
      if (BigInt(amount) > BigInt(totalDebitBaseUnits)) {
        return `step ${i} approves ${amount}, more than the ${totalDebitBaseUnits} this plan may debit`;
      }
      continue;
    }

    return `step ${i} calls ${call.functionName}, which no invoice authorises`;
  }

  const last = names[names.length - 1];
  if (last !== "transferFromWithReferenceAndFee") {
    return `the last step of this plan is ${last}, but only the last step is dispatched; the payment would never be sent`;
  }
  if (names.filter((n) => n === "transferFromWithReferenceAndFee").length > 1) {
    return "this plan carries more than one payment; one obligation is one payment";
  }
  return null;
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

/**
 * The plan, content-addressed.
 *
 * Exported so a human approval tool can recompute the hash from the invoice itself rather
 * than trusting a hash an agent handed it. If the two disagree, the agent proposed something
 * other than what the human is being shown, and the approval must not be recorded.
 */
export function derivePlan(p: {
  obligationId: string;
  policy: Policy;
  facts: SourceFacts;
  steps: SettleInput["steps"];
  totalDebitBaseUnits: string;
  sourceFactsHash: string;
}): { planBody: Record<string, unknown> & { policyHash: string }; planHash: string } {
  const planBody = {
    obligationId: p.obligationId,
    chainId: p.policy.chainId,
    token: p.policy.token.address.toLowerCase(),
    decimals: p.policy.token.decimals,
    payee: p.facts.payee.toLowerCase(),
    invoiceBaseUnits: p.facts.invoiceBaseUnits,
    feeBaseUnits: p.facts.feeBaseUnits,
    totalDebitBaseUnits: p.totalDebitBaseUnits,
    steps: p.steps,
    sourceFactsHash: p.sourceFactsHash,
    policyHash: hashPolicy(p.policy),
  };
  return { planBody, planHash: hashPlan(planBody) };
}

export async function settleObligation(deps: SettleDeps, input: SettleInput): Promise<SettleOutcome> {
  const { store, provider, policy } = deps;
  const factsHash = sourceFactsHash(input.facts);

  // --- 0. one payment reference is one debt -------------------------------
  //
  // The request id is free text supplied by the caller. Two spellings of one invoice used to
  // produce two obligations, two approvals and two sends of the same payment. The reference
  // is derived from the invoice by Request, so it is the identity that actually binds.
  {
    const holder = store.obligationForReference(input.paymentReference);
    if (holder && holder.obligationId !== input.obligationId) {
      store.audit(input.obligationId, "system", "REFUSED", {
        code: "REFERENCE_ALREADY_CLAIMED",
        heldBy: holder.obligationId,
      });
      return out({
        state: "OBLIGATION_RESERVED",
        refusal: "REFERENCE_ALREADY_CLAIMED",
        detail:
          `payment reference ${input.paymentReference} already belongs to obligation ` +
          `${holder.obligationId.slice(0, 12)}… (${holder.state}); this is the same debt ` +
          "under a different request id",
        providerWriteIssued: false,
      });
    }
  }

  // --- 0b. an obligation whose money already moved is not re-entered ------
  //
  // Without this the pipeline runs again on a settled obligation and setState drags it back
  // to PAYMENT_PREFLIGHT before the later guards refuse, so the money is safe but the
  // recorded state regresses and the agent surface reports a finished payment as
  // pre-dispatch. PLAN_EXPIRED and POLICY_DENIED are terminal too, and a fresh plan for
  // those must still be proposable, so only the money-moved states short-circuit.
  const priorState = store.getObligation(input.obligationId)?.state as State | undefined;
  if (priorState !== undefined && !canReplan(priorState)) {
    store.audit(input.obligationId, "system", "REFUSED_REENTRY", { state: priorState });
    return out({
      state: priorState,
      refusal: priorState === "SETTLED" ? "ALREADY_SETTLED" : "ALREADY_DISPATCHED",
      detail:
        `obligation is already ${priorState}; a payment past this point is resolved by ` +
        "observing the one that was sent, never by proposing another. Nothing sent.",
      providerWriteIssued: false,
    });
  }

  store.importObligation({
    obligationId: input.obligationId,
    namespace: input.namespace,
    requestId: input.requestId,
    sourceFactsJson: JSON.stringify(input.facts),
    sourceFactsHash: factsHash,
    paymentReference: input.paymentReference ?? null,
    now: input.now,
  });
  store.audit(input.obligationId, "agent", "PROPOSED", { requestId: input.requestId });

  // --- 1. policy, before anything else can cost money ---------------------
  //
  // `replan`, not `setState`: a previous refusal is closed forever and this opens a new
  // settlement beside it. It throws for anything past the point of no return, which is the
  // same guard as 0b enforced one layer down, where nothing can route around it.
  store.replan(input.obligationId, input.now);
  const decision = checkPolicy(policy, input.facts);
  if (!decision.ok) {
    const state: State = decision.code === "SOURCE_ALREADY_PAID" ? "SOURCE_ALREADY_PAID" : "POLICY_DENIED";
    store.setState(input.obligationId, state, input.now);
    store.audit(input.obligationId, "system", "REFUSED", { code: decision.code });
    return out({ state, refusal: decision.code, detail: decision.detail, providerWriteIssued: false });
  }

  // --- 1b. the bytes must mean the facts policy just cleared --------------
  //
  // Policy clears an invoice; the provider is handed calldata. Nothing used to compare the
  // two, so a plan could pass every ceiling and still carry bytes paying a different payee.
  // The gate at the provider proves the bytes decode to an allowlisted call — it has no idea
  // what this invoice says. This is the only place both halves are in scope at once.
  const disagreement = calldataDisagreesWithFacts(
    input.steps,
    input.facts,
    decision.totalDebitBaseUnits,
    input.paymentReference,
  );
  if (disagreement) {
    store.setState(input.obligationId, "CALLDATA_MISMATCH", input.now);
    store.audit(input.obligationId, "system", "REFUSED", { code: "CALLDATA_MISMATCH", detail: disagreement });
    return out({
      state: "CALLDATA_MISMATCH",
      refusal: "CALLDATA_MISMATCH",
      detail: disagreement,
      providerWriteIssued: false,
    });
  }

  // --- 2. immutable plan --------------------------------------------------
  const { planBody, planHash } = derivePlan({
    obligationId: input.obligationId,
    policy,
    facts: input.facts,
    steps: input.steps,
    totalDebitBaseUnits: decision.totalDebitBaseUnits,
    sourceFactsHash: factsHash,
  });
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

  // A rejection is permanent for the plan it rejected. Re-asking is how an agent turns a no
  // into a yes by attrition, so the recorded decision is consulted before any new one is
  // taken. A genuinely different plan hashes differently and gets its own hearing.
  const quorum = Math.max(1, deps.quorum ?? 1);
  const priorDecision = store.getApproval(planHash);
  if (priorDecision?.decision === "REJECTED") {
    store.setState(input.obligationId, "REVIEW_REJECTED", input.now);
    store.releaseObligation(input.obligationId, planHash);
    store.audit(input.obligationId, "system", "REFUSED", { code: "REVIEW_REJECTED", planHash });
    return out({
      state: "REVIEW_REJECTED",
      refusal: "REVIEW_REJECTED",
      detail: `${priorDecision.approver} rejected this exact plan; asking again does not change it`,
      providerWriteIssued: false,
      planHash,
    });
  }

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
    // A rejected plan must not hold the invoice hostage. Releasing lets a corrected plan be
    // proposed; without it one bad proposal bricks the debt forever.
    store.releaseObligation(input.obligationId, planHash);
    return out({
      state: "REVIEW_REJECTED",
      refusal: "REVIEW_REJECTED",
      detail: input.approval.reason ?? "rejected by reviewer",
      providerWriteIssued: false,
      planHash,
    });
  }
  // A quorum is counted over distinct approvers of THIS plan hash, so a second signature on
  // a different plan cannot be borrowed to reach the threshold.
  const approvers = store.approversFor(planHash);
  if (approvers.length < quorum) {
    return out({
      state: "AWAITING_APPROVAL",
      refusal: "AWAITING_APPROVAL",
      detail: `this workspace requires ${quorum} approvers; ${approvers.length} so far`,
      providerWriteIssued: false,
      planHash,
      restatement,
    });
  }

  store.setState(input.obligationId, "APPROVED", input.now);

  // --- 5. re-check at the dispatch boundary -------------------------------
  const plan = store.getPlan(planHash);
  if (!plan || input.now > plan.expiresAt) {
    store.setState(input.obligationId, "PLAN_EXPIRED", input.now);
    store.releaseObligation(input.obligationId, planHash);
    return out({ state: "PLAN_EXPIRED", refusal: "PLAN_EXPIRED", detail: "approval expired before dispatch", providerWriteIssued: false, planHash });
  }
  if (input.factsAtDispatch) {
    const nowHash = sourceFactsHash(input.factsAtDispatch);
    if (nowHash !== plan.sourceFactsHash) {
      store.setState(input.obligationId, "PLAN_CHANGED", input.now);
      store.releaseObligation(input.obligationId, planHash);
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
      store.releaseObligation(input.obligationId, planHash);
      return out({ state: "SIMULATION_BLOCKED", refusal: "SIMULATION_BLOCKED", detail: "payment would revert", providerWriteIssued: false, planHash });
    }
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : "simulate_failed";
    const retryable = e instanceof ProviderError && e.retryable;
    store.releaseObligation(input.obligationId, planHash);

    // A 429 is not a revert. Funnelling every preflight error into SIMULATION_BLOCKED — a
    // TERMINAL state whose agent guidance reads "the payment would revert" — turns the
    // platform's rate limit into a permanent refusal and a support ticket blaming the
    // platform for a revert that never happened. A retryable failure leaves the obligation in
    // PAYMENT_PREFLIGHT, which is replannable, so proposing again later is the right move and
    // is the move the agent is told to make.
    if (retryable) {
      store.audit(input.obligationId, "system", "PREFLIGHT_UNAVAILABLE", { code });
      return out({
        state: "PAYMENT_PREFLIGHT",
        refusal: code,
        detail: `preflight unavailable: ${code}. This is the platform being busy, not the payment being wrong — propose again later. Nothing was sent.`,
        providerWriteIssued: false,
        planHash,
      });
    }

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
