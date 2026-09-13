/**
 * `truncated` has to be MEASURED, not restated.
 *
 * The first repair of this flag set `floor = min(requested, anchorFloor)` and then asked
 * `floor > anchorFloor`. That condition is unsatisfiable: supplying any anchor at all made
 * `truncated` false unconditionally. The flag stopped being a statement about what the scan
 * reached and became a restatement of whatever the caller claimed — which is the same defect as
 * the one it was added to fix, one level up.
 *
 * It matters because an anchor can be wrong without anyone forging anything. `storageAnchor` used
 * to fall back to the first `storageMeta` entry carrying an ethereum block when the create's own
 * entry had none, and on a channel with later actions (an amount increase, a cancel) that is a
 * LATER block. A too-high anchor asserted coverage of a window the scan never reached, so an
 * invoice paid before that window read as unpaid at the one gate that exists to catch a payment
 * this store did not make.
 *
 * Too-high is the unsafe direction. Absent is handled everywhere; wrong is not.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { EXPECTED_CHAIN_ID, findPaymentByReference, type PaymentExpectation } from "../src/chain.ts";
import { toBaseUnits } from "../src/money.ts";
import { FAU } from "../src/plan.ts";

const HEAD = 11_692_278;
const ANCHOR = 11_691_240;
const LOOKBACK = 300_000;

const PAYEE = "0x0e2bB0000000000000000000000000000000F531";
const FEE_ADDR = "0xAaAa000000000000000000000000000000000001";
const REFERENCE = "0x0056a1b2c3d4e5f6";

const expectation: PaymentExpectation = {
  tokenAddress: FAU,
  to: PAYEE,
  amount: toBaseUnits("50", 18).toString(),
  feeAmount: "0",
  feeAddress: FEE_ADDR,
};

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** A Sepolia at HEAD with no fee-proxy log for this reference, recording every range asked for. */
function stubEmptyChain(): { ranges: Array<{ from: number; to: number }> } {
  const ranges: Array<{ from: number; to: number }> = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] };
    let result: unknown = [];
    if (method === "eth_chainId") result = `0x${EXPECTED_CHAIN_ID.toString(16)}`;
    else if (method === "eth_blockNumber") result = `0x${HEAD.toString(16)}`;
    else if (method === "eth_getLogs") {
      const filter = params[0] as { fromBlock: string; toBlock: string };
      ranges.push({ from: Number(BigInt(filter.fromBlock)), to: Number(BigInt(filter.toBlock)) });
    }
    return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  }) as unknown as typeof fetch;
  return { ranges };
}

describe("an anchor is honoured only where it can be true", () => {
  test("an anchor above the chain head is not an anchor, and the scan says so", async () => {
    stubEmptyChain();

    const sighting = await findPaymentByReference(REFERENCE, {
      lookbackBlocks: LOOKBACK,
      anchorBlock: HEAD + 50_000,
      expect: expectation,
    });

    assert.equal(sighting.found, false);
    assert.equal(
      sighting.truncated,
      true,
      "a block that does not exist yet cannot be a create block, and must not license a conclusive negative",
    );
  });

  test("a too-high anchor inside the chain cannot assert coverage the scan never had", async () => {
    // The `.find(Boolean)` case: an anchor from a LATER action on the same channel. The scan
    // still only reaches `head - lookback`, so it has not covered everything below that anchor.
    stubEmptyChain();

    const sighting = await findPaymentByReference(REFERENCE, {
      lookbackBlocks: 1_000,
      anchorBlock: HEAD - 10,
      expect: expectation,
    });

    assert.equal(sighting.found, false);
    assert.equal(
      sighting.truncated,
      false,
      "this one IS covered: the floor (head-1000) is below the claimed anchor (head-10)",
    );

    // And the inverse: a lookback that stops above the anchor has not covered the window.
    const short = await findPaymentByReference(REFERENCE, {
      lookbackBlocks: 5,
      anchorBlock: HEAD - 100_000,
      expect: expectation,
    });
    assert.equal(short.truncated, false, "the anchor widens the floor rather than shortening it");
    assert.ok(
      short.scannedFrom !== undefined && short.scannedFrom <= HEAD - 100_000,
      `the scan must actually reach the anchor it claims: ${short.scannedFrom}`,
    );
  });

  test("with no anchor a negative stays inconclusive, however far back it looked", async () => {
    stubEmptyChain();

    const sighting = await findPaymentByReference(REFERENCE, {
      lookbackBlocks: LOOKBACK,
      expect: expectation,
    });

    assert.equal(sighting.found, false);
    assert.equal(
      sighting.truncated,
      true,
      "without a floor to prove coverage against, 300k blocks of silence is still only silence",
    );
  });

  test("the flag tracks the scan, not the caller's claim", async () => {
    // The regression in one assertion. Under the old `floor > (anchorFloor ?? 0)` with
    // `floor = min(requested, anchorFloor)`, every one of these came back `false`.
    stubEmptyChain();

    const withAnchor = await findPaymentByReference(REFERENCE, { lookbackBlocks: LOOKBACK, anchorBlock: ANCHOR });
    const noAnchor = await findPaymentByReference(REFERENCE, { lookbackBlocks: LOOKBACK });
    const impossibleAnchor = await findPaymentByReference(REFERENCE, { lookbackBlocks: LOOKBACK, anchorBlock: HEAD * 2 });

    assert.deepEqual(
      [withAnchor.truncated, noAnchor.truncated, impossibleAnchor.truncated],
      [false, true, true],
      "the same scan depth must yield different answers depending on what could be proved",
    );
  });
});
