/**
 * Proving that a leaked dry run can never become a payment.
 *
 * A `?simulate=true` call that really executes (#1959) and then loses its reply leaves one
 * question open: is there a transaction out there that will pay this invoice? Until that is
 * answered the obligation cannot be released, because releasing it authorises a second payment.
 *
 * Two answers have been tried and both were wrong in the same way.
 *
 *   1. "The scan found nothing." `eth_getLogs` reads blocks. A pending transaction is not in a
 *      block, so an honest, complete, `truncated: false` scan says nothing about it.
 *   2. "Enough chain has passed since the preflight." This measures how far the chain has moved.
 *      What has to be excluded is how long a transaction can sit in the mempool, and there is no
 *      bound on that at all — a low-fee transaction can be mined after any number of blocks. The
 *      gate gets *more* willing to release as time passes, which is backwards.
 *
 * Both read a value that means "I do not know" as though it meant "no". That is the same defect
 * this codebase has now found eight times, and the lesson from the previous seven is that it is
 * fixed by changing the shape of the answer, not by tightening the threshold.
 *
 * So the answer here is not a threshold. A transaction is bound to a nonce, and a nonce is spent
 * exactly once: the moment some *other* transaction from the payer is mined at the nonce the leak
 * would have used, the leak is permanently unmineable. Every node will reject it for ever. That
 * is a fact about the payment rather than about the clock, and it does not decay.
 *
 * The reading order is load-bearing. The nonce and the head are read BEFORE the log scan, so the
 * scan's ceiling is guaranteed to be at or past the block by which the nonce was consumed —
 * which is what makes "the scan found nothing" cover every block the leak could have been mined
 * into. Reading the nonce afterwards would prove the exclusion over a window the scan never saw.
 *
 * When the proof cannot be made, `NOT_PROVEN` says so and names the gap. There is no third
 * option and no timeout: an obligation with an unexcluded leak waits for a human. Refusing to
 * move is a liveness cost measured in one operator action; being wrong here is measured in money.
 */

import { conflictVerdict, type ConflictKind } from "./chain.ts";

/** Why the exclusion could not be proven. Each one is "I do not know", never "no". */
export type ExclusionGap =
  /** No payer account is configured, so there is no nonce to reason about. See `payerAddress`. */
  | "NO_PAYER_CONFIGURED"
  /** The row predates the column, or the nonce could not be read before the dry run. */
  | "NO_PREFLIGHT_NONCE"
  /** The RPC would not answer now. Unreadable is not unchanged. */
  | "NONCE_UNREADABLE"
  /** The nonce is where it was. The leak may still be pending and mineable. */
  | "NONCE_UNCHANGED"
  /** The nonce moved, but the scan stopped short of the block that proves it. */
  | "SCAN_BEHIND_PROOF"
  /** Only one endpoint said no, and one endpoint's silence is not evidence of absence. */
  | "NEGATIVE_UNCORROBORATED"
  /**
   * The payer is shared, so a moved nonce says nothing about THIS transaction's slot.
   * See `payerIsDedicated`.
   */
  | "PAYER_NOT_DEDICATED"
  /** The account had transactions queued when the dry run ran, so the leak's slot is unknown. */
  | "SLOT_UNKNOWN_AT_PREFLIGHT";

export type LeakExclusion =
  | {
      readonly kind: "NONCE_CONSUMED";
      readonly payer: string;
      readonly preflightNonce: number;
      readonly observedNonce: number;
      /** The scan had to reach at least this far for the proof to cover the same blocks. */
      readonly provenThroughBlock: number;
    }
  | { readonly kind: "NOT_PROVEN"; readonly code: ExclusionGap; readonly detail: string };

/** The payer's nonce and the chain head, read together and read first. */
export interface PayerReading {
  readonly payer: string;
  /** `eth_getTransactionCount(payer, "latest")` — mined transactions only, never "pending". */
  readonly nonce: number;
  /**
   * `eth_getTransactionCount(payer, "pending")` — mined plus queued.
   *
   * The difference is the whole proof. A new broadcast takes the PENDING slot, not the mined one,
   * so on an account with anything in flight the leak sits above the mined count and an unrelated
   * transaction mining moves `nonce` past the baseline while the leak is still perfectly
   * mineable. Reading only the mined count is how the first version of this released an
   * obligation whose payment was still live.
   */
  readonly pending: number;
  /** The head at the moment of that reading. Any consuming transaction is at or below it. */
  readonly head: number;
}

/**
 * The account whose nonce excludes the leak, or undefined when the operator has not named one.
 *
 * Not derivable in code: the execution is a meta-transaction, so the account that pays gas and
 * carries the nonce is KeeperHub's relayer, not anything this deployment owns or is told about at
 * plan time. It is discoverable — `eth_getTransactionByHash(<any settled txHash>).from` — and
 * `docs/RUNBOOK.md` says how. It is a deployment-level fact, so it belongs in the environment.
 *
 * Absent means absent. This never falls back to a default address: excluding a leak against the
 * wrong account's nonce would manufacture exactly the false negative the whole module exists to
 * prevent.
 */
export function payerAddress(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.REQKEEPER_PAYER_ADDRESS?.trim();
  if (!raw) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`REQKEEPER_PAYER_ADDRESS is not an address: ${raw.slice(0, 64)}`);
  }
  return raw.toLowerCase();
}

/**
 * Has an operator asserted that nothing else broadcasts from the payer account?
 *
 * Undetectable from outside, and the proof is worthless without it, so it is asked for explicitly
 * and its absence refuses. Default false: a deployment that has not thought about this gets the
 * safe answer.
 */
export function payerIsDedicated(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.REQKEEPER_PAYER_IS_DEDICATED ?? "").trim().toLowerCase() === "true";
}

/**
 * Decide whether the leak is excluded, from readings the caller has already taken.
 *
 * Pure, so the decision can be tested without a chain. Every branch that is not a proof returns
 * `NOT_PROVEN` with the reason, and the caller's switch is exhaustive.
 */
export function excludeByNonce(input: {
  /** Taken before the scan. Undefined when there is no payer, or the read threw. */
  readonly reading: PayerReading | undefined;
  /**
   * The slot the leak would have taken, recorded before the dry run — or null when it could not
   * be pinned down.
   *
   * It is only knowable when the account had NOTHING queued at that moment (`pending === latest`),
   * because then the next broadcast takes exactly that number. With a queue, the leak lands
   * somewhere above it and no later reading of the mined count can say where.
   */
  readonly preflightNonce: number | null;
  /**
   * Whether this deployment is the only thing broadcasting from the payer account.
   *
   * The proof needs it, and the first version of this did not ask. A nonce is spent once, so a
   * slot mined by another transaction kills anything pending in it — but on a SHARED relayer the
   * leak's slot is not the baseline. A reviewer put numbers on it: every settlement in this
   * repository was relayed by one address whose mined nonce went from 25786 to 30078 while this
   * was being built, so "the nonce moved" on that account is a near-certain automatic yes, and a
   * leak still in the mempool would have been declared dead. Two physical payments.
   *
   * There is no way to detect exclusivity from outside, so it is an operator's assertion
   * (`REQKEEPER_PAYER_IS_DEDICATED`) and its absence refuses. KeeperHub's relayer is shared, so
   * this deployment does not get the automatic release and uses the operator path instead —
   * `docs/RUNBOOK.md` says so and `scripts/resolve.ts` prints it.
   */
  readonly payerIsDedicated: boolean;
  /** The scan's own ceiling. Undefined means the reader did not say, which is not a number. */
  readonly scannedTo: number | undefined;
  /** Whether a payer is configured at all, so the gap can name the real cause. */
  readonly payerConfigured: boolean;
}): LeakExclusion {
  const { reading, preflightNonce, scannedTo, payerConfigured } = input;

  if (!payerConfigured) {
    return {
      kind: "NOT_PROVEN",
      code: "NO_PAYER_CONFIGURED",
      detail:
        "no REQKEEPER_PAYER_ADDRESS, so no nonce can be read; a leaked dry run cannot be excluded " +
        "and this obligation needs an operator (see docs/RUNBOOK.md)",
    };
  }
  if (preflightNonce === null) {
    return {
      kind: "NOT_PROVEN",
      code: "NO_PREFLIGHT_NONCE",
      detail: "the payer's nonce before the dry run was never recorded, so there is no baseline to compare against",
    };
  }
  if (!reading) {
    return { kind: "NOT_PROVEN", code: "NONCE_UNREADABLE", detail: "the payer's nonce could not be read now" };
  }
  if (!input.payerIsDedicated) {
    return {
      kind: "NOT_PROVEN",
      code: "PAYER_NOT_DEDICATED",
      detail:
        "the payer account is shared, so a transaction mining in some slot says nothing about the " +
        "slot this deployment's leak would have taken; release it through an operator instead",
    };
  }
  if (reading.nonce <= preflightNonce) {
    return {
      kind: "NOT_PROVEN",
      code: "NONCE_UNCHANGED",
      detail:
        `the payer's nonce is still ${reading.nonce}; a transaction broadcast by the dry run would ` +
        "sit at that nonce and remains mineable, so absence from the chain proves nothing",
    };
  }
  if (scannedTo === undefined || scannedTo < reading.head) {
    return {
      kind: "NOT_PROVEN",
      code: "SCAN_BEHIND_PROOF",
      detail:
        `the nonce advanced by block ${reading.head}, but the scan only reached ` +
        `${scannedTo ?? "an unstated block"}; the transaction that consumed it may carry the payment`,
    };
  }

  // The nonce the leak would have used has been mined by something else, and the scan covered
  // every block up to the point where that was true and found no payment for this reference.
  // Nothing pending can pay this invoice any more.
  return {
    kind: "NONCE_CONSUMED",
    payer: reading.payer,
    preflightNonce,
    observedNonce: reading.nonce,
    provenThroughBlock: reading.head,
  };
}

/**
 * What an operator is allowed to do about an obligation whose dry run never came back.
 *
 * The automatic path needs a spent nonce, which needs a payer address, which a deployment may
 * not have configured — and "waits for a proof that can never be made" is a permanent wedge at
 * zero payments, which is the failure this project has fixed four times in other disguises. So
 * there is a door, and this is the decision behind it.
 *
 * It is a decision, not a switch. The operator's certainty is not evidence: the chain is read
 * first, and a payment that is actually there turns the request into an integrity incident rather
 * than a release. Separated from the CLI so the decision can be tested without a database, a
 * process or a chain.
 */
export type OperatorRelease =
  | { readonly kind: "RELEASE" }
  | { readonly kind: "REFUSE_PAID"; readonly txHash?: string }
  | { readonly kind: "REFUSE_INCONCLUSIVE" }
  /** A log paying this invoice's token and payee disagreed about amount or fee. */
  | { readonly kind: "REFUSE_CONFLICT" }
  /** Only one endpoint returned this negative, and one endpoint's silence is not absence. */
  | { readonly kind: "REFUSE_UNCORROBORATED" }
  | { readonly kind: "REFUSE_STATE"; readonly state: string };

export function operatorReleaseDecision(input: {
  readonly state: string;
  /**
   * The WHOLE sighting, not three fields of it.
   *
   * This took `{found, truncated, txHash}` — and a sighting the worker escalates to
   * EVIDENCE_CONFLICT carries neither `found` nor `truncated` set against it, so it arrived here
   * as a clean negative and this returned RELEASE. `scripts/resolve.ts` then wrote "no payment for
   * this reference on chain" into the audit trail over a log that was paying this invoice's token
   * and payee and disagreeing about the amount — which is our own money moving in a plan nobody
   * made. Two exits from PAYMENT_PREFLIGHT reading one sighting two different ways.
   */
  readonly sighting: {
    readonly found: boolean;
    readonly truncated?: boolean;
    readonly txHash?: string;
    readonly conflictKinds?: readonly ConflictKind[];
    readonly negativeCorroborations?: number;
  };
}): OperatorRelease {
  // Only an obligation actually waiting on a dry run can be released this way. Anything else is
  // either already resolved or in a state whose exit is somewhere else entirely.
  if (input.state !== "PAYMENT_PREFLIGHT") return { kind: "REFUSE_STATE", state: input.state };

  // Checked before the scan's completeness, deliberately: a payment that is visibly there is an
  // answer no matter how little else the scan managed to cover.
  if (input.sighting.found) return { kind: "REFUSE_PAID", txHash: input.sighting.txHash };

  // `truncated` must be an explicit false. Undefined is a reader that did not say, and a reader
  // that did not say is not a reader that said no.
  if (input.sighting.truncated !== false) return { kind: "REFUSE_INCONCLUSIVE" };

  // The same test the worker applies, from the same function, so the two exits cannot disagree —
  // including the third answer. A sighting that never says what conflicting logs it saw has not
  // concluded, and a human cannot release on a scan that did not finish deciding.
  const conflict = conflictVerdict(input.sighting);
  if (conflict === "OURS_AND_WRONG") return { kind: "REFUSE_CONFLICT" };
  if (conflict === "UNKNOWN") return { kind: "REFUSE_INCONCLUSIVE" };

  // One endpoint's "no" is not evidence of absence. publicnode has been observed returning an
  // empty `eth_getLogs` for a fee-proxy log that demonstrably exists and that other endpoints
  // return, with no error — which is why a negative is re-asked at all. What was never recorded
  // is whether anyone ANSWERED: a reviewer showed that "the primary said no and two fallbacks
  // agreed" and "the primary said no and both fallbacks' sockets were destroyed" came back
  // byte-identical, so silence authorised a payment.
  if ((input.sighting.negativeCorroborations ?? 0) < 1) return { kind: "REFUSE_UNCORROBORATED" };

  return { kind: "RELEASE" };
}
