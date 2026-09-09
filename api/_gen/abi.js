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
import { selector } from "./keccak.js";
export class AbiError extends Error {
    // Declared then assigned: Node's strip-only TypeScript mode rejects parameter properties.
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "AbiError";
    }
}
const WORD = 64; // one 32-byte word, in hex characters
const UINT256_MAX = (1n << 256n) - 1n;
const SUPPORTED = new Set(["address", "uint256", "bytes"]);
/** Split "name(a,b,c)" into its function name and argument types. */
export function parseSignature(signature) {
    const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\((.*)\)$/.exec(signature.trim());
    if (!m)
        throw new AbiError("BAD_SIGNATURE", `not a function signature: ${signature}`);
    const inner = m[2].trim();
    const types = inner === "" ? [] : inner.split(",").map((t) => t.trim());
    for (const t of types) {
        if (!SUPPORTED.has(t)) {
            throw new AbiError("UNSUPPORTED_TYPE", `type "${t}" is not supported by this codec`);
        }
    }
    return { name: m[1], types: types };
}
function stripHex(v, code, what) {
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v)) {
        throw new AbiError(code, `${what} must be a 0x hex string, got ${String(v)}`);
    }
    return v.slice(2);
}
/** Addresses are compared lowercased: mixed case in an EVM address is a checksum, not identity. */
function encodeAddress(v) {
    const hex = stripHex(String(v), "BAD_ADDRESS", "address");
    if (hex.length !== 40)
        throw new AbiError("BAD_ADDRESS", `address must be 20 bytes, got ${hex.length / 2}`);
    return "0".repeat(24) + hex.toLowerCase();
}
/** Accepts a decimal string or a bigint. Never a Number — uint256 exceeds Number.MAX_SAFE_INTEGER. */
function encodeUint256(v) {
    let n;
    if (typeof v === "bigint")
        n = v;
    else if (typeof v === "string" && /^\d+$/.test(v.trim()))
        n = BigInt(v.trim());
    else
        throw new AbiError("BAD_UINT", `uint256 must be a decimal string or bigint, got ${String(v)}`);
    if (n < 0n)
        throw new AbiError("BAD_UINT", "uint256 cannot be negative");
    if (n > UINT256_MAX)
        throw new AbiError("BAD_UINT", "value exceeds uint256");
    return n.toString(16).padStart(WORD, "0");
}
function encodeBytesTail(v) {
    const hex = stripHex(String(v), "BAD_BYTES", "bytes");
    if (hex.length % 2 !== 0)
        throw new AbiError("BAD_BYTES", "bytes must be whole octets");
    const len = hex.length / 2;
    // length word, then the payload right-padded to a whole number of words
    const padded = hex.length === 0 ? "" : hex.padEnd(Math.ceil(hex.length / WORD) * WORD, "0");
    return encodeUint256(String(len)) + padded;
}
/** Encode a full call: 4-byte selector followed by the ABI head and tail. */
export function encodeCall(signature, args) {
    const { types } = parseSignature(signature);
    if (args.length !== types.length) {
        throw new AbiError("ARITY_MISMATCH", `signature takes ${types.length} args, got ${args.length}`);
    }
    const head = [];
    let tail = "";
    // Dynamic offsets are measured from the start of the argument block, past every head word.
    const headBytes = types.length * 32;
    for (let i = 0; i < types.length; i++) {
        switch (types[i]) {
            case "address":
                head.push(encodeAddress(args[i]));
                break;
            case "uint256":
                head.push(encodeUint256(args[i]));
                break;
            case "bytes": {
                head.push(encodeUint256(String(headBytes + tail.length / 2)));
                tail += encodeBytesTail(args[i]);
                break;
            }
        }
    }
    return `0x${selector(signature).slice(2)}${head.join("")}${tail}`;
}
/** Decode a full call. Throws if the selector does not match the signature. */
export function decodeCall(signature, calldata) {
    const { types } = parseSignature(signature);
    const hex = stripHex(calldata, "BAD_CALLDATA", "calldata");
    if (hex.length < 8)
        throw new AbiError("BAD_CALLDATA", "calldata shorter than a selector");
    const sel = `0x${hex.slice(0, 8)}`;
    const expected = selector(signature);
    if (sel.toLowerCase() !== expected.toLowerCase()) {
        throw new AbiError("SELECTOR_MISMATCH", `calldata selector ${sel} is not ${expected} (${signature})`);
    }
    const body = hex.slice(8);
    if (body.length < types.length * WORD) {
        throw new AbiError("BAD_CALLDATA", "calldata truncated: fewer head words than arguments");
    }
    const word = (i) => body.slice(i * WORD, (i + 1) * WORD);
    const out = [];
    for (let i = 0; i < types.length; i++) {
        const w = word(i);
        switch (types[i]) {
            case "address": {
                if (!/^0{24}/.test(w))
                    throw new AbiError("BAD_CALLDATA", `address word ${i} has dirty high bytes`);
                out.push(`0x${w.slice(24)}`);
                break;
            }
            case "uint256":
                out.push(BigInt(`0x${w}`).toString(10));
                break;
            case "bytes": {
                const offsetBytes = Number(BigInt(`0x${w}`));
                const at = offsetBytes * 2;
                if (at + WORD > body.length)
                    throw new AbiError("BAD_CALLDATA", `bytes offset ${offsetBytes} out of range`);
                const len = Number(BigInt(`0x${body.slice(at, at + WORD)}`));
                const start = at + WORD;
                if (start + len * 2 > body.length)
                    throw new AbiError("BAD_CALLDATA", `bytes length ${len} out of range`);
                out.push(`0x${body.slice(start, start + len * 2)}`);
                break;
            }
        }
    }
    return out;
}
/**
 * The load-bearing check. Decode the platform-independent calldata, then re-encode the
 * arguments and require the result to be byte-identical. Case is normalised because an EVM
 * address's case is a checksum; nothing else is normalised.
 *
 * Returns the decoded arguments so the caller can hand them to a platform that will only
 * accept arguments — having proved they mean exactly the approved bytes.
 */
export function decodeAndVerify(signature, calldata) {
    const args = decodeCall(signature, calldata);
    const reencoded = encodeCall(signature, args);
    if (reencoded.toLowerCase() !== calldata.toLowerCase()) {
        throw new AbiError("BAD_CALLDATA", `re-encoding did not reproduce the original calldata\n  original:  ${calldata}\n  re-encoded: ${reencoded}`);
    }
    return args;
}
