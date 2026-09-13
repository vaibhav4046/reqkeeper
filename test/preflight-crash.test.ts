/**
 * A process killed inside `simulate`, and how the invoice gets unstuck.
 *
 * This was the last crash checkpoint with no way forward. `p3-crash.ts` recorded it:
 *
 *     SIMULATE   CRASH@SIMULATE   sends 0   after worker PAYMENT_PREFLIGHT   jobs 0
 *                agent retry: PAYMENT_PREFLIGHT / ALREADY_DISPATCHED
 *
 * Zero sends, so no money was at risk — and zero ways forward, so that invoice could never be
 * paid by this system again. The attempt row, which makes every later step recoverable, is not
 * written until after the simulation, because an attempt means "intent to send" and nothing is
 * being sent yet. That left one uncovered window and the crash fell into it.
 *
 * The tempting repair is to make PAYMENT_PREFLIGHT replannable. It is wrong, and the test at the
 * bottom of `preflight-unavailable.test.ts` pins it shut: a simulate can TIME OUT, and a
 * timed-out dry run may have executed for real (#1959), so assuming nothing happened is exactly
 * the assumption this project exists to refuse.
 *
 * So the uncertainty is resolved the way every other uncertainty here is resolved — by looking at
 * the chain. `beginPreflight` commits an OBSERVE_PREFLIGHT job in the same transaction as the
 * state, before the risky call; the settle path cancels it the moment it gets past the simulation
 * under its own power; and only a crash leaves it behind to be claimed.
 *
 * The post-crash state is reconstructed through the store rather than by killing a process,
 * because that is precisely what the probe shows a kill produces, and a unit test that spawns
 * processes is a unit test nobody runs.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { encodeCall } from "../src/abi.ts";
import type { PaymentSighting } from "../src/chain.ts";
import { obligationId } from "../src/identity.ts";
import { toBaseUnits } from "../src/money.ts";
import { FAU, NAMESPACE, PAY_SIGNATURE } from "../src/plan.ts";
import { FixtureProvider, type Receipt } from "../src/provider.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";
import { drainUntilQuiet } from "../src/worker.ts";
import type { Policy, SourceFacts } from "../src/policy.ts";

const PAYEE = "0x0e2bB0000000000000000000000000000000F531";
const FEE_ADDR = "0xAaAa000000000000000000000000000000000001";
const PROXY = "0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE";
const REFERENCE = "0x0056a1b2c3d4e5f6";
const AMOUNT = toBaseUnits("50", 18).toString();
const PLAN_HASH = "c".repeat(64);
const LEAKED_TX = `0x${"7e".repeat(32)}`;

/**
 * Excluding a leaked dry run needs a payer whose nonce can be read, not a stopwatch. These
 * fixtures state the proof the production path demands: the payer's mined nonce before the dry
 * run, and a later reading showing it has moved. A nonce is spent once, so a nonce that has
 * advanced means any transaction the dry run broadcast can never be included. See
 * src/exclusion.ts and test/mempool-residency.test.ts.
 */
const PAYER = "0x00000000000000000000000000000000000ce111";
const PREFLIGHT_NONCE = 42;

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
  invoiceBaseUnits: AMOUNT,
  feeBaseUnits: "0",
  feeRecipient: FEE_ADDR,
  hasBeenPaid: false,
};

const steps = [
  {
    kind: "REQUEST_PAYMENT",
    to: PROXY,
    data: encodeCall(PAY_SIGNATURE, [FAU, PAYEE, AMOUNT, REFERENCE, "0", FEE_ADDR]),
    value: "0",
  },
];

const receipt = async (hash: string): Promise<Receipt> => ({
  hash,
  verified: true,
  receiptStatus: "success",
  gasUsed: "1",
});

/** Exactly what a SIGKILL inside `simulate` leaves behind: see p3-crash.ts, row SIMULATE. */
function killedInsideSimulate(requestId: string) {
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
  // With the head the dry run was about to run at. A scan cannot see the mempool, so the
  // observer may only conclude once the chain has moved past this block.
  store.beginPreflight(oid, PLAN_HASH, 1, PREFLIGHT_HEAD, PREFLIGHT_NONCE);

  // The shape the probe reports, asserted rather than assumed.
  assert.equal(store.obligationForRecovery(oid)?.state, "PAYMENT_PREFLIGHT");
  assert.equal(store.sentAttemptFor(oid), undefined, "nothing was ever dispatched");
  assert.equal(store.pendingJobCount(), 1, "the observation must be durable BEFORE the simulate");
  return { store, oid };
}

const PREFLIGHT_HEAD = 11_000_000;
const AGED_CEILING = PREFLIGHT_HEAD + 10;

const unpaid: PaymentSighting = {
  found: false,
  scannedBlocks: 450_000,
  truncated: false,
  // Read after the chain moved past the preflight: only then is absence evidence.
  scannedTo: AGED_CEILING,
};
const paid: PaymentSighting = {
  found: true,
  txHash: LEAKED_TX,
  amount: AMOUNT,
  to: PAYEE,
  tokenAddress: FAU,
  corroborated: true,
  scannedBlocks: 450_000,
};

function drain(store: Store, sighting: PaymentSighting) {
  return drainUntilQuiet(
    {
      store,
      provider: { receipt },
      sourceSaysPaid: async () => true,
      sightPayment: async () => sighting,
      payer: PAYER,
      readPayerNonce: async () => ({ payer: PAYER, nonce: PREFLIGHT_NONCE + 1, head: sighting.scannedTo ?? 0 }),
    },
    { now: 1_000_000, maxPasses: 3, lookaheadMs: 120_000 },
  );
}

describe("a simulation that never came back is resolved by looking, not by assuming", () => {
  test("the chain says nothing happened, so the debt becomes payable again", async () => {
    const { store, oid } = killedInsideSimulate("01req-sim-crash-clean");

    await drain(store, unpaid);

    assert.equal(store.obligationForRecovery(oid)?.state, "PREFLIGHT_UNAVAILABLE");
    assert.equal(store.getObligation(oid)?.reservedByPlan, null, "the reservation must come back");
    assert.equal(store.pendingJobCount(), 0, "and the outbox must not be left holding it");
    store.close();
  });

  test("and it really can be paid afterwards — exactly once", async () => {
    // The point of the whole exercise. A state that is technically replannable but that no
    // settlement can actually get through is not a fix.
    const { store, oid } = killedInsideSimulate("01req-sim-crash-then-pay");
    await drain(store, unpaid);

    const provider = new FixtureProvider("NONE");
    const outcome = await settleObligation(
      { store, provider, policy, sourceSaysPaid: async () => true, currentBlock: async () => PREFLIGHT_HEAD,
      payerNonce: async () => PREFLIGHT_NONCE },
      {
        namespace: NAMESPACE,
        requestId: "01req-sim-crash-then-pay",
        obligationId: oid,
        paymentReference: REFERENCE,
        facts,
        steps,
        approval: { approver: "human:owner", decision: "APPROVED" },
        now: 2_000_000,
      },
    );

    assert.equal(outcome.state, "SETTLED");
    assert.equal(provider.totalSends(), 1, "one payment, not zero and not two");
    store.close();
  });

  test("the chain says the dry run DID execute, so it is an incident, not a retry", async () => {
    // #1959: a simulate can be ignored and execute for real. Money moved with no attempt row
    // behind it. That must never read as "unattempted", and nothing may re-propose it.
    const { store, oid } = killedInsideSimulate("01req-sim-crash-leaked");

    await drain(store, paid);

    assert.equal(store.obligationForRecovery(oid)?.state, "EVIDENCE_CONFLICT");
    const trail = JSON.stringify(store.auditTrail(oid));
    assert.match(trail, /SIMULATE_LEAKED_EXECUTION/);
    assert.match(trail, new RegExp(LEAKED_TX.slice(2, 20)), "the hash a human needs must be on the record");
    store.close();
  });

  test("a leaked execution is not re-proposable, however healthy the platform looks", async () => {
    const { store, oid } = killedInsideSimulate("01req-sim-crash-leaked-retry");
    await drain(store, paid);

    const provider = new FixtureProvider("NONE");
    const outcome = await settleObligation(
      { store, provider, policy, sourceSaysPaid: async () => true, currentBlock: async () => PREFLIGHT_HEAD,
      payerNonce: async () => PREFLIGHT_NONCE },
      {
        namespace: NAMESPACE,
        requestId: "01req-sim-crash-leaked-retry",
        obligationId: oid,
        paymentReference: REFERENCE,
        facts,
        steps,
        approval: { approver: "human:owner", decision: "APPROVED" },
        now: 2_000_000,
      },
    );

    assert.notEqual(outcome.state, "SETTLED");
    assert.equal(provider.totalSends(), 0, "a payment that already happened must never happen twice");
    store.close();
  });

  test("an inconclusive read rescues nothing", async () => {
    // The control, and the one that matters most. A truncated scan is "I could not tell", and
    // "I could not tell" must never become "go ahead" — that is how a second payment is
    // authorised. It stays stuck, deliberately, until something can actually see.
    const { store, oid } = killedInsideSimulate("01req-sim-crash-truncated");

    await drain(store, { found: false, scannedBlocks: 100, truncated: true });

    assert.equal(store.obligationForRecovery(oid)?.state, "PAYMENT_PREFLIGHT");
    assert.equal(store.pendingJobCount(), 1, "the job stays owed rather than concluding");
    store.close();
  });

  test("with no chain reader at all it also rescues nothing", async () => {
    const { store, oid } = killedInsideSimulate("01req-sim-crash-noreader");

    await drainUntilQuiet(
      { store, provider: { receipt }, sourceSaysPaid: async () => true },
      { now: 1_000_000, maxPasses: 3, lookaheadMs: 120_000 },
    );

    assert.equal(store.obligationForRecovery(oid)?.state, "PAYMENT_PREFLIGHT");
    assert.equal(store.pendingJobCount(), 1);
    store.close();
  });
});

describe("the observation does not linger on a settlement that went fine", () => {
  test("an uninterrupted settle leaves no preflight job behind", async () => {
    const store = new Store();
    const provider = new FixtureProvider("NONE");
    const requestId = "01req-sim-clean";

    const outcome = await settleObligation(
      { store, provider, policy, sourceSaysPaid: async () => true, currentBlock: async () => PREFLIGHT_HEAD,
      payerNonce: async () => PREFLIGHT_NONCE },
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

    assert.equal(outcome.state, "SETTLED");
    assert.ok(
      !store.pendingJobKinds().includes("OBSERVE_PREFLIGHT"),
      "openAttempt supersedes the observation, in the same transaction",
    );
    store.close();
  });
});
