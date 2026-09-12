/**
 * Reconciliation matches the payment, not just the reference.
 *
 * A payment reference is public. It is `last8Bytes(keccak256(requestId + salt + payee))` over
 * data anchored openly on Sepolia, so anyone who can read an invoice can compute one — and
 * `ERC20FeeProxy.transferFromWithReferenceAndFee` is a stateless forwarder that will emit an
 * event carrying any reference you hand it. Matching on the reference alone therefore means
 * accepting a stranger's transaction as proof this invoice was paid.
 *
 * Two audits found the same hole from opposite directions: the reconciler compared only the
 * amount and never `to`, `tokenAddress`, `feeAddress` or `feeAmount`; and the "already paid"
 * pre-check compared nothing at all, so a 1-wei transfer carrying a reference could block that
 * invoice permanently. Both are the same missing comparison.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import {
  assertChainId,
  EXPECTED_CHAIN_ID,
  findPaymentByReference,
  matchPaymentLog,
  type PaymentExpectation,
} from "../src/chain.ts";
import { ERC20_FEE_PROXY, FAU } from "../src/plan.ts";

const PAYEE = "0x0e2bB0000000000000000000000000000000F531";
const STRANGER = "0xdEAdBeef00000000000000000000000000000001";
const FEE_ADDR = "0xAaAa000000000000000000000000000000000001";
const OTHER_TOKEN = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const REFERENCE = "0x0056a1b2c3d4e5f6";
const ONE_FAU = "1000000000000000000";
const TX = `0x${"ab".repeat(32)}`;

const expected: PaymentExpectation = {
  tokenAddress: FAU,
  to: PAYEE,
  amount: ONE_FAU,
  feeAmount: "0",
  feeAddress: FEE_ADDR,
};

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** The five non-indexed words, in the order the fee proxy emits them. */
function logData(o: {
  token?: string;
  to?: string;
  amount?: string;
  feeAmount?: string;
  feeAddress?: string;
}): string {
  return (
    "0x" +
    word(o.token ?? FAU) +
    word(o.to ?? PAYEE) +
    word(BigInt(o.amount ?? ONE_FAU).toString(16)) +
    word(BigInt(o.feeAmount ?? "0").toString(16)) +
    word(o.feeAddress ?? FEE_ADDR)
  );
}

const fields = (o: Parameters<typeof logData>[0] = {}) => ({
  tokenAddress: o.token ?? FAU,
  to: o.to ?? PAYEE,
  amount: o.amount ?? ONE_FAU,
  feeAmount: o.feeAmount ?? "0",
  feeAddress: o.feeAddress ?? FEE_ADDR,
});

describe("matchPaymentLog compares every field the payment is made of", () => {
  test("the honest payment matches", () => {
    const verdict = matchPaymentLog({ ...fields(), emitter: ERC20_FEE_PROXY }, expected);
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.conflicts, []);
  });

  test("a payment to somebody else is a conflict, not a settlement", () => {
    const verdict = matchPaymentLog({ ...fields({ to: STRANGER }), emitter: ERC20_FEE_PROXY }, expected);
    assert.equal(verdict.ok, false);
    assert.match(verdict.conflicts.join(" "), /pays 0xdEAdBeef/i);
  });

  test("a payment in another token is a conflict", () => {
    const verdict = matchPaymentLog({ ...fields({ token: OTHER_TOKEN }), emitter: ERC20_FEE_PROXY }, expected);
    assert.equal(verdict.ok, false);
    assert.match(verdict.conflicts.join(" "), /token/i);
  });

  test("a dust transfer carrying the reference is a conflict", () => {
    // The griefing shape: 1 wei with a reference anyone can compute, which used to be enough
    // to mark an invoice SOURCE_ALREADY_PAID forever.
    const verdict = matchPaymentLog({ ...fields({ amount: "1" }), emitter: ERC20_FEE_PROXY }, expected);
    assert.equal(verdict.ok, false);
    assert.match(verdict.conflicts.join(" "), /moves 1,/);
  });

  test("a fee skimmed to somebody else is a conflict", () => {
    const verdict = matchPaymentLog(
      { ...fields({ feeAmount: "5", feeAddress: STRANGER }), emitter: ERC20_FEE_PROXY },
      expected,
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.conflicts.length, 2, "both the fee amount and its recipient disagree");
  });

  test("an event from a contract that is not the fee proxy is a conflict", () => {
    const verdict = matchPaymentLog({ ...fields(), emitter: STRANGER }, expected);
    assert.equal(verdict.ok, false);
    assert.match(verdict.conflicts.join(" "), /ERC20FeeProxy/);
  });

  test("addresses compare case-insensitively, so checksum spelling is not a conflict", () => {
    const verdict = matchPaymentLog(
      { ...fields({ to: PAYEE.toLowerCase(), token: FAU.toUpperCase().replace("0X", "0x") }), emitter: ERC20_FEE_PROXY },
      expected,
    );
    assert.equal(verdict.ok, true, "a different spelling of the same address is the same address");
  });
});

describe("findPaymentByReference refuses a log that carries the reference but pays someone else", () => {
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
  });

  /** Answers eth_chainId, eth_blockNumber and eth_getLogs with the log under test. */
  function stubChain(logs: Array<{ data: string; transactionHash: string; address: string; blockNumber: string }>) {
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const { method } = JSON.parse(init.body) as { method: string };
      const result =
        method === "eth_chainId"
          ? `0x${EXPECTED_CHAIN_ID.toString(16)}`
          : method === "eth_blockNumber"
            ? "0x64"
            : logs;
      return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    }) as unknown as typeof fetch;
  }

  const foreign = [
    { data: logData({ to: STRANGER }), transactionHash: TX, address: ERC20_FEE_PROXY, blockNumber: "0x64" },
  ];
  const ours = [
    { data: logData({}), transactionHash: TX, address: ERC20_FEE_PROXY, blockNumber: "0x64" },
  ];

  test("a foreign log is not found, and says why", async () => {
    stubChain(foreign);
    const sighting = await findPaymentByReference(REFERENCE, { lookbackBlocks: 50, expect: expected });

    assert.equal(sighting.found, false, "a payment to a stranger must never read as this invoice paid");
    assert.ok(sighting.conflicts && sighting.conflicts.length > 0, "and it must not read as silence either");
    assert.match(sighting.conflicts.join(" "), /pays 0xdEAdBeef/i);
  });

  test("the same log, with no expectation supplied, is still found — the check is the expectation", async () => {
    // The control. Without this the test above would pass for the wrong reason: a scan that
    // returned nothing at all would also satisfy it.
    stubChain(foreign);
    const sighting = await findPaymentByReference(REFERENCE, { lookbackBlocks: 50 });
    assert.equal(sighting.found, true);
    assert.equal(sighting.to?.toLowerCase(), STRANGER.toLowerCase());
  });

  test("our own payment is found, with every field decoded", async () => {
    stubChain(ours);
    const sighting = await findPaymentByReference(REFERENCE, { lookbackBlocks: 50, expect: expected });

    assert.equal(sighting.found, true);
    assert.equal(sighting.txHash, TX);
    assert.equal(sighting.amount, ONE_FAU);
    assert.equal(sighting.to?.toLowerCase(), PAYEE.toLowerCase());
    assert.equal(sighting.tokenAddress?.toLowerCase(), FAU.toLowerCase());
    assert.equal(sighting.feeAmount, "0");
    assert.equal(sighting.corroborated, true, "a second endpoint returned the same transaction");
  });
});

describe("an RPC endpoint has to be on the right chain before it is believed", () => {
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
  });

  test("a wrong-chain endpoint is refused, by name and by number", async () => {
    // `grep -rn "eth_chainId" src/` used to return nothing. A transaction hash is only unique
    // within a chain, so a receipt or a log read from the wrong one was accepted as this
    // chain's evidence. An RPC URL is a string; nothing about it says who answers.
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const { method } = JSON.parse(init.body) as { method: string };
      const result = method === "eth_chainId" ? "0x1" : method === "eth_blockNumber" ? "0x64" : [];
      return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => assertChainId("https://pretending-to-be-sepolia.example"),
      (e: Error) => /refusing to read chain 1\b/.test(e.message) && e.message.includes(String(EXPECTED_CHAIN_ID)),
    );
  });

  test("the right chain passes, so the check is not refusing everything", async () => {
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const { method } = JSON.parse(init.body) as { method: string };
      const result = method === "eth_chainId" ? `0x${EXPECTED_CHAIN_ID.toString(16)}` : "0x64";
      return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    }) as unknown as typeof fetch;

    await assert.doesNotReject(() => assertChainId("https://actually-sepolia.example"));
  });
});
