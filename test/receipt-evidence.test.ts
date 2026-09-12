/**
 * What a receipt has to prove before a payment is called settled.
 *
 * The receipt used to be parsed as `{status, gasUsed}` and nothing else. Its `to` and its
 * `logs` were never read, so nothing after dispatch checked that the transaction had touched
 * the fee proxy, paid the right payee, or moved the right amount — those were bound BEFORE
 * dispatch only.
 *
 * That gap matters more here than it would in most systems, because of the execution shape.
 * From the real settled transaction:
 *
 *     to   0x5af5194b4b0909eb978e3cf1e25333852277f07d   <- a forwarder, not the fee proxy
 *     from 0x809d8252aa4f9b8f7d9be7213855b289fe7d0444   <- a relayer, not the payer
 *     fee-proxy event emitted by 0x399f5ee1…, nested inside that meta-transaction
 *
 * A forwarder that does not bubble an inner revert returns `status: 0x1` regardless. That is
 * exactly the shape in which "the transaction succeeded" and "the payment happened" come apart.
 *
 * And there was no finality concept at all: a receipt one block deep settled identically to one
 * a hundred blocks deep, and nothing re-checked afterwards. On Sepolia a shallow reorg is not
 * theoretical — nobody has to attack it, they wait for it and then dispute the settlement.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { encodeCall } from "../src/abi.ts";
import { obligationId } from "../src/identity.ts";
import { toBaseUnits } from "../src/money.ts";
import { ERC20_FEE_PROXY, FAU, NAMESPACE, PAY_SIGNATURE } from "../src/plan.ts";
import { FixtureProvider, type Receipt } from "../src/provider.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";
import type { Policy, SourceFacts } from "../src/policy.ts";

const PAYEE = "0x0e2bB0000000000000000000000000000000F531";
const STRANGER = "0xdEAdBeef00000000000000000000000000000001";
const FEE_ADDR = "0xAaAa000000000000000000000000000000000001";
const FORWARDER = "0x5af5194b4b0909eb978e3cf1e25333852277f07d";
const REFERENCE = "0x0056a1b2c3d4e5f6";
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
    to: ERC20_FEE_PROXY,
    data: encodeCall(PAY_SIGNATURE, [FAU, PAYEE, AMOUNT, REFERENCE, "0", FEE_ADDR]),
    value: "0",
  },
];

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** The five non-indexed words of TransferWithReferenceAndFee, in emission order. */
function logData(o: { token?: string; to?: string; amount?: string; feeAmount?: string; feeAddress?: string } = {}) {
  return (
    "0x" +
    word(o.token ?? FAU) +
    word(o.to ?? PAYEE) +
    word(BigInt(o.amount ?? AMOUNT).toString(16)) +
    word(BigInt(o.feeAmount ?? "0").toString(16)) +
    word(o.feeAddress ?? FEE_ADDR)
  );
}

/** A provider whose receipts say exactly what a test wants them to say. */
function providerWithReceipt(over: Partial<Receipt>) {
  const p = new FixtureProvider("NONE");
  const original = p.receipt.bind(p);
  p.receipt = async (hash: string): Promise<Receipt> => ({ ...(await original(hash)), ...over });
  return p;
}

async function settleWith(provider: FixtureProvider, requestId: string) {
  const store = new Store();
  const outcome = await settleObligation(
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
  store.close();
  return { outcome, sends: provider.totalSends() };
}

describe("the receipt's own logs have to contain the payment", () => {
  test("a forwarder receipt whose fee-proxy event pays this invoice settles", () => {
    // The control, and the real shape: the fee proxy is a log emitter nested inside a
    // forwarder's transaction, so `to` is the forwarder and that is correct, not suspicious.
    return settleWith(
      providerWithReceipt({
        to: FORWARDER,
        logs: [{ address: ERC20_FEE_PROXY, data: logData(), topics: [] }],
        confirmations: 12,
      }),
      "01req-receipt-good",
    ).then(({ outcome, sends }) => {
      assert.equal(outcome.state, "SETTLED");
      assert.equal(sends, 1);
    });
  });

  test("a successful receipt with NO fee-proxy event is a conflict, not a settlement", async () => {
    // The forwarder returned 0x1 and the inner call did nothing. This is the case the whole
    // test file exists for.
    const { outcome, sends } = await settleWith(
      providerWithReceipt({ to: FORWARDER, logs: [], confirmations: 12 }),
      "01req-receipt-empty",
    );

    assert.equal(outcome.state, "EVIDENCE_CONFLICT");
    assert.match(outcome.detail, /no ERC20FeeProxy event/i);
    assert.equal(sends, 1, "the money did leave; what is refused is calling it settled");
  });

  test("a fee-proxy event paying somebody else is a conflict", async () => {
    const { outcome } = await settleWith(
      providerWithReceipt({
        to: FORWARDER,
        logs: [{ address: ERC20_FEE_PROXY, data: logData({ to: STRANGER }), topics: [] }],
        confirmations: 12,
      }),
      "01req-receipt-stranger",
    );

    assert.equal(outcome.state, "EVIDENCE_CONFLICT");
    assert.match(outcome.detail, /pays 0xdEAdBeef/i);
  });

  test("a fee-proxy event for the wrong amount is a conflict", async () => {
    const { outcome } = await settleWith(
      providerWithReceipt({
        to: FORWARDER,
        logs: [{ address: ERC20_FEE_PROXY, data: logData({ amount: "1" }), topics: [] }],
        confirmations: 12,
      }),
      "01req-receipt-dust",
    );

    assert.equal(outcome.state, "EVIDENCE_CONFLICT");
    assert.match(outcome.detail, /moves 1,/);
  });

  test("an event from a contract that is not the fee proxy does not count as one", async () => {
    const { outcome } = await settleWith(
      providerWithReceipt({
        to: FORWARDER,
        logs: [{ address: STRANGER, data: logData(), topics: [] }],
        confirmations: 12,
      }),
      "01req-receipt-wrong-emitter",
    );

    assert.equal(outcome.state, "EVIDENCE_CONFLICT");
    assert.match(outcome.detail, /no ERC20FeeProxy event/i);
  });

  test("a transport that supplies no logs skips the check rather than failing it", async () => {
    // A fixture has no chain behind it. A check that cannot run must not pretend to have run,
    // and must not block a settlement it knows nothing about either.
    const { outcome } = await settleWith(new FixtureProvider("NONE"), "01req-receipt-nologs");
    assert.equal(outcome.state, "SETTLED");
  });
});

describe("a receipt one block deep is not a settlement", () => {
  test("insufficient depth waits in RECONCILIATION_PENDING with a job", async () => {
    const store = new Store();
    const provider = providerWithReceipt({
      to: FORWARDER,
      logs: [{ address: ERC20_FEE_PROXY, data: logData(), topics: [] }],
      confirmations: 1,
    });
    const requestId = "01req-shallow";

    const outcome = await settleObligation(
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

    assert.equal(outcome.state, "RECONCILIATION_PENDING");
    assert.notEqual(outcome.state, "SETTLED");
    assert.match(outcome.detail, /depth 1/);
    assert.ok(store.pendingJobKinds().includes("RECONCILE_SOURCE"), "something must come back for it");
    assert.equal(provider.totalSends(), 1, "and it must not pay again while it waits");
    store.close();
  });

  test("enough depth settles", async () => {
    const { outcome } = await settleWith(
      providerWithReceipt({
        to: FORWARDER,
        logs: [{ address: ERC20_FEE_PROXY, data: logData(), topics: [] }],
        confirmations: 2,
      }),
      "01req-deep-enough",
    );
    assert.equal(outcome.state, "SETTLED");
  });

  test("unknown depth is not treated as zero depth", async () => {
    // `confirmations: undefined` means the read could not tell, which is the fixture case and
    // must stay settleable — otherwise every offline test and the whole recorded evidence run
    // would be blocked by a check that never actually looked.
    const { outcome } = await settleWith(
      providerWithReceipt({
        to: FORWARDER,
        logs: [{ address: ERC20_FEE_PROXY, data: logData(), topics: [] }],
      }),
      "01req-depth-unknown",
    );
    assert.equal(outcome.state, "SETTLED");
  });
});
