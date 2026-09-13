/**
 * An expired plan must be re-proposable, and a stale approval must not spend.
 *
 * A plan hash is deterministic: the same obligation, facts, policy and steps produce the same
 * hash for ever. `savePlan` used `INSERT OR IGNORE`, so a debt proposed again after its TTL got
 * the first proposal's row back — with the first proposal's expired timestamp — and refused as
 * PLAN_EXPIRED. Not "refused this time": refused permanently, with no way out short of changing
 * the invoice. Safe, and the invoice never gets paid, which is the failure mode this project has
 * hit once per round in a different disguise.
 *
 * The fix separates two clocks that had been conflated in one column:
 *
 *   - The plan's window is how long *this proposal* stays dispatchable. It restarts on a new
 *     proposal, because the bytes being identical is not a reason to refuse for ever.
 *   - The approval's `decidedAt` is how long a *human decision* authorises a payment. Nothing
 *     restarts that except another human.
 *
 * Refreshing the first is only safe because the authority lives on the second. Both halves are
 * pinned below: without the first the debt is unpayable, without the second a restarted window
 * spends a decision taken days ago.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { encodeCall } from "../src/abi.ts";
import { obligationId } from "../src/identity.ts";
import { toBaseUnits } from "../src/money.ts";
import { NAMESPACE, ERC20_FEE_PROXY, PAY_SIGNATURE, buildSourceFacts } from "../src/plan.ts";
import { FixtureProvider } from "../src/provider.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";
import type { Policy } from "../src/policy.ts";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PAYEE = "0x0e2bB0000000000000000000000000000000F531";
const FEE_ADDR = "0xAaAa000000000000000000000000000000000001";
const REFERENCE = "0x0056a1b2c3d4e5f6";
const AMOUNT = toBaseUnits("50", 18).toString();
const TTL_SECONDS = 900;
const TTL_MS = TTL_SECONDS * 1000;

const policy: Policy = {
  version: 1,
  chainId: 11155111,
  token: { address: FAU, decimals: 18, symbol: "FAU" },
  allowedPayees: [PAYEE],
  maxTotalDebitBaseUnits: toBaseUnits("100", 18).toString(),
  allowedFeeRecipients: [FEE_ADDR],
  maxFeeBaseUnits: toBaseUnits("1", 18).toString(),
  planTtlSeconds: TTL_SECONDS,
};

const REQUEST_ID = "01req-expiry";
const OID = obligationId(NAMESPACE, REQUEST_ID);

const facts = buildSourceFacts({
  requestId: REQUEST_ID,
  paymentReference: REFERENCE,
  payee: PAYEE,
  amountBaseUnits: AMOUNT,
  maxTotalDebitBaseUnits: AMOUNT,
  feeAmount: "0",
  feeAddress: FEE_ADDR,
  tokenAddress: FAU,
  anchorBlock: 11_690_000,
});

const steps = [
  {
    kind: "REQUEST_PAYMENT",
    to: ERC20_FEE_PROXY,
    data: encodeCall(PAY_SIGNATURE, [FAU, PAYEE, AMOUNT, REFERENCE, "0", FEE_ADDR]),
    value: "0",
  },
];

function settle(store: Store, provider: FixtureProvider, now: number, approver = "human:owner") {
  return settleObligation(
    { store, provider, policy, sourceSaysPaid: async () => true },
    {
      namespace: NAMESPACE,
      requestId: REQUEST_ID,
      obligationId: OID,
      paymentReference: REFERENCE,
      facts,
      steps,
      approval: { approver, decision: "APPROVED" },
      now,
    },
  );
}

describe("an expired plan is re-proposable, and a stale decision is not spendable", () => {
  test("the same plan proposed again after its TTL is payable, not dead for ever", async () => {
    const store = new Store();
    const provider = new FixtureProvider();

    // Proposed and approved now, but nobody dispatches — the reply is lost, the operator goes
    // home, whatever. The window closes.
    const first = await settle(store, provider, 1_000);
    assert.equal(first.state, "SETTLED", "the premise: this plan is dispatchable when fresh");

    store.close();
  });

  test("a plan hash whose row expired gets a fresh window when re-proposed", () => {
    // Directly on the store, because this is a property of `savePlan` and nothing else.
    const store = new Store();
    store.importObligation({
      obligationId: OID,
      namespace: NAMESPACE,
      requestId: REQUEST_ID,
      sourceFactsJson: JSON.stringify(facts),
      sourceFactsHash: "f".repeat(64),
      paymentReference: REFERENCE,
      now: 1_000,
    });
    const common = {
      planHash: "a".repeat(64),
      obligationId: OID,
      version: 1,
      policyHash: "p".repeat(64),
      sourceFactsHash: "f".repeat(64),
      planJson: "{}",
      totalDebitBaseUnits: AMOUNT,
    };
    store.savePlan({ ...common, expiresAt: 1_000 + TTL_MS, now: 1_000 });
    assert.equal(store.getPlan(common.planHash)?.expiresAt, 1_000 + TTL_MS);

    // A day later, the identical plan is proposed again. Same hash — that is what determinism
    // means — and before the fix this silently kept the stale expiry.
    const later = 1_000 + 86_400_000;
    store.savePlan({ ...common, expiresAt: later + TTL_MS, now: later });
    assert.equal(
      store.getPlan(common.planHash)?.expiresAt,
      later + TTL_MS,
      "a re-proposal must restart the window, or a deterministic hash is a permanent death sentence",
    );

    // And the bytes are still the bytes: re-proposing does not rewrite what was approved.
    assert.equal(store.getPlan(common.planHash)?.sourceFactsHash, common.sourceFactsHash);
    store.close();
  });

  test("a replayed decision keeps its original date, so a stale yes cannot spend", async () => {
    // The other half, and the reason refreshing the window is safe at all.
    //
    // This is exactly what `settle_obligation` does: it reads the approval a human recorded and
    // hands it back as an argument. `recordApproval` used to stamp that new row with `now`, so
    // the decision was re-dated on every call and a yes from last week authorised a payment
    // today — for ever, because each call refreshed it again.
    const store = new Store();
    const provider = new FixtureProvider();
    const DECIDED_AT = 1_000;
    const A_DAY_LATER = DECIDED_AT + 86_400_000;

    const outcome = await settleObligation(
      { store, provider, policy, sourceSaysPaid: async () => true },
      {
        namespace: NAMESPACE,
        requestId: REQUEST_ID,
        obligationId: OID,
        paymentReference: REFERENCE,
        facts,
        steps,
        approval: { approver: "human:owner", decision: "APPROVED", decidedAt: DECIDED_AT },
        now: A_DAY_LATER,
      },
    );

    assert.equal(provider.totalSends(), 0, "a decision a day old must not move money");
    assert.equal(outcome.state, "PLAN_EXPIRED");
    assert.equal(outcome.refusal, "PLAN_EXPIRED");
    store.close();
  });

  test("a fresh decision on the same plan still spends", async () => {
    // The control: the gate must bound the decision's age, not refuse the plan for ever. A human
    // approving again is exactly the thing that should unblock it.
    const store = new Store();
    const provider = new FixtureProvider();
    const outcome = await settle(store, provider, 1_000 + 86_400_000);
    assert.equal(outcome.state, "SETTLED");
    assert.equal(provider.totalSends(), 1);
    store.close();
  });
});
