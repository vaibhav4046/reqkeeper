/**
 * Keccak-256, as Ethereum uses it.
 *
 * Node ships `sha3-256`, which is NOT this: SHA-3 pads with 0x06, original Keccak pads with
 * 0x01, and the digests differ completely. Using the wrong one yields a plausible-looking
 * 32-byte hash and a function selector that no contract answers to.
 *
 * Written out rather than taken as a dependency because this build has none, and because a
 * hash function with published test vectors verifies itself. See test/keccak.test.ts.
 *
 * ponytail: BigInt lanes, not 32-bit halves. Selectors and references are a few dozen bytes,
 * so clarity beats throughput here. Swap in split-word lanes if this ever hashes bulk data.
 */
/** Keccak-256 of raw bytes. */
export declare function keccak256(input: Uint8Array): Uint8Array;
export declare function toHex(bytes: Uint8Array): string;
export declare function keccak256Hex(input: string | Uint8Array): string;
/**
 * The 4-byte selector of a Solidity function signature.
 * Signature must be canonical: no spaces, no argument names, e.g.
 * "transferFromWithReferenceAndFee(address,address,uint256,bytes,uint256,address)".
 */
export declare function selector(signature: string): string;
