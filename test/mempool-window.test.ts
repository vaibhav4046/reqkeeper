/**
 * A scan cannot see the mempool, so covering the window is not the same as looking late enough.
 *
 * This is the fifth instance of the class, and it was introduced by the fix for the fourth. The
 * recovery path releases an obligation when a chain scan finds no payment. Making that scan's
 * `truncated` flag honest — so `PREFLIGHT_UNAVAILABLE` became reachable at all, which it had never
 * been on a live chain — turned a branch that was dead into a branch that runs. The branch was
 * fail-closed only by accident, and shipping it live shipped the hole with it.
 *
 * `eth_getLogs` returns logs from blocks. A transaction the dry run leaked (#1959) is not in a
 * block yet; it is in the mempool. The scan covers every block in range, finds nothing, and
 * reports `truncated: false` with complete honesty. The worker reads "nothing was broadcast",
 * releases, and the next proposal pays the invoice a second time.
 *
 * The losing timing is the ordinary one, not a rare race: `OBSERVE_PREFLIGHT` comes due thirty
 * seconds after the preflight, the resolver claims it with a sixty-second lookahead, and Sepolia
 * takes about twelve seconds a block. The observer routinely looks before a leak could be mined.
 *
 * The fix first attempted here was "has enough chain passed since the send could have happened",
 * measured as `scannedTo >= preflightBlock + minConfirmations()`. A later adversarial pass showed
 * that question is also the wrong one, and this file's own control test was asserting the wrong
 * answer as intended behaviour: elapsed chain measures how far the chain has moved, while what
 * must be excluded is how long a transaction can sit pending — which has no bound. Eight instances
 * of one class now. The sound answer is a spent nonce, in src/exclusion.ts.
 *
 * What survives here is the half that was always right: a scan taken too early proves nothing.
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
const PAYER = "0x00000000000000000000000000000000000ce111";

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
  requestId: "01req-mempool",
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

/** The dry run executes for real and the reply is lost — #1959, the premise throughout. */
class LeakyProvider extends FixtureProvider {
  override async simulate(): Promise<SimulateOutcome> {
    this.sendCounts.set("leaked-simulate", (this.sendCounts.get("leaked-simulate") ?? 0) + 1);
    throw new Error("gateway timeout");
  }
}

function settle(store: Store, provider: FixtureProvider, requestId: string, now: number) {
  return settleObligation(
    { store, provider, policy, sourceSaysPaid: async () => true, currentBlock: async () => PREFLIGHT_HEAD },
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

/** An honest scan: it covered everything down to the anchor, and it looked at `ceiling`. */
function honestScan(ceiling: number) {
  return async (): Promise<PaymentSighting> => ({
    found: false,
    corroborated: true,
    truncated: false,
    scannedBlocks: 300_000,
    scannedFrom: ANCHOR_BLOCK,
    scannedTo: ceiling,
  });
}

function drain(store: Store, sighting: ReturnType<typeof honestScan>) {
  return drainUntilQuiet(
    {
      store,
      provider: { receipt: async () => null as unknown as Receipt },
      sourceSaysPaid: async () => true,
      sightPayment: sighting,
    },
    { now: 1_000_000, maxPasses: 3, lookaheadMs: 120_000 },
  );
}

describe("absence is only evidence once the chain has moved past the send", () => {
  test("a scan taken before the leak could be mined does not release the obligation", async () => {
    const store = new Store();
    const provider = new LeakyProvider();
    const requestId = "01req-mempool-too-soon";

    const first = await settle(store, provider, requestId, 1_000);
    assert.equal(first.refusal, "EXECUTION_OUTCOME_UNKNOWN");
    assert.equal(provider.totalSends(), 1, "the dry run leaked a send; that is the premise");

    // The observer looks at the same block the preflight ran at. Honest, complete, and far too
    // early: the leaked transaction is in the mempool, which no log query can see.
    await drain(store, honestScan(PREFLIGHT_HEAD));

    assert.equal(
      store.getObligation(obligationId(NAMESPACE, requestId))?.state,
      "PAYMENT_PREFLIGHT",
      "an honest but too-recent scan must not be read as 'nothing was broadcast'",
    );

    // And the proposal that would have paid a second time is refused.
    const second = await settle(store, provider, requestId, 2_000);
    assert.notEqual(second.state, "SETTLED");
    assert.equal(provider.totalSends(), 1, "TWO SENDS HERE IS THE DUPLICATE PAYMENT");
    store.close();
  });

  test("chain moving past the preflight is NOT what releases it", async () => {
    // This test used to assert the opposite, and asserting it is how the hole shipped. The gate
    // it guarded measured elapsed chain, and elapsed chain says nothing about a transaction
    // sitting in the mempool: there is no number of blocks after which a pending transaction
    // becomes unmineable. test/mempool-residency.test.ts is the repro that cost two sends.
    const store = new Store();
    const provider = new LeakyProvider();
    const requestId = "01req-mempool-aged";

    await settle(store, provider, requestId, 1_000);
    await drain(store, honestScan(PREFLIGHT_HEAD + 10_000));

    assert.equal(
      store.getObligation(obligationId(NAMESPACE, requestId))?.state,
      "PAYMENT_PREFLIGHT",
      "ten thousand blocks is still not evidence that nothing is pending",
    );
    store.close();
  });

  test("a consumed nonce is what releases it, and the debt is payable again", async () => {
    // The control the age gate was reaching for, done with a fact instead of a clock. The payer's
    // nonce has moved, so any transaction the dry run broadcast is bound to a nonce some other
    // transaction has already spent and can never be included. Liveness is preserved — this is
    // still the way out of a failed dry run — but it is bought with a proof.
    const store = new Store();
    const provider = new LeakyProvider();
    const requestId = "01req-mempool-excluded";

    await settleObligation(
      {
        store,
        provider,
        policy,
        sourceSaysPaid: async () => true,
        currentBlock: async () => PREFLIGHT_HEAD,
        payerNonce: async () => 42,
      },
      {
        namespace: NAMESPACE,
        requestId,
        obligationId: obligationId(NAMESPACE, requestId),
        paymentReference: REFERENCE,
        facts,
        steps,
        approval: { approver: "human:owner", decision: "APPROVED" },
        now: 1_000,
      },
    );

    await drainUntilQuiet(
      {
        store,
        provider: { receipt: async () => null as unknown as Receipt },
        sourceSaysPaid: async () => true,
        sightPayment: honestScan(PREFLIGHT_HEAD + 10),
        payer: PAYER,
        readPayerNonce: async () => ({ payer: PAYER, nonce: 43, head: PREFLIGHT_HEAD }),
      },
      { now: 1_000_000, maxPasses: 3, lookaheadMs: 120_000 },
    );

    assert.equal(
      store.getObligation(obligationId(NAMESPACE, requestId))?.state,
      "PREFLIGHT_UNAVAILABLE",
      "a spent nonce makes the silence conclusive, so the debt becomes payable again",
    );
    store.close();
  });

  test("an obligation with no recorded preflight block is never released on absence", async () => {
    // Rows written before the column existed, and any path where the head could not be read.
    // Unknown waits: there is no block to measure the scan's recency against.
    const store = new Store();
    const provider = new LeakyProvider();
    const requestId = "01req-mempool-no-head";

    await settleObligation(
      { store, provider, policy, sourceSaysPaid: async () => true },
      {
        namespace: NAMESPACE,
        requestId,
        obligationId: obligationId(NAMESPACE, requestId),
        paymentReference: REFERENCE,
        facts,
        steps,
        approval: { approver: "human:owner", decision: "APPROVED" },
        now: 1_000,
      },
    );

    await drain(store, honestScan(PREFLIGHT_HEAD + 10_000));

    assert.equal(
      store.getObligation(obligationId(NAMESPACE, requestId))?.state,
      "PAYMENT_PREFLIGHT",
      "without a preflight block there is nothing to measure recency against, so it waits",
    );
    store.close();
  });
});
