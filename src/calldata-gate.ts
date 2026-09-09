/**
 * The one place that turns approved calldata into a dispatchable call.
 *
 * Both execution providers need this and neither may have its own copy. A second provider
 * that decoded slightly differently, or skipped a check, would be a hole in exactly the
 * defence this project exists to provide.
 *
 * Three things are bound here, not two. An earlier version checked only the calldata, which
 * left the destination unchecked: byte-perfect, allowlisted
 * `transferFromWithReferenceAndFee` calldata pointed at an attacker's contract would have
 * passed, and both providers then forwarded `step.to` straight through. So the selector, the
 * arguments AND the target are all validated, and callers are handed back the target this
 * module approved rather than the one the step carried.
 */

import { decodeAndVerify } from "./abi.ts";
import { selector } from "./keccak.ts";
import { ProviderError } from "./provider.ts";

/** Canonical Sepolia addresses. Verified deployed by `npm run verify:onchain`. */
export const ERC20_FEE_PROXY = "0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE";
export const FAU_TOKEN = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";

/**
 * Every dispatchable call, bound to the contracts it may be sent to.
 *
 * `mint(address,uint256)` is deliberately absent. It was here while the payer was being
 * funded, and a payment gate that allowlists a mint function is indefensible: setup happens
 * out of band, not through the settlement path.
 */
const ALLOWED: ReadonlyArray<{ signature: string; targets: readonly string[] }> = [
  {
    signature: "transferFromWithReferenceAndFee(address,address,uint256,bytes,uint256,address)",
    targets: [ERC20_FEE_PROXY],
  },
  {
    // An allowance is granted on the token, never on the proxy.
    signature: "approve(address,uint256)",
    targets: [FAU_TOKEN],
  },
];

export const ALLOWED_SIGNATURES = ALLOWED.map((a) => a.signature);

const BY_SELECTOR = new Map(
  ALLOWED.map((a) => [selector(a.signature).toLowerCase(), a] as const),
);

/** The step shape settle.ts dispatches: exactly what Request's /pay endpoint returns. */
export interface CallStep {
  readonly to: string;
  readonly data: string;
  readonly value?: string;
}

export interface AllowedCall {
  readonly signature: string;
  readonly functionName: string;
  readonly args: string[];
  /** The validated target. Providers must send this, not `step.to`. */
  readonly to: string;
  /** The validated native value, as a decimal string. */
  readonly value: string;
}

function fail(code: string, message: string): never {
  // Every refusal here is non-retryable: a malformed plan does not become well-formed.
  throw new ProviderError(code, message, false);
}

/**
 * Decode approved calldata into a dispatchable call, proving along the way that the
 * arguments mean exactly the approved bytes and that the destination is one this call is
 * allowed to reach.
 */
export function decodeAllowedCall(step: CallStep): AllowedCall {
  if (typeof step?.data !== "string" || step.data.length < 10) {
    fail("calldata_invalid", "step has no calldata to dispatch");
  }
  if (typeof step?.to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(step.to)) {
    fail("target_invalid", `step target is not an address: ${String(step?.to)}`);
  }

  const sel = step.data.slice(0, 10).toLowerCase();
  const entry = BY_SELECTOR.get(sel);
  if (!entry) {
    fail("selector_not_allowed", `calldata selector ${sel} is not on the allowlist`);
  }

  // Case is a checksum, not identity, so compare lowercased.
  const to = step.to.toLowerCase();
  if (!entry.targets.some((t) => t.toLowerCase() === to)) {
    fail(
      "target_not_allowed",
      `${entry.signature} may not be sent to ${step.to}; ` +
        `allowed: ${entry.targets.join(", ")}`,
    );
  }

  // A payment carries no native value. A non-zero one would leave the wallet unaccounted
  // for by the invoice, and the approval sentence never mentioned it.
  const value = step.value ?? "0";
  if (!/^\d+$/.test(value)) {
    fail("value_invalid", `value must be a decimal string, got ${String(step.value)}`);
  }
  if (value !== "0") {
    fail("value_not_allowed", `${entry.signature} must carry no native value, got ${value}`);
  }

  let args: string[];
  try {
    args = decodeAndVerify(entry.signature, step.data);
  } catch (e) {
    // Re-encoding did not reproduce the approved bytes. Never send: the platform would
    // encode from arguments that do not provably mean what was approved.
    fail("calldata_mismatch", `${entry.signature}: ${(e as Error).message}`);
  }

  return {
    signature: entry.signature,
    functionName: entry.signature.slice(0, entry.signature.indexOf("(")),
    args,
    to: step.to,
    value,
  };
}
