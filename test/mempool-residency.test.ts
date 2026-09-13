/**
 * Chain progress is not mempool residency. Seventh instance of the class.
 *
 * The sixth instance was fixed by asking "has enough chain passed since the send could have
 * happened" — `scannedTo >= preflightBlock + minConfirmations()`. An adversarial pass then showed
 * what that question actually measures: how far the chain has moved, which is not how long a
 * transaction can sit in the mempool. There is no bound on the second. A leaked dry run (#1959)
 * with a low fee can sit pending through any number of blocks and be mined afterwards, and every
 * block that passes makes the age gate *more* willing to release, not less.
 *
 * So the gate answers a question nobody asked. "Ten blocks have passed" was being consumed as
 * "nothing was broadcast" — a value that means "I do not know" read as if it meant "no", which is
 * the same defect this codebase has now found eight times.
 *
 * What makes a negative conclusive is exclusion, not elapsed time: a nonce that has been consumed
 * by a different mined transaction can never carry the leak, because a nonce is spent once. That
 * is a proof about the payment itself rather than about the clock. See `src/exclusion.ts`.
 *
 * This file is the repro. It asserts on physical sends, not on states, because the states were
 * self-consistent the whole time — it was the money that moved twice.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { encodeCall } from "../src/abi.ts";
import type { PaymentSighting } from "../src/chain.ts";
import { obligationId } from "../src/identity.ts";
import { toBaseUnits } from "../src/money.ts";
import { NAMESPACE, PAY_SIGNATURE, buildSourceFacts } from "../src/plan.ts";
import { FixtureProvider, type Receipt, type SimulateOutcome } from "../src/provider.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";
import { drainUntilQuiet } from "../src/worker.ts";
import type { Policy } from "../src/policy.ts";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PAYEE = "0x0e2bB0000000000000000000000000000000F531";
const FEE_ADDR = "0xAaAa000000000000000000000000000000000001";
const PROXY = "0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE";
const REFERENCE = "0x0056a1b2c3d4e5f6";
const ANCHOR_BLOCK = 11_690_000;
const PREFLIGHT_HEAD = 11_691_000;
const AMOUNT = toBaseUnits("50", 18).toString();

const policy: Policy = {
  version: 1,
  chainId: 11155111,
  token: { address: FAU, decimals: 18, symbol: "FAU" },
  allowedPayees: [PAYEE],
  maxTotalDebitBaseUnits: toBaseUnits("100", 18).toString(),
  allowedFeeRecipients: [FEE_ADDR],
  maxFeeBaseUnits: toBaseUnits("1", 18).toString(),
  planTtlSeconds: 900,
};

const facts = buildSourceFacts({
  requestId: "01req-residency",
  paymentReference: REFERENCE,
  payee: PAYEE,
  amountBaseUnits: AMOUNT,
  maxTotalDebitBaseUnits: AMOUNT,
  feeAmount: "0",
  feeAddress: FEE_ADDR,
  tokenAddress: FAU,
  anchorBlock: ANCHOR_BLOCK,
});

const steps = [
  {
    kind: "REQUEST_PAYMENT",
    to: PROXY,
    data: encodeCall(PAY_SIGNATURE, [FAU, PAYEE, AMOUNT, REFERENCE, "0", FEE_ADDR]),
    value: "0",
  },
];

/**
 * Leaks once, then behaves. #1959 is intermittent, and this is the shape that costs money: the
 * retry has to succeed for the second payment to land. A provider that leaks every time merely
 * wedges.
 */
class LeaksOnceProvider extends FixtureProvider {
  #leaked = false;

  override async simulate(): Promise<SimulateOutcome> {
    if (this.#leaked) return { kind: "WOULD_SUCCEED", gasEstimate: "21000" };
    this.#leaked = true;
    // The physical send the dry run was never supposed to make, counted the way every other
    // send in this suite is counted.
    this.sendCounts.set("leaked-simulate", (this.sendCounts.get("leaked-simulate") ?? 0) + 1);
    throw new Error("gateway timeout");
  }
}

/** Honest and complete: covered everything down to the anchor, looked as far as `ceiling`. */
function honestScan(ceiling: number) {
  return async (): Promise<PaymentSighting> => ({
    found: false,
    corroborated: true,
    truncated: false,
    conflictKinds: [],
    negativeCorroborations: 2,
    scannedBlocks: 300_000,
    scannedFrom: ANCHOR_BLOCK,
    scannedTo: ceiling,
  });
}

function settle(store: Store, provider: FixtureProvider, requestId: string, now: number) {
  return settleObligation(
    { store, provider, policy, approvalAuthority: "caller" as const, sourceSaysPaid: async () => true, currentBlock: async () => PREFLIGHT_HEAD },
    {
      namespace: NAMESPACE,
      requestId,
      obligationId: obligationId(NAMESPACE, requestId),
      paymentReference: REFERENCE,
      facts,
      steps,
      approval: { approver: "human:owner", decision: "APPROVED" },
      now,
    },
  );
}

describe("a pending transaction outlives any number of blocks", () => {
  test("chain moving past the preflight is not evidence the mempool is empty", async () => {
    const store = new Store();
    const provider = new LeaksOnceProvider();
    const requestId = "01req-residency-sends-twice";

    const first = await settle(store, provider, requestId, 1_000);
    assert.equal(first.refusal, "EXECUTION_OUTCOME_UNKNOWN");
    assert.equal(provider.totalSends(), 1, "the dry run leaked a send; that is the premise");

    // Ten thousand blocks — a day and a half of Sepolia — and the leak is still pending. Nothing
    // about the passage of time evicts it, and the scan is telling the whole truth about blocks.
    await drainUntilQuiet(
      {
        store,
        provider: { receipt: async () => null as unknown as Receipt },
        sourceSaysPaid: async () => true,
        sightPayment: honestScan(PREFLIGHT_HEAD + 10_000),
      },
      { now: 1_000_000, maxPasses: 3, lookaheadMs: 120_000 },
    );

    // The second proposal needs no new human decision: same plan hash, so the approval recorded
    // before the leak is reused.
    await settle(store, provider, requestId, 2_000);

    assert.equal(
      provider.totalSends(),
      1,
      "TWO SENDS HERE IS THE DUPLICATE PAYMENT — one approval, one obligation, two physical sends",
    );
    store.close();
  });
});
