/**
 * The dispatch protocol. One function owns the order of checks, because the order IS the
 * safety property: everything that can refuse must refuse before the attempt is committed,
 * and nothing may reach the provider without a durable attempt row behind it.
 */

import { decodePaymentLogFields, matchPaymentLog, type PaymentExpectation } from "./chain.ts";
import { canReplan, type State } from "./machine.ts";
import { ERC20_FEE_PROXY, decodeAllowedCall } from "./calldata-gate.ts";
import { idempotencyKey, obligationId, planHash as hashPlan, policyHash as hashPolicy, sourceFactsHash } from "./identity.ts";
import { checkPolicy, type Policy, type SourceFacts } from "./policy.ts";
import { toHuman } from "./money.ts";
import type { ExecutionProvider, SimulateOutcome } from "./provider.ts";
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
    // Hex, folded, so the plan hash addresses the EFFECT rather than one spelling of it.
    //
    // `steps[].data` used to go into the hash verbatim while the payment reference beside it
    // was folded. Two plans whose calldata differed only in hex case therefore produced two
    // plan hashes, and so two provider idempotency keys, for one identical on-chain effect.
    // Blocked today by reserveObligation and canReplan, which is a defence one layer away from
    // the thing that is wrong; it becomes a live lever the moment either is relaxed, or the
    // moment a path reaches derivePlan without a reservation.
    //
    // Folding here does not weaken the calldata gate. That gate is byte identity between the
    // approved bytes and the dispatched bytes, and it still runs on `p.steps` exactly as given
    // — only the hash input is normalised, and hex is case-insensitive by definition, so two
    // spellings are one instruction to the chain.
    steps: p.steps.map((step) => ({
      ...step,
      to: step.to.toLowerCase(),
      data: step.data.toLowerCase(),
    })),
    sourceFactsHash: p.sourceFactsHash,
    policyHash: hashPolicy(p.policy),
  };
  return { planBody, planHash: hashPlan(planBody) };
}

/**
 * The refusal a second proposer of the same debt is supposed to get.
 *
 * Shared between the pre-read at step 0 and the insert that follows it, because under a race
 * they are two different ways of discovering the same fact and a caller should not be able to
 * tell which one fired.
 */
function referenceAlreadyClaimed(
  paymentReference: string,
  holder: { obligationId: string; state: string } | undefined,
): SettleOutcome {
  const who = holder
    ? `obligation ${holder.obligationId.slice(0, 12)}… (${holder.state})`
    : "another obligation";
  return out({
    state: "OBLIGATION_RESERVED",
    refusal: "REFERENCE_ALREADY_CLAIMED",
    detail:
      `payment reference ${paymentReference} already belongs to ${who}; this is the same debt ` +
      "under a different request id",
    providerWriteIssued: false,
  });
}

/**
 * Turn a lost race into the refusal it should have been, or return null to rethrow.
 *
 * `settleObligation` reads state and then acts on it in a separate statement, three times over:
 * the reference check at step 0 then the insert at 0c, the state read at 0b then `replan` at
 * step 1, and `replan` then `setState` at step 4. Two processes proposing the same debt at the
 * same millisecond therefore lose in one of three places, and a red-team probe showed what the
 * loser actually got in 39 of 40 trials: a raw
 * `UNIQUE constraint failed: obligations.payment_reference` thrown out of the function, or a
 * bare transition error — instead of `REFERENCE_ALREADY_CLAIMED`, and with no audit row under
 * the right code.
 *
 * The money invariant held throughout: `execute()` was called exactly once in all 40 trials.
 * This is about the refusal surface and the audit trail, not about safety. Every branch below
 * is a refusal that costs zero sends, and anything not recognised here is rethrown, so a real
 * bug still surfaces as a real bug rather than being dressed up as a polite refusal.
 */
function refusalForLostRace(e: unknown, store: Store, input: SettleInput): SettleOutcome | null {
  const message = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string } | undefined)?.code;

  if (/UNIQUE constraint failed:\s*obligations\.payment_reference/i.test(message)) {
    const holder = store.obligationForReference(input.paymentReference);
    store.audit(input.obligationId, "system", "REFUSED", {
      code: "REFERENCE_ALREADY_CLAIMED",
      heldBy: holder?.obligationId ?? null,
      via: "lost the race to the unique index",
    });
    return referenceAlreadyClaimed(input.paymentReference, holder);
  }

  // The winner finished between our read and our write. Both of these mean the same thing to a
  // caller: somebody else is already past the point of no return on this debt.
  if (code === "REPLAN_REFUSED" || code === "ILLEGAL_TRANSITION") {
    const state = store.getObligation(input.obligationId)?.state as State | undefined;
    store.audit(input.obligationId, "system", "REFUSED_REENTRY", { state: state ?? null, via: code });
    return out({
      state: state ?? "OBLIGATION_RESERVED",
      refusal: state === "SETTLED" ? "ALREADY_SETTLED" : "ALREADY_DISPATCHED",
      detail:
        `another process reached ${state ?? "this obligation"} while this one was still ` +
        "planning; a payment past that point is resolved by observing the one that was sent, " +
        "never by proposing another. Nothing sent.",
      providerWriteIssued: false,
    });
  }

  return null;
}


/**
 * Minimum confirmations before a payment may be called settled.
 *
 * There was no finality concept in this codebase at all: a receipt one block deep settled
 * exactly like a receipt a hundred blocks deep, and nothing re-checked afterwards. On Sepolia a
 * shallow reorg is not theoretical. Nobody has to attack this — they wait for it, and then
 * dispute a settlement whose transaction is no longer there.
 *
 * Two is the default rather than something larger because the honest claim this project makes
 * is "confirmed by an independently read receipt plus the fee-proxy event for the same
 * transaction and the same amount", and depth is a second, separate axis. Raise it with
 * REQKEEPER_MIN_CONFIRMATIONS where a deployment wants more.
 *
 * Insufficient depth is NOT a refusal. It is RECONCILIATION_PENDING with a job, which is the
 * state this system already has for "true, but not yet provable" — the worker re-reads and
 * finishes it. What it must never be is SETTLED.
 */
const MIN_CONFIRMATIONS = Math.max(1, Number(process.env.REQKEEPER_MIN_CONFIRMATIONS ?? "2") || 2);

/**
 * Does this transaction's OWN receipt contain the payment?
 *
 * The execution shape here is a meta-transaction: `to` is a forwarder, `from` is a relayer, and
 * the ERC20FeeProxy appears only as a log emitter nested inside someone else's transaction. A
 * forwarder that does not bubble an inner revert returns `status: 0x1` regardless, which is
 * precisely the shape in which "the transaction succeeded" and "the payment happened" come
 * apart. Reconciliation catches that by scanning for the reference, but the receipt already
 * carries the answer and it costs nothing to insist on it.
 *
 * Returns null when the transport supplies no logs — a fixture has no chain behind it, and a
 * check that cannot run must not masquerade as a check that passed.
 */
function receiptDisagreesWithPayment(
  receipt: { logs?: ReadonlyArray<{ address?: string; data?: string; topics?: string[] }> },
  expect: PaymentExpectation,
): string | null {
  if (!receipt.logs) return null;
  const candidates = receipt.logs.filter((l) => l.address && sameAddress(l.address, ERC20_FEE_PROXY));
  if (candidates.length === 0) {
    return "the receipt carries no ERC20FeeProxy event, so this transaction did not pay the invoice";
  }
  const conflicts: string[] = [];
  for (const log of candidates) {
    const fields = log.data ? decodePaymentLogFields(log.data) : null;
    if (!fields) continue;
    const verdict = matchPaymentLog({ ...fields, emitter: log.address }, expect);
    if (verdict.ok) return null;
    conflicts.push(verdict.conflicts.join("; "));
  }
  return `the receipt's own fee-proxy event does not pay this invoice: ${conflicts.join(" | ") || "unreadable event data"}`;
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Settle one obligation, or refuse, exactly once.
 *
 * The wrapper exists because losing a race is not an error. `settleObligation` reads state and
 * then acts on it in five separate places — the reference index, `replan`, the approval
 * transition, `beginPreflight`, and the dispatch guard — and under a real N-way race the loser
 * can be overtaken at any of them. Each one was guarded individually as it showed up in a race
 * artifact, which meant every new one was found by a judge-shaped process rather than by the
 * code. The fifth (`illegal transition PAYMENT_PREFLIGHT -> AWAITING_APPROVAL`, once per fifty
 * workers) made the pattern obvious enough to stop patching sites.
 *
 * `refusalForLostRace` recognises lost races by their SIGNATURE, not by where they happened, so
 * one wrapper covers every site including ones not written yet. Anything it does not recognise
 * is rethrown, so a real bug still surfaces as a real bug rather than being dressed up as a
 * polite refusal. Every branch it returns costs zero sends.
 *
 * The money invariant never depended on this: across 40 two-process races and a 50-worker run,
 * `provider.execute()` was called exactly once. What this fixes is the refusal surface and the
 * audit trail.
 */
export async function settleObligation(deps: SettleDeps, input: SettleInput): Promise<SettleOutcome> {
  try {
    return await settleOrRefuse(deps, input);
  } catch (e) {
    const refused = refusalForLostRace(e, deps.store, input);
    if (refused) return refused;
    throw e;
  }
}

async function settleOrRefuse(deps: SettleDeps, input: SettleInput): Promise<SettleOutcome> {
  const { store, provider, policy } = deps;
  const factsHash = sourceFactsHash(input.facts);

  // --- 0. one payment reference is one debt -------------------------------
  //
  // The request id is free text supplied by the caller. Two spellings of one invoice used to
  // produce two obligations, two approvals and two sends of the same payment. The reference
  // is derived from the invoice by Request, so it is the identity that actually binds.
  {
    const holder = store.obligationForReference(input.paymentReference);
    // The identity the whole duplicate defence rests on: obligationId is DERIVED from the
    // namespace and the Request id (src/identity.ts), so a caller that supplies one which does not
    // derive from the pair it also supplied is describing two different debts at once. Nothing
    // downstream re-checks it -- the reference index, the reservation and the idempotency key all
    // trust this id -- so a mismatched pair could open a second obligation for an invoice that
    // already has one, and pay it again. It costs one hash to refuse.
    const derived = obligationId(input.namespace, input.requestId);
    if (derived !== input.obligationId) {
      store.audit(input.obligationId, "system", "REFUSED", {
        code: "OBLIGATION_ID_MISMATCH",
        derived,
        supplied: input.obligationId,
      });
      return out({
        state: "IMPORTED",
        refusal: "OBLIGATION_ID_MISMATCH",
        detail:
          `the obligation id does not derive from this namespace and request id: expected ${derived}. ` +
          `One invoice is one obligation, and the id is a function of the invoice, never an argument.`,
        providerWriteIssued: false,
      });
    }

    if (holder && holder.obligationId !== input.obligationId) {
      store.audit(input.obligationId, "system", "REFUSED", {
        code: "REFERENCE_ALREADY_CLAIMED",
        heldBy: holder.obligationId,
      });
      return referenceAlreadyClaimed(input.paymentReference, holder);
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
  // State and the observation that will come looking, committed together. See store.beginPreflight.
  store.beginPreflight(input.obligationId, planHash, input.now);
  // --- 6b. the dry run, as a disposition rather than a pair of booleans ----
  //
  // Four duplicate-payment findings in three adversarial rounds all had the same shape: a caller
  // reading a flag that could mean "I do not know" as though it meant "no". They were fixed one
  // at a time, and each round found the next one, so the shape of the data is the defect. The
  // provider now returns a `SimulateOutcome`, this switch is exhaustive, and the `never`
  // assignment at the end makes a fifth outcome a compile error instead of a payment.
  //
  // The line that matters runs between EXECUTED/WOULD_REVERT -- the provider told us something --
  // and UNKNOWN, which includes a timeout, a 4xx, an HTML error page, `{"success": false}` and a
  // body with no verdict in it. Only the first kind may release the obligation.
  let outcome: SimulateOutcome;
  try {
    outcome = await provider.simulate({ ...body, simulate: true });
  } catch (e) {
    // A throw is an UNKNOWN like any other: the call may or may not have broadcast, and nothing
    // reachable from here can tell. It is emphatically NOT "the provider refused the plan".
    const code = e instanceof ProviderError ? e.code : "simulate_failed";
    outcome = { kind: "UNKNOWN", code, detail: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }

  switch (outcome.kind) {
    case "EXECUTED": {
      // #1959: the dry run really executed. Money moved with no attempt row behind it, which is
      // an integrity incident and never a settlement. A human has to look at it.
      store.setState(input.obligationId, "EVIDENCE_CONFLICT", input.now);
      store.audit(input.obligationId, "system", "SIMULATE_EXECUTED", { txHash: outcome.transactionHash });
      return out({
        state: "EVIDENCE_CONFLICT",
        refusal: "SIMULATE_EXECUTED",
        detail: `dry run returned tx ${outcome.transactionHash} — the platform executed a simulate call (#1959)`,
        providerWriteIssued: true,
        txHash: outcome.transactionHash,
        planHash,
      });
    }

    case "WOULD_REVERT": {
      // A verdict. The provider ran the dry run and the payment reverts, so nothing was
      // broadcast: end the observation, hand the reservation back, let a corrected plan come.
      store.setState(input.obligationId, "SIMULATION_BLOCKED", input.now);
      store.endPreflight(planHash);
      store.releaseObligation(input.obligationId, planHash);
      return out({ state: "SIMULATION_BLOCKED", refusal: "SIMULATION_BLOCKED", detail: outcome.detail, providerWriteIssued: false, planHash });
    }

    case "UNKNOWN": {
      // No verdict, from any cause. The reservation stays held and OBSERVE_PREFLIGHT stays
      // queued, because the chain is the only thing that can answer this and the job to go and
      // ask it was committed in the same transaction as PAYMENT_PREFLIGHT. The resolver either
      // finds the leaked execution (EVIDENCE_CONFLICT, for a human) or establishes across the
      // whole window that nothing carrying this reference paid this invoice, and only then
      // releases to PREFLIGHT_UNAVAILABLE. A truncated scan stays unresolved, because "I could
      // not tell" must never become "go ahead".
      store.audit(input.obligationId, "system", "PREFLIGHT_OUTCOME_UNKNOWN", {
        code: outcome.code,
        reason: outcome.detail,
      });
      return out({
        state: "PAYMENT_PREFLIGHT",
        refusal: "EXECUTION_OUTCOME_UNKNOWN",
        detail:
          `the dry run did not come back with a verdict (${outcome.code}). Whether it executed is ` +
          `not known here, and a dry run that executed can still have moved money. The reservation ` +
          `is held and an observation is queued: run the resolver (npm run resolve, or the MCP ` +
          `resolve_pending tool) to settle the question from the chain. Do not propose this ` +
          `obligation again until it has.`,
        providerWriteIssued: false,
        planHash,
      });
    }

    case "WOULD_SUCCEED":
      // The only outcome that continues to the dispatch below.
      break;

    default: {
      // Unreachable while the union is fully handled. If someone adds a fifth outcome, this stops
      // compiling -- which is the entire reason the disposition is a union and not a boolean.
      const exhaustive: never = outcome;
      throw new Error(`unhandled simulate outcome: ${JSON.stringify(exhaustive)}`);
    }
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
  //
  // It is one statement, deliberately. Reading `firstSendAt` and then stamping it is a
  // test-and-set across two statements: both callers read null, both pass, and the only thing
  // stopping the second send is that SQLite serialises writers and Node happened not to yield
  // between the two. `markSent` now carries `WHERE first_send_at IS NULL` and reports whether
  // it changed a row, so the claim is decided by the database, not by the scheduler.
  if (!store.markSent(attemptId, input.now)) {
    const priorAttempt = store.getAttempt(attemptId);
    store.enqueue({
      kind: "OBSERVE_EXECUTION",
      dedupeKey: `observe:${planHash}:${stepIndex}`,
      obligationId: input.obligationId,
      attemptId,
      dueAt: input.now + 5_000,
    });
    store.audit(input.obligationId, "system", "REFUSED_RESEND", {
      attemptId,
      firstSendAt: priorAttempt?.firstSendAt ?? null,
      outcome: priorAttempt?.outcome ?? null,
    });
    return out({
      state: "EXECUTION_OUTCOME_UNKNOWN",
      refusal: "ALREADY_DISPATCHED",
      detail:
        `step ${stepIndex} of this plan was already dispatched at ${priorAttempt?.firstSendAt}` +
        ` (execution ${priorAttempt?.executionId ?? "unknown"}); checking that execution,` +
        " no new payment submitted",
      providerWriteIssued: false,
      txHash: priorAttempt?.txHash ?? undefined,
      planHash,
    });
  }

  store.setState(input.obligationId, "PAYMENT_EXECUTING", input.now);
  let executed;
  try {
    executed = await provider.execute(body, key);
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : "unknown";
    if (code === "idempotency_conflict") {
      // Same key, different body. An integrity incident: never rotate the key to succeed.
      store.recordOutcome(attemptId, { outcome: "INTEGRITY_CONFLICT", now: input.now });
      store.setState(input.obligationId, "EVIDENCE_CONFLICT", input.now);
      return out({ state: "EVIDENCE_CONFLICT", refusal: "IDEMPOTENCY_CONFLICT", detail: "provider holds a different body for this key", providerWriteIssued: true, planHash });
    }
    store.recordOutcome(attemptId, { outcome: "UNKNOWN", now: input.now });
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
    //
    // The hash is recorded when there is one. KeeperHub returns a transaction hash on `failed`
    // whenever the transaction actually reached the chain, so dropping it — which this call
    // used to do — threw away the only identifier that says whether gas was spent and whether
    // the fee proxy was touched. Recording it also enqueues the observation that reads the
    // receipt, so "failed" is checked against the chain rather than believed.
    store.recordOutcome(attemptId, {
      outcome: "FAILED",
      executionId: executed.executionId ?? undefined,
      txHash: executed.transactionHash,
      now: input.now,
    });
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

  store.recordOutcome(attemptId, {
    outcome: "SENT",
    executionId: executed.executionId ?? undefined,
    txHash: executed.transactionHash,
    now: input.now,
  });
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
  // The receipt's own logs have to contain the payment. Bound pre-dispatch is not the same as
  // observed post-dispatch, and a forwarder's success is not the inner call's success.
  const paymentExpectation: PaymentExpectation = {
    tokenAddress: input.facts.tokenAddress,
    to: input.facts.payee,
    amount: input.facts.invoiceBaseUnits,
    feeAmount: input.facts.feeBaseUnits,
    feeAddress: input.facts.feeRecipient,
  };
  const receiptDisagreement = receiptDisagreesWithPayment(receipt, paymentExpectation);
  if (receiptDisagreement) {
    store.setState(input.obligationId, "EVIDENCE_CONFLICT", input.now);
    store.audit(input.obligationId, "system", "RECEIPT_DISAGREES", { txHash: receipt.hash, why: receiptDisagreement });
    return out({
      state: "EVIDENCE_CONFLICT",
      refusal: "EVIDENCE_CONFLICT",
      detail: receiptDisagreement,
      providerWriteIssued: true,
      txHash: receipt.hash,
      planHash,
    });
  }

  store.setState(input.obligationId, "CHAIN_CONFIRMED", input.now);

  // Depth. A receipt one block deep is a receipt that can still be reorged away, and this used
  // to settle on it. Not a refusal — the payment is almost certainly real — but not settlement
  // either, so it waits in the state this system already has for "true, not yet provable".
  if (receipt.confirmations !== undefined && receipt.confirmations < MIN_CONFIRMATIONS) {
    store.setState(input.obligationId, "RECONCILING", input.now);
    store.setState(input.obligationId, "RECONCILIATION_PENDING", input.now);
    store.enqueue({
      kind: "RECONCILE_SOURCE",
      dedupeKey: `reconcile:${planHash}`,
      obligationId: input.obligationId,
      dueAt: input.now + 15_000,
      now: input.now,
    });
    return out({
      state: "RECONCILIATION_PENDING",
      detail:
        `paid on chain at depth ${receipt.confirmations}, and settlement here needs ` +
        `${MIN_CONFIRMATIONS}. A receipt that shallow can still be reorged away. Resolving.`,
      providerWriteIssued: true,
      txHash: receipt.hash,
      planHash,
    });
  }

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
