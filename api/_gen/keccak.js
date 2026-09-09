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
const MASK64 = (1n << 64n) - 1n;
/** Rotation offsets, ρ step, indexed [x + 5y]. */
const RHO = [
    0, 1, 62, 28, 27,
    36, 44, 6, 55, 20,
    3, 10, 43, 25, 39,
    41, 45, 15, 21, 8,
    18, 2, 61, 56, 14,
];
/** Round constants, ι step. */
const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
function rotl64(x, n) {
    if (n === 0)
        return x;
    const s = BigInt(n);
    return ((x << s) | (x >> (64n - s))) & MASK64;
}
/** Keccak-f[1600] permutation, in place on 25 lanes. */
function permute(lanes) {
    for (let round = 0; round < 24; round++) {
        // θ
        const c = new Array(5);
        for (let x = 0; x < 5; x++) {
            c[x] = lanes[x] ^ lanes[x + 5] ^ lanes[x + 10] ^ lanes[x + 15] ^ lanes[x + 20];
        }
        for (let x = 0; x < 5; x++) {
            const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
            for (let y = 0; y < 5; y++)
                lanes[x + 5 * y] ^= d;
        }
        // ρ and π
        const b = new Array(25).fill(0n);
        for (let x = 0; x < 5; x++) {
            for (let y = 0; y < 5; y++) {
                b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(lanes[x + 5 * y], RHO[x + 5 * y]);
            }
        }
        // χ
        for (let y = 0; y < 5; y++) {
            for (let x = 0; x < 5; x++) {
                lanes[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK64 & b[((x + 2) % 5) + 5 * y]);
            }
        }
        // ι
        lanes[0] ^= RC[round];
    }
}
/** Keccak-256 of raw bytes. */
export function keccak256(input) {
    const RATE = 136; // (1600 - 2*256) / 8
    const lanes = new Array(25).fill(0n);
    // Pad10*1 with the original Keccak domain byte 0x01 (SHA-3 would use 0x06).
    const padLen = RATE - (input.length % RATE);
    const padded = new Uint8Array(input.length + padLen);
    padded.set(input);
    padded[input.length] = 0x01;
    padded[padded.length - 1] |= 0x80;
    for (let offset = 0; offset < padded.length; offset += RATE) {
        for (let i = 0; i < RATE / 8; i++) {
            let lane = 0n;
            for (let byte = 7; byte >= 0; byte--) {
                lane = (lane << 8n) | BigInt(padded[offset + i * 8 + byte]);
            }
            lanes[i] ^= lane;
        }
        permute(lanes);
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 4; i++) {
        let lane = lanes[i];
        for (let byte = 0; byte < 8; byte++) {
            out[i * 8 + byte] = Number(lane & 0xffn);
            lane >>= 8n;
        }
    }
    return out;
}
export function toHex(bytes) {
    return `0x${Buffer.from(bytes).toString("hex")}`;
}
export function keccak256Hex(input) {
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
    return toHex(keccak256(bytes));
}
/**
 * The 4-byte selector of a Solidity function signature.
 * Signature must be canonical: no spaces, no argument names, e.g.
 * "transferFromWithReferenceAndFee(address,address,uint256,bytes,uint256,address)".
 */
export function selector(signature) {
    if (/\s/.test(signature)) {
        throw new Error(`signature must not contain whitespace: ${JSON.stringify(signature)}`);
    }
    return keccak256Hex(signature).slice(0, 10);
}
