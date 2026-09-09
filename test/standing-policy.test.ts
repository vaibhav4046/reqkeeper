/**
 * The gate has to be the operator's, not the agent's.
 *
 * Three independent reviews found the same hole: `buildPolicy` derived every constraint from
 * the invoice it would then check, so `checkPolicy` compared the agent's input to itself and
 * five of the nine refusal codes could not fire on any real entry point. These tests are the
 * hostile proposal each of them demonstrated.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildPolicy, buildSourceFacts, type InvoiceFacts } from "../src/plan.ts";
import { checkPolicy } from "../src/policy.ts";
import { describeStandingPolicy, loadStandingPolicy, NO_STANDING_POLICY } from "../src/standing-policy.ts";

const HONEST_PAYEE = "0x0e2bb1c8d52315cad63f341424c5a7dd81a50f53";
const ATTACKER = "0xdeadbeef00000000000000000000000000000001";
const FEE_HOME = "0xaaaa000000000000000000000000000000000001";

const hostile: InvoiceFacts = {
  requestId: "01aaaa",
  paymentReference: "0x0056a1b2c3d4e5f6",
  payee: ATTACKER,
  amountBaseUnits: "1000000000000000000",
  // The agent sets its own ceiling, generously.
  maxTotalDebitBaseUnits: "999000000000000000000",
  feeAmount: "500000000000000000000",
  feeAddress: ATTACKER,
};

const operator = {
  allowedPayees: [HONEST_PAYEE],
  allowedFeeRecipients: [FEE_HOME],
  maxTotalDebitBaseUnits: "2000000000000000000",
  maxFeeBaseUnits: "0",
  source: "environment" as const,
};

describe("a standing policy is what makes the gate real", () => {
  test("without one, the agent's own invoice is the only constraint", () => {
    const policy = buildPolicy(hostile, NO_STANDING_POLICY);
    const decision = checkPolicy(policy, buildSourceFacts(hostile));
    // This is the hole, asserted rather than described: with nothing standing behind it the
    // gate cannot refuse anything the proposer was willing to write down.
    assert.equal(decision.ok, true);
    assert.match(describeStandingPolicy(NO_STANDING_POLICY), /no standing policy set/);
  });

  test("with one, the attacker payee is refused", () => {
    const policy = buildPolicy(hostile, operator);
    const decision = checkPolicy(policy, buildSourceFacts(hostile));
    assert.equal(decision.ok, false);
    assert.equal(decision.code, "PAYEE_NOT_ALLOWED");
  });

  test("an agent cannot raise its own ceiling above the operator's", () => {
    const policy = buildPolicy(hostile, operator);
    // The agent asked for 999 FAU of headroom. It gets the operator's 2.
    assert.equal(policy.maxTotalDebitBaseUnits, "2000000000000000000");
  });

  test("an agent may tighten its own ceiling below the operator's", () => {
    const modest: InvoiceFacts = { ...hostile, maxTotalDebitBaseUnits: "1500000000000000000" };
    const policy = buildPolicy(modest, operator);
    assert.equal(policy.maxTotalDebitBaseUnits, "1500000000000000000");
  });

  test("the fee ceiling and the fee recipient both come from the operator", () => {
    const policy = buildPolicy(hostile, operator);
    assert.deepEqual(policy.allowedFeeRecipients, [FEE_HOME]);
    assert.equal(policy.maxFeeBaseUnits, "0");

    const honestPayee: InvoiceFacts = { ...hostile, payee: HONEST_PAYEE };
    const decision = checkPolicy(buildPolicy(honestPayee, operator), buildSourceFacts(honestPayee));
    assert.equal(decision.ok, false);
    // The payee is fine now, so the next thing to refuse is where the fee goes.
    assert.ok(["FEE_RECIPIENT_UNKNOWN", "FEE_EXCEEDS_CEILING"].includes(String(decision.code)));
  });

  test("malformed operator settings are treated as unset, never as zero", () => {
    // A ceiling that silently became "0" would refuse every payment; an allowlist that
    // silently became empty would look like a working gate while allowing everything.
    const loaded = loadStandingPolicy(
      {
        REQKEEPER_ALLOWED_PAYEES: "not-an-address, 0xzz",
        REQKEEPER_MAX_DEBIT: "1.5 FAU",
      },
      "does-not-exist.json",
    );
    assert.deepEqual(loaded.allowedPayees, []);
    assert.equal(loaded.maxTotalDebitBaseUnits, null);
    assert.equal(loaded.source, "none");
  });

  test("addresses are read case-insensitively, because case is a checksum", () => {
    const loaded = loadStandingPolicy(
      { REQKEEPER_ALLOWED_PAYEES: HONEST_PAYEE.toUpperCase().replace("0X", "0x") },
      "does-not-exist.json",
    );
    assert.deepEqual(loaded.allowedPayees, [HONEST_PAYEE]);
    assert.equal(loaded.source, "environment");
  });
});

describe("mainnet is disabled in code, not only in prose", () => {
  test("a mainnet chain id is refused even when the policy names it", () => {
    const mainnetPolicy = { ...buildPolicy(hostile, operator), chainId: 1 };
    const mainnetFacts = { ...buildSourceFacts(hostile), chainId: 1 };
    const decision = checkPolicy(mainnetPolicy, mainnetFacts);
    assert.equal(decision.ok, false);
    assert.equal(decision.code, "UNSUPPORTED_CHAIN");
    assert.match(decision.detail, /production network/);
  });

  test("every chain a mistake would cost real money on is covered", () => {
    // Ethereum, Optimism, BNB, Polygon, Base, Arbitrum, Avalanche.
    for (const chainId of [1, 10, 56, 137, 8453, 42161, 43114]) {
      const decision = checkPolicy(
        { ...buildPolicy(hostile, operator), chainId },
        { ...buildSourceFacts(hostile), chainId },
      );
      assert.equal(decision.ok, false, `chain ${chainId} must be refused`);
      assert.equal(decision.code, "UNSUPPORTED_CHAIN");
    }
  });

  test("Sepolia still works", () => {
    const honest = { ...hostile, payee: HONEST_PAYEE, feeAddress: FEE_HOME, feeAmount: "0" };
    const decision = checkPolicy(buildPolicy(honest, operator), buildSourceFacts(honest));
    assert.equal(decision.ok, true);
  });
});
