/**
 * Public-key recovery over secp256k1, in BigInt, because this project has no runtime
 * dependencies and a signature that is never checked is a signature that proves nothing.
 *
 * Scope, deliberately narrow: this file RECOVERS the address that produced a signature over a
 * hash. It holds no key, signs nothing, and derives nothing secret. There is no branch here whose
 * timing could leak a private value because there is no private value — every input is public and
 * already on somebody's website. That is what makes a hand-written implementation acceptable in a
 * money path, and it is the only reason it is one.
 *
 * What it is for: Request's channel actions are signed, and the gateway serving them is not the
 * party that signed them. `src/request.ts` already binds the CREATE to the channel id by hash, so
 * a forged create cannot be served under a genuine id. Everything after the create — a cancel, an
 * amount increase — was still taken on the gateway's word, and an increase is the one that costs
 * money: it raises what this system is about to pay. Recovering the signer turns each action from
 * "the gateway says" into "this address said", and the role rules in `src/request.ts` then decide
 * whether that address was allowed to say it.
 */

import { keccak256 } from "./keccak.ts";

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

/** A point on the curve, or the point at infinity. */
type Point = { readonly x: bigint; readonly y: bigint } | null;

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

/** Extended Euclid. Throws on a non-invertible input rather than returning a wrong answer. */
function invert(a: bigint, m: bigint): bigint {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error("value is not invertible");
  return mod(old_s, m);
}

function add(a: Point, b: Point): Point {
  if (a === null) return b;
  if (b === null) return a;
  if (a.x === b.x) {
    // P + (-P) is the point at infinity; P + P needs the doubling formula.
    if (mod(a.y + b.y, P) === 0n) return null;
    const lam = mod(3n * a.x * a.x * invert(2n * a.y, P), P);
    const x = mod(lam * lam - 2n * a.x, P);
    return { x, y: mod(lam * (a.x - x) - a.y, P) };
  }
  const lam = mod((b.y - a.y) * invert(mod(b.x - a.x, P), P), P);
  const x = mod(lam * lam - a.x - b.x, P);
  return { x, y: mod(lam * (a.x - x) - a.y, P) };
}

function multiply(point: Point, scalar: bigint): Point {
  let result: Point = null;
  let addend = point;
  let k = mod(scalar, N);
  while (k > 0n) {
    if (k & 1n) result = add(result, addend);
    addend = add(addend, addend);
    k >>= 1n;
  }
  return result;
}

function bytesFromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error(`not hex: ${hex.slice(0, 20)}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toWord(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, "0");
  return bytesFromHex(hex);
}

/**
 * The address that signed `hash`, or null if the signature does not recover to one.
 *
 * `hash` is the 32-byte digest that was signed -- for an Ethereum `personal_sign` that is the
 * digest of the prefixed message, not of the message. `signature` is 65 bytes: r, s, v.
 *
 * Returns null rather than throwing for every malformed or unrecoverable input, so a caller
 * cannot accidentally treat a thrown error as a verification failure and a verification failure
 * as an error. There is exactly one shape of success.
 */
export function recoverAddress(hash: Uint8Array, signature: string): string | null {
  let sig: Uint8Array;
  try {
    sig = bytesFromHex(signature);
  } catch {
    return null;
  }
  if (hash.length !== 32 || sig.length !== 65) return null;

  const r = BigInt(`0x${Buffer.from(sig.subarray(0, 32)).toString("hex")}`);
  const s = BigInt(`0x${Buffer.from(sig.subarray(32, 64)).toString("hex")}`);
  const vRaw = sig[64] as number;
  // 27/28 is the Ethereum convention; 0/1 is the raw recovery id, and both are seen in the wild.
  const recovery = vRaw >= 27 ? vRaw - 27 : vRaw;
  if (recovery !== 0 && recovery !== 1) return null;
  if (r <= 0n || r >= N || s <= 0n || s >= N) return null;

  // y^2 = x^3 + 7. p = 3 mod 4, so the square root is a single exponentiation.
  const ySquared = mod(r * r * r + 7n, P);
  let y = powmod(ySquared, (P + 1n) / 4n, P);
  if (mod(y * y, P) !== ySquared) return null; // r is not the x of any curve point
  if (Number(y & 1n) !== recovery) y = P - y;

  const z = BigInt(`0x${Buffer.from(hash).toString("hex")}`);
  const rInv = invert(r, N);
  // Q = r^-1 (sR - zG)
  const point = multiply(add(multiply({ x: r, y }, s), multiply({ x: GX, y: GY }, N - mod(z, N))), rInv);
  if (point === null) return null;

  const uncompressed = new Uint8Array(64);
  uncompressed.set(toWord(point.x), 0);
  uncompressed.set(toWord(point.y), 32);
  const digest = keccak256(uncompressed);
  return `0x${Buffer.from(digest.subarray(12)).toString("hex")}`;
}

function powmod(base: bigint, exponent: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b, m);
    b = mod(b * b, m);
    e >>= 1n;
  }
  return result;
}

/**
 * The digest `personal_sign` actually signs: keccak256 of the EIP-191 prefix, the decimal length,
 * and the message BYTES.
 *
 * The length is the byte length of the message, and getting that wrong is the classic way to
 * build a verifier that rejects every real signature -- or, worse, one that accepts a signature
 * over a different message of the same length.
 */
export function personalSignDigest(message: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const buffer = new Uint8Array(prefix.length + message.length);
  buffer.set(prefix, 0);
  buffer.set(message, prefix.length);
  return keccak256(buffer);
}
