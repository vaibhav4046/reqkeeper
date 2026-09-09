/**
 * Deterministic policy. No LLM runs here, and nothing in this file reads the clock except
 * where a caller passes the time in explicitly.
 *
 * Every refusal returns a stable code plus a detail string safe to show a human. The codes
 * are the rows of the refusal table that the submission is scored on, so they are part of
 * the contract, not debug output.
 */
export type RefusalCode = "UNSUPPORTED_CHAIN" | "UNSUPPORTED_TOKEN" | "TOKEN_DECIMALS_MISMATCH" | "PAYEE_NOT_ALLOWED" | "LIMIT_EXCEEDED" | "SOURCE_ALREADY_PAID" | "FEE_RECIPIENT_UNKNOWN" | "FEE_EXCEEDS_CEILING" | "AMOUNT_NOT_POSITIVE";
export interface Policy {
    /** Bumped on every change; committed into the plan via policyHash. */
    readonly version: number;
    readonly chainId: number;
    readonly token: {
        readonly address: string;
        readonly decimals: number;
        readonly symbol: string;
    };
    /** Recipients this workspace is willing to pay at all. Compared case-insensitively. */
    readonly allowedPayees: readonly string[];
    /** Ceiling on the TOTAL token debit for one payment, not on the invoice alone. */
    readonly maxTotalDebitBaseUnits: string;
    /** Fee recipients we recognise. An unrecognised one is a refusal, never a silent accept. */
    readonly allowedFeeRecipients: readonly string[];
    /** Ceiling on the fee portion, as a guard against a mis-quoted or hostile fee. */
    readonly maxFeeBaseUnits: string;
    /** How long an approved plan stays valid. */
    readonly planTtlSeconds: number;
}
/** Facts read from Request. Untrusted input: shape-checked, never assumed. */
export interface SourceFacts {
    readonly chainId: number;
    readonly tokenAddress: string;
    readonly tokenDecimals: number;
    readonly payee: string;
    readonly invoiceBaseUnits: string;
    readonly feeBaseUnits: string;
    readonly feeRecipient: string;
    readonly hasBeenPaid: boolean;
}
export type Decision = {
    readonly ok: true;
    readonly totalDebitBaseUnits: string;
} | {
    readonly ok: false;
    readonly code: RefusalCode;
    readonly detail: string;
};
/**
 * EVM addresses are case-insensitive on chain; the mixed case in a checksummed address is a
 * checksum, not an identity. Comparing them raw is how an allowlist silently fails open or
 * closed depending on who formatted the string.
 */
export declare function normaliseAddress(address: string): string;
/**
 * The whole gate. Ordered cheapest-and-most-fundamental first so the refusal a human sees
 * names the root problem rather than a downstream symptom.
 */
export declare function checkPolicy(policy: Policy, facts: SourceFacts): Decision;
