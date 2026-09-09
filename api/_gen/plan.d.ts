/**
 * One definition of what a payment plan is.
 *
 * Both the live settlement script and the MCP server dispatch payments, and if they built
 * their policies separately they would drift — the agent-facing surface would end up
 * enforcing a slightly different ceiling than the human-facing one. That is precisely the
 * class of bug this project exists to prevent, so the plan is built here or nowhere.
 */
import type { Policy, SourceFacts } from "./policy.ts";
import { type StandingPolicy } from "./standing-policy.ts";
export declare const NAMESPACE = "request-network:sepolia";
export declare const SEPOLIA = 11155111;
export declare const ERC20_FEE_PROXY = "0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE";
export declare const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
export declare const PAY_SIGNATURE = "transferFromWithReferenceAndFee(address,address,uint256,bytes,uint256,address)";
/** What a Request invoice tells us. Every field is read from the source, never inferred. */
export interface InvoiceFacts {
    readonly requestId: string;
    readonly paymentReference: string;
    readonly payee: string;
    readonly amountBaseUnits: string;
    readonly feeAmount: string;
    readonly feeAddress: string;
    /** The ceiling a human set on the TOTAL debit. Required: there is no safe default. */
    readonly maxTotalDebitBaseUnits: string;
    readonly tokenAddress?: string;
    readonly tokenDecimals?: number;
    readonly tokenSymbol?: string;
    /**
     * Whether the chain already shows this reference paid.
     *
     * This was hardcoded false, which made SOURCE_ALREADY_PAID unreachable: the policy checked
     * a field nothing ever set, so the one refusal that stops paying a settled invoice could
     * never fire outside a test. Callers that can read the chain must read it and pass the
     * answer; callers that cannot must say so by omitting it, and get the safe default.
     */
    readonly hasBeenPaid?: boolean;
}
/**
 * The policy a plan is checked against.
 *
 * Every constraint here used to come from `f` — the same invoice the agent supplied and the
 * same object `checkPolicy` would then compare it to. That made five of the nine refusal
 * codes structurally unreachable on both real entry points: an agent could name an attacker
 * payee, a 500 FAU fee and its own ceiling, and get a clean approval sentence. The refusal
 * table demonstrated a gate that only ever existed inside the harness.
 *
 * The operator's standing policy wins wherever it is set. Where it is not, the invoice's own
 * value is used and `policySource` says so, so a bare clone still runs and nobody is told
 * they are protected when they are not. A ceiling is always the LOWER of the two: an agent
 * may tighten its own limit, never raise it above what a human wrote down.
 */
export declare function buildPolicy(f: InvoiceFacts, standing?: StandingPolicy): Policy;
export declare function buildSourceFacts(f: InvoiceFacts): SourceFacts;
/**
 * The single payment step. The calldata is built once, here, so the bytes the approval
 * sentence describes and the bytes that get dispatched come from the same expression.
 */
export declare function buildSteps(f: InvoiceFacts): ReadonlyArray<{
    kind: string;
    to: string;
    data: string;
    value: string;
}>;
