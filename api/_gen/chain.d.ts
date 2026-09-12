/**
 * Independent chain reads. Nothing here talks to the execution provider, deliberately:
 * these are the functions that get to contradict it.
 */
export declare const DEFAULT_RPC: string;
/**
 * Sepolia. Hardcoded rather than configurable, because every address, selector and piece of
 * recorded evidence in this repository is Sepolia's, and "it read the wrong chain" is not a
 * failure mode worth leaving open for a convenience nobody asked for.
 */
export declare const EXPECTED_CHAIN_ID = 11155111;
export declare function assertChainId(rpcUrl: string, expected?: number): Promise<void>;
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
    readonly truncated?: boolean;
    /**
     * A second, independent endpoint returned the same transaction for this reference.
     * `found: true` without this is one endpoint's unverified word, and one endpoint has been
     * observed answering wrongly in both directions.
     */
    readonly corroborated?: boolean;
    /**
     * Set when a log carried this reference but disagreed about the payment itself. This is
     * EVIDENCE_CONFLICT, not "unpaid" and certainly not "paid".
     */
    readonly conflicts?: readonly string[];
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
export declare function matchPaymentLog(log: PaymentLogFields & {
    readonly emitter?: string;
}, expect: PaymentExpectation): {
    ok: boolean;
    conflicts: string[];
};
/**
 * Request Network's payment detection, as a direct chain read: find the ERC20FeeProxy event
 * carrying this payment reference. This is the same evidence Request's own indexer uses, so
 * agreeing with it does not depend on Request's API being up.
 *
 * Scans backwards from head in permitted chunks and stops at the first hit, because a payment
 * we care about is almost always recent. `truncated` says whether the window ran out before
 * genesis — a `found: false` with `truncated: true` means "not seen recently", never "unpaid".
 */
export declare function findPaymentByReference(reference: string, opts?: {
    rpcUrl?: string;
    fromBlock?: number;
    lookbackBlocks?: number;
    /**
     * The payment this obligation is owed. Supplied by every caller that can decide money;
     * without it a log is matched on its reference alone, which is what made a foreign
     * transaction look like settlement.
     */
    expect?: PaymentExpectation;
}): Promise<PaymentSighting>;
export declare function currentBlock(rpcUrl?: string): Promise<number>;
