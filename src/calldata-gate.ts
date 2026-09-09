/**
 * The one place that turns approved calldata into arguments.
 *
 * Both execution providers need this, and they must not each have their own copy. A second
 * provider that decoded calldata slightly differently, or skipped the byte-comparison, would
 * be a hole in exactly the defence this project exists to provide: whichever surface you
 * dispatch through, the arguments sent have to provably mean the bytes that were approved.
 */

import { decodeAndVerify } from "./abi.ts";
import { selector } from "./keccak.ts";
import { ProviderError } from "./provider.ts";

/** Only these calls may ever be dispatched. A plan naming anything else is refused. */
export const ALLOWED_SIGNATURES = [
  "transferFromWithReferenceAndFee(address,address,uint256,bytes,uint256,address)",
  "approve(address,uint256)",
  "mint(address,uint256)",
] as const;

const BY_SELECTOR = new Map<string, string>(
  ALLOWED_SIGNATURES.map((sig) => [selector(sig).toLowerCase(), sig]),
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
}

/**
 * Decode approved calldata into arguments, proving along the way that the arguments mean
 * exactly the approved bytes. Any doubt refuses, non-retryably: a malformed plan is not
 * going to become well-formed on a retry.
 */
export function decodeAllowedCall(step: CallStep): AllowedCall {
  if (typeof step?.data !== "string" || step.data.length < 10) {
    throw new ProviderError("calldata_invalid", "step has no calldata to dispatch", false);
  }
  const sel = step.data.slice(0, 10).toLowerCase();
  const signature = BY_SELECTOR.get(sel);
  if (!signature) {
    throw new ProviderError(
      "selector_not_allowed",
      `calldata selector ${sel} is not on the allowlist; refusing to dispatch`,
      false,
    );
  }
  let args: string[];
  try {
    args = decodeAndVerify(signature, step.data);
  } catch (e) {
    // Re-encoding did not reproduce the approved bytes. Never send: the platform would be
    // encoding from arguments that do not provably mean what was approved.
    throw new ProviderError("calldata_mismatch", `${signature}: ${(e as Error).message}`, false);
  }
  return {
    signature,
    functionName: signature.slice(0, signature.indexOf("(")),
    args,
  };
}
