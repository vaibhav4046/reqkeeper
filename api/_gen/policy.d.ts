/**
 * Deterministic policy. No LLM runs here, and nothing in this file reads the clock except
 * where a caller passes the time in explicitly.
 *
 * Every refusal returns a stable code plus a detail string safe to show a human. The codes
 * are the rows of the refusal table that the submission is scored on, so they are part of
 * the contract, not debug output.
 */
export type RefusalCode = "UNSUPPORTED_CHAIN" | "UNSUPPORTED_TOKEN" | "TOKEN_DECIMALS_MISMATCH" | "PAYEE_NOT_ALLOWED"
/** The operator set a standing policy and this process could not read part of it. */
 | "POLICY_UNREADABLE" | "LIMIT_EXCEEDED" | "SOURCE_ALREADY_PAID" | "FEE_RECIPIENT_UNKNOWN" | "FEE_EXCEEDS_CEILING" | "AMOUNT_NOT_POSITIVE";
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
    /**
     * What the operator's standing policy said that could not be read.
     *
     * Carried into the policy rather than left in the loader, because the loader's caller is not
     * the one who decides. An unreadable allowlist used to arrive here as an EMPTY allowlist, and
     * `buildPolicy` reads empty as "the operator set none" and substitutes the invoice's own payee
     * -- so a payee allowlist with one hex character missing approved an attacker, and the run
     * looked clean. Measured in three separate spellings of one typo.
     */
    readonly standingGaps?: readonly string[];
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
    /**
     * The money goes somewhere other than the party of record on the invoice.
     *
     * Legitimate in Request, so never a refusal -- but the person approving is being asked to send
     * funds to an address that is not the party the invoice names, and that is exactly the thing
     * they would want to be told. `src/request.ts` promised "a human should look" and nothing
     * looked; this is what carries it to them.
     */
    readonly payeeDiffersFromRecord?: boolean;
    /**
     * How many later channel actions changed the amount the create stated, and by how much.
     *
     * Request channels are append-only and a creditor can increase or reduce the expected amount
     * after raising the invoice. This reader applies those deltas, and authenticates them:
     * `src/request.ts` recovers the ECDSA signer of every action and enforces Request's role rules,
     * so an increase must really have been signed by the PAYER. It did not always. A reviewer
     * raised an amount with a signature of sixty-five 0xab bytes and watched it apply.
     *
     * Authenticated is still not expected. The person approving was shown a figure by the creditor
     * at some point, and an amount that moved since then is the one number on the screen they
     * cannot check against that -- so it is carried into the sentence they read rather than
     * arriving as a plain figure indistinguishable from the one first asked for.
     */
    readonly amountChangedBy?: {
        readonly actions: number;
        readonly fromBaseUnits: string;
    };
    /**
     * The Sepolia block the invoice's create action is anchored at, when Request has confirmed it.
     *
     * Not a policy input -- nothing here decides anything from it. It is carried so the RECOVERY
     * path can bound its chain scan: a payment for an invoice cannot predate the invoice, so this
     * is the floor below which a silence is conclusive rather than merely unobserved. Without it
     * `findPaymentByReference` reports every negative as truncated, `worker.ts` refuses to conclude
     * from a truncated scan, and PREFLIGHT_UNAVAILABLE is unreachable on the real chain -- which
     * turns every failed dry run into a permanent wedge. Safety without liveness is not recovery.
     */
    readonly anchorBlock?: number;
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
