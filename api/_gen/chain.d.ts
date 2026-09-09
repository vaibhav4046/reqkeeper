/**
 * Independent chain reads. Nothing here talks to the execution provider, deliberately:
 * these are the functions that get to contradict it.
 */
export declare const DEFAULT_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
export declare function rpcCall(rpcUrl: string, method: string, params: unknown[], timeoutMs?: number): Promise<unknown>;
export interface PaymentSighting {
    readonly found: boolean;
    readonly txHash?: string;
    readonly amount?: string;
    /** How far back the scan actually looked. A false with a small window is not "unpaid". */
    readonly scannedBlocks?: number;
    readonly truncated?: boolean;
}
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
}): Promise<PaymentSighting>;
export declare function currentBlock(rpcUrl?: string): Promise<number>;
