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
/** Why the exclusion could not be proven. Each one is "I do not know", never "no". */
export type ExclusionGap = 
/** No payer account is configured, so there is no nonce to reason about. See `payerAddress`. */
"NO_PAYER_CONFIGURED"
/** The row predates the column, or the nonce could not be read before the dry run. */
 | "NO_PREFLIGHT_NONCE"
/** The RPC would not answer now. Unreadable is not unchanged. */
 | "NONCE_UNREADABLE"
/** The nonce is where it was. The leak may still be pending and mineable. */
 | "NONCE_UNCHANGED"
/** The nonce moved, but the scan stopped short of the block that proves it. */
 | "SCAN_BEHIND_PROOF";
export type LeakExclusion = {
    readonly kind: "NONCE_CONSUMED";
    readonly payer: string;
    readonly preflightNonce: number;
    readonly observedNonce: number;
    /** The scan had to reach at least this far for the proof to cover the same blocks. */
    readonly provenThroughBlock: number;
} | {
    readonly kind: "NOT_PROVEN";
    readonly code: ExclusionGap;
    readonly detail: string;
};
/** The payer's nonce and the chain head, read together and read first. */
export interface PayerReading {
    readonly payer: string;
    /** `eth_getTransactionCount(payer, "latest")` — mined transactions only, never "pending". */
    readonly nonce: number;
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
export declare function payerAddress(env?: NodeJS.ProcessEnv): string | undefined;
/**
 * Decide whether the leak is excluded, from readings the caller has already taken.
 *
 * Pure, so the decision can be tested without a chain. Every branch that is not a proof returns
 * `NOT_PROVEN` with the reason, and the caller's switch is exhaustive.
 */
export declare function excludeByNonce(input: {
    /** Taken before the scan. Undefined when there is no payer, or the read threw. */
    readonly reading: PayerReading | undefined;
    /** `eth_getTransactionCount(payer, "latest")` as the dry run was about to run. */
    readonly preflightNonce: number | null;
    /** The scan's own ceiling. Undefined means the reader did not say, which is not a number. */
    readonly scannedTo: number | undefined;
    /** Whether a payer is configured at all, so the gap can name the real cause. */
    readonly payerConfigured: boolean;
}): LeakExclusion;
