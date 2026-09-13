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
import type { PaymentSighting } from "../src/chain.ts";
import { obligationId } from "../src/identity.ts";
import { PRE_DISPATCH_REFUSALS, REPLANNABLE, TERMINAL, canReplan, canTransition } from "../src/machine.ts";
import { toBaseUnits } from "../src/money.ts";
import { NAMESPACE, PAY_SIGNATURE } from "../src/plan.ts";
import { FixtureProvider, ProviderError, type ExecuteResult, type Receipt, type SimulateOutcome } from "../src/provider.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";
import { drainUntilQuiet } from "../src/worker.ts";
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
    { store, provider, policy, sourceSaysPaid: async () => true, currentBlock: async () => PREFLIGHT_HEAD },
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
  override async simulate(): Promise<SimulateOutcome> {
    throw new ProviderError("bad_response", "400 from provider", false);
  }
}

/**
 * The dry run executes and then answers `{"success": false}` with no revert verdict. Both
 * transports map that to `wouldRevert: true, simulated: false` -- fail-closed for the dispatch
 * decision, because an unreadable answer must never authorise a send. The bug this pins is what
 * happened next: settle read `wouldRevert` alone as "the provider simulated and said no", ended
 * the chain observation, released the reservation into SIMULATION_BLOCKED (replannable), and the
 * agent was told "The payment would revert. A retry repeats the revert." The retry paid.
 */
class LeakySilentFailureProvider extends FixtureProvider {
  override async simulate(): Promise<SimulateOutcome> {
    this.sendCounts.set("leaked-simulate", (this.sendCounts.get("leaked-simulate") ?? 0) + 1);
    // A reply that failed without a verdict. The whole point is that this is UNKNOWN and not
    // WOULD_REVERT: the dry run above already moved money.
    return { kind: "UNKNOWN", code: "simulate_unsuccessful", detail: "success:false, no verdict" };
  }
}

/** A provider that really did simulate, and the payment really does revert. */
class HonestRevertProvider extends FixtureProvider {
  override async simulate(): Promise<SimulateOutcome> {
    return { kind: "WOULD_REVERT", detail: "the provider simulated the call and it reverts" };
  }
}

/**
 * The same leak, reported as a DEFINITE failure. Both transports raise non-retryable for any
 * 4xx -- a 409, or a 4xx whose body is not JSON at all, which is what an edge or WAF HTML page
 * looks like. None of those can tell a plan the provider rejected from a plan it executed
 * before the reply was lost.
 */
class LeakyHardFailureProvider extends FixtureProvider {
  override async simulate(): Promise<SimulateOutcome> {
    this.sendCounts.set("leaked-simulate", (this.sendCounts.get("leaked-simulate") ?? 0) + 1);
    throw new ProviderError("bad_response", "400 from provider", false);
  }
}

/** The #1959 hazard in its dangerous shape: the dry run executes, and then the reply is lost. */
class LeakyTimeoutProvider extends FixtureProvider {
  override async simulate(): Promise<SimulateOutcome> {
    this.sendCounts.set("leaked-simulate", (this.sendCounts.get("leaked-simulate") ?? 0) + 1);
    throw new ProviderError("timeout", "no response from provider", true);
  }
}

// `truncated: false` because that is what a conclusive read returns, and the worker now
// requires it explicitly. This fixture omitted the flag and so pinned the lenient reading:
// it asserted that an obligation is released on a scan that never said whether it covered
// the window. That is the reading the whole file exists to argue against.
// The head when the dry run ran, and a scan ceiling well past it. A scan cannot see the
// mempool, so the observer may only call absence conclusive once the chain has moved on from
// the moment a broadcast could have happened. These fixtures model a read taken later.
const PREFLIGHT_HEAD = 11_000_000;
const AGED_CEILING = PREFLIGHT_HEAD + 10;
const unpaid: PaymentSighting = {
  found: false,
  corroborated: true,
  scannedBlocks: 450_000,
  truncated: false,
  scannedTo: AGED_CEILING,
};

/** Covered the window, but read it before the chain could have mined a leak. */
const unpaidButTooSoon: PaymentSighting = {
  found: false,
  corroborated: true,
  scannedBlocks: 450_000,
  truncated: false,
  scannedTo: PREFLIGHT_HEAD,
};
const paid: PaymentSighting = {
  found: true,
  txHash: `0x${"ab".repeat(32)}`,
  amount: toBaseUnits("50", 18).toString(),
  to: PAYEE,
  tokenAddress: FAU,
  corroborated: true,
  scannedBlocks: 450_000,
};

/** The observer the money paths defer to: it reads the chain, and only it may conclude. */
function drain(store: Store, sighting: PaymentSighting) {
  return drainUntilQuiet(
    {
      store,
      provider: { receipt: async () => null as unknown as Receipt },
      sourceSaysPaid: async () => true,
      sightPayment: async () => sighting,
    },
    { now: 1_000_000, maxPasses: 3, lookaheadMs: 120_000 },
  );
}

describe("a retryable preflight failure, with nothing ever dispatched", () => {
  test("holds the reservation and refuses to conclude, at zero sends", async () => {
    const store = new Store();
    const provider = new FixtureProvider("RATE_LIMITED");
    const requestId = "01req-429";

    const first = await propose(store, provider, requestId, "50", 1_000);

    // Not PREFLIGHT_UNAVAILABLE. That state is replannable, and entering it asserts that nothing
    // executed -- which nothing reachable from here is in a position to know.
    assert.equal(first.state, "PAYMENT_PREFLIGHT");
    assert.equal(first.refusal, "EXECUTION_OUTCOME_UNKNOWN");
    assert.equal(first.providerWriteIssued, false);
    assert.equal(provider.totalSends(), 0, "a rate limit must never move money");
    assert.match(first.detail ?? "", /not known here/i);

    // The observation committed alongside PAYMENT_PREFLIGHT is still queued: the question was
    // handed to the thing that can answer it, not cancelled.
    assert.ok(store.pendingJobKinds().includes("OBSERVE_PREFLIGHT"));
    store.close();
  });

  test("a second proposal before the observer has looked sends nothing", async () => {
    // The duplicate-payment path, as a test. The old code released the reservation here on the
    // strength of `retryable` alone, and the next proposal paid the invoice a second time.
    const store = new Store();
    const provider = new FixtureProvider("RATE_LIMITED");
    const requestId = "01req-429-second";

    await propose(store, provider, requestId, "50", 1_000);
    provider.setFault("NONE");
    const second = await propose(store, provider, requestId, "50", 2_000);

    assert.notEqual(second.state, "SETTLED");
    assert.equal(provider.totalSends(), 0, "the platform recovering is not evidence about the dry run");
    store.close();
  });

  test("once the observer establishes nothing paid, the debt is payable again and pays once", async () => {
    const store = new Store();
    const provider = new FixtureProvider("RATE_LIMITED");
    const requestId = "01req-429-resolved";

    await propose(store, provider, requestId, "50", 1_000);
    await drain(store, unpaid);

    // Only now, and only because the chain was read across the whole window.
    assert.equal(store.getObligation(obligationId(NAMESPACE, requestId))?.state, "PREFLIGHT_UNAVAILABLE");

    provider.setFault("NONE");
    const corrected = await propose(store, provider, requestId, "40", 2_000);
    assert.notEqual(corrected.refusal, "OBLIGATION_RESERVED");
    assert.equal(corrected.state, "SETTLED");
    assert.equal(provider.totalSends(), 1, "the corrected plan pays once, and only once");
    store.close();
  });

  test("a dry run that executed is found by the observer, and never pays twice", async () => {
    // #1959 in its dangerous shape: the execution happens and the reply is lost, so the provider
    // reports exactly what a harmless rate limit reports.
    const store = new Store();
    const provider = new LeakyTimeoutProvider();
    const requestId = "01req-leaked-simulate";

    const first = await propose(store, provider, requestId, "50", 1_000);
    assert.equal(first.refusal, "EXECUTION_OUTCOME_UNKNOWN");
    assert.equal(provider.totalSends(), 1, "the dry run moved money; that is the premise");

    // A caller that takes "the platform was busy" at face value and proposes again.
    const second = await propose(store, provider, requestId, "50", 2_000);
    assert.notEqual(second.state, "SETTLED");
    assert.equal(provider.totalSends(), 1, "TWO SENDS HERE IS THE DUPLICATE PAYMENT");

    // The observer looks, finds the leaked execution, and hands it to a human.
    await drain(store, paid);
    assert.equal(store.getObligation(obligationId(NAMESPACE, requestId))?.state, "EVIDENCE_CONFLICT");
    assert.equal(provider.totalSends(), 1);
    store.close();
  });

  test("a NON-retryable preflight error does not conclude anything either", async () => {
    // This test used to assert that a definite rejection hands the reservation back, and that
    // assertion was the second duplicate-payment path. A red-team pass walked through it: both
    // transports raise non-retryable for any 4xx, the branch released into SIMULATION_BLOCKED,
    // which is replannable, and the next proposal paid an invoice whose dry run had already
    // executed. "The provider said no" and "the provider never answered" are the same sentence
    // to this code, because a 4xx can arrive after the execution as easily as before it.
    const store = new Store();
    const provider = new HardRefusalProvider();
    const requestId = "01req-hard-refusal";

    const first = await propose(store, provider, requestId, "50", 1_000);
    assert.equal(first.state, "PAYMENT_PREFLIGHT");
    assert.equal(first.refusal, "EXECUTION_OUTCOME_UNKNOWN");
    assert.equal(provider.totalSends(), 0);
    assert.ok(store.pendingJobKinds().includes("OBSERVE_PREFLIGHT"));

    // Once the chain has been read and says nothing paid, the debt is payable again.
    await drain(store, unpaid);
    assert.equal(store.getObligation(obligationId(NAMESPACE, requestId))?.state, "PREFLIGHT_UNAVAILABLE");

    const healthy = new FixtureProvider("NONE");
    const corrected = await propose(store, healthy, requestId, "40", 2_000);
    assert.notEqual(corrected.refusal, "OBLIGATION_RESERVED");
    assert.equal(corrected.state, "SETTLED");
    assert.equal(healthy.totalSends(), 1);
    store.close();
  });

  test("a failed simulate with no verdict is not a verdict, and never pays twice", async () => {
    // The red-team repro, driven through the same shape the real transports produce.
    const store = new Store();
    const provider = new LeakySilentFailureProvider();
    const requestId = "01req-silent-simulate-failure";

    const first = await propose(store, provider, requestId, "50", 1_000);
    assert.equal(first.refusal, "EXECUTION_OUTCOME_UNKNOWN");
    assert.notEqual(first.state, "SIMULATION_BLOCKED");
    assert.equal(provider.totalSends(), 1, "the dry run moved money; that is the premise");
    assert.ok(store.pendingJobKinds().includes("OBSERVE_PREFLIGHT"));

    const second = await propose(store, provider, requestId, "50", 2_000);
    assert.notEqual(second.state, "SETTLED");
    assert.equal(provider.totalSends(), 1, "TWO SENDS HERE IS THE DUPLICATE PAYMENT");

    await drain(store, paid);
    assert.equal(store.getObligation(obligationId(NAMESPACE, requestId))?.state, "EVIDENCE_CONFLICT");
    assert.equal(provider.totalSends(), 1);
    store.close();
  });

  test("a real revert verdict still blocks the plan and hands the reservation back", async () => {
    // The control. Splitting the flag must not turn a genuine revert into a wedge: a provider
    // that actually simulated and says the payment reverts is conclusive, and re-planning from
    // there is both safe and the point.
    const store = new Store();
    const provider = new HonestRevertProvider();
    const requestId = "01req-honest-revert";

    const first = await propose(store, provider, requestId, "50", 1_000);
    assert.equal(first.state, "SIMULATION_BLOCKED");
    assert.equal(first.refusal, "SIMULATION_BLOCKED");
    assert.equal(provider.totalSends(), 0);

    const healthy = new FixtureProvider("NONE");
    const corrected = await propose(store, healthy, requestId, "40", 2_000);
    assert.equal(corrected.state, "SETTLED");
    assert.equal(healthy.totalSends(), 1);
    store.close();
  });

  test("a dry run that executed and then returned 4xx never pays twice", async () => {
    // The red-team repro, kept. The leak is the premise; the duplicate is what must not happen.
    const store = new Store();
    const provider = new LeakyHardFailureProvider();
    const requestId = "01req-leaked-hard-failure";

    const first = await propose(store, provider, requestId, "50", 1_000);
    assert.equal(first.refusal, "EXECUTION_OUTCOME_UNKNOWN");
    assert.equal(provider.totalSends(), 1, "the dry run moved money; that is the premise");

    // A human approves again and the agent proposes again, which is the realistic sequence.
    const second = await propose(store, provider, requestId, "50", 2_000);
    assert.notEqual(second.state, "SETTLED");
    assert.equal(provider.totalSends(), 1, "TWO SENDS HERE IS THE DUPLICATE PAYMENT");

    await drain(store, paid);
    assert.equal(store.getObligation(obligationId(NAMESPACE, requestId))?.state, "EVIDENCE_CONFLICT");
    assert.equal(provider.totalSends(), 1);
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
