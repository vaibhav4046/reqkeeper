/**
 * A signer for the tests, written independently of the verifier it exercises.
 *
 * `src/secp256k1.ts` recovers an address from a signature. Nothing in `src/` signs anything, and
 * nothing in `src/` should: this project holds no keys. But a test that wants to prove "an
 * increase signed by the payee is refused, and one signed by the payer is accepted" has to be
 * able to produce both, and a fixture carrying `0x1111…` proves only that garbage is rejected.
 *
 * The curve arithmetic here is deliberately a second implementation rather than an import of the
 * first. If both were the same code, a bug in it would cancel itself out: every signature this
 * file produced would verify under the same mistake, and the tests would agree with each other
 * about something untrue. They agree with the live chain instead —
 * `scripts/verify-signatures.ts` recovers all 46 real invoices' actions to the parties Request
 * names, which is the check no fixture can fake.
 */


import { keccak256 } from "../src/keccak.ts";
import { personalSignDigest } from "../src/secp256k1.ts";

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = { x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n };

type Pt = { x: bigint; y: bigint } | null;

const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m;

function inv(a: bigint, m: bigint): bigint {
  let [r0, r1] = [mod(a, m), m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new Error("not invertible");
  return mod(s0, m);
}

function addPoints(a: Pt, b: Pt): Pt {
  if (a === null) return b;
  if (b === null) return a;
  if (a.x === b.x && mod(a.y + b.y, P) === 0n) return null;
  const lam =
    a.x === b.x
      ? mod(3n * a.x * a.x * inv(2n * a.y, P), P)
      : mod((b.y - a.y) * inv(mod(b.x - a.x, P), P), P);
  const x = mod(lam * lam - a.x - b.x, P);
  return { x, y: mod(lam * (a.x - x) - a.y, P) };
}

function mul(point: Pt, k: bigint): Pt {
  let acc: Pt = null;
  let base = point;
  let n = mod(k, N);
  while (n > 0n) {
    if (n & 1n) acc = addPoints(acc, base);
    base = addPoints(base, base);
    n >>= 1n;
  }
  return acc;
}

const hex32 = (v: bigint): string => v.toString(16).padStart(64, "0");

/** The address a private key controls. */
export function addressOf(privateKey: bigint): string {
  const pub = mul(G, privateKey);
  if (pub === null) throw new Error("degenerate key");
  const bytes = Uint8Array.from(Buffer.from(hex32(pub.x) + hex32(pub.y), "hex"));
  return `0x${Buffer.from(keccak256(bytes).subarray(12)).toString("hex")}`;
}

/**
 * A 65-byte signature over `digest`, with the recovery byte set so the public key can be
 * recovered from it.
 *
 * `s` is normalised to the lower half of the curve order and the recovery parity flipped to
 * match, which is what every Ethereum signer does — a high-`s` signature is equally valid
 * mathematically and equally unwelcome in practice.
 */
export function signDigest(digest: Uint8Array, privateKey: bigint): string {
  const z = BigInt(`0x${Buffer.from(digest).toString("hex")}`);
  // Deterministic k, in the spirit of RFC 6979: one key and one digest always produce the same
  // signature. A random k made `signAction` impure, and a fixture that signs its create twice --
  // once for the bytes it serves, once for the channel id derived from those bytes -- then built
  // an id the served create does not hash to. That failure reads as a reader bug and is a fixture
  // bug. Determinism is also what lets a recorded vector be recorded at all.
  for (let counter = 0n; ; counter++) {
    const seed = Buffer.from(hex32(mod(privateKey, N)) + Buffer.from(digest).toString("hex") + hex32(counter), "hex");
    const k = mod(BigInt(`0x${Buffer.from(keccak256(Uint8Array.from(seed))).toString("hex")}`), N);
    if (k === 0n) continue;
    const R = mul(G, k);
    if (R === null) continue;
    const r = mod(R.x, N);
    if (r === 0n) continue;
    let s = mod(inv(k, N) * (z + r * mod(privateKey, N)), N);
    if (s === 0n) continue;
    let recovery = Number(R.y & 1n) ^ (R.x >= N ? 2 : 0);
    if (s > N / 2n) {
      s = N - s;
      recovery ^= 1;
    }
    return `0x${hex32(r)}${hex32(s)}${(recovery + 27).toString(16).padStart(2, "0")}`;
  }
}

/** Request's normalisation: keys deep-sorted, then the whole JSON string lowercased. */
export function normalizedText(data: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(sort(data)).toLowerCase();
}

/** The digest Request signs under `ecdsa`: keccak256 over the normalised text. */
export function actionDigest(data: unknown): Uint8Array {
  return keccak256(new TextEncoder().encode(normalizedText(data)));
}

/** The signed envelope the gateway serves, for an action and the key that took it. */
export function signAction(data: unknown, privateKey: bigint): { data: unknown; signature: { method: string; value: string } } {
  return { data, signature: { method: "ecdsa", value: signDigest(actionDigest(data), privateKey) } };
}

/** Two parties with keys, so a test can sign as either and as neither. */
export const PAYEE_KEY = 0x00000000000000000000000000000000000000000000000000000000000a11cen;
export const PAYER_KEY = 0x0000000000000000000000000000000000000000000000000000000000000b0bn;
export const STRANGER_KEY = 0x000000000000000000000000000000000000000000000000000000000000deadn;

/**
 * The same authorisation, produced the way a browser wallet produces it.
 *
 * `personal_sign` signs the EIP-191 prefix and the message, and Request calls that method
 * `ecdsa-ethereum`. Two encodings of the same message are in the wild -- the 32 digest bytes, and
 * the `0x…` text of those bytes -- so a fixture can produce either and the reader is expected to
 * recognise both.
 */
export function signActionPersonal(
  data: unknown,
  privateKey: bigint,
): { data: unknown; signature: { method: string; value: string } } {
  // What Request's web3 signature provider does: `signMessage(Buffer.from(normalize(data)))` --
  // the EIP-191 message is the normalised JSON TEXT, not its hash. A previous version of this
  // helper signed the hash and the hex of the hash, and the reader under test accepted both, so
  // the test proved only that two pieces of this repository agreed with each other.
  const message = new TextEncoder().encode(normalizedText(data));
  return {
    data,
    signature: { method: "ecdsa-ethereum", value: signDigest(personalSignDigest(message), privateKey) },
  };
}
