/**
 * A deliberately tiny ABI codec — only the types the Request payment path actually uses.
 *
 * Why this exists at all, when the execution platform already encodes calls:
 *
 * Request Network hands you finished calldata from `GET /request/{id}/pay`. KeeperHub has
 * no route that will send finished calldata — every write goes through
 * `(contractAddress, functionName, functionArgs)` and is re-encoded on KeeperHub's side
 * against an ABI KeeperHub resolves itself. So the bytes a human approved are not, by
 * construction, the bytes that get signed. Something has to decode Request's calldata into
 * arguments and something has to check that re-encoding those arguments reproduces the
 * original bytes exactly. That check is the only thing standing between "approved this
 * payment" and "signed whatever the platform encoded".
 *
 * Unsupported types throw. They are never skipped, defaulted, or best-guessed: a codec that
 * quietly mis-encodes an argument is worse than no codec, because it fails a byte-comparison
 * that was supposed to be the safety net.
 */
export type AbiType = "address" | "uint256" | "bytes";
export type AbiErrorCode = "BAD_SIGNATURE" | "UNSUPPORTED_TYPE" | "BAD_ADDRESS" | "BAD_UINT" | "BAD_BYTES" | "ARITY_MISMATCH" | "BAD_CALLDATA" | "SELECTOR_MISMATCH";
export declare class AbiError extends Error {
    readonly code: AbiErrorCode;
    constructor(code: AbiErrorCode, message: string);
}
/** Split "name(a,b,c)" into its function name and argument types. */
export declare function parseSignature(signature: string): {
    name: string;
    types: AbiType[];
};
/** Encode a full call: 4-byte selector followed by the ABI head and tail. */
export declare function encodeCall(signature: string, args: readonly unknown[]): string;
/** Decode a full call. Throws if the selector does not match the signature. */
export declare function decodeCall(signature: string, calldata: string): string[];
/**
 * The load-bearing check. Decode the platform-independent calldata, then re-encode the
 * arguments and require the result to be byte-identical. Case is normalised because an EVM
 * address's case is a checksum; nothing else is normalised.
 *
 * Returns the decoded arguments so the caller can hand them to a platform that will only
 * accept arguments — having proved they mean exactly the approved bytes.
 */
export declare function decodeAndVerify(signature: string, calldata: string): string[];
