/**
 * A row the duplicate defence cannot see.
 *
 * Both defences against paying one debt twice key on the payment reference: a UNIQUE index over
 * `obligations.payment_reference`, and a lookup that finds the obligation holding a reference
 * across namespaces. The index is PARTIAL — `WHERE payment_reference IS NOT NULL` — because a row
 * may legitimately be imported before its invoice has been read.
 *
 * So a row stored with a NULL reference is invisible to both at once. The same debt can be opened
 * again under another request id and paid a second time, with the index built to stop exactly that
 * looking straight through the row. `importObligation` back-fills NULL → value on re-import, which
 * closes it going forward; a database in the field can still hold a row created before that
 * existed and never re-imported since, and nothing could even name those rows.
 *
 * Now they are named, and settle refuses to dispatch one.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { encodeCall } from "../src/abi.ts";
import { obligationId } from "../src/identity.ts";
import { toBaseUnits } from "../src/money.ts";
import { ERC20_FEE_PROXY, FAU, NAMESPACE, PAY_SIGNATURE } from "../src/plan.ts";
import type { Policy, SourceFacts } from "../src/policy.ts";
import { FixtureProvider } from "../src/provider.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";

const PAYEE = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const FEE_ADDR = `0x${"0".repeat(40)}`;
const REFERENCE = "0x0056a1b2c3d4e5f6";
const AMOUNT = toBaseUnits("1", 18).toString();
const REQUEST_ID = "01req-legacy-null-reference";
const OID = obligationId(NAMESPACE, REQUEST_ID);

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

/** A store holding one legacy row: imported before references were recorded, never re-imported. */
function legacyStore(): Store {
  const store = new Store();
  store.importObligation({
    obligationId: OID,
    namespace: NAMESPACE,
    requestId: REQUEST_ID,
    sourceFactsJson: JSON.stringify(facts),
    sourceFactsHash: "h".repeat(64),
    paymentReference: null,
    now: 1,
  });
  return store;
}

async function settle(store: Store) {
  const provider = new FixtureProvider("NONE");
  const outcome = await settleObligation(
    { store, provider, policy, approvalAuthority: "caller" as const, sourceSaysPaid: async () => true },
    {
      namespace: NAMESPACE,
      requestId: REQUEST_ID,
      obligationId: OID,
      paymentReference: REFERENCE,
      facts,
      steps,
      approval: { approver: "human:owner", decision: "APPROVED" },
      now: 1_000_000,
    },
  );
  return { outcome, sends: provider.totalSends() };
}

describe("an obligation no index can see is not one this system will pay", () => {
  test("the store can name the rows the uniqueness index skips", () => {
    const store = legacyStore();
    const unindexed = store.obligationsWithoutReference();
    store.close();

    assert.equal(unindexed.length, 1, JSON.stringify(unindexed));
    assert.equal(unindexed[0]?.obligationId, OID);
    assert.equal(unindexed[0]?.requestId, REQUEST_ID);
  });

  test("re-importing it with its reference closes the hole, and it settles", async () => {
    // The forward path, and the control for the refusal below: a row that gets its reference is
    // an ordinary row.
    const store = legacyStore();
    store.importObligation({
      obligationId: OID,
      namespace: NAMESPACE,
      requestId: REQUEST_ID,
      sourceFactsJson: JSON.stringify(facts),
      sourceFactsHash: "h".repeat(64),
      paymentReference: REFERENCE,
      now: 2,
    });
    assert.deepEqual(store.obligationsWithoutReference(), []);

    const { outcome, sends } = await settle(store);
    store.close();
    assert.equal(outcome.state, "SETTLED", JSON.stringify(outcome).slice(0, 200));
    assert.equal(sends, 1);
  });

  test("a legacy row whose reference arrives with the dispatch is back-filled by settle itself", async () => {
    // No re-import, no stub: the row has a NULL reference and the settle call is the first thing
    // to carry one. The check must run AFTER the import that back-fills, or every legacy row is
    // refused on the very call that would have indexed it (the harness rival-plan case hit this).
    const store = legacyStore();
    assert.equal(store.obligationsWithoutReference().length, 1);

    const { outcome, sends } = await settle(store);
    const unindexedAfter = store.obligationsWithoutReference();
    store.close();

    assert.equal(outcome.state, "SETTLED", JSON.stringify(outcome).slice(0, 300));
    assert.equal(sends, 1);
    assert.deepEqual(unindexedAfter, [], "the dispatch that carried the reference must have indexed the row");
  });

  test("a row still carrying no reference at dispatch refuses, and sends nothing", async () => {
    // `settleObligation` back-fills on its way through, so reaching this means the row had no
    // reference after everything that could supply one had run.
    const store = legacyStore();
    // Freeze the hole open: the back-fill would otherwise close it, and what is under test is the
    // behaviour for a row that is still unindexed when the dispatch is attempted.
    const original = store.obligationsWithoutReference.bind(store);
    store.obligationsWithoutReference = () => [
      ...original(),
      { obligationId: OID, requestId: REQUEST_ID, state: "IMPORTED" },
    ];

    const { outcome, sends } = await settle(store);
    const trail = store.auditTrail(OID);
    store.close();

    assert.equal(outcome.refusal, "REFERENCE_UNRECORDED", JSON.stringify(outcome).slice(0, 300));
    assert.equal(sends, 0, "a debt no index is watching must not be paid");
    assert.equal(outcome.providerWriteIssued, false);
    assert.ok(
      trail.some((r) => (r.detail as { code?: string })?.code === "REFERENCE_UNRECORDED"),
      "the refusal is not in the audit trail",
    );
  });
});
