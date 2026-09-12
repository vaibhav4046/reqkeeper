/**
 * Independent chain reads. Nothing here talks to the execution provider, deliberately:
 * these are the functions that get to contradict it.
 */
export declare const DEFAULT_RPC: string;
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
 * The five non-indexed words: tokenAddress, to, amount, feeAmount, feeAddress.
 *
 * There is no offset placeholder among them. An indexed dynamic parameter is removed from
 * `data` entirely rather than replaced, which is why `amount` is word 2 and not word 3 — a
 * detail worth stating, because a comment in this file used to claim otherwise and the next
 * person to "fix" the correct offset would have broken every amount check at once.
 */
export declare function decodePaymentLogFields(data: string): PaymentLogFields | null;
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
