/**
 * One debt, one payment. This file is the product.
 *
 * Every case here is a way an adversarial pass actually got two physical sends out of one
 * invoice, or would have. The assertion that matters in each is `provider.totalSends()`:
 * states and refusal codes are commentary, the send count is the money.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { canonicalReference, obligationId } from "../src/identity.ts";
import { toBaseUnits } from "../src/money.ts";
import { encodeCall } from "../src/abi.ts";
import { ERC20_FEE_PROXY, FAU, PAY_SIGNATURE } from "../src/plan.ts";
import { FixtureProvider } from "../src/provider.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";
import type { Policy, SourceFacts } from "../src/policy.ts";

const NS = "request-network:sepolia";
const PAYEE = "0x0e2bB0000000000000000000000000000000F531";
const FEE_ADDR = "0xAaAa000000000000000000000000000000000001";
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

const payStep = (reference: string) => ({
  kind: "REQUEST_PAYMENT",
  to: ERC20_FEE_PROXY,
  data: encodeCall(PAY_SIGNATURE, [FAU, PAYEE, facts.invoiceBaseUnits, reference, "0", FEE_ADDR]),
  value: "0",
});

const approveStep = {
  kind: "ALLOWANCE_GRANT",
  to: FAU,
  data: encodeCall("approve(address,uint256)", [ERC20_FEE_PROXY, facts.invoiceBaseUnits]),
  value: "0",
};

function bench() {
  const store = new Store();
  const provider = new FixtureProvider("NONE");
  const deps = { store, provider, policy, approvalAuthority: "caller" as const, sourceSaysPaid: async () => true };
  // The calldata always carries the canonical reference; only the value handed to settle
  // varies, which is exactly the shape of the attack.
  const settle = (requestId: string, reference: string, steps = [payStep(REFERENCE)]) =>
    settleObligation(deps, {
      namespace: NS,
      requestId,
      paymentReference: reference,
      obligationId: obligationId(NS, requestId),
      facts,
      steps,
      approval: { approver: "human:owner", decision: "APPROVED" as const },
      now: 1_000_000,
    });
  return { store, provider, settle };
}

describe("one payment reference is one debt, however it is spelled", () => {
  test("case is a rendering choice, not a second invoice", () => {
    assert.equal(canonicalReference("0xAABBcc"), "0xaabbcc");
    assert.equal(canonicalReference("  0xAABBCC  "), "0xaabbcc");
    assert.throws(() => canonicalReference("not-hex"), /0x-prefixed hex/);
    assert.throws(() => canonicalReference("0x"), /0x-prefixed hex/);
  });

  test("upper-casing the reference does not buy a second payment", async () => {
    const { provider, settle } = bench();

    const first = await settle("invoice-1", REFERENCE);
    assert.equal(first.state, "SETTLED");
    assert.equal(provider.totalSends(), 1);

    // Same eight bytes on chain. SQLite compares TEXT byte by byte, so before the reference
    // was canonicalised this produced a second obligation and a second real payment.
    const shouted = await settle("invoice-1-again", REFERENCE.toUpperCase().replace("0X", "0x"));
    assert.equal(shouted.refusal, "REFERENCE_ALREADY_CLAIMED");
    assert.equal(provider.totalSends(), 1, "the shouted spelling must not pay again");

    const padded = await settle("invoice-1-padded", `  ${REFERENCE}  `);
    assert.equal(padded.refusal, "REFERENCE_ALREADY_CLAIMED");
    assert.equal(provider.totalSends(), 1, "whitespace must not pay again");
  });

  test("a reference that is not hex is refused rather than normalised", async () => {
    const { settle, provider } = bench();
    await assert.rejects(() => settle("invoice-junk", "totally-not-a-reference"), /0x-prefixed hex/);
    assert.equal(provider.totalSends(), 0);
  });
});

describe("a plan has to be shaped like the thing that gets dispatched", () => {
  test("an allowance in the last position is refused, because only the last step is sent", async () => {
    const { settle, provider } = bench();
    // Reversed order: the payment would never be dispatched, and the obligation would report
    // itself settled while the payee was never paid.
    const out = await settle("invoice-2", REFERENCE, [payStep(REFERENCE), approveStep]);
    assert.equal(out.refusal, "CALLDATA_MISMATCH");
    assert.match(out.detail, /only the last step is dispatched/);
    assert.equal(provider.totalSends(), 0);
  });

  test("an allowance followed by the payment is the correct shape", async () => {
    const { settle, provider } = bench();
    const out = await settle("invoice-3", REFERENCE, [approveStep, payStep(REFERENCE)]);
    assert.equal(out.state, "SETTLED");
    assert.equal(provider.totalSends(), 1);
  });

  test("an empty plan is refused rather than reserving the obligation forever", async () => {
    const { settle, provider } = bench();
    const out = await settle("invoice-4", REFERENCE, []);
    assert.equal(out.refusal, "CALLDATA_MISMATCH");
    assert.match(out.detail, /no steps/);
    assert.equal(provider.totalSends(), 0);
  });

  test("two payments in one plan is refused", async () => {
    const { settle, provider } = bench();
    const out = await settle("invoice-5", REFERENCE, [payStep(REFERENCE), payStep(REFERENCE)]);
    assert.equal(out.refusal, "CALLDATA_MISMATCH");
    assert.match(out.detail, /more than one payment/);
    assert.equal(provider.totalSends(), 0);
  });

  test("calldata carrying a different reference than the debt is refused", async () => {
    const { settle, provider } = bench();
    const out = await settle("invoice-6", REFERENCE, [payStep("0xdeadbeefdeadbeef")]);
    assert.equal(out.refusal, "CALLDATA_MISMATCH");
    assert.equal(provider.totalSends(), 0);
  });
});
