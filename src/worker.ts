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
import type { Job, Store } from "./store.ts";

export interface WorkerDeps {
  readonly store: Store;
  /** Only `receipt` is used. The worker never calls execute or simulate. */
  readonly provider: Pick<ExecutionProvider, "receipt">;
  /** The same independent reconciliation settle uses: this transaction, this invoice. */
  readonly sourceSaysPaid: (requestId: string, txHash: string) => Promise<boolean>;
}

export interface DrainResult {
  readonly claimed: number;
  readonly completed: number;
  readonly deferred: number;
  readonly advanced: ReadonlyArray<{ obligationId: string; from: State; to: State }>;
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

async function resolveJob(deps: WorkerDeps, job: Job, now: number): Promise<Resolution> {
  const { store } = deps;
  const obligation = store.obligationForRecovery(job.obligationId);
  if (!obligation) return { done: true, advanced: [] }; // nothing to resolve; drop the job

  // A settled or closed obligation has nothing left to observe. Without this the job is
  // deferred forever: every pass reads a good receipt, tries to move a terminal state, and
  // is refused by the machine. The outbox would never drain for exactly the obligations
  // that finished correctly.
  if (isTerminal(obligation.state)) return { done: true, advanced: [] };

  const advanced: Array<{ obligationId: string; from: State; to: State }> = [];
  const move = (to: State): void => {
    const from = store.obligationForRecovery(job.obligationId)?.state;
    if (from === undefined || from === to) return;
    store.setState(job.obligationId, to, now);
    advanced.push({ obligationId: job.obligationId, from, to });
  };

  // A dispatch job exists only so the attempt is durable before the send. The send itself is
  // inline in settle, so this job is done once the attempt records any outcome at all.
  if (job.kind === "DISPATCH_STEP") {
    const attempt = job.attemptId === null ? undefined : store.getAttempt(job.attemptId);
    if (attempt?.outcome) return { done: true, advanced };
    return { done: false, reason: "AWAITING_DISPATCH", advanced };
  }

  const attempt = store.sentAttemptFor(job.obligationId);
  if (!attempt) return { done: false, reason: "NO_ATTEMPT_SENT", advanced };

  // --- OBSERVE_EXECUTION: the chain is the authority on what happened -----
  if (job.kind === "OBSERVE_EXECUTION") {
    if (!attempt.txHash) return { done: false, reason: "NO_TX_HASH", advanced };
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
