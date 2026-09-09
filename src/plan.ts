/**
 * One definition of what a payment plan is.
 *
 * Both the live settlement script and the MCP server dispatch payments, and if they built
 * their policies separately they would drift — the agent-facing surface would end up
 * enforcing a slightly different ceiling than the human-facing one. That is precisely the
 * class of bug this project exists to prevent, so the plan is built here or nowhere.
 */

import { encodeCall } from "./abi.ts";
import type { Policy, SourceFacts } from "./policy.ts";

export const NAMESPACE = "request-network:sepolia";
export const SEPOLIA = 11155111;
export const ERC20_FEE_PROXY = "0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE";
export const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";

export const PAY_SIGNATURE =
  "transferFromWithReferenceAndFee(address,address,uint256,bytes,uint256,address)";

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

export function buildPolicy(f: InvoiceFacts): Policy {
  return {
    version: 1,
    chainId: SEPOLIA,
    token: {
      address: f.tokenAddress ?? FAU,
      decimals: f.tokenDecimals ?? 18,
      symbol: f.tokenSymbol ?? "FAU",
    },
    allowedPayees: [f.payee.toLowerCase()],
    maxTotalDebitBaseUnits: f.maxTotalDebitBaseUnits,
    allowedFeeRecipients: [f.feeAddress.toLowerCase()],
    maxFeeBaseUnits: f.feeAmount,
    planTtlSeconds: 3600,
  };
}

export function buildSourceFacts(f: InvoiceFacts): SourceFacts {
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
export function buildSteps(
  f: InvoiceFacts,
): ReadonlyArray<{ kind: string; to: string; data: string; value: string }> {
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
