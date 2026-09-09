/**
 * The trigger must never be a payer.
 *
 * `watchPass` is the one loop in this repository that runs unattended, so the assertion that
 * matters in every case here is `provider.totalSends()`. A poller that proposes is an
 * integration; a poller that can send is an agent paying invoices on a timer.
 *
 * The chain reader is injected, so no test here touches the network and "the chain says
 * paid" is a fact the test decides rather than one it hopes for.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PaymentSighting } from "../src/chain.ts";
import { obligationId, sourceFactsHash } from "../src/identity.ts";
import { checkPolicy } from "../src/policy.ts";
import { buildPolicy, buildSourceFacts, buildSteps, NAMESPACE, type InvoiceFacts } from "../src/plan.ts";
import { FixtureProvider } from "../src/provider.ts";
import { derivePlan } from "../src/settle.ts";
import { NO_STANDING_POLICY, type StandingPolicy } from "../src/standing-policy.ts";
import { Store } from "../src/store.ts";
import { watchPass, type WatchInvoice } from "../src/watch.ts";

const PAYEE = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const INVOICE: WatchInvoice = {
  requestId: "01ee24955c76fd84d9ed61ed4ce540b5b38a8726b59dbcdb0179a03145ee590e24",
  paymentReference: "0xfaac1220a314c4a9",
  payee: PAYEE,
  amountBaseUnits: "1000000000000000000",
  feeAmount: "0",
  feeAddress: `0x${"0".repeat(40)}`,
};

const UNPAID: PaymentSighting = { found: false, scannedBlocks: 450_000, truncated: true };
const PAID: PaymentSighting = {
  found: true,
  txHash: `0x${"1c".repeat(32)}`,
  amount: INVOICE.amountBaseUnits,
  scannedBlocks: 45_000,
};

function bench(sighting: PaymentSighting, standing: StandingPolicy = NO_STANDING_POLICY) {
  const store = new Store();
  const provider = new FixtureProvider("NONE");
  const deps = {
    store,
    provider,
    standing,
    findPayment: async (_reference: string): Promise<PaymentSighting> => sighting,
  };
  return { store, provider, deps };
}

/**
 * Re-derive the plan hash from the printed command, the way `scripts/approve.ts` does.
 *
 * The command is not decoration: approve.ts recomputes a hash from exactly these flags and
 * refuses anything that does not match the plan holding the obligation. A tidier `--max` in
 * the printed line would hash to a plan nothing proposed, and the operator would meet
 * "no such plan locally" with no way to tell why.
 */
function planHashFromCommand(command: string): string {
  const flag = (name: string): string => {
    const m = new RegExp(`--${name}=(\\S+)`).exec(command);
    assert.ok(m, `command is missing --${name}: ${command}`);
    return m[1];
  };
  const facts: InvoiceFacts = {
    requestId: flag("requestId"),
    paymentReference: flag("reference"),
    payee: flag("payee"),
    amountBaseUnits: flag("amount"),
    maxTotalDebitBaseUnits: flag("max"),
    feeAmount: flag("fee"),
    feeAddress: flag("feeAddress"),
  };
  const policy = buildPolicy(facts, NO_STANDING_POLICY);
  const sourceFacts = buildSourceFacts(facts);
  const decision = checkPolicy(policy, sourceFacts);
  assert.equal(decision.ok, true);
  return derivePlan({
    obligationId: obligationId(NAMESPACE, facts.requestId),
    policy,
    facts: sourceFacts,
    steps: buildSteps(facts),
    totalDebitBaseUnits: decision.ok ? decision.totalDebitBaseUnits : "0",
    sourceFactsHash: sourceFactsHash(sourceFacts),
  }).planHash;
}

describe("an unpaid Request invoice proposes, and only proposes", () => {
  test("unpaid on chain produces AWAITING_APPROVAL and zero sends", async () => {
    const { store, provider, deps } = bench(UNPAID);

    const [row] = await watchPass(deps, [INVOICE], 1_000_000);

    assert.equal(row.chainSaysPaid, false);
    assert.equal(row.state, "AWAITING_APPROVAL");
    assert.equal(row.providerWriteIssued, false);
    assert.ok(row.planHash, "a proposal must persist a plan for a human to approve");
    assert.equal(provider.totalSends(), 0);
    assert.equal(store.getObligation(obligationId(NAMESPACE, INVOICE.requestId))?.state, "AWAITING_APPROVAL");
    store.close();
  });

  test("the printed approval command hashes to the plan that was actually proposed", async () => {
    const { store, deps } = bench(UNPAID);

    const [row] = await watchPass(deps, [INVOICE], 1_000_000);

    assert.ok(row.approvalCommand);
    assert.equal(planHashFromCommand(row.approvalCommand), row.planHash);
    store.close();
  });

  test("an invoice the chain reports as paid is skipped, not proposed", async () => {
    const { store, provider, deps } = bench(PAID);

    const [row] = await watchPass(deps, [INVOICE], 1_000_000);

    assert.equal(row.chainSaysPaid, true);
    assert.equal(row.state, "PAID_ON_CHAIN");
    assert.equal(row.planHash, null);
    assert.equal(row.approvalCommand, null);
    // Not merely refused after the fact: no obligation was ever imported for it.
    assert.equal(store.getObligation(obligationId(NAMESPACE, INVOICE.requestId)), undefined);
    assert.equal(store.obligationForReference(INVOICE.paymentReference), undefined);
    assert.equal(provider.totalSends(), 0);
    store.close();
  });

  test("a second pass reuses the obligation rather than creating another", async () => {
    const { store, provider, deps } = bench(UNPAID);

    const [first] = await watchPass(deps, [INVOICE], 1_000_000);
    const [second] = await watchPass(deps, [INVOICE], 1_060_000);

    assert.equal(second.state, "AWAITING_APPROVAL");
    // Same plan, so the approval a human is about to give still applies to it.
    assert.equal(second.planHash, first.planHash);
    // The reference is UNIQUE across obligations, so one holder means one obligation.
    assert.equal(
      store.obligationForReference(INVOICE.paymentReference)?.obligationId,
      obligationId(NAMESPACE, INVOICE.requestId),
    );
    assert.equal(second.providerWriteIssued, false);
    assert.equal(provider.totalSends(), 0);
    store.close();
  });

  test("a payee outside the operator's allowlist is refused, not proposed", async () => {
    const standing: StandingPolicy = {
      ...NO_STANDING_POLICY,
      allowedPayees: ["0x000000000000000000000000000000000000dead"],
      source: "environment",
    };
    const { store, provider, deps } = bench(UNPAID, standing);

    const [row] = await watchPass(deps, [INVOICE], 1_000_000);

    assert.equal(row.refusal, "PAYEE_NOT_ALLOWED");
    assert.equal(row.state, "POLICY_DENIED");
    // No command is printed for a refusal: there is nothing here a human should approve.
    assert.equal(row.approvalCommand, null);
    assert.equal(row.providerWriteIssued, false);
    assert.equal(provider.totalSends(), 0);
    store.close();
  });
});
