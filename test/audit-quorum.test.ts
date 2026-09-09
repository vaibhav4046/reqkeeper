/**
 * Two limitations, closed and proved.
 *
 * "The audit trail is tamper-evident, not tamper-proof" was true in the weak sense: nothing
 * detected an edit. And "single-operator mode" was a description of a missing feature, not a
 * design choice. Both are now properties the code enforces, so both come with the test that
 * would fail if they stopped holding.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { obligationId } from "../src/identity.ts";
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

const steps = [
  {
    kind: "REQUEST_PAYMENT",
    to: ERC20_FEE_PROXY,
    data: encodeCall(PAY_SIGNATURE, [FAU, PAYEE, facts.invoiceBaseUnits, REFERENCE, "0", FEE_ADDR]),
    value: "0",
  },
];

describe("the audit trail detects its own rewriting", () => {
  test("a clean trail verifies, and names who approved and when", () => {
    const store = new Store();
    const oid = obligationId(NS, "audit-1");
    store.importObligation({
      obligationId: oid,
      namespace: NS,
      requestId: "audit-1",
      sourceFactsJson: "{}",
      sourceFactsHash: "h",
      paymentReference: REFERENCE,
      now: 1_000,
    });
    store.audit(oid, "agent", "PROPOSED", { requestId: "audit-1" }, 1_001);
    store.savePlan({
      planHash: "plan-a",
      obligationId: oid,
      version: 1,
      policyHash: "p",
      sourceFactsHash: "h",
      planJson: "{}",
      totalDebitBaseUnits: "1",
      expiresAt: 9_000,
      now: 1_002,
    });
    store.recordApproval({
      planHash: "plan-a",
      obligationId: oid,
      approver: "alice@example.com",
      decision: "APPROVED",
      restatement: "Pay 50 FAU",
      now: 1_003,
    });

    const chain = store.verifyAuditChain();
    assert.equal(chain.ok, true, chain.reason);
    assert.ok(chain.rows >= 2);

    // The question an auditor actually asks: who, and when.
    const trail = store.auditTrail(oid);
    const approval = trail.find((r) => r.action === "HUMAN_APPROVED");
    assert.ok(approval, "recording an approval must leave a row in the trail");
    assert.equal(approval.actor, "alice@example.com");
    assert.equal(approval.at, 1_003);
    store.close();
  });

  test("editing a row after the fact is detected", () => {
    const store = new Store();
    store.audit(null, "system", "ONE", { n: 1 }, 10);
    store.audit(null, "system", "TWO", { n: 2 }, 20);
    store.audit(null, "system", "THREE", { n: 3 }, 30);
    assert.equal(store.verifyAuditChain().ok, true);

    // Someone with write access rewrites the middle of the trail.
    store.rawExecForTests("UPDATE audit SET detail_json = '{\"n\":999}' WHERE action = 'TWO'");

    const after = store.verifyAuditChain();
    assert.equal(after.ok, false);
    assert.match(String(after.reason), /edited/);
    store.close();
  });

  test("deleting a row is detected too", () => {
    const store = new Store();
    store.audit(null, "system", "ONE", {}, 10);
    store.audit(null, "system", "TWO", {}, 20);
    store.audit(null, "system", "THREE", {}, 30);
    store.rawExecForTests("DELETE FROM audit WHERE action = 'TWO'");

    const after = store.verifyAuditChain();
    assert.equal(after.ok, false);
    assert.match(String(after.reason), /missing or was reordered/);
    store.close();
  });
});

describe("more than one pair of eyes, when a workspace wants it", () => {
  async function settleWith(quorum: number, approvers: string[]) {
    const store = new Store();
    const provider = new FixtureProvider("NONE");
    const oid = obligationId(NS, "quorum-1");
    const input = {
      namespace: NS,
      requestId: "quorum-1",
      paymentReference: REFERENCE,
      obligationId: oid,
      facts,
      steps,
      now: 1_000_000,
    };
    const deps = { store, provider, policy, sourceSaysPaid: async () => true, quorum };

    // First pass with no approval, to persist the plan the humans will sign.
    const proposal = await settleObligation(deps, input);
    for (const approver of approvers) {
      store.recordApproval({
        planHash: proposal.planHash as string,
        obligationId: oid,
        approver,
        decision: "APPROVED",
        restatement: proposal.restatement ?? "",
        now: 1_000_001,
      });
    }
    const out = await settleObligation(deps, {
      ...input,
      approval: { approver: approvers[0] ?? "nobody", decision: "APPROVED" as const },
    });
    return { out, provider, store };
  }

  test("one approver is enough when one is what the workspace requires", async () => {
    const { out, provider, store } = await settleWith(1, ["alice@example.com"]);
    assert.equal(out.state, "SETTLED");
    assert.equal(provider.totalSends(), 1);
    store.close();
  });

  test("one approver is not enough when two are required, and nothing is sent", async () => {
    const { out, provider, store } = await settleWith(2, ["alice@example.com"]);
    assert.equal(out.state, "AWAITING_APPROVAL");
    assert.match(out.detail, /requires 2 approvers; 1 so far/);
    assert.equal(provider.totalSends(), 0);
    store.close();
  });

  test("the same person twice is still one person", async () => {
    const { out, provider, store } = await settleWith(2, ["alice@example.com", "ALICE@example.com"]);
    assert.equal(out.state, "AWAITING_APPROVAL");
    assert.equal(provider.totalSends(), 0);
    store.close();
  });

  test("two distinct approvers reach the quorum", async () => {
    const { out, provider, store } = await settleWith(2, ["alice@example.com", "bob@example.com"]);
    assert.equal(out.state, "SETTLED");
    assert.equal(provider.totalSends(), 1);
    store.close();
  });
});
