import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { keccak256Hex, selector } from "../src/keccak.ts";

describe("keccak256 — published vectors", () => {
  test("empty input", () => {
    assert.equal(
      keccak256Hex(""),
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });

  test("abc", () => {
    assert.equal(
      keccak256Hex("abc"),
      "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });

  test("the canonical Ethereum test string", () => {
    assert.equal(
      keccak256Hex("hello"),
      "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8",
    );
  });

  test("input exactly one block long (136 bytes) exercises the padding edge", () => {
    // A full rate block means the pad occupies an entire extra block.
    const block = "a".repeat(136);
    const h = keccak256Hex(block);
    assert.match(h, /^0x[0-9a-f]{64}$/);
    assert.notEqual(h, keccak256Hex("a".repeat(135)));
    assert.notEqual(h, keccak256Hex("a".repeat(137)));
  });

  test("multi-block input", () => {
    const h = keccak256Hex("x".repeat(1000));
    assert.match(h, /^0x[0-9a-f]{64}$/);
    assert.notEqual(h, keccak256Hex("x".repeat(999)));
  });
});

describe("keccak256 is NOT sha3-256", () => {
  test("differs from Node's sha3-256, which uses a different pad byte", () => {
    // The whole reason this file exists. SHA-3 pads 0x06, original Keccak pads 0x01.
    const sha3 = `0x${createHash("sha3-256").update("").digest("hex")}`;
    assert.equal(sha3, "0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a");
    assert.notEqual(keccak256Hex(""), sha3);
  });
});

describe("selector", () => {
  test("ERC-20 transfer, the most widely published selector there is", () => {
    assert.equal(selector("transfer(address,uint256)"), "0xa9059cbb");
  });

  test("ERC-20 approve", () => {
    assert.equal(selector("approve(address,uint256)"), "0x095ea7b3");
  });

  test("ERC-20 allowance and balanceOf", () => {
    assert.equal(selector("allowance(address,address)"), "0xdd62ed3e");
    assert.equal(selector("balanceOf(address)"), "0x70a08231");
  });

  test("Request's ERC20FeeProxy payment entrypoint", () => {
    // Cross-checked against the live dispatcher in the deployed Sepolia bytecode at
    // 0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE — see test/proxy-selector.test.ts.
    assert.equal(
      selector("transferFromWithReferenceAndFee(address,address,uint256,bytes,uint256,address)"),
      "0xc219a14d",
    );
  });

  test("rejects a non-canonical signature with whitespace", () => {
    assert.throws(() => selector("transfer(address, uint256)"), /whitespace/);
  });

  test("is sensitive to argument types, not just the name", () => {
    assert.notEqual(selector("transfer(address,uint256)"), selector("transfer(address,uint128)"));
  });
});
