/**
 * Exact fixed-point money. No floats, ever.
 *
 * Request's API takes `amount` as a human-readable string ("100"); the chain takes base
 * units. That gap is the Lobstar failure class — $4 intended, $441,780 sent, from "a decimal
 * misinterpretation between human-readable units and onchain raw amounts". Every conversion
 * here is exact or it throws. There is no rounding mode, deliberately: rounding money by
 * default is how you lose a base unit and never notice.
 */
export class MoneyError extends Error {
    // Declared and assigned explicitly: Node's strip-only TypeScript mode rejects
    // constructor parameter properties, since those emit code rather than erase types.
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "MoneyError";
    }
}
/** Plain non-negative decimal only. Rejects "", ".", "1.", ".5", "-1", "+1", "1e5", "1_0", NaN. */
const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/;
/** ERC-20 decimals seen in the wild top out well below this; the cap is a sanity rail. */
const MAX_DECIMALS = 36;
function assertDecimals(decimals) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
        throw new MoneyError("BAD_DECIMALS", `decimals must be an integer in 0..${MAX_DECIMALS}, got ${decimals}`);
    }
}
/**
 * Human-readable decimal string -> base units.
 *
 * Throws PRECISION_LOSS rather than truncating. A caller asking to send "1.005" of a
 * 2-decimal token has a bug, and silently sending 1.00 is the worst possible answer.
 */
export function toBaseUnits(human, decimals) {
    assertDecimals(decimals);
    if (typeof human !== "string") {
        throw new MoneyError("NOT_A_STRING", `amount must be a string, got ${typeof human}`);
    }
    const match = PLAIN_DECIMAL.exec(human.trim());
    if (!match) {
        throw new MoneyError("NOT_DECIMAL", `not a plain non-negative decimal: ${JSON.stringify(human)}`);
    }
    const [, whole, frac = ""] = match;
    if (frac.length > decimals) {
        throw new MoneyError("PRECISION_LOSS", `${human.trim()} has ${frac.length} decimal places but the token has ${decimals}`);
    }
    return BigInt(whole + frac.padEnd(decimals, "0"));
}
/** Base units -> human-readable decimal string. Exact; trailing fractional zeros trimmed. */
export function toHuman(base, decimals) {
    assertDecimals(decimals);
    if (base < 0n)
        throw new MoneyError("NEGATIVE", `base units must be non-negative, got ${base}`);
    if (decimals === 0)
        return base.toString();
    const digits = base.toString().padStart(decimals + 1, "0");
    const whole = digits.slice(0, digits.length - decimals);
    const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole;
}
/**
 * Canonical decimal-string form of base units, for hashing and JSON.
 *
 * uint256 exceeds Number.MAX_SAFE_INTEGER and PostgreSQL bigint alike, so base units cross
 * every boundary as a string. A JSON money field is never a JS number.
 */
export function baseUnitsToString(base) {
    if (base < 0n)
        throw new MoneyError("NEGATIVE", `base units must be non-negative, got ${base}`);
    return base.toString();
}
export function baseUnitsFromString(s) {
    if (typeof s !== "string" || !/^\d+$/.test(s)) {
        throw new MoneyError("NOT_DECIMAL", `base units must be a non-negative integer string: ${JSON.stringify(s)}`);
    }
    return BigInt(s);
}
/** Largest value a uint256 can hold. Anything above this cannot reach the chain intact. */
export const MAX_UINT256 = (1n << 256n) - 1n;
export function assertFitsUint256(base, what = "amount") {
    if (base < 0n)
        throw new MoneyError("NEGATIVE", `${what} must be non-negative, got ${base}`);
    if (base > MAX_UINT256) {
        throw new MoneyError("PRECISION_LOSS", `${what} exceeds uint256: ${base}`);
    }
}
