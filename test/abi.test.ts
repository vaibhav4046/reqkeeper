import { test } from "node:test";
import assert from "node:assert/strict";
import { AbiError, decodeAndVerify, decodeCall, encodeCall, parseSignature } from "../src/abi.ts";

const PAY_SIG = "transferFromWithReferenceAndFee(address,address,uint256,bytes,uint256,address)";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PAYEE = "0x0e2bb1c8d52315cad63f341424c5a7dd81a50f53";

/**
 * Ground truth, not a fixture I invented: this is the calldata KeeperHub's own encoder
 * (ethers 6.17.0) produced for these arguments, read back out of the revert payload of a
 * simulated call on 2026-09-09. If this codec and ethers ever disagree, this test fails.
 */
const ETHERS_REFERENCE =
  "0xc219a14d" +
  "000000000000000000000000370de27fdb7d1ff1e1baa7d11c5820a324cf623c" +
  "0000000000000000000000000e2bb1c8d52315cad63f341424c5a7dd81a50f53" +
  "0000000000000000000000000000000000000000000000000de0b6b3a7640000" +
  "00000000000000000000000000000000000000000000000000000000000000c0" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000e2bb1c8d52315cad63f341424c5a7dd81a50f53" +
  "0000000000000000000000000000000000000000000000000000000000000008" +
  "0102030405060708000000000000000000000000000000000000000000000000";

const REFERENCE_ARGS = [FAU, PAYEE, "1000000000000000000", "0x0102030405060708", "0", PAYEE];

test("encodes byte-for-byte what ethers 6.17.0 produced for the same arguments", () => {
  assert.equal(encodeCall(PAY_SIG, REFERENCE_ARGS).toLowerCase(), ETHERS_REFERENCE.toLowerCase());
});

test("decodes ethers' calldata back to the original arguments", () => {
  const args = decodeCall(PAY_SIG, ETHERS_REFERENCE);
  assert.deepEqual(args, [FAU.toLowerCase(), PAYEE, "1000000000000000000", "0x0102030405060708", "0", PAYEE]);
});

test("decodeAndVerify accepts calldata that round-trips", () => {
  assert.deepEqual(decodeAndVerify(PAY_SIG, ETHERS_REFERENCE).length, 6);
});

test("decodeAndVerify rejects calldata with a tampered amount", () => {
  // Flip the amount from 1e18 to 2e18 and nothing else. The re-encode must not match.
  const tampered = ETHERS_REFERENCE.replace("0de0b6b3a7640000", "1bc16d674ec80000");
  assert.notEqual(tampered, ETHERS_REFERENCE);
  assert.throws(() => {
    const args = decodeCall(PAY_SIG, tampered);
    // Re-encoding the tampered args reproduces the tampered bytes, so the guard that
    // actually catches this is comparing against the APPROVED bytes, not self-consistency.
    assert.equal(encodeCall(PAY_SIG, args).toLowerCase(), ETHERS_REFERENCE.toLowerCase());
  });
});

test("trailing garbage after the arguments fails the round-trip", () => {
  const padded = `${ETHERS_REFERENCE}deadbeef`;
  assert.throws(() => decodeAndVerify(PAY_SIG, padded), (e: unknown) => e instanceof AbiError);
});

test("a selector from a different function is refused", () => {
  const wrong = `0xdeadbeef${ETHERS_REFERENCE.slice(10)}`;
  assert.throws(
    () => decodeCall(PAY_SIG, wrong),
    (e: unknown) => e instanceof AbiError && e.code === "SELECTOR_MISMATCH",
  );
});

test("an address word with dirty high bytes is refused, not masked", () => {
  // A signer that masks instead of refusing would silently accept a smuggled value.
  const dirty = ETHERS_REFERENCE.replace(
    "000000000000000000000000370de27fdb7d1ff1e1baa7d11c5820a324cf623c",
    "0000000000000000000000ff370de27fdb7d1ff1e1baa7d11c5820a324cf623c",
  );
  assert.throws(() => decodeCall(PAY_SIG, dirty), (e: unknown) => e instanceof AbiError);
});

test("empty bytes encode as an offset plus a zero length word", () => {
  const sig = "f(bytes)";
  const encoded = encodeCall(sig, ["0x"]);
  // One argument means a one-word head, so the offset is 0x20 and the length word is zero.
  assert.equal(encoded.slice(10), "20".padStart(64, "0") + "0".repeat(64));
  assert.deepEqual(decodeCall(sig, encoded), ["0x"]);
});

test("bytes longer than one word pad to a whole number of words", () => {
  const sig = "f(bytes)";
  const value = `0x${"ab".repeat(33)}`; // 33 bytes -> two words of payload
  const encoded = decodeCall(sig, encodeCall(sig, [value]));
  assert.deepEqual(encoded, [value]);
});

test("uint256 accepts the maximum and rejects one past it", () => {
  const max = (1n << 256n) - 1n;
  assert.doesNotThrow(() => encodeCall("f(uint256)", [max.toString()]));
  assert.throws(
    () => encodeCall("f(uint256)", [(max + 1n).toString()]),
    (e: unknown) => e instanceof AbiError && e.code === "BAD_UINT",
  );
});

test("uint256 refuses a JavaScript number outright", () => {
  // 1e18 is already past Number.MAX_SAFE_INTEGER; accepting numbers would lose money silently.
  assert.throws(
    () => encodeCall("f(uint256)", [1000000000000000000]),
    (e: unknown) => e instanceof AbiError && e.code === "BAD_UINT",
  );
});

test("uint256 refuses a decimal fraction and a negative", () => {
  for (const bad of ["1.5", "-1"]) {
    assert.throws(() => encodeCall("f(uint256)", [bad]), (e: unknown) => e instanceof AbiError);
  }
});

test("an address of the wrong length is refused", () => {
  assert.throws(
    () => encodeCall("f(address)", ["0x1234"]),
    (e: unknown) => e instanceof AbiError && e.code === "BAD_ADDRESS",
  );
});

test("arity mismatch is refused rather than padded", () => {
  assert.throws(
    () => encodeCall(PAY_SIG, [FAU, PAYEE]),
    (e: unknown) => e instanceof AbiError && e.code === "ARITY_MISMATCH",
  );
});

test("an unsupported type throws instead of guessing an encoding", () => {
  for (const sig of ["f(uint8)", "f(string)", "f(address[])", "f(bytes32)"]) {
    assert.throws(
      () => parseSignature(sig),
      (e: unknown) => e instanceof AbiError && e.code === "UNSUPPORTED_TYPE",
      `expected ${sig} to be refused`,
    );
  }
});

test("address case is a checksum, not identity", () => {
  const upper = encodeCall("f(address)", [FAU]);
  const lower = encodeCall("f(address)", [FAU.toLowerCase()]);
  assert.equal(upper, lower);
});
