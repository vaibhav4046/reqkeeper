/**
 * The three identities that make settlement exactly-once.
 *
 *   obligation  - which economic debt this is. Issued by Request, not by us.
 *   plan        - which exact set of bytes was approved.
 *   step        - which call inside that plan.
 *
 * Everything is derived from persisted state. No timestamps, no randomness, no
 * model-generated text ever enters a key: a retry must reproduce the identical value or
 * the provider treats it as a new payment.
 */

import { createHash } from "node:crypto";

export type IdentityErrorCode = "NOT_CANONICAL" | "EMPTY" | "BAD_INDEX";

export class IdentityError extends Error {
  // See MoneyError: parameter properties are unsupported under strip-only type erasure.
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "IdentityError";
  }
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Deterministic JSON. Object keys sorted, no insignificant whitespace, arrays keep order.
 *
 * Rejects anything whose serialisation is ambiguous or lossy: non-finite numbers,
 * undefined, functions, symbols, bigint. Money crosses as a decimal string (see money.ts),
 * so a bigint here means someone forgot to convert and the hash would have been unstable.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new IdentityError("NOT_CANONICAL", `non-finite number is not canonical: ${value}`);
    }
    if (!Number.isInteger(value)) {
      throw new IdentityError(
        "NOT_CANONICAL",
        `fractional number is not canonical (use a decimal string): ${value}`,
      );
    }
    return String(value);
  }
  if (t === "bigint") {
    throw new IdentityError(
      "NOT_CANONICAL",
      "bigint is not canonical; convert base units to a decimal string first",
    );
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (t === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new IdentityError("NOT_CANONICAL", `cannot canonicalise ${t}`);
}

/**
 * Canonical obligation identity.
 *
 * Keyed on Request's own namespace + request id, so it survives a payer wallet change, an
 * API-key rotation, a re-import, and regenerated calldata. This value carries a UNIQUE
 * constraint in the store, and that constraint is the entire duplicate defence — it outlives
 * KeeperHub's 24h idempotency replay window, after which the same provider key silently
 * executes again.
 *
 * Request ids are not case-normalised here. Guessing at a foreign system's canonicalisation
 * rules is how two spellings of one debt become two debts.
 */
export function obligationId(namespace: string, requestId: string): string {
  const ns = namespace.trim();
  const id = requestId.trim();
  if (!ns) throw new IdentityError("EMPTY", "namespace is required");
  if (!id) throw new IdentityError("EMPTY", "requestId is required");
  // Length-prefixed framing, not a delimiter ban. A plain "ns:id" preimage lets
  // ("a", "b:c") and ("a:b", "c") collide; forbidding ':' would fix that but also reject
  // the real namespace, which is "request-network:sepolia". Framing costs nothing and
  // makes the encoding unambiguous for every possible input.
  return sha256Hex(`reqkeeper.obligation.v1:${ns.length}:${ns}:${id.length}:${id}`);
}

/** Content address of an approved plan. Any change to any committed field yields a new plan. */
export function planHash(plan: unknown): string {
  return sha256Hex(`reqkeeper.plan.v1:${canonicalJson(plan)}`);
}

/** Content address of a policy document, committed into the plan it authorised. */
export function policyHash(policy: unknown): string {
  return sha256Hex(`reqkeeper.policy.v1:${canonicalJson(policy)}`);
}

/** Content address of the upstream facts a plan was built from. */
export function sourceFactsHash(facts: unknown): string {
  return sha256Hex(`reqkeeper.source.v1:${canonicalJson(facts)}`);
}

/**
 * Provider idempotency key for one step of one approved plan.
 *
 * Deterministic in its three inputs, so retrying the same attempt reproduces it byte for
 * byte. A genuinely new approved plan yields a new plan hash and therefore a new key,
 * which is the only legitimate way a second payment identity comes into existence.
 */
export function idempotencyKey(
  obligationIdHex: string,
  planHashHex: string,
  stepIndex: number,
): string {
  if (!/^[0-9a-f]{64}$/.test(obligationIdHex)) {
    throw new IdentityError("NOT_CANONICAL", "obligationId must be 64 lowercase hex chars");
  }
  if (!/^[0-9a-f]{64}$/.test(planHashHex)) {
    throw new IdentityError("NOT_CANONICAL", "planHash must be 64 lowercase hex chars");
  }
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 255) {
    throw new IdentityError("BAD_INDEX", `stepIndex must be an integer in 0..255, got ${stepIndex}`);
  }
  return sha256Hex(`reqkeeper.step.v1:${obligationIdHex}:${planHashHex}:${stepIndex}`);
}

/**
 * The one spelling of a payment reference.
 *
 * `0xAA` and `0xaa` are the same eight bytes on chain, but SQLite compares TEXT byte by byte,
 * so a UNIQUE index over the raw string treats them as two different debts — and an attacker,
 * or an agent that simply upper-cased a hex string, gets a second payment out of it. Case is
 * a rendering choice, not identity, so it is removed before the value is ever stored or
 * looked up. A reference that is not hex is refused outright rather than normalised, because
 * a value this load-bearing must not be guessed at.
 *
 * The `0x` is a rendering choice too, and Request makes the other one: its own
 * `PaymentReferenceCalculator.calculate` returns the bare sixteen hex characters, while
 * `derivePaymentReference` returns them with a prefix. Refusing the bare spelling answered
 * REFERENCE_MISMATCH for what is the identical eight bytes — so it is accepted, and
 * normalised INTO the prefixed form. The direction matters: this value feeds a UNIQUE index,
 * so both spellings have to land on one stored string or one debt becomes two rows and gets
 * paid twice. Only the exact 8-byte spelling is taken bare; anything else unprefixed is too
 * ambiguous to guess at (a bare "1000" is as plausibly a decimal as a reference).
 */
export function canonicalReference(reference: string): string {
  const trimmed = String(reference).trim();
  if (/^[0-9a-fA-F]{16}$/.test(trimmed)) return `0x${trimmed.toLowerCase()}`;
  if (!/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    throw new Error(
      `payment reference must be 0x-prefixed hex, or Request's bare 16-character spelling, ` +
        `got ${JSON.stringify(reference)}`,
    );
  }
  return trimmed.toLowerCase();
}
