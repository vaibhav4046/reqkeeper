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

import type { PaymentExpectation, PaymentSighting } from "../src/chain.ts";
import { obligationId, sourceFactsHash } from "../src/identity.ts";
import { checkPolicy } from "../src/policy.ts";
import { buildPolicy, buildSourceFacts, buildSteps, FAU, NAMESPACE, type InvoiceFacts } from "../src/plan.ts";
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

/**
 * A log that actually pays this invoice: the right token to the right payee for the right
 * amount and fee. Anything less than all five is somebody else's transaction.
 */
const PAID: PaymentSighting = {
  found: true,
  txHash: `0x${"1c".repeat(32)}`,
  tokenAddress: FAU,
  to: PAYEE,
  amount: INVOICE.amountBaseUnits,
  feeAmount: "0",
  feeAddress: `0x${"0".repeat(40)}`,
  scannedBlocks: 45_000,
};

/**
 * The public-reference attack. Payment references derive from data anchored openly on
 * Sepolia, so anyone can read one off-chain and emit a fee-proxy event carrying it — paying
 * themselves a dust amount, in any token. It costs the attacker nothing and it used to be
 * enough to mark a real invoice PAID_ON_CHAIN on every pass, for ever.
 */
const SOMEBODY_ELSES_PAYMENT: PaymentSighting = {
  ...PAID,
  txHash: `0x${"ee".repeat(32)}`,
  to: "0x000000000000000000000000000000000000dEaD",
  amount: "1",
};

function bench(sighting: PaymentSighting, standing: StandingPolicy = NO_STANDING_POLICY) {
  const store = new Store();
  const provider = new FixtureProvider("NONE");
  const asked: PaymentExpectation[] = [];
  const deps = {
    store,
    provider,
    standing,
    findPayment: async (_reference: string, expect: PaymentExpectation): Promise<PaymentSighting> => {
      asked.push(expect);
      return sighting;
    },
  };
  return { store, provider, deps, asked };
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

  test("a log carrying the reference but paying somebody else does not suppress the invoice", async () => {
    // The grief case. `found` alone made this invoice PAID_ON_CHAIN — never proposed, never
    // approved, never paid, and with no refusal anywhere to explain the silence. It fails
    // safe on money, which is why it survived: the damage is a real debt suppressed.
    const { store, provider, deps } = bench(SOMEBODY_ELSES_PAYMENT);

    const [row] = await watchPass(deps, [INVOICE], 1_000_000);

    assert.equal(row.chainSaysPaid, false);
    assert.equal(row.state, "AWAITING_APPROVAL");
    assert.ok(row.planHash, "the invoice must still reach a human");
    assert.ok(row.approvalCommand);
    // The conflicting log is named rather than swallowed: it is either an attack or a
    // misconfiguration, and both need a human to see it.
    assert.match(row.detail, /carries this reference but does not pay this invoice/);
    assert.match(row.detail, /0x000000000000000000000000000000000000dEaD/i);
    assert.equal(provider.totalSends(), 0);
    store.close();
  });

  test("a sighting with no payment fields is not evidence of payment", async () => {
    // What a reader that only matched the reference returns. It corroborates nothing, so it
    // cannot be the reason an invoice is skipped.
    const { store, provider, deps } = bench({ found: true, txHash: `0x${"ab".repeat(32)}` });

    const [row] = await watchPass(deps, [INVOICE], 1_000_000);

    assert.equal(row.chainSaysPaid, false);
    assert.equal(row.state, "AWAITING_APPROVAL");
    assert.equal(provider.totalSends(), 0);
    store.close();
  });

  test("the chain reader is told what paying this invoice looks like", async () => {
    // So the scan can skip a foreign log rather than return it and rely on the check here.
    const { store, deps, asked } = bench(UNPAID);

    await watchPass(deps, [INVOICE], 1_000_000);

    assert.deepEqual(asked, [
      {
        tokenAddress: FAU,
        to: INVOICE.payee,
        amount: INVOICE.amountBaseUnits,
        feeAmount: "0",
        feeAddress: INVOICE.feeAddress,
      },
    ]);
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
