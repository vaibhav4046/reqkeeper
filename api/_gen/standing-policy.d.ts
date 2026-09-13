/**
 * The policy the operator owns, not the one the agent hands over.
 *
 * `buildPolicy` used to derive every constraint from the same invoice it would then check —
 * `allowedPayees: [f.payee]`, `maxFeeBaseUnits: f.feeAmount` — so `checkPolicy` compared the
 * invoice to itself. Five of the nine refusal codes could not fire on either real entry
 * point: an agent proposing an attacker payee with a 500 FAU fee to an attacker fee address
 * got a clean approval sentence. The refusal table demonstrated a gate against a standing
 * policy that existed only inside the harness.
 *
 * A standing policy is a thing a human writes down once, out of band, and the agent cannot
 * reach. It lives in the environment or a JSON file next to the database — never in the
 * proposal. Where the operator has set nothing, the invoice-derived value is used and the
 * fact is reported, so a bare clone still runs but nobody is told it is protected when it
 * is not.
 */
export interface StandingPolicy {
    /** Recipients this workspace will pay at all. Empty means the operator set none. */
    readonly allowedPayees: readonly string[];
    readonly allowedFeeRecipients: readonly string[];
    /** Ceiling on the TOTAL debit. An agent's own cap is clamped to this, never above it. */
    readonly maxTotalDebitBaseUnits: string | null;
    readonly maxFeeBaseUnits: string | null;
    /**
     * Which of the above the operator actually set. The UI and the docs must not overstate.
     *
     * `unreadable` is the fourth state and the reason this type changed: an operator wrote a policy
     * and nothing in it could be loaded. That is not `none`, and treating it as `none` handed the
     * invoice its own payee as the allowlist.
     */
    readonly source: "environment" | "file" | "none" | "mixed" | "unreadable";
    /** Everything the loader had to drop, so a caller can refuse rather than silently narrow. */
    readonly gaps: readonly PolicyGap[];
}
/**
 * What the loader could not make sense of.
 *
 * Empty means "the operator set none", and empty is what an unreadable file used to produce -- so
 * a trailing comma, an address one hex character short, or a ceiling written as a JSON number all
 * became "no standing policy", and `buildPolicy` then substituted the INVOICE's own payee as the
 * allowlist and the caller's own number as the ceiling. Measured: an attacker payee that the
 * correct file refuses was approved in all three cases. `docs/RUNBOOK.md` tells every new operator
 * to hand-edit that file and promises PAYEE_NOT_ALLOWED until they do; one missing character
 * returns the opposite, and the run looks clean.
 *
 * So the third state is named. A policy that failed to load is not a policy that is absent.
 */
export type PolicyGap = {
    readonly field: "file";
    readonly detail: string;
} | {
    readonly field: "allowedPayees" | "allowedFeeRecipients";
    readonly detail: string;
} | {
    readonly field: "maxTotalDebitBaseUnits" | "maxFeeBaseUnits";
    readonly detail: string;
};
export declare const NO_STANDING_POLICY: StandingPolicy;
/**
 * Read the standing policy.
 *
 * Environment first, then `policy.json` beside the database, because an operator running one
 * process wants an env var and an operator running many wants a file. Anything malformed is
 * treated as unset rather than as zero: a ceiling that silently became "0" would refuse every
 * payment, and an allowlist that silently became empty would look like a working gate.
 */
export declare function loadStandingPolicy(env?: Record<string, string | undefined>, filePath?: string): StandingPolicy;
/** Human-readable statement of what is actually enforced. Used by the CLI and the docs. */
export declare function describeStandingPolicy(p: StandingPolicy): string;
