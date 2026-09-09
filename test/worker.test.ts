/**
 * The outbox has to drain, or every unknown is permanent.
 *
 * These tests are written from the failure they exist to stop: a payment that reached the
 * chain but ended in RECONCILIATION_PENDING or EXECUTION_OUTCOME_UNKNOWN, and stayed there
 * forever because nothing ever read the jobs table. The important assertion in each one is
 * the send count: resolution must move the state without moving any money.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { obligationId } from "../src/identity.ts";
import { toBaseUnits } from "../src/money.ts";
import { encodeCall } from "../src/abi.ts";
import { PAY_SIGNATURE } from "../src/plan.ts";
import { FixtureProvider } from "../src/provider.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";
import { drainOnce, drainUntilQuiet } from "../src/worker.ts";
import type { Policy, SourceFacts } from "../src/policy.ts";

const NS = "request-network:sepolia";
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

const facts: SourceFacts = {
  chainId: 11155111,
  tokenAddress: FAU,
  tokenDecimals: 18,
  payee: PAYEE,
  invoiceBaseUnits: toBaseUnits("50", 18).toString(),
  feeBaseUnits: "0",
  feeRecipient: FEE_ADDR,
  hasBeenPaid: false,
};

const steps = [
  {
    kind: "REQUEST_PAYMENT",
    to: PROXY,
    data: encodeCall(PAY_SIGNATURE, [
      FAU,
      PAYEE,
      facts.invoiceBaseUnits,
      REFERENCE,
      "0",
      FEE_ADDR,
    ]),
    value: "0",
  },
];

/** Settle far enough to move money, with Request refusing to confirm it yet. */
async function paidButUnreconciled(requestId: string) {
  const store = new Store();
  const provider = new FixtureProvider("NONE");
  const oid = obligationId(NS, requestId);
  const outcome = await settleObligation(
    { store, provider, policy, sourceSaysPaid: async () => false },
    {
      namespace: NS,
      requestId,
      obligationId: oid,
      paymentReference: REFERENCE,
      facts,
      steps,
      approval: { approver: "human:owner", decision: "APPROVED" },
      now: 1_000_000,
    },
  );
  return { store, provider, oid, outcome };
}

describe("the outbox actually drains", () => {
  test("a payment Request had not indexed yet reaches SETTLED without a second send", async () => {
    const { store, provider, oid, outcome } = await paidButUnreconciled("req-pending");
    assert.equal(outcome.state, "RECONCILIATION_PENDING");
    assert.equal(provider.totalSends(), 1);
    assert.equal(store.pendingJobCount() > 0, true, "a job must be waiting");

    // The indexer catches up. The worker looks; it never sends.
    const passes = await drainUntilQuiet(
      { store, provider, sourceSaysPaid: async () => true },
      { now: 1_100_000 },
    );

    assert.equal(store.getObligation(oid)?.state, "SETTLED");
    assert.equal(provider.totalSends(), 1, "resolution must not move money");
    assert.equal(store.pendingJobCount(), 0, "the outbox must be empty afterwards");
    assert.ok(passes.some((p) => p.completed > 0));
  });

  test("a source that stays silent leaves the obligation pending, not settled", async () => {
    const { store, provider, oid } = await paidButUnreconciled("req-silent");

    await drainUntilQuiet(
      { store, provider, sourceSaysPaid: async () => false },
      { now: 1_100_000, maxPasses: 3 },
    );

    assert.equal(store.getObligation(oid)?.state, "RECONCILIATION_PENDING");
    assert.equal(provider.totalSends(), 1);
    assert.equal(store.pendingJobCount(), 1, "the job stays owed, deferred rather than dropped");
  });

  test("an unknown outcome is resolved by observing the chain, never by paying again", async () => {
    const store = new Store();
    const provider = new FixtureProvider("TIMEOUT_NO_RESPONSE");
    const requestId = "req-unknown";
    const oid = obligationId(NS, requestId);

    const first = await settleObligation(
      { store, provider, policy, sourceSaysPaid: async () => true },
      {
        namespace: NS,
        requestId,
        obligationId: oid,
        paymentReference: REFERENCE,
        facts,
        steps,
        approval: { approver: "human:owner", decision: "APPROVED" },
        now: 2_000_000,
      },
    );
    assert.equal(first.state, "EXECUTION_OUTCOME_UNKNOWN");
    const sendsAfterFirst = provider.totalSends();
    assert.equal(sendsAfterFirst, 1, "the provider did execute; we just never heard back");

    // The timeout cleared, but the attempt row has no hash, so there is nothing to observe.
    const blind = await drainOnce(
      { store, provider, sourceSaysPaid: async () => true },
      { now: 2_100_000 },
    );
    assert.ok(blind.deferred > 0, "the observation job must wait, not resolve");
    assert.equal(store.getObligation(oid)?.state, "EXECUTION_OUTCOME_UNKNOWN");
    assert.equal(provider.totalSends(), sendsAfterFirst, "observation is read-only");
  });

  test("a reverted receipt is recorded as reverted, not retried", async () => {
    const store = new Store();
    const provider = new FixtureProvider("NONE");
    const requestId = "req-revert";
    const oid = obligationId(NS, requestId);

    await settleObligation(
      { store, provider, policy, sourceSaysPaid: async () => false },
      {
        namespace: NS,
        requestId,
        obligationId: oid,
        paymentReference: REFERENCE,
        facts,
        steps,
        approval: { approver: "human:owner", decision: "APPROVED" },
        now: 3_000_000,
      },
    );

    // The chain view changes underneath us: the transaction is now reported reverted.
    provider.setFault("RECEIPT_REVERTED");
    store.enqueue({
      kind: "OBSERVE_EXECUTION",
      dedupeKey: "observe:late",
      obligationId: oid,
      dueAt: 3_100_000,
    });

    await drainOnce({ store, provider, sourceSaysPaid: async () => true }, { now: 3_100_000 });

    assert.equal(store.getObligation(oid)?.state, "EXECUTION_REVERTED");
    assert.equal(provider.totalSends(), 1);
  });

  test("a worker that lost its lease cannot advance the obligation", async () => {
    const { store, provider, oid } = await paidButUnreconciled("req-fenced");
    const [stale] = store.claimJobs({ limit: 1, now: 1_100_000, leaseMs: 1 });
    // Another worker takes the job over.
    store.claimJobs({ limit: 1, now: 1_200_000, leaseMs: 60_000 });

    assert.throws(() => store.completeJob(stale.id, stale.fencingGeneration), /stale fencing/);
    assert.equal(store.getObligation(oid)?.state, "RECONCILIATION_PENDING");
    assert.equal(provider.totalSends(), 1);
  });
});

describe("a crash inside the send is recoverable, not permanent", () => {
  // The window between markSent and recordOutcome. The provider may have executed; the
  // process died before anything was written down. PAYMENT_EXECUTING is not replannable and
  // there is no transaction hash to observe, so without recovery the obligation is bricked in
  // a money-moved state forever.
  function crashedMidSend() {
    const store = new Store();
    const provider = new FixtureProvider("NONE");
    const requestId = "req-crashed";
    const oid = obligationId(NS, requestId);
    store.importObligation({
      obligationId: oid,
      namespace: NS,
      requestId,
      sourceFactsJson: JSON.stringify(facts),
      sourceFactsHash: "h",
      paymentReference: REFERENCE,
      now: 1_000,
    });
    for (const s of ["VALIDATING", "AWAITING_APPROVAL", "APPROVED", "PAYMENT_PREFLIGHT", "PAYMENT_EXECUTING"] as const) {
      store.setState(oid, s, 1_000);
    }
    const { attemptId } = store.openAttempt({
      obligationId: oid,
      planHash: "plan-crashed",
      stepIndex: 0,
      idempotencyKey: "key-crashed",
      endpoint: "/api/execute/contract-call",
      bodyJson: "{}",
      now: 1_000,
    });
    store.markSent(attemptId, 1_000);   // ... and then the process died here.
    return { store, provider, oid };
  }

  test("the payment is found by its reference and the obligation moves on", async () => {
    const { store, provider, oid } = crashedMidSend();
    const hash = `0x${"7".repeat(64)}`;

    await drainOnce(
      {
        store,
        provider: { receipt: async (h) => ({ hash: h, verified: true, receiptStatus: "success", gasUsed: "52000" }) },
        sourceSaysPaid: async () => true,
        findPaidReference: async () => ({ txHash: hash, amount: facts.invoiceBaseUnits }),
      },
      { now: 2_000, lookaheadMs: 60_000 },
    );

    assert.notEqual(store.getObligation(oid)?.state, "PAYMENT_EXECUTING", "must not stay stuck");
    assert.equal(store.sentAttemptFor(oid)?.txHash, hash);
    assert.equal(provider.totalSends(), 0, "recovery reads, it never sends");
  });

  test("a payment that is not on chain stays unknown rather than being retried", async () => {
    const { store, provider, oid } = crashedMidSend();

    await drainOnce(
      {
        store,
        provider: { receipt: async (h) => ({ hash: h, verified: false, receiptStatus: "not_found", gasUsed: "0" }) },
        sourceSaysPaid: async () => false,
        findPaidReference: async () => null,
      },
      { now: 2_000, lookaheadMs: 60_000 },
    );

    assert.equal(store.getObligation(oid)?.state, "EXECUTION_OUTCOME_UNKNOWN");
    assert.equal(provider.totalSends(), 0);
  });
});
