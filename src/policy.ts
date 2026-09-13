/**
 * Deterministic policy. No LLM runs here, and nothing in this file reads the clock except
 * where a caller passes the time in explicitly.
 *
 * Every refusal returns a stable code plus a detail string safe to show a human. The codes
 * are the rows of the refusal table that the submission is scored on, so they are part of
 * the contract, not debug output.
 */

import { assertFitsUint256, baseUnitsFromString, MAX_UINT256 } from "./money.ts";

export type RefusalCode =
  | "UNSUPPORTED_CHAIN"
  | "UNSUPPORTED_TOKEN"
  | "TOKEN_DECIMALS_MISMATCH"
  | "PAYEE_NOT_ALLOWED"
  | "LIMIT_EXCEEDED"
  | "SOURCE_ALREADY_PAID"
  | "FEE_RECIPIENT_UNKNOWN"
  | "FEE_EXCEEDS_CEILING"
  | "AMOUNT_NOT_POSITIVE";

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

/**
 * Networks where a mistake costs real money. Refused outright, whatever the policy says.
 *
 * Ethereum, Optimism, BNB, Polygon, Base, Arbitrum, Avalanche. Not exhaustive, and not meant
 * to be: it is a floor, not a firewall. Adding a chain here is a one-line change; removing
 * the check is a decision someone has to make deliberately.
 */
const MAINNET_CHAIN_IDS = new Set([1, 10, 56, 137, 8453, 42161, 43114]);

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
   * How many later channel actions changed the amount the create stated, and by how much.
   *
   * Request channels are append-only and a creditor can increase or reduce the expected amount
   * after raising the invoice. This reader applies those deltas — and cannot authenticate them:
   * every action carries an ECDSA signature and nothing here recovers a signer, so the bytes the
   * gateway serves are taken at their word. A reviewer raised an amount with a signature of
   * sixty-five 0xab bytes and watched it apply.
   *
   * What bounds it is the human and the ceiling, so this is carried into the sentence the human
   * reads: an amount that was changed after the invoice was raised says so, rather than arriving
   * as a plain figure indistinguishable from the one the creditor first asked for.
   */
  readonly amountChangedBy?: { readonly actions: number; readonly fromBaseUnits: string };
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

export type Decision =
  | { readonly ok: true; readonly totalDebitBaseUnits: string }
  | { readonly ok: false; readonly code: RefusalCode; readonly detail: string };

/**
 * EVM addresses are case-insensitive on chain; the mixed case in a checksummed address is a
 * checksum, not an identity. Comparing them raw is how an allowlist silently fails open or
 * closed depending on who formatted the string.
 */
export function normaliseAddress(address: string): string {
  const a = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) {
    throw new Error(`not an EVM address: ${JSON.stringify(address)}`);
  }
  return a;
}

function refuse(code: RefusalCode, detail: string): Decision {
  return { ok: false, code, detail };
}

/**
 * The whole gate. Ordered cheapest-and-most-fundamental first so the refusal a human sees
 * names the root problem rather than a downstream symptom.
 */
export function checkPolicy(policy: Policy, facts: SourceFacts): Decision {
  if (facts.hasBeenPaid) {
    return refuse("SOURCE_ALREADY_PAID", "the invoice facts say this obligation is already paid");
  }

  // The README says mainnet is disabled in code, and this is the code. It used to be a single
  // equality check against whatever the policy happened to name, so a caller constructing a
  // Policy with chainId 1 passed straight through and the claim was prose, not a guard.
  if (MAINNET_CHAIN_IDS.has(facts.chainId) || MAINNET_CHAIN_IDS.has(policy.chainId)) {
    return refuse(
      "UNSUPPORTED_CHAIN",
      `chain ${MAINNET_CHAIN_IDS.has(facts.chainId) ? facts.chainId : policy.chainId} is a ` +
        "production network. This project is testnet-only by construction: it has never been " +
        "run where a mistake costs anything, so it must not be the thing that finds out.",
    );
  }

  if (facts.chainId !== policy.chainId) {
    return refuse(
      "UNSUPPORTED_CHAIN",
      `obligation is on chain ${facts.chainId}, policy allows only ${policy.chainId}`,
    );
  }

  const policyToken = normaliseAddress(policy.token.address);
  const factsToken = normaliseAddress(facts.tokenAddress);
  if (policyToken !== factsToken) {
    return refuse(
      "UNSUPPORTED_TOKEN",
      `obligation pays in ${factsToken}, policy allows only ${policyToken}`,
    );
  }

  // A token symbol is a display label. Decimals are load-bearing: the same "100" is a
  // 10^12 difference between an 18dp and a 6dp token on this very chain.
  if (facts.tokenDecimals !== policy.token.decimals) {
    return refuse(
      "TOKEN_DECIMALS_MISMATCH",
      `token reports ${facts.tokenDecimals} decimals, policy pinned ${policy.token.decimals}`,
    );
  }

  let payee: string;
  try {
    payee = normaliseAddress(facts.payee);
  } catch {
    return refuse("PAYEE_NOT_ALLOWED", `payee ${facts.payee} is not a valid EVM address`);
  }
  const allowed = policy.allowedPayees.map(normaliseAddress);
  if (!allowed.includes(payee)) {
    return refuse("PAYEE_NOT_ALLOWED", `${payee} is not an allowlisted recipient`);
  }

  const invoice = baseUnitsFromString(facts.invoiceBaseUnits);
  if (invoice <= 0n) {
    return refuse("AMOUNT_NOT_POSITIVE", `invoice amount must be positive, got ${invoice}`);
  }

  const fee = baseUnitsFromString(facts.feeBaseUnits);
  const maxFee = baseUnitsFromString(policy.maxFeeBaseUnits);
  if (fee > 0n) {
    let feeRecipient: string;
    try {
      feeRecipient = normaliseAddress(facts.feeRecipient);
    } catch {
      return refuse("FEE_RECIPIENT_UNKNOWN", `fee recipient ${facts.feeRecipient} is not a valid EVM address`);
    }
    const allowedFees = policy.allowedFeeRecipients.map(normaliseAddress);
    if (!allowedFees.includes(feeRecipient)) {
      return refuse("FEE_RECIPIENT_UNKNOWN", `fee recipient ${feeRecipient} is not recognised`);
    }
    if (fee > maxFee) {
      return refuse("FEE_EXCEEDS_CEILING", `fee ${fee} exceeds ceiling ${maxFee}`);
    }
  }

  // The cap applies to what actually leaves the wallet. Checking the invoice alone lets a
  // quoted fee push the real debit over the ceiling the human thought they were setting.
  const total = invoice + fee;
  if (total > MAX_UINT256) {
    return refuse("LIMIT_EXCEEDED", `total debit exceeds uint256 maximum`);
  }
  const cap = baseUnitsFromString(policy.maxTotalDebitBaseUnits);
  if (total > cap) {
    return refuse(
      "LIMIT_EXCEEDED",
      `total debit ${total} (invoice ${invoice} + fee ${fee}) exceeds cap ${cap}`,
    );
  }

  return { ok: true, totalDebitBaseUnits: total.toString() };
}
