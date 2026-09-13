/**
 * Recovery has to finish, not just refuse.
 *
 * Every failed dry run now ends in PAYMENT_PREFLIGHT with the outcome unknown and the reservation
 * held, because nothing at the provider can tell a call that never ran from one that ran and lost
 * its reply. That is the safety half, and four duplicate-payment findings paid for it.
 *
 * The liveness half is this file. The only thing that can end that uncertainty is the chain, and
 * a chain read can only be conclusive if it covers the window a payment could be in. A payment
 * cannot predate its invoice, so the invoice's own anchor block is that floor — and the anchor
 * has to survive the whole route to be useful: Request's gateway -> InvoiceFacts -> SourceFacts ->
 * the stored facts JSON -> obligationForRecovery -> the worker -> findPaymentByReference.
 *
 * Break any link and the system is still perfectly safe and never recovers: `truncated` stays
 * true, the worker refuses to conclude from a truncated scan (correctly), and the obligation is
 * wedged for ever. "It never pays twice" is not the whole property. It also has to pay once.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { encodeCall } from "../src/abi.ts";
import type { PaymentSighting } from "../src/chain.ts";
import { obligationId } from "../src/identity.ts";
import { toBaseUnits } from "../src/money.ts";
import { NAMESPACE, PAY_SIGNATURE, buildSourceFacts } from "../src/plan.ts";
import { FixtureProvider, type Receipt } from "../src/provider.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";
import { drainUntilQuiet } from "../src/worker.ts";
import type { Policy } from "../src/policy.ts";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PAYEE = "0x0e2bB0000000000000000000000000000000F531";
const FEE_ADDR = "0xAaAa000000000000000000000000000000000001";
const PROXY = "0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE";
const REFERENCE = "0x0056a1b2c3d4e5f6";
const ANCHOR_BLOCK = 11_690_278;
const PREFLIGHT_HEAD = 11_691_000;
const AGED_CEILING = PREFLIGHT_HEAD + 10;

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

/** Built the way the money paths build them: from the invoice, anchor included. */
function factsFrom(anchorBlock: number | undefined) {
  return buildSourceFacts({
    requestId: "01req-liveness",
    paymentReference: REFERENCE,
    payee: PAYEE,
    amountBaseUnits: toBaseUnits("50", 18).toString(),
    maxTotalDebitBaseUnits: toBaseUnits("50", 18).toString(),
    feeAmount: "0",
    feeAddress: FEE_ADDR,
    hasBeenPaid: false,
    tokenAddress: FAU,
    ...(anchorBlock === undefined ? {} : { anchorBlock }),
  });
}

const steps = [
  {
    kind: "REQUEST_PAYMENT",
    to: PROXY,
    data: encodeCall(PAY_SIGNATURE, [FAU, PAYEE, toBaseUnits("50", 18).toString(), REFERENCE, "0", FEE_ADDR]),
    value: "0",
  },
];

async function wedge(store: Store, requestId: string, anchorBlock: number | undefined) {
  const provider = new FixtureProvider("RATE_LIMITED");
  const outcome = await settleObligation(
    { store, provider, policy, sourceSaysPaid: async () => true, currentBlock: async () => PREFLIGHT_HEAD },
    {
      namespace: NAMESPACE,
      requestId,
      obligationId: obligationId(NAMESPACE, requestId),
      paymentReference: REFERENCE,
      facts: factsFrom(anchorBlock),
      steps,
      approval: { approver: "human:owner", decision: "APPROVED" },
      now: 1_000,
    },
  );
  assert.equal(outcome.refusal, "EXECUTION_OUTCOME_UNKNOWN");
  assert.equal(provider.totalSends(), 0);
  return provider;
}

/**
 * Stands in for the real scan. It answers the question `findPaymentByReference` answers: a
 * negative is conclusive only when the floor it reached is at or below the invoice's anchor.
 */
function scanner(anchorSeenBy: { value?: number }) {
  return async (_reference: string, _expect?: unknown, anchorBlock?: number): Promise<PaymentSighting> => {
    anchorSeenBy.value = anchorBlock;
    const floor = anchorBlock ?? 11_392_278;
    return {
      found: false,
      corroborated: true,
      scannedBlocks: 300_000,
      truncated: floor > (anchorBlock ?? 0),
      // Read after the chain moved past the preflight, which is what makes absence evidence.
      scannedTo: AGED_CEILING,
    };
  };
}

describe("an obligation wedged by a failed dry run can actually be recovered", () => {
  test("the anchor reaches the scan, the silence is conclusive, and the debt is payable again", async () => {
    const store = new Store();
    const requestId = "01req-liveness-anchored";
    await wedge(store, requestId, ANCHOR_BLOCK);

    const seen: { value?: number } = {};
    await drainUntilQuiet(
      {
        store,
        provider: { receipt: async () => null as unknown as Receipt },
        sourceSaysPaid: async () => true,
        sightPayment: scanner(seen),
      },
      { now: 1_000_000, maxPasses: 3, lookaheadMs: 120_000 },
    );

    // The whole route, asserted at its far end: the number that started life in Request's
    // storageMeta arrived at the chain read.
    assert.equal(seen.value, ANCHOR_BLOCK, "the invoice anchor must survive facts -> store -> worker -> scan");
    assert.equal(
      store.getObligation(obligationId(NAMESPACE, requestId))?.state,
      "PREFLIGHT_UNAVAILABLE",
      "a conclusive silence must release the obligation, or recovery never completes",
    );

    // And released means payable: the corrected plan settles, once.
    const healthy = new FixtureProvider("NONE");
    const again = await settleObligation(
      { store, provider: healthy, policy, sourceSaysPaid: async () => true },
      {
        namespace: NAMESPACE,
        requestId,
        obligationId: obligationId(NAMESPACE, requestId),
        paymentReference: REFERENCE,
        facts: factsFrom(ANCHOR_BLOCK),
        steps,
        approval: { approver: "human:owner", decision: "APPROVED" },
        now: 2_000,
      },
    );
    assert.equal(again.state, "SETTLED");
    assert.equal(healthy.totalSends(), 1);
    store.close();
  });

  test("without an anchor it stays held — safe, and the honest cost of not knowing", async () => {
    // The control, and it must keep passing. An unbounded scan cannot distinguish "never paid"
    // from "paid before the window", so it stays wedged rather than guessing. This is the
    // behaviour that makes the test above meaningful rather than a tautology.
    const store = new Store();
    const requestId = "01req-liveness-unanchored";
    await wedge(store, requestId, undefined);

    const seen: { value?: number } = {};
    await drainUntilQuiet(
      {
        store,
        provider: { receipt: async () => null as unknown as Receipt },
        sourceSaysPaid: async () => true,
        sightPayment: async (_r: string, _e?: unknown, anchorBlock?: number) => {
          seen.value = anchorBlock;
          return { found: false, corroborated: true, scannedBlocks: 300_000, truncated: true, scannedTo: AGED_CEILING };
        },
      },
      { now: 1_000_000, maxPasses: 3, lookaheadMs: 120_000 },
    );

    assert.equal(seen.value, undefined, "no anchor was stored, so none should be claimed");
    assert.equal(
      store.getObligation(obligationId(NAMESPACE, requestId))?.state,
      "PAYMENT_PREFLIGHT",
      "a truncated scan must never release the obligation",
    );
    store.close();
  });
});
