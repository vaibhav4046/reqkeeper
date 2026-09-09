/**
 * One definition of what a payment plan is.
 *
 * Both the live settlement script and the MCP server dispatch payments, and if they built
 * their policies separately they would drift — the agent-facing surface would end up
 * enforcing a slightly different ceiling than the human-facing one. That is precisely the
 * class of bug this project exists to prevent, so the plan is built here or nowhere.
 */
import { encodeCall } from "./abi.js";
import { loadStandingPolicy } from "./standing-policy.js";
export const NAMESPACE = "request-network:sepolia";
export const SEPOLIA = 11155111;
export const ERC20_FEE_PROXY = "0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE";
export const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
export const PAY_SIGNATURE = "transferFromWithReferenceAndFee(address,address,uint256,bytes,uint256,address)";
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
export function buildPolicy(f, standing = loadStandingPolicy()) {
    const lower = (a, b) => (b === null ? a : (BigInt(a) < BigInt(b) ? a : b));
    return {
        version: 1,
        chainId: SEPOLIA,
        token: {
            address: f.tokenAddress ?? FAU,
            decimals: f.tokenDecimals ?? 18,
            symbol: f.tokenSymbol ?? "FAU",
        },
        allowedPayees: standing.allowedPayees.length > 0 ? standing.allowedPayees : [f.payee.toLowerCase()],
        maxTotalDebitBaseUnits: lower(f.maxTotalDebitBaseUnits, standing.maxTotalDebitBaseUnits),
        allowedFeeRecipients: standing.allowedFeeRecipients.length > 0 ? standing.allowedFeeRecipients : [f.feeAddress.toLowerCase()],
        maxFeeBaseUnits: lower(f.feeAmount, standing.maxFeeBaseUnits),
        planTtlSeconds: 3600,
    };
}
export function buildSourceFacts(f) {
    return {
        chainId: SEPOLIA,
        tokenAddress: f.tokenAddress ?? FAU,
        tokenDecimals: f.tokenDecimals ?? 18,
        payee: f.payee.toLowerCase(),
        invoiceBaseUnits: f.amountBaseUnits,
        feeBaseUnits: f.feeAmount,
        feeRecipient: f.feeAddress.toLowerCase(),
        hasBeenPaid: f.hasBeenPaid ?? false,
    };
}
/**
 * The single payment step. The calldata is built once, here, so the bytes the approval
 * sentence describes and the bytes that get dispatched come from the same expression.
 */
export function buildSteps(f) {
    const data = encodeCall(PAY_SIGNATURE, [
        f.tokenAddress ?? FAU,
        f.payee.toLowerCase(),
        f.amountBaseUnits,
        f.paymentReference,
        f.feeAmount,
        f.feeAddress.toLowerCase(),
    ]);
    return [{ kind: "PAY", to: ERC20_FEE_PROXY, data, value: "0" }];
}
