/**
 * What a negative chain read is allowed to mean, and the window that decides it.
 *
 * `findPaymentByReference` marked a scan `truncated` whenever its floor was above block 0. On a
 * live chain that is every scan there has ever been: a red-team pass measured head 11692278 with
 * the standard 300k lookback, which puts the floor at 11392278, so `truncated` was permanently
 * true and every `found: false` read as "I could not tell".
 *
 * That flag is load-bearing in exactly one direction. `src/worker.ts` releases an obligation to
 * PREFLIGHT_UNAVAILABLE — the one way back for an obligation whose preflight failed, and since
 * `settleObligation` routes every failed simulate into that state, the way back for all of them —
 * only when `truncated !== true`. Against the real chain that condition could never be met, so
 * the recovery path was unreachable and those obligations were wedged permanently: 24 hours of
 * drains with the plan TTL long past still answered ALREADY_DISPATCHED.
 *
 * The repair is the meaning, not the threshold. A payment cannot predate the invoice it pays, so
 * the invoice's own anchor block is the floor below which there is nothing to find, and a scan
 * that reaches it has covered the whole window that could contain the payment. A caller that
 * cannot name that floor gets the fail-safe answer it got before, because the one thing this flag
 * must never do is let "I could not tell" become "go ahead".
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { EXPECTED_CHAIN_ID, findPaymentByReference, type PaymentExpectation } from "../src/chain.ts";
import { obligationId } from "../src/identity.ts";
import { toBaseUnits } from "../src/money.ts";
import { FAU, NAMESPACE } from "../src/plan.ts";
import type { Receipt } from "../src/provider.ts";
import { Store } from "../src/store.ts";
import { drainUntilQuiet } from "../src/worker.ts";

/** The numbers the red team measured against Sepolia, used as measured. */
const HEAD = 11692278;
const ANCHOR = 11691240;
const LOOKBACK = 300_000;

const PAYEE = "0x0e2bB0000000000000000000000000000000F531";
const FEE_ADDR = "0xAaAa000000000000000000000000000000000001";
const REFERENCE = "0x0056a1b2c3d4e5f6";
const AMOUNT = toBaseUnits("50", 18).toString();
const PLAN_HASH = "c".repeat(64);

const expectation: PaymentExpectation = {
  tokenAddress: FAU,
  to: PAYEE,
  amount: AMOUNT,
  feeAmount: "0",
  feeAddress: FEE_ADDR,
};

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/**
 * A Sepolia at block 11692278 with no fee-proxy log for this reference anywhere, recording every
 * range it is asked for. Every endpoint answers, fallbacks included, so nothing here reaches the
 * network — and the recorded ranges are how "the window widened" is proved rather than assumed.
 */
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

describe("a scan is truncated when it could not cover the window, not when it skipped genesis", () => {
  test("with the invoice's anchor block, a negative on the live chain is an answer", async () => {
    stubEmptyChain();

    const sighting = await findPaymentByReference(REFERENCE, {
      lookbackBlocks: LOOKBACK,
      anchorBlock: ANCHOR,
      expect: expectation,
    });

    assert.equal(sighting.found, false);
    assert.equal(
      sighting.truncated,
      false,
      "the scan reached the block the invoice was anchored at; nothing below it could pay this invoice",
    );
    assert.ok(
      sighting.scannedFrom !== undefined && sighting.scannedFrom <= ANCHOR,
      `and it says where it stopped, so the claim is checkable: ${sighting.scannedFrom} must be at or below ${ANCHOR}`,
    );
  });

  test("with no anchor to reach, the same negative stays inconclusive", async () => {
    // The fail-safe half, and the reason this is not simply `truncated = false`. Nothing here
    // knows how old the invoice is, so nothing here can say the window was wide enough.
    stubEmptyChain();

    const sighting = await findPaymentByReference(REFERENCE, { lookbackBlocks: LOOKBACK, expect: expectation });

    assert.equal(sighting.found, false);
    assert.equal(sighting.truncated, true, "'I could not tell' must not quietly become 'go ahead'");
    assert.equal(sighting.scannedFrom, HEAD - LOOKBACK);
  });

  test("an anchor below the requested window widens the scan rather than shortening the answer", async () => {
    // An older invoice: the caller's lookback stops 700k blocks short of the anchor. Reporting
    // "conclusive" over the shorter window would be a lie; the scan goes and covers it.
    const old = HEAD - 1_000_000;
    const { ranges } = stubEmptyChain();

    const sighting = await findPaymentByReference(REFERENCE, {
      lookbackBlocks: LOOKBACK,
      anchorBlock: old,
      expect: expectation,
    });

    assert.equal(sighting.truncated, false);
    assert.equal(sighting.scannedFrom, old);
    assert.equal(Math.min(...ranges.map((r) => r.from)), old, "the chain was actually asked down to the anchor");
    assert.equal(Math.max(...ranges.map((r) => r.to)), HEAD);
  });

  test("a scan that really did reach genesis is still conclusive without an anchor", async () => {
    // The old rule, kept: `fromBlock: 0` covers every window there is.
    stubEmptyChain();

    const sighting = await findPaymentByReference(REFERENCE, { fromBlock: 0, expect: expectation });

    assert.equal(sighting.truncated, false);
    assert.equal(sighting.scannedFrom, 0);
  });
});

const receipt = async (hash: string): Promise<Receipt> => ({
  hash,
  verified: true,
  receiptStatus: "success",
  gasUsed: "1",
});

/**
 * Exactly what a SIGKILL inside `simulate` leaves behind — the same reconstruction
 * `test/preflight-crash.test.ts` uses, and the state a failed simulate now always lands in.
 */
function wedgedInsideSimulate(requestId: string) {
  const store = new Store();
  const oid = obligationId(NAMESPACE, requestId);
  store.importObligation({
    obligationId: oid,
    namespace: NAMESPACE,
    requestId,
    sourceFactsJson: JSON.stringify({
      invoiceBaseUnits: AMOUNT,
      payee: PAYEE,
      tokenAddress: FAU,
      feeBaseUnits: "0",
      feeRecipient: FEE_ADDR,
    }),
    sourceFactsHash: "h",
    paymentReference: REFERENCE,
    now: 1,
  });
  for (const s of ["VALIDATING", "AWAITING_APPROVAL", "APPROVED"] as const) store.setState(oid, s, 1);
  assert.deepEqual(store.reserveObligation(oid, PLAN_HASH), { ok: true });
  store.beginPreflight(oid, PLAN_HASH, 1);
  assert.equal(store.obligationForRecovery(oid)?.state, "PAYMENT_PREFLIGHT");
  assert.equal(store.sentAttemptFor(oid), undefined, "nothing was ever dispatched");
  return { store, oid };
}

/** The real chain read, wired into the real worker — the production path, not a hand-made flag. */
function drainAgainstChain(store: Store, opts: { anchorBlock?: number }) {
  return drainUntilQuiet(
    {
      store,
      provider: { receipt },
      sourceSaysPaid: async () => true,
      sightPayment: (reference, expect) =>
        findPaymentByReference(reference, { lookbackBlocks: LOOKBACK, expect, ...opts }),
    },
    { now: 1_000_000, maxPasses: 3, lookaheadMs: 120_000 },
  );
}

describe("the worker's way out of a failed preflight is reachable against a live-sized chain", () => {
  test("the chain is read to the invoice's anchor, and the debt becomes payable again", async () => {
    // The wedge, end to end: head 11692278, a 300k lookback, nothing on chain. Every ingredient
    // is the production one, and before the semantics were fixed this obligation stayed in
    // PAYMENT_PREFLIGHT forever with its reservation held.
    stubEmptyChain();
    const { store, oid } = wedgedInsideSimulate("01req-window-wedge");

    await drainAgainstChain(store, { anchorBlock: ANCHOR });

    assert.equal(store.getObligation(oid)?.state, "PREFLIGHT_UNAVAILABLE");
    assert.equal(store.pendingJobCount(), 0, "the observation is answered, not deferred forever");
    assert.equal(
      store.getObligation(oid)?.reservedByPlan ?? null,
      null,
      "the reservation is handed back, which is what makes the debt payable again",
    );
    store.close();
  });

  test("with no anchor supplied it stays wedged rather than guessing", async () => {
    // The control that keeps the fix honest. Reaching PREFLIGHT_UNAVAILABLE on a window nothing
    // can vouch for would release an obligation whose dry run may have executed for real (#1959).
    stubEmptyChain();
    const { store, oid } = wedgedInsideSimulate("01req-window-no-anchor");

    await drainAgainstChain(store, {});

    assert.equal(store.getObligation(oid)?.state, "PAYMENT_PREFLIGHT");
    assert.equal(store.pendingJobCount(), 1, "the question is still open, and still queued");
    store.close();
  });
});
