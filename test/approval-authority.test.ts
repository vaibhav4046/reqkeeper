/**
 * An approval authorises one plan, and an authority its own consumer can assert is not one.
 *
 * `settleObligation` took `input.approval` as the authority itself and wrote it straight into the
 * record: whatever the caller asserted became a human decision for whatever plan THIS call had
 * just derived. Nothing checked that the decision had been given for this plan.
 *
 * An adversarial pass drove it with a single genuine "yes" — 1 FAU to the invoice's real payee —
 * and settled 5 FAU to an attacker's address, leaving a HUMAN_APPROVED row in the audit trail
 * naming a sentence the human never saw. The approval-age gate did not help: the replayed
 * `decidedAt` was milliseconds old, so it passed.
 *
 * The fix is provenance rather than a new field. A decision is READ from the store, keyed by the
 * plan hash it was given for, so a plan nobody approved has no approval however convincing the
 * argument looks. The agent surface cannot write approvals — `src/mcp.ts` has no tool that records
 * one — which makes this structural there rather than incidental.
 *
 * `approvalAuthority: "caller"` remains for harnesses that legitimately stand in for a human. It
 * is opt-in, nothing in `src/` selects it, and it writes APPROVAL_ASSERTED_BY_CALLER into the
 * trail so a decision nobody made is never indistinguishable from one somebody did.
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
const HONEST_PAYEE = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const FEE_ADDR = "0xAaAa000000000000000000000000000000000001";
const REFERENCE = "0x0056a1b2c3d4e5f6";
const ONE = toBaseUnits("1", 18).toString();
const FIVE = toBaseUnits("5", 18).toString();
const REQUEST_ID = "01req-authority";
const OID = obligationId(NAMESPACE, REQUEST_ID);

/**
 * Deliberately permissive: both payees allowed, a ceiling above both amounts.
 *
 * The policy is not the control under test. If it refused the attacker's payee the test would pass
 * while proving nothing about approvals, which is how a gate gets credit for another gate's work.
 */
const policy: Policy = {
  version: 1,
  chainId: 11155111,
  token: { address: FAU, decimals: 18, symbol: "FAU" },
  allowedPayees: [HONEST_PAYEE, ATTACKER],
  maxTotalDebitBaseUnits: toBaseUnits("100", 18).toString(),
  allowedFeeRecipients: [FEE_ADDR],
  maxFeeBaseUnits: toBaseUnits("1", 18).toString(),
  planTtlSeconds: 900,
};

function plan(payee: string, amount: string) {
  const facts = buildSourceFacts({
    requestId: REQUEST_ID,
    paymentReference: REFERENCE,
    payee,
    amountBaseUnits: amount,
    maxTotalDebitBaseUnits: amount,
    feeAmount: "0",
    feeAddress: FEE_ADDR,
    tokenAddress: FAU,
    anchorBlock: 11_690_000,
  });
  const steps = [
    {
      kind: "REQUEST_PAYMENT",
      to: ERC20_FEE_PROXY,
      data: encodeCall(PAY_SIGNATURE, [FAU, payee, amount, REFERENCE, "0", FEE_ADDR]),
      value: "0",
    },
  ];
  return { facts, steps };
}

const HUMAN = { approver: "human:owner", decision: "APPROVED" as const };

function settle(
  store: Store,
  provider: FixtureProvider,
  p: ReturnType<typeof plan>,
  opts: { asCaller?: boolean; approval?: typeof HUMAN } = {},
) {
  return settleObligation(
    {
      store,
      provider,
      policy,
      sourceSaysPaid: async () => true,
      ...(opts.asCaller ? { approvalAuthority: "caller" as const } : {}),
    },
    {
      namespace: NAMESPACE,
      requestId: REQUEST_ID,
      obligationId: OID,
      paymentReference: REFERENCE,
      facts: p.facts,
      steps: p.steps,
      ...(opts.approval ? { approval: opts.approval } : {}),
      now: 1_000,
    },
  );
}

describe("a decision authorises the plan it was given for, and no other", () => {
  test("an approval for one plan cannot settle a different one", async () => {
    const store = new Store();
    const provider = new FixtureProvider();

    // The human really did approve something: 1 FAU to the invoice's real payee.
    const honest = plan(HONEST_PAYEE, ONE);
    const proposed = await settle(store, provider, honest);
    assert.equal(proposed.state, "AWAITING_APPROVAL", "a plan with no recorded decision waits");
    assert.ok(proposed.planHash);
    store.recordApproval({
      planHash: proposed.planHash!,
      obligationId: OID,
      approver: HUMAN.approver,
      decision: "APPROVED",
      restatement: proposed.restatement ?? "",
      now: 1_000,
    });

    // The reservation is released first, exactly as the adversarial pass did it — otherwise the
    // second plan is stopped by OBLIGATION_RESERVED and this test would prove nothing about
    // approvals while looking like it had. A gate must be tested with the other gates out of the
    // way, or it gets the credit for their work.
    assert.ok(store.releaseObligation(OID, proposed.planHash!).released);

    // The attack: a different plan — 5 FAU to an address the human never saw — carrying the same
    // approval object. Before the fix this settled, and recorded the human as having approved it.
    const evil = plan(ATTACKER, FIVE);
    const outcome = await settle(store, provider, evil, { approval: HUMAN });

    assert.equal(provider.totalSends(), 0, "NO PAYMENT MAY LEAVE ON A DECISION GIVEN FOR ANOTHER PLAN");
    assert.notEqual(outcome.state, "SETTLED");
    assert.equal(outcome.state, "AWAITING_APPROVAL");
    store.close();
  });

  test("the plan the human did approve still settles", async () => {
    // The control. A gate that refuses everything would satisfy the test above and stop the
    // product working, which is the failure mode on the other side.
    const store = new Store();
    const provider = new FixtureProvider();
    const honest = plan(HONEST_PAYEE, ONE);

    const proposed = await settle(store, provider, honest);
    store.recordApproval({
      planHash: proposed.planHash!,
      obligationId: OID,
      approver: HUMAN.approver,
      decision: "APPROVED",
      restatement: proposed.restatement ?? "",
      now: 1_000,
    });

    const outcome = await settle(store, provider, honest);
    assert.equal(outcome.state, "SETTLED");
    assert.equal(provider.totalSends(), 1);
    store.close();
  });

  test("a recorded rejection is honoured, and is not something the caller can talk past", async () => {
    const store = new Store();
    const provider = new FixtureProvider();
    const honest = plan(HONEST_PAYEE, ONE);

    const proposed = await settle(store, provider, honest);
    store.recordApproval({
      planHash: proposed.planHash!,
      obligationId: OID,
      approver: HUMAN.approver,
      decision: "REJECTED",
      restatement: proposed.restatement ?? "",
      reason: "wrong payee",
      now: 1_000,
    });

    // The caller asserts a yes over the human's recorded no.
    const outcome = await settle(store, provider, honest, { approval: HUMAN });
    assert.equal(provider.totalSends(), 0);
    assert.equal(outcome.state, "REVIEW_REJECTED");
    store.close();
  });

  test("an invoice that moved after a human approved it is named as such", async () => {
    // A plan hash commits to the facts hash, so a changed invoice always yields a DIFFERENT plan
    // hash — which is why the PLAN_CHANGED branch could never fire and `factsAtDispatch` compared
    // a hash to itself. A reviewer found it dead. The danger was being caught, under a name that
    // described the mechanism ("something holds the reservation") rather than the cause.
    const store = new Store();
    const provider = new FixtureProvider();

    const honest = plan(HONEST_PAYEE, ONE);
    const proposed = await settle(store, provider, honest);
    store.recordApproval({
      planHash: proposed.planHash!,
      obligationId: OID,
      approver: HUMAN.approver,
      decision: "APPROVED",
      restatement: proposed.restatement ?? "",
      now: 1_000,
    });

    // The invoice now says something else. The reservation is still held by the approved plan.
    const moved = plan(HONEST_PAYEE, FIVE);
    const outcome = await settle(store, provider, moved);

    assert.equal(provider.totalSends(), 0);
    assert.equal(outcome.refusal, "PLAN_CHANGED");
    store.close();
  });

  test("a rival plan nobody approved is still just a rival, not a changed invoice", async () => {
    // The control that C15 of the harness lost when this branch was first written: a concurrent
    // proposal also has a different facts hash, and calling that "the invoice changed" sends an
    // operator looking for a creditor who did nothing.
    const store = new Store();
    const provider = new FixtureProvider();

    await settle(store, provider, plan(HONEST_PAYEE, ONE)); // reserves, unapproved
    const outcome = await settle(store, provider, plan(HONEST_PAYEE, FIVE));

    assert.equal(provider.totalSends(), 0);
    assert.equal(outcome.refusal, "OBLIGATION_RESERVED");
    store.close();
  });

  test("a harness standing in for the human says so in the audit trail", async () => {
    // `"caller"` is the escape for fixtures and scripts, and the cost of using it is that the
    // trail records an asserted decision rather than a recorded one.
    const store = new Store();
    const provider = new FixtureProvider();
    const honest = plan(HONEST_PAYEE, ONE);

    const outcome = await settle(store, provider, honest, { asCaller: true, approval: HUMAN });
    assert.equal(outcome.state, "SETTLED");
    assert.ok(
      store.auditTrail(OID).some((r) => r.action === "APPROVAL_ASSERTED_BY_CALLER"),
      "an asserted approval must be distinguishable from one a human recorded",
    );
    store.close();
  });
});
