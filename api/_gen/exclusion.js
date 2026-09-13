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
import { amountOrFeeConflict } from "./chain.js";
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
export function payerAddress(env = process.env) {
    const raw = env.REQKEEPER_PAYER_ADDRESS?.trim();
    if (!raw)
        return undefined;
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
export function payerIsDedicated(env = process.env) {
    return (env.REQKEEPER_PAYER_IS_DEDICATED ?? "").trim().toLowerCase() === "true";
}
/**
 * Decide whether the leak is excluded, from readings the caller has already taken.
 *
 * Pure, so the decision can be tested without a chain. Every branch that is not a proof returns
 * `NOT_PROVEN` with the reason, and the caller's switch is exhaustive.
 */
export function excludeByNonce(input) {
    const { reading, preflightNonce, scannedTo, payerConfigured } = input;
    if (!payerConfigured) {
        return {
            kind: "NOT_PROVEN",
            code: "NO_PAYER_CONFIGURED",
            detail: "no REQKEEPER_PAYER_ADDRESS, so no nonce can be read; a leaked dry run cannot be excluded " +
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
            detail: "the payer account is shared, so a transaction mining in some slot says nothing about the " +
                "slot this deployment's leak would have taken; release it through an operator instead",
        };
    }
    if (reading.nonce <= preflightNonce) {
        return {
            kind: "NOT_PROVEN",
            code: "NONCE_UNCHANGED",
            detail: `the payer's nonce is still ${reading.nonce}; a transaction broadcast by the dry run would ` +
                "sit at that nonce and remains mineable, so absence from the chain proves nothing",
        };
    }
    if (scannedTo === undefined || scannedTo < reading.head) {
        return {
            kind: "NOT_PROVEN",
            code: "SCAN_BEHIND_PROOF",
            detail: `the nonce advanced by block ${reading.head}, but the scan only reached ` +
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
export function operatorReleaseDecision(input) {
    // Only an obligation actually waiting on a dry run can be released this way. Anything else is
    // either already resolved or in a state whose exit is somewhere else entirely.
    if (input.state !== "PAYMENT_PREFLIGHT")
        return { kind: "REFUSE_STATE", state: input.state };
    // Checked before the scan's completeness, deliberately: a payment that is visibly there is an
    // answer no matter how little else the scan managed to cover.
    if (input.sighting.found)
        return { kind: "REFUSE_PAID", txHash: input.sighting.txHash };
    // `truncated` must be an explicit false. Undefined is a reader that did not say, and a reader
    // that did not say is not a reader that said no.
    if (input.sighting.truncated !== false)
        return { kind: "REFUSE_INCONCLUSIVE" };
    // The same test the worker applies, from the same function, so the two exits cannot disagree.
    if (amountOrFeeConflict(input.sighting))
        return { kind: "REFUSE_CONFLICT" };
    return { kind: "RELEASE" };
}
