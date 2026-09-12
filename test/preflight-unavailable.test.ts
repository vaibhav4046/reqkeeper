/**
 * PREFLIGHT_UNAVAILABLE — the platform being busy is not the payment being wrong.
 *
 * A single 429 from KeeperHub used to brick an obligation forever, at zero sends. The catch in
 * `settleObligation` called `releaseObligation` while the state was still PAYMENT_PREFLIGHT,
 * which is not replannable, so the release returned `{ released: false }` and the return value
 * was discarded. Two independent audits reproduced it:
 *
 *     pass 1 (429 at preflight): state=PAYMENT_PREFLIGHT refusal=rate_limited
 *        guidance given to the agent: "... propose again later. Nothing was sent."
 *        is PAYMENT_PREFLIGHT replannable? false        reservation held: YES
 *     pass 2, same plan, platform healthy: state=PAYMENT_PREFLIGHT refusal=ALREADY_DISPATCHED
 *     pass 3, a corrected plan:            state=PAYMENT_PREFLIGHT refusal=ALREADY_DISPATCHED
 *
 * The agent was told to do something the system would refuse forever, and the invoice was lost.
 *
 * The obvious repair — adding PAYMENT_PREFLIGHT to REPLANNABLE — is a trap, and these tests
 * exist to stop someone reaching for it later. It would also admit a re-plan after a simulate
 * TIMEOUT, and this repository documents that a timed-out dry run may have executed for real
 * (#1959). `retryable` cannot separate the two: rate_limited and timeout are both retryable.
 * The discriminator is durable local state — has anything EVER been handed to the provider for
 * this obligation — and that is what the last group here pins.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { encodeCall } from "../src/abi.ts";
import { obligationId } from "../src/identity.ts";
import { PRE_DISPATCH_REFUSALS, REPLANNABLE, TERMINAL, canReplan, canTransition } from "../src/machine.ts";
import { toBaseUnits } from "../src/money.ts";
import { NAMESPACE, PAY_SIGNATURE } from "../src/plan.ts";
import { FixtureProvider, ProviderError, type ExecuteResult, type Receipt, type SimulateResult } from "../src/provider.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";
import type { Policy, SourceFacts } from "../src/policy.ts";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PAYEE = "0x0e2bB0000000000000000000000000000000F531";
const FEE_ADDR = "0xAaAa000000000000000000000000000000000001";
const PROXY = "0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE";
const REFERENCE = "0x0056a1b2c3d4e5f6";

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

function factsFor(amount: string): SourceFacts {
  return {
    chainId: 11155111,
    tokenAddress: FAU,
    tokenDecimals: 18,
    payee: PAYEE,
    invoiceBaseUnits: toBaseUnits(amount, 18).toString(),
    feeBaseUnits: "0",
    feeRecipient: FEE_ADDR,
    hasBeenPaid: false,
  };
}

function stepsFor(amount: string) {
  return [
    {
      kind: "REQUEST_PAYMENT",
      to: PROXY,
      data: encodeCall(PAY_SIGNATURE, [FAU, PAYEE, toBaseUnits(amount, 18).toString(), REFERENCE, "0", FEE_ADDR]),
      value: "0",
    },
  ];
}

function propose(store: Store, provider: FixtureProvider, requestId: string, amount: string, now: number) {
  return settleObligation(
    { store, provider, policy, sourceSaysPaid: async () => true },
    {
      namespace: NAMESPACE,
      requestId,
      obligationId: obligationId(NAMESPACE, requestId),
      paymentReference: REFERENCE,
      facts: factsFor(amount),
      steps: stepsFor(amount),
      approval: { approver: "human:owner", decision: "APPROVED" },
      now,
    },
  );
}

/** A provider whose preflight fails the way a revoked key or a bad request does. */
class HardRefusalProvider extends FixtureProvider {
  override async simulate(): Promise<SimulateResult> {
    throw new ProviderError("bad_response", "400 from provider", false);
  }
}

describe("a retryable preflight failure, with nothing ever dispatched", () => {
  test("lands in PREFLIGHT_UNAVAILABLE at zero sends, and says so", async () => {
    const store = new Store();
    const provider = new FixtureProvider("RATE_LIMITED");
    const requestId = "01req-429";

    const first = await propose(store, provider, requestId, "50", 1_000);

    assert.equal(first.state, "PREFLIGHT_UNAVAILABLE");
    assert.equal(first.refusal, "PREFLIGHT_UNAVAILABLE");
    assert.equal(first.providerWriteIssued, false);
    assert.equal(provider.totalSends(), 0, "a rate limit must never move money");
    assert.match(first.detail ?? "", /nothing has ever been/i);
    store.close();
  });

  test("the reservation comes back, so a CORRECTED plan is not refused forever", async () => {
    // This is the F-6 half. The old code left the reservation attached to the plan that never
    // ran, so changing anything about the plan was answered OBLIGATION_RESERVED for good.
    const store = new Store();
    const provider = new FixtureProvider("RATE_LIMITED");
    const requestId = "01req-429-corrected";

    const first = await propose(store, provider, requestId, "50", 1_000);
    assert.equal(first.state, "PREFLIGHT_UNAVAILABLE");

    provider.setFault("NONE");
    const corrected = await propose(store, provider, requestId, "40", 2_000);

    assert.notEqual(corrected.refusal, "OBLIGATION_RESERVED");
    assert.notEqual(corrected.refusal, "ALREADY_DISPATCHED");
    assert.equal(corrected.state, "SETTLED");
    assert.equal(provider.totalSends(), 1, "the corrected plan pays once, and only once");
    store.close();
  });

  test("proposing the SAME plan again once the platform recovers settles it", async () => {
    const store = new Store();
    const provider = new FixtureProvider("RATE_LIMITED");
    const requestId = "01req-429-same";

    await propose(store, provider, requestId, "50", 1_000);
    provider.setFault("NONE");
    const second = await propose(store, provider, requestId, "50", 2_000);

    assert.equal(second.state, "SETTLED");
    assert.equal(provider.totalSends(), 1);
    store.close();
  });

  test("a NON-retryable preflight error blocks the plan but still hands the reservation back", async () => {
    // Same ordering bug, other branch: the release must happen after the state moves, or a
    // definitively bad plan also bricks the invoice.
    const store = new Store();
    const provider = new HardRefusalProvider();
    const requestId = "01req-hard-refusal";

    const first = await propose(store, provider, requestId, "50", 1_000);
    assert.equal(first.state, "SIMULATION_BLOCKED");
    assert.equal(provider.totalSends(), 0);

    const healthy = new FixtureProvider("NONE");
    const corrected = await propose(store, healthy, requestId, "40", 2_000);
    assert.notEqual(corrected.refusal, "OBLIGATION_RESERVED");
    assert.equal(corrected.state, "SETTLED");
    assert.equal(healthy.totalSends(), 1);
    store.close();
  });
});

describe("PREFLIGHT_UNAVAILABLE is unreachable once anything has been dispatched", () => {
  test("an obligation that already sent is refused before preflight is even reached", async () => {
    // The gate that makes the state safe. Once an attempt carries first_send_at the obligation
    // is no longer in a replannable state, so step 0b refuses re-entry before `simulate` is
    // called at all — a platform outage cannot reopen a settlement that may have moved money.
    const store = new Store();
    const provider = new FixtureProvider("NONE");
    const requestId = "01req-already-sent";

    const first = await propose(store, provider, requestId, "50", 1_000);
    assert.equal(first.state, "SETTLED");
    assert.ok(store.sentAttemptFor(obligationId(NAMESPACE, requestId)), "an attempt must be on the record");

    // The platform now rate-limits. A retryable preflight error must not rescue this.
    provider.setFault("RATE_LIMITED");
    const again = await propose(store, provider, requestId, "50", 2_000);

    assert.notEqual(again.state, "PREFLIGHT_UNAVAILABLE");
    assert.equal(again.refusal, "ALREADY_SETTLED");
    assert.equal(provider.totalSends(), 1, "still exactly one payment");
    store.close();
  });

  test("an unknown outcome is not rescued by a later rate limit either", async () => {
    const store = new Store();
    const provider = new FixtureProvider("TIMEOUT_NO_RESPONSE");
    const requestId = "01req-unknown-then-429";

    const first = await propose(store, provider, requestId, "50", 1_000);
    assert.equal(first.state, "EXECUTION_OUTCOME_UNKNOWN");
    const sends = provider.totalSends();
    assert.equal(sends, 1, "the provider did execute; we just never heard back");

    provider.setFault("RATE_LIMITED");
    const again = await propose(store, provider, requestId, "50", 2_000);

    assert.notEqual(again.state, "PREFLIGHT_UNAVAILABLE");
    assert.equal(again.refusal, "ALREADY_DISPATCHED");
    assert.equal(provider.totalSends(), sends, "an unknown outcome must never authorise a second send");
    store.close();
  });
});

describe("the state is wired into the machine the way the safety argument assumes", () => {
  test("it is replannable, a pre-dispatch refusal, and has no outgoing edge", () => {
    assert.ok(canReplan("PREFLIGHT_UNAVAILABLE"), "the whole point is that the debt can be re-proposed");
    assert.ok(REPLANNABLE.includes("PREFLIGHT_UNAVAILABLE"));
    assert.ok(PRE_DISPATCH_REFUSALS.includes("PREFLIGHT_UNAVAILABLE"), "it is reached at zero sends, by construction");
    assert.ok(TERMINAL.includes("PREFLIGHT_UNAVAILABLE"), "replanning is a separate operation, not a transition");
    assert.equal(canTransition("PAYMENT_PREFLIGHT", "PREFLIGHT_UNAVAILABLE"), true, "the only way in");
  });

  test("PAYMENT_PREFLIGHT itself stays NOT replannable", () => {
    // The trap this state exists to avoid. If someone ever flips this, a simulate timeout —
    // which may have executed for real — becomes a re-plan, and that is a second payment.
    assert.equal(canReplan("PAYMENT_PREFLIGHT"), false);
  });
});
