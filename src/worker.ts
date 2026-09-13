/**
 * The thing that drains the outbox.
 *
 * The store has always written jobs in the same transaction as the attempt they belong to,
 * and nothing ever read them back. That made the outbox a log, not a queue: an obligation
 * that ended in RECONCILIATION_PENDING or EXECUTION_OUTCOME_UNKNOWN stayed there forever,
 * because the only code that could resolve it was the settle path, and re-entering the
 * settle path is exactly what those states forbid. Every one of them was a permanent
 * unknown, which is a worse failure than a refusal: the money moved and nothing closed
 * the loop.
 *
 * So resolution is a separate reader with its own rule: it may only look. It reads chain
 * receipts and asks Request whether it has indexed the payment. It has no provider write
 * path at all, which is what makes it safe to run on a timer — the worst a bug here can do
 * is fail to advance a state, never pay twice.
 */

import { isTerminal, type State } from "./machine.ts";
import type { ExecutionProvider } from "./provider.ts";
import { belowConfirmationDepth } from "./provider.ts";
import { amountOrFeeConflict } from "./chain.ts";
import { excludeByNonce, payerAddress, type PayerReading } from "./exclusion.ts";
import type { PaymentExpectation, PaymentSighting } from "./chain.ts";
import type { Fence, Job, Store } from "./store.ts";

export interface WorkerDeps {
  readonly store: Store;
  /** Only `receipt` is used. The worker never calls execute or simulate. */
  readonly provider: Pick<ExecutionProvider, "receipt">;
  /** The same independent reconciliation settle uses: this transaction, this invoice. */
  readonly sourceSaysPaid: (requestId: string, txHash: string) => Promise<boolean>;
  /**
   * Find a payment by its reference, for an attempt that was sent but never recorded.
   *
   * Optional because the fixture provider has no chain behind it. Without it, a process that
   * dies between `markSent` and `recordOutcome` leaves the obligation in PAYMENT_EXECUTING
   * with no transaction hash and no way out: it is not replannable, and no observation has
   * anything to observe. The reference is the one identifier that survives the crash.
   */
  /**
   * The payer's mined nonce and the head it was true at, for excluding a leaked dry run.
   *
   * Optional the same way `sightPayment` is: a deployment that cannot read it does not get the
   * automatic release, it gets an obligation waiting for an operator. That is the fail-safe
   * direction and the only one available -- there is no reading of "I could not check" that
   * justifies a second payment.
   */
  readonly readPayerNonce?: (payer: string) => Promise<PayerReading>;
  /**
   * The account whose nonce excludes a leaked dry run. Defaults to `REQKEEPER_PAYER_ADDRESS`.
   *
   * Injectable rather than read from the environment at the point of use, so that the property
   * -- "a conclusive negative needs a consumed nonce" -- can be exercised without a process-wide
   * variable, and so the one place that decides it is visible in the dependency list.
   */
  readonly payer?: string;
  readonly findPaidReference?: (
    reference: string,
    expect?: PaymentExpectation,
  ) => Promise<{ txHash?: string; amount?: string } | null>;
  /**
   * A full chain sighting, with its own uncertainty attached.
   *
   * `findPaidReference` answers "here is a payment" or `null`, and `null` conflates "the chain
   * says no" with "I could not tell". That is fine for recovering a hash — a retry costs
   * nothing — but it is not enough to decide whether a simulation that died mid-flight ever
   * executed. Concluding "nothing happened" from an inconclusive read is precisely how a second
   * payment gets authorised, so that decision needs `found`, `truncated` and `corroborated`.
   *
   * An implementation that cannot bound its scan cannot produce a conclusive negative, and the
   * obligation stays where it is: `truncated` is only false when the scan reached a floor below
   * which a payment for this obligation could not exist, which in practice means passing the
   * invoice's `anchorBlock` to `findPaymentByReference`. A lookback alone, however large, leaves
   * PREFLIGHT_UNAVAILABLE unreachable — deliberately, because nothing else here can vouch for it.
   */
  /**
   * Reads the chain for a payment carrying this reference.
   *
   * `anchorBlock` is the invoice's own anchor: a payment for an invoice cannot predate the
   * invoice, so it is the floor below which a silence is conclusive. An implementation that
   * ignores it reports every negative as truncated, which leaves PREFLIGHT_UNAVAILABLE
   * unreachable and every failed dry run wedged forever. Safety without liveness is not
   * recovery, and this parameter is the difference.
   */
  readonly sightPayment?: (
    reference: string,
    expect?: PaymentExpectation,
    anchorBlock?: number,
  ) => Promise<PaymentSighting>;
}

export interface DrainResult {
  readonly claimed: number;
  readonly completed: number;
  readonly deferred: number;
  readonly advanced: ReadonlyArray<{ obligationId: string; from: State; to: State }>;
}

/**
 * Read at call time rather than at import, so a test or an operator can change it without
 * reloading the module. Same default and same env var as the settle path, deliberately: two
 * places deciding depth differently is how one of them quietly stops mattering.
 */
function minConfirmations(): number {
  return Math.max(1, Number(process.env.REQKEEPER_MIN_CONFIRMATIONS ?? "2") || 2);
}

/** How long a job waits before another look. Chain and indexer both need a moment. */
const RETRY_MS = 15_000;
const LEASE_MS = 30_000;

/**
 * One pass over the due jobs. Returns what moved, so a caller can log it or assert on it.
 *
 * Never throws for a job-level problem: a job that cannot be resolved yet is deferred with
 * its reason, and the pass continues. A stale fencing generation means another worker owns
 * the job now, which is also not an error — it is the fence doing its job.
 */
export async function drainOnce(
  deps: WorkerDeps,
  opts: { now: number; limit?: number; lookaheadMs?: number },
): Promise<DrainResult> {
  const { store } = deps;
  const jobs = store.claimJobs({
    limit: opts.limit ?? 25,
    now: opts.now,
    leaseMs: LEASE_MS,
    dueBy: opts.now + (opts.lookaheadMs ?? 0),
  });

  let completed = 0;
  let deferred = 0;
  const advanced: Array<{ obligationId: string; from: State; to: State }> = [];

  for (const job of jobs) {
    try {
      const moved = await resolveJob(deps, job, opts.now);
      advanced.push(...moved.advanced);
      if (moved.done) {
        store.completeJob(job.id, job.fencingGeneration);
        completed++;
      } else {
        store.deferJob(job.id, opts.now + RETRY_MS, moved.reason ?? "NOT_READY", job.fencingGeneration);
        deferred++;
      }
    } catch (e) {
      const code = (e as Error & { code?: string }).code;
      if (code === "STALE_FENCE") continue; // another worker owns it; nothing to do
      try {
        store.deferJob(job.id, opts.now + RETRY_MS, code ?? "WORKER_ERROR", job.fencingGeneration);
        deferred++;
      } catch {
        // Lost the lease while handling the error. The live worker will pick it up.
      }
    }
  }

  return { claimed: jobs.length, completed, deferred, advanced };
}

interface Resolution {
  readonly done: boolean;
  readonly reason?: string;
  readonly advanced: ReadonlyArray<{ obligationId: string; from: State; to: State }>;
}

/**
 * Find the transaction for an obligation whose attempt has no recorded hash.
 *
 * The reference is the identifier that survives a lost reply — it is derived from the invoice,
 * it is in the fee-proxy log, and it is the same question Request's own detection asks. The
 * amount is checked as well as the reference, because a log carrying this reference for a
 * different value is somebody else's transaction, and accepting it here is how an obligation
 * ends up citing a payment it never made.
 */
async function findByReference(
  deps: WorkerDeps,
  obligation: {
    readonly paymentReference: string | null;
    readonly invoiceBaseUnits: string | null;
    readonly expectation?: PaymentExpectation | null;
  },
): Promise<string | undefined> {
  if (!deps.findPaidReference || !obligation.paymentReference) return undefined;
  // The expectation is handed down so the chain read can match token, payee and fee as well
  // as the reference. The amount check below stays regardless: a lookup that ignores the
  // expectation must not silently become a reference-only match.
  const seen = await deps.findPaidReference(obligation.paymentReference, obligation.expectation ?? undefined);
  if (!seen?.txHash) return undefined;
  if (obligation.invoiceBaseUnits !== null && seen.amount !== obligation.invoiceBaseUnits) return undefined;
  return seen.txHash;
}

async function resolveJob(deps: WorkerDeps, job: Job, now: number): Promise<Resolution> {
  const { store } = deps;
  const obligation = store.obligationForRecovery(job.obligationId);
  if (!obligation) return { done: true, advanced: [] }; // nothing to resolve; drop the job

  // A settled or closed obligation has nothing left to observe. Without this the job is
  // deferred forever: every pass reads a good receipt, tries to move a terminal state, and
  // is refused by the machine. The outbox would never drain for exactly the obligations
  // that finished correctly.
  if (isTerminal(obligation.state)) return { done: true, advanced: [] };

  // Every write below carries the lease this worker holds. Fencing used to protect the job row
  // and nothing else, so a worker whose lease expired could still rewrite the obligation's
  // state and the attempt's recorded evidence while another worker owned the job — it could not
  // finish the job, but it could corrupt what the job was about. The generation now travels
  // with the write and is checked inside the same transaction, so a stale worker writes nothing
  // and `drainOnce` catches STALE_FENCE and moves on.
  const fence: Fence = { jobId: job.id, generation: job.fencingGeneration };

  const advanced: Array<{ obligationId: string; from: State; to: State }> = [];
  const move = (to: State): void => {
    const from = store.obligationForRecovery(job.obligationId)?.state;
    if (from === undefined || from === to) return;
    store.setState(job.obligationId, to, now, fence);
    advanced.push({ obligationId: job.obligationId, from, to });
  };

  // --- OBSERVE_PREFLIGHT: did a simulation that never came back actually execute? ------
  //
  // Committed before `simulate`, cancelled the moment the settle path gets past it under its own
  // power. Surviving to be claimed means the process died inside the simulation: the obligation
  // is stuck in PAYMENT_PREFLIGHT, which is not replannable, with no attempt row and nothing
  // else queued. Zero sends and, before this existed, zero ways forward.
  //
  // The question is not "may we retry" but "did anything happen", and the chain is the only
  // thing that knows. Nothing here can send.
  if (job.kind === "OBSERVE_PREFLIGHT") {
    if (obligation.state !== "PAYMENT_PREFLIGHT") return { done: true, advanced };
    // Something was dispatched after all: the dispatch and observation jobs own this now, and
    // they reason about a payment rather than about whether one exists.
    if (store.sentAttemptFor(job.obligationId)) return { done: true, advanced };
    if (!deps.sightPayment || !obligation.paymentReference) {
      return { done: false, reason: "CANNOT_OBSERVE", advanced };
    }

    // Read before the scan, never after. See the exclusion block below for why the order is the
    // whole proof. A read that throws leaves `reading` undefined, which is "I could not tell".
    const payer = deps.payer ?? payerAddress();
    let reading: PayerReading | undefined;
    if (payer && deps.readPayerNonce) {
      try {
        reading = await deps.readPayerNonce(payer);
      } catch {
        reading = undefined;
      }
    }

    const sighting = await deps.sightPayment(
      obligation.paymentReference,
      obligation.expectation ?? undefined,
      obligation.anchorBlock ?? undefined,
    );

    if (sighting.found) {
      // The dry run executed for real (#1959). Money moved with no attempt row behind it, which
      // is an integrity incident, not a settlement — a human has to look at it.
      // No attempt row exists to hang the hash on — nothing ever intended to send — so the
      // audit trail carries it. EVIDENCE_CONFLICT is an open investigation, not a settlement:
      // the hash is here for the human who has to reconcile it, and no code path will treat it
      // as permission to do anything.
      move("EVIDENCE_CONFLICT");
      store.audit(job.obligationId, "worker", "SIMULATE_LEAKED_EXECUTION", {
        txHash: sighting.txHash ?? null,
        via: "preflight observation",
      });
      return { done: true, advanced };
    }

    // Absence only counts when the read could actually see the whole window in which a payment
    // for this obligation could be — which is the window down to the invoice's anchor block, not
    // down to genesis. A scan that stopped short is "I could not tell", and "I could not tell"
    // must never become "go ahead", so the obligation waits here rather than being released.
    // Only an EXPLICIT `truncated: false` releases. This read `=== true` and released on
    // anything else, including a reader that simply did not say -- while the already-paid
    // gate in src/mcp.ts requires the explicit false. Two sites, two opposite readings of the
    // same absent flag, and this is the site that releases an obligation. No production
    // reader can currently omit it (`findPaymentByReference` has one negative exit and always
    // sets it), so this is hardening rather than a live hole -- but the next implementation
    // of `sightPayment` should not be able to reintroduce the whole class by forgetting a
    // field.
    if (sighting.truncated !== false) return { done: false, reason: "SCAN_TRUNCATED", advanced };

    // Covered the window is not the same as: the leak can no longer be mined.
    //
    // Two earlier answers stood here and both were wrong in the same direction. The first read
    // the scan's own silence as evidence -- but `eth_getLogs` reads blocks, and a leaked
    // transaction sitting in the mempool is not in one. The second measured elapsed chain
    // (`scannedTo >= preflightBlock + minConfirmations()`) and an adversarial pass proved it
    // costs money: it measures how far the chain has moved, while what has to be excluded is how
    // long a transaction can sit pending, which has no bound at all. Ten thousand blocks later a
    // low-fee leak is still mineable, and the gate had grown MORE willing to release, not less.
    // Two physical sends on one human approval. test/mempool-residency.test.ts is that repro.
    //
    // Both were the same defect: a value meaning "I do not know" consumed as "no". Eight
    // instances now, and what has worked every time is changing the shape of the answer rather
    // than tightening a threshold. So there is no threshold here. A transaction is bound to a
    // nonce and a nonce is spent once: when another transaction is mined at the nonce the leak
    // would have used, the leak is permanently unmineable by every node. That is a fact about
    // the payment, and unlike a timer it does not decay.
    //
    // The reading is taken BEFORE the scan, so the scan's ceiling is guaranteed to cover the
    // block the proof is anchored at. Taken afterwards it would prove exclusion over blocks the
    // scan never looked at.
    const exclusion = excludeByNonce({
      reading,
      preflightNonce: obligation.preflightNonce,
      scannedTo: sighting.scannedTo,
      payerConfigured: payer !== undefined,
    });
    switch (exclusion.kind) {
      case "NONCE_CONSUMED":
        break; // proven dead; fall through to the release below
      case "NOT_PROVEN":
        // No timeout and no escalating retry. An unexcluded leak waits for a human, because the
        // only thing worse than an invoice that is late is an invoice that is paid twice.
        return { done: false, reason: `LEAK_NOT_EXCLUDED:${exclusion.code}`, advanced };
      default: {
        const exhaustive: never = exclusion;
        return exhaustive;
      }
    }

    // A conflicting log usually means a stranger paid somebody else under our public reference,
    // and the invoice is genuinely unpaid: release, and let it be proposed once. Escalating on
    // every conflict would let one junk log wedge any invoice for ever.
    //
    // The exception is a log that matches this invoice's token AND payee but disagrees about the
    // amount or the fee. Nobody else has a reason to pay our payee, in our token, under our
    // reference: that shape is our own money moving in a plan we did not make -- the #1959 leak
    // executing with different fields -- and releasing on it is a double spend of our funds.
    if (amountOrFeeConflict(sighting)) {
      move("EVIDENCE_CONFLICT");
      store.audit(job.obligationId, "worker", "PAYMENT_FIELDS_DISAGREE", {
        conflicts: sighting.conflicts ?? null,
        txHash: sighting.txHash ?? null,
        reason: "a log paying this invoice's token and payee disagreed about amount or fee",
      });
      return { done: true, advanced };
    }

    // Nothing carrying this reference paid this invoice, across the full window. The simulation
    // did not execute, so the debt simply stands unattempted and may be proposed again.
    move("PREFLIGHT_UNAVAILABLE");
    const heldBy = store.getObligation(job.obligationId)?.reservedByPlan;
    const release = heldBy ? store.releaseObligation(job.obligationId, heldBy) : { released: false };
    store.audit(job.obligationId, "worker", "PREFLIGHT_UNAVAILABLE", {
      reason: "no payment for this reference on chain; the simulation did not execute",
      scannedBlocks: sighting.scannedBlocks ?? null,
      conflicts: sighting.conflicts ?? null,
      released: release.released,
    });
    return { done: true, advanced };
  }

  // A dispatch job exists only so the attempt is durable before the send. The send itself is
  // inline in settle, so this job is done once the attempt records any outcome at all.
  if (job.kind === "DISPATCH_STEP") {
    const attempt = job.attemptId === null ? undefined : store.getAttempt(job.attemptId);
    if (attempt?.outcome) return { done: true, advanced };

    // Sent, but no outcome was ever written: the process died inside the send. The money may
    // have moved. The only honest way to find out is to look for the reference on chain.
    if (attempt?.firstSendAt && obligation.state === "PAYMENT_EXECUTING") {
      if (!deps.findPaidReference || !obligation.paymentReference) {
        move("EXECUTION_OUTCOME_UNKNOWN");
        return { done: false, reason: "CANNOT_OBSERVE", advanced };
      }
      const recovered = await findByReference(deps, obligation);
      if (recovered) {
        // Recording the send enqueues OBSERVE_EXECUTION in the same transaction, so the
        // hand-off cannot be lost between these two writes.
        store.recordOutcome(attempt.id, { outcome: "SENT", txHash: recovered, now, fence });
        move("CHAIN_PENDING");
        return { done: true, advanced };
      }
      // Nothing on chain yet. Not "unpaid" — unknown, and it stays unknown until it is seen.
      move("EXECUTION_OUTCOME_UNKNOWN");
      return { done: false, reason: "NOT_SEEN_ON_CHAIN", advanced };
    }

    return { done: false, reason: "AWAITING_DISPATCH", advanced };
  }

  const attempt = store.sentAttemptFor(job.obligationId);
  if (!attempt) return { done: false, reason: "NO_ATTEMPT_SENT", advanced };

  // --- OBSERVE_EXECUTION: the chain is the authority on what happened -----
  if (job.kind === "OBSERVE_EXECUTION") {
    if (!attempt.txHash) {
      // Sent, but no hash was ever recorded: the provider answered success without one, or the
      // reply was lost. There is nothing to read a receipt for, so without this the job defers
      // forever and a real payment sits unobserved. The reference is the way back to the hash.
      const recovered = await findByReference(deps, obligation);
      if (!recovered) return { done: false, reason: "NO_TX_HASH", advanced };
      store.recordOutcome(attempt.id, { outcome: "SENT", txHash: recovered, now, fence });
      move("CHAIN_PENDING");
      // Deferred rather than completed: the next pass reads the receipt with the hash in hand.
      return { done: false, reason: "HASH_RECOVERED", advanced };
    }

    // A crash between recording the send and recording CHAIN_PENDING leaves the obligation one
    // step behind its own evidence. Catch it up before reading the receipt.
    if (obligation.state === "PAYMENT_EXECUTING") move("CHAIN_PENDING");

    // This job is enqueued in the same transaction that records the send, so on an uninterrupted
    // run it exists while the settle path is still going and reads the receipt inline. By the
    // time the job is claimed the obligation can already be past the point this job exists to
    // reach. The job asks that SOMEBODY observe the execution, not that this worker be the one
    // who does, so a state beyond observation completes it rather than driving an illegal move.
    const current = store.obligationForRecovery(job.obligationId)?.state;
    const awaitingObservation =
      current === "CHAIN_PENDING" || current === "EXECUTION_OUTCOME_UNKNOWN" || current === "CHAIN_CONFIRMED";
    if (!awaitingObservation) {
      // Past observation but not finished. A crash between the receipt read and the
      // reconciliation answer lands here — RECONCILING with an empty outbox, a real payment,
      // and nothing left that would ever look again. Hand off instead of closing the loop.
      store.enqueue({
        kind: "RECONCILE_SOURCE",
        dedupeKey: `reconcile:${attempt.planHash}`,
        obligationId: job.obligationId,
        dueAt: now,
        now,
        fence,
      });
      return { done: true, reason: "ALREADY_OBSERVED", advanced };
    }

    const receipt = await deps.provider.receipt(attempt.txHash);
    if (receipt.receiptStatus === "reverted") {
      move("EXECUTION_REVERTED");
      return { done: true, advanced };
    }
    if (!receipt.verified || receipt.receiptStatus !== "success") {
      return { done: false, reason: "RECEIPT_NOT_FINAL", advanced };
    }
    move("CHAIN_CONFIRMED");
    // Confirmed is not settled. Hand off to reconciliation rather than closing here.
    store.enqueue({
      kind: "RECONCILE_SOURCE",
      dedupeKey: `reconcile:${attempt.planHash}`,
      obligationId: job.obligationId,
      dueAt: now,
      now,
      fence,
    });
    return { done: true, advanced };
  }

  // --- RECONCILE_SOURCE: Request must agree, about THIS transaction -------
  if (job.kind === "RECONCILE_SOURCE") {
    if (!attempt.txHash) return { done: false, reason: "NO_TX_HASH", advanced };

    // The chain is re-read here rather than trusted from the earlier pass. Between the send
    // and this job the transaction can have been reorged out or found reverted, and a source
    // that says "paid" against a receipt that says "reverted" must never produce SETTLED.
    const receipt = await deps.provider.receipt(attempt.txHash);
    if (receipt.receiptStatus === "reverted") {
      move("EVIDENCE_CONFLICT");
      move("EXECUTION_REVERTED");
      return { done: true, advanced };
    }
    if (!receipt.verified || receipt.receiptStatus !== "success") {
      return { done: false, reason: "RECEIPT_NOT_FINAL", advanced };
    }

    // Depth, here too. Without it the settle path's gate is decorative: it hands the obligation
    // to this job, and this job settles it one block deep anyway.
    if (belowConfirmationDepth(receipt, minConfirmations())) {
      move("RECONCILING");
      move("RECONCILIATION_PENDING");
      return { done: false, reason: "AWAITING_CONFIRMATIONS", advanced };
    }

    move("RECONCILING");
    const paid = await deps.sourceSaysPaid(obligation.requestId, attempt.txHash);
    if (!paid) {
      move("RECONCILIATION_PENDING");
      return { done: false, reason: "SOURCE_NOT_INDEXED", advanced };
    }
    move("SETTLED");
    store.audit(job.obligationId, "worker", "SETTLED", { txHash: attempt.txHash });
    return { done: true, advanced };
  }

  return { done: false, reason: "UNKNOWN_JOB_KIND", advanced };
}

/**
 * Drain until nothing moves or the budget runs out.
 *
 * Deliberately bounded: a settlement loop that can spin forever is a settlement loop that
 * can spin forever in production too.
 */
export async function drainUntilQuiet(
  deps: WorkerDeps,
  opts: { now: number; maxPasses?: number; stepMs?: number; lookaheadMs?: number },
): Promise<DrainResult[]> {
  const passes: DrainResult[] = [];
  const step = opts.stepMs ?? RETRY_MS;
  let now = opts.now;
  for (let i = 0; i < (opts.maxPasses ?? 5); i++) {
    const r = await drainOnce(deps, { now, lookaheadMs: opts.lookaheadMs });
    passes.push(r);
    if (r.claimed === 0) break;
    now += step;
  }
  return passes;
}
