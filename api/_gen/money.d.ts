/**
 * Exact fixed-point money. No floats, ever.
 *
 * Request's API takes `amount` as a human-readable string ("100"); the chain takes base
 * units. That gap is the Lobstar failure class — $4 intended, $441,780 sent, from "a decimal
 * misinterpretation between human-readable units and onchain raw amounts". Every conversion
 * here is exact or it throws. There is no rounding mode, deliberately: rounding money by
 * default is how you lose a base unit and never notice.
 */
export declare class MoneyError extends Error {
    readonly code: MoneyErrorCode;
    constructor(code: MoneyErrorCode, message: string);
}
export type MoneyErrorCode = "BAD_DECIMALS" | "NOT_A_STRING" | "NOT_DECIMAL" | "PRECISION_LOSS" | "NEGATIVE";
/**
 * Human-readable decimal string -> base units.
 *
 * Throws PRECISION_LOSS rather than truncating. A caller asking to send "1.005" of a
 * 2-decimal token has a bug, and silently sending 1.00 is the worst possible answer.
 */
export declare function toBaseUnits(human: string, decimals: number): bigint;
/** Base units -> human-readable decimal string. Exact; trailing fractional zeros trimmed. */
export declare function toHuman(base: bigint, decimals: number): string;
/**
 * Canonical decimal-string form of base units, for hashing and JSON.
 *
 * uint256 exceeds Number.MAX_SAFE_INTEGER and PostgreSQL bigint alike, so base units cross
 * every boundary as a string. A JSON money field is never a JS number.
 */
export declare function baseUnitsToString(base: bigint): string;
export declare function baseUnitsFromString(s: string): bigint;
/** Largest value a uint256 can hold. Anything above this cannot reach the chain intact. */
export declare const MAX_UINT256: bigint;
export declare function assertFitsUint256(base: bigint, what?: string): void;
