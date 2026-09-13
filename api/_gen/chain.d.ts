/**
 * Independent chain reads. Nothing here talks to the execution provider, deliberately:
 * these are the functions that get to contradict it.
 */
import type { PayerReading } from "./exclusion.ts";
export declare const DEFAULT_RPC: string;
/**
 * The endpoints a negative has to be put to before it counts, exported so that anything drawing a
 * conclusion from silence uses the same set this module does.
 *
 * A verification script that asks one endpoint and believes an empty `eth_getLogs` reproduces the
 * exact defect this module was built around — measured against this project's own payment, which
 * publicnode returns zero logs for and two other endpoints return in full.
 */
export declare const negativeCorroborationEndpoints: () => readonly string[];
/**
 * `TransferWithReferenceAndFee`'s `paymentReference` is an INDEXED bytes parameter, so the
 * topic is the keccak hash of the reference bytes, not the bytes themselves. Getting this
 * wrong returns zero logs and looks exactly like "not paid yet".
 */
export declare const EVENT_TOPIC: string;
/**
 * Sepolia. Hardcoded rather than configurable, because every address, selector and piece of
 * recorded evidence in this repository is Sepolia's, and "it read the wrong chain" is not a
 * failure mode worth leaving open for a convenience nobody asked for.
 */
export declare const EXPECTED_CHAIN_ID = 11155111;
export declare function assertChainId(rpcUrl: string, expected?: number): Promise<void>;
export declare function referenceTopic(reference: string): string;
export declare function rpcCall(rpcUrl: string, method: string, params: unknown[], timeoutMs?: number): Promise<unknown>;
/**
 * Every non-indexed field of `TransferWithReferenceAndFee`.
 *
 * The reference alone was the only thing ever compared, and the reference is public: it is
 * derived from data anchored openly on Sepolia, so anyone can read one off-chain and emit a
 * fee-proxy event carrying it. Reconciling on the reference means accepting that event as
 * proof this invoice was paid.
 */
export interface PaymentLogFields {
    readonly tokenAddress: string;
    readonly to: string;
    readonly amount: string;
    readonly feeAmount: string;
    readonly feeAddress: string;
}
export interface PaymentSighting extends Partial<PaymentLogFields> {
    readonly found: boolean;
    readonly txHash?: string;
    readonly block?: number;
    /** How far back the scan actually looked. A false with a small window is not "unpaid". */
    readonly scannedBlocks?: number;
    /** The lowest block the scan reached. With `truncated: false` there is nothing below it to find. */
    readonly scannedFrom?: number;
    /**
     * The scan could not cover the window in which a payment for this obligation could
     * plausibly be, so `found: false` means "I could not tell", never "unpaid".
     *
     * This used to mean "the scan did not start at genesis", which on a live chain is every
     * scan there has ever been: head 11692278 with the standard 300k lookback puts the floor at
     * 11392278, so `truncated` was permanently true and every negative was inconclusive. The
     * floor that actually settles the question is the invoice's own anchor block — a payment
     * cannot predate the invoice it pays — which callers pass as `anchorBlock`.
     */
    readonly truncated?: boolean;
    /**
     * A second, independent endpoint returned the same transaction for this reference.
     * `found: true` without this is one endpoint's unverified word, and one endpoint has been
     * observed answering wrongly in both directions.
     */
    readonly corroborated?: boolean;
    /**
     * Set when a log carried this reference but disagreed about the payment itself.
     *
     * NOT automatically EVIDENCE_CONFLICT, which is what this comment used to say. The
     * ERC20FeeProxy is permissionless and payment references derive from data anchored openly on
     * Sepolia, so anyone can emit a log carrying this reference that pays somebody else. Treating
     * every such log as an integrity incident would move the obligation to a human-only terminal
     * state, which means one junk log could permanently suppress any invoice -- exactly the grief
     * `src/watch.ts` refuses for the same reason.
     *
     * For the dominant case, a third party's log, the invoice genuinely IS unpaid and paying it
     * once is correct. The case that deserves escalation is narrower: a log whose token and payee
     * match this invoice but whose amount or fee does not, because that is our own money moving
     * under this reference in a shape we did not plan. `conflictVerdict` below is that test,
     * and it is what the worker branches on.
     */
    readonly conflicts?: readonly string[];
    /** The same disagreements as `conflicts`, classified, for callers that must branch on them. */
    readonly conflictKinds?: readonly ConflictKind[];
    /**
     * The highest block this scan covered.
     *
     * `eth_getLogs` does not see the mempool. A dry run that leaked (#1959) and is still pending is
     * invisible to a scan that honestly covered its whole window and honestly reports
     * `truncated: false` -- so "I looked everywhere and found nothing" is not the same statement as
     * "nothing was broadcast". The difference is AGE: absence only becomes evidence once enough
     * chain has passed since the send could have happened. A caller that knows when the send could
     * have happened compares it against this.
     */
    readonly scannedTo?: number;
}
/** What a log has to say before it counts as paying THIS obligation. */
export interface PaymentExpectation {
    readonly tokenAddress: string;
    readonly to: string;
    readonly amount: string;
    readonly feeAmount?: string;
    readonly feeAddress?: string;
}
/**
 * Does this log actually pay this obligation?
 *
 * Emitter, token, payee, amount and fee — not the reference alone. A log that matches the
 * reference but not the fields is somebody else's transaction, and reporting it as settlement
 * is how an obligation ends up citing a payment it never made. Returns the disagreements
 * rather than a bare false, because "which field" is the difference between an attack, a
 * misconfiguration and a rounding bug.
 */
export type ConflictKind = "emitter" | "token" | "to" | "amount" | "fee" | "feeAddress";
export declare function matchPaymentLog(log: PaymentLogFields & {
    readonly emitter?: string;
}, expect: PaymentExpectation): {
    ok: boolean;
    conflicts: string[];
    kinds: ConflictKind[];
};
/**
 * Is this a log that paid OUR payee in OUR token under our reference, but for the wrong amount or
 * fee?
 *
 * The distinction decides whether an obligation is released or escalated, and getting it wrong is
 * costly in both directions. Escalate on every conflicting log and anyone who can read a public
 * payment reference can wedge any invoice for ever with one junk log. Release on every conflicting
 * log and a dry run that leaked (#1959) with different fields gets paid a second time, out of our
 * own funds.
 *
 * Nobody else has a reason to pay our payee, in our token, under our reference. That shape is our
 * money moving in a plan we did not make, and it is the one that belongs in front of a human.
 */
/**
 * Three answers, not two: this log is ours and wrong, it is somebody else's, or nobody checked.
 *
 * This returned a boolean, and `undefined` — a reader that never populated the field — took the
 * same branch as "no conflicting log was seen". Both released. `scanForReference` now always
 * states the list, so an absent one can only come from a reader that did not conclude, and that
 * is not something to release on.
 */
export type ConflictVerdict = "OURS_AND_WRONG" | "NOT_OURS" | "UNKNOWN";
export declare function conflictVerdict(sighting: {
    readonly conflictKinds?: readonly ConflictKind[];
}): ConflictVerdict;
/**
 * What a chain read ESTABLISHED about a payment, as three mutually exclusive answers.
 *
 * `PaymentSighting` carries `found`, `truncated`, `corroborated` and `conflicts`, and five call
 * sites combined them five different ways. Every duplicate-payment finding in this project has
 * been one of those combinations getting it wrong, in one direction or the other:
 *
 *   - `found === true` alone → a forged log paying somebody else read as settlement
 *   - `found === false` alone → "I could not look" read as "not paid"
 *   - `truncated !== true` → an absent flag read as a conclusive scan
 *   - `found || truncated !== true` → the permissive inverse, on the hosted surface
 *   - conflicts discarded → a log paying the wrong amount read as no payment at all
 *
 * The dry-run path had exactly this shape and was fixed by giving it a union with an exhaustive
 * switch (`SimulateOutcome`). That fix was never carried across to the chain-read path, which is
 * where the remaining instances have all been found. This is the same repair, applied here.
 *
 * The three answers are deliberately NOT "paid / not paid / error". `UNKNOWN` is the normal
 * outcome of reading a distributed system through a public endpoint, and it is the one every
 * caller has to handle explicitly, because it is the one that has been silently collapsing into
 * "no".
 */
export type PaymentVerdict = 
/** A log corroborated against what this obligation actually owes. Safe to treat as settlement. */
{
    readonly kind: "PAID";
    readonly txHash: string;
    readonly block?: number;
}
/**
 * The scan covered the whole window in which a payment could exist and there was none. Only
 * ever returned when the caller supplied the floor that makes coverage provable.
 */
 | {
    readonly kind: "NOT_PAID";
    readonly scannedFrom?: number;
    readonly scannedTo?: number;
}
/**
 * Anything else, and there are more ways to land here than to land anywhere else: a scan that
 * ran out of window, a log that carries the reference but disagrees about the payment, a
 * positive no second endpoint would corroborate, or a read that could not be made at all.
 *
 * Never a licence to send, and never a licence to release an obligation either.
 */
 | {
    readonly kind: "UNKNOWN";
    readonly reason: "TRUNCATED" | "CONFLICTS" | "UNCORROBORATED" | "UNREADABLE";
    readonly detail: string;
    readonly conflicts?: readonly string[];
    readonly conflictKinds?: readonly ConflictKind[];
};
/**
 * The single place a sighting becomes a decision.
 *
 * `requireCorroboration` is for callers deciding whether to treat a payment as THIS obligation's
 * settlement, where an uncorroborated positive must not count. A caller merely reporting what is
 * on chain passes false and gets the sighting's own word.
 */
export declare function verdictFor(sighting: PaymentSighting | null | undefined, opts?: {
    readonly requireCorroboration?: boolean;
}): PaymentVerdict;
/**
 * The five non-indexed words: tokenAddress, to, amount, feeAmount, feeAddress.
 *
 * There is no offset placeholder among them. An indexed dynamic parameter is removed from
 * `data` entirely rather than replaced, which is why `amount` is word 2 and not word 3 — a
 * detail worth stating, because a comment in this file used to claim otherwise and the next
 * person to "fix" the correct offset would have broken every amount check at once.
 */
export declare function decodePaymentLogFields(data: string): PaymentLogFields | null;
export declare const DEFAULT_LOOKBACK = 450000;
/**
 * Request Network's payment detection, as a direct chain read: find the ERC20FeeProxy event
 * carrying this payment reference. This is the same evidence Request's own indexer uses, so
 * agreeing with it does not depend on Request's API being up.
 *
 * Scans backwards from head in permitted chunks and stops at the first hit, because a payment
 * we care about is almost always recent. `truncated` says whether the window ran out before it
 * reached the block below which there is nothing to find — a `found: false` with
 * `truncated: true` means "not seen", never "unpaid".
 */
export declare function findPaymentByReference(reference: string, opts?: {
    rpcUrl?: string;
    fromBlock?: number;
    lookbackBlocks?: number;
    /**
     * The block the invoice itself is anchored at. A payment cannot predate the invoice it
     * pays, so this is the floor below which there is nothing to find — supply it and a
     * `found: false` is an answer rather than a shrug. The scan is extended down to it when
     * the requested window stops short, because a window that cannot reach the anchor cannot
     * settle the question, and its cost is bounded by the invoice's own age.
     */
    anchorBlock?: number;
    /**
     * The payment this obligation is owed. Supplied by every caller that can decide money;
     * without it a log is matched on its reference alone, which is what made a foreign
     * transaction look like settlement.
     */
    expect?: PaymentExpectation;
}): Promise<PaymentSighting>;
export declare function currentBlock(rpcUrl?: string): Promise<number>;
/**
 * The payer's mined nonce, and the head it was true at.
 *
 * `"latest"` and never `"pending"`. A pending count includes the very transaction we are trying
 * to exclude, so it would move on the strength of the leak itself and read as proof that the leak
 * cannot happen -- the exact inversion this exists to prevent. Only mined transactions spend a
 * nonce irreversibly.
 *
 * Nonce first, head second. The transactions that advanced the nonce to this value were mined at
 * or below the head read immediately afterwards, so `head` is a sound upper bound on "the block
 * by which this was true" -- which is what the log scan then has to cover. See src/exclusion.ts.
 */
export declare function readPayerNonce(payer: string, rpcUrl?: string): Promise<PayerReading>;
/** The raw JSON-RPC receipt, as the node returns it. */
export interface RawReceipt {
    status?: string;
    gasUsed?: string;
    to?: string;
    blockNumber?: string;
    logs?: Array<{
        address?: string;
        data?: string;
        topics?: string[];
    }>;
}
/**
 * The one receipt reader, for every transport.
 *
 * There were four private copies of this, and each one had to learn separately that publicnode
 * answers `result: null` for receipts it still holds. The MCP provider was the last to keep its
 * own `fetch`, so on that transport a pruned null still became `not_found`, which settle reads
 * as EVIDENCE_CONFLICT — a real settlement reported as missing, for the wrong reason, on the
 * path that had just moved money.
 *
 * Reads more than `{status, gasUsed}`: the transaction's own target, its own logs, and how far
 * behind head its block is. The real execution shape is a meta-transaction, so the fee proxy
 * appears only as a log emitter nested inside a forwarder's transaction — and a forwarder that
 * does not bubble an inner revert returns status 0x1 regardless. Without the logs, "the
 * transaction succeeded" and "the payment happened" are indistinguishable here.
 */
export declare function readReceipt(rpcUrl: string, hash: string, timeoutMs?: number): Promise<{
    hash: string;
    verified: boolean;
    receiptStatus: "success" | "reverted" | "not_found" | "timeout";
    gasUsed: string;
    to?: string;
    logs?: Array<{
        address?: string;
        data?: string;
        topics?: string[];
    }>;
    blockNumber?: number;
    confirmations?: number;
}>;
