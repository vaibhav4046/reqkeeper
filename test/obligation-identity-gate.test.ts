/**
 * The obligation id is derived, not supplied — and the row that carries the payment reference
 * must carry it.
 *
 * Both halves here close one finding. `obligationId` is a function of the namespace and the
 * Request id (`src/identity.ts`), and everything downstream trusts it: the reservation, the
 * idempotency key, the global uniqueness index on the payment reference. Nothing re-derived it,
 * so a caller could hand `settle()` an id belonging to one debt alongside the namespace and
 * request id of another, and open a second obligation for an invoice that already had one.
 *
 * The second half is the index the first would have collided with. It is partial —
 * `WHERE payment_reference IS NOT NULL` — and `importObligation` early-returned on an existing
 * row without back-filling, so a row imported once with no reference kept NULL for life and both
 * the index and the cross-namespace lookup looked straight through it.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { encodeCall } from "../src/abi.ts";
import { obligationId } from "../src/identity.ts";
import { toBaseUnits } from "../src/money.ts";
import { NAMESPACE, PAY_SIGNATURE } from "../src/plan.ts";
import { FixtureProvider } from "../src/provider.ts";
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
    data: encodeCall(PAY_SIGNATURE, [FAU, PAYEE, toBaseUnits("50", 18).toString(), REFERENCE, "0", FEE_ADDR]),
    value: "0",
  },
];

describe("the obligation id has to derive from the invoice it claims to be", () => {
  test("an id belonging to another debt is refused, at zero sends", async () => {
    const store = new Store();
    const provider = new FixtureProvider("NONE");

    const outcome = await settleObligation(
      { store, provider, policy, approvalAuthority: "caller" as const, sourceSaysPaid: async () => true },
      {
        namespace: NAMESPACE,
        requestId: "01req-identity-a",
        // The id of a different invoice entirely.
        obligationId: obligationId(NAMESPACE, "01req-identity-b"),
        paymentReference: REFERENCE,
        facts,
        steps,
        approval: { approver: "human:owner", decision: "APPROVED" },
        now: 1_000,
      },
    );

    assert.equal(outcome.refusal, "OBLIGATION_ID_MISMATCH");
    assert.equal(outcome.providerWriteIssued, false);
    assert.equal(provider.totalSends(), 0);
    store.close();
  });

  test("the derived id settles normally, so the gate refuses only the mismatch", async () => {
    const store = new Store();
    const provider = new FixtureProvider("NONE");
    const requestId = "01req-identity-ok";

    const outcome = await settleObligation(
      { store, provider, policy, approvalAuthority: "caller" as const, sourceSaysPaid: async () => true },
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
    assert.equal(provider.totalSends(), 1);
    store.close();
  });
});

describe("a row imported without a reference does not keep NULL for life", () => {
  test("the second import back-fills, so the uniqueness index can see the row", () => {
    const store = new Store();
    const oid = obligationId(NAMESPACE, "01req-backfill");

    const first = store.importObligation({
      obligationId: oid,
      namespace: NAMESPACE,
      requestId: "01req-backfill",
      sourceFactsJson: "{}",
      sourceFactsHash: "h",
      // Imported before anything knew the reference.
      paymentReference: null,
      now: 1_000,
    });
    assert.equal(first.created, true);

    const second = store.importObligation({
      obligationId: oid,
      namespace: NAMESPACE,
      requestId: "01req-backfill",
      sourceFactsJson: "{}",
      sourceFactsHash: "h",
      paymentReference: REFERENCE,
      now: 2_000,
    });
    assert.equal(second.created, false);

    // The point of the back-fill: the reference now resolves to this obligation, so a second
    // obligation claiming the same debt collides with the index instead of being invisible to it.
    assert.equal(store.obligationForReference(REFERENCE)?.obligationId, oid);
    store.close();
  });

  test("a reference already stored is never overwritten by a later import", () => {
    const store = new Store();
    const oid = obligationId(NAMESPACE, "01req-no-clobber");
    const OTHER = "0x00ffeeddccbbaa99";

    store.importObligation({
      obligationId: oid,
      namespace: NAMESPACE,
      requestId: "01req-no-clobber",
      sourceFactsJson: "{}",
      sourceFactsHash: "h",
      paymentReference: REFERENCE,
      now: 1_000,
    });
    store.importObligation({
      obligationId: oid,
      namespace: NAMESPACE,
      requestId: "01req-no-clobber",
      sourceFactsJson: "{}",
      sourceFactsHash: "h",
      paymentReference: OTHER,
      now: 2_000,
    });

    assert.equal(store.obligationForReference(REFERENCE)?.obligationId, oid);
    assert.ok(!store.obligationForReference(OTHER), "the later reference must not have been stored");
    store.close();
  });
});
