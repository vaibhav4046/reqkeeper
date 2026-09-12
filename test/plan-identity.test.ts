/**
 * Two gates that existed on paper and could not fire.
 *
 * `TOKEN_DECIMALS_MISMATCH` compared `f.tokenDecimals ?? 18` against `f.tokenDecimals ?? 18` —
 * both sides of the comparison read the same field, so on every composed entry point it was
 * 18 against 18. The refusal had a test, a code and a row in the harness, and was structurally
 * unable to happen in production. Today FAU is the only token and 18 is correct, so nothing was
 * wrong; the repository already references a 6-decimal FakeUSDC, and the day that lands this is
 * the single comparison between a scale error and a payment 10^12 too large.
 *
 * The plan hash had the mirror-image problem: the payment reference was case-folded and
 * `steps[].data` was not, so two spellings of one calldata gave two plan hashes and therefore
 * two provider idempotency keys for one identical on-chain effect.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { encodeCall } from "../src/abi.ts";
import { obligationId } from "../src/identity.ts";
import { toBaseUnits } from "../src/money.ts";
import { checkPolicy } from "../src/policy.ts";
import { buildPolicy, buildSourceFacts, ERC20_FEE_PROXY, FAU, knownTokenDecimals, NAMESPACE, PAY_SIGNATURE } from "../src/plan.ts";
import { derivePlan } from "../src/settle.ts";
import type { InvoiceFacts } from "../src/plan.ts";

const PAYEE = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const FEE_ADDR = `0x${"0".repeat(40)}`;
const REFERENCE = "0x050562a52ec69fa2";
const ONE = toBaseUnits("1", 18).toString();
const TWO = toBaseUnits("2", 18).toString();

function invoice(over: Partial<InvoiceFacts> = {}): InvoiceFacts {
  return {
    requestId: "01req-decimals",
    paymentReference: REFERENCE,
    payee: PAYEE,
    amountBaseUnits: ONE,
    maxTotalDebitBaseUnits: TWO,
    feeAmount: "0",
    feeAddress: FEE_ADDR,
    ...over,
  } as InvoiceFacts;
}

describe("the decimals gate can actually fire", () => {
  test("the operator's table, not the invoice, is what the policy believes", () => {
    assert.equal(knownTokenDecimals(FAU), 18);
    assert.equal(knownTokenDecimals(FAU.toLowerCase()), 18, "address spelling is not a different token");
    assert.equal(knownTokenDecimals("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"), undefined);
  });

  test("an invoice that claims the wrong scale for a known token is refused", () => {
    // The case the gate exists for, and the case it could not previously see: FAU is 18dp and
    // this invoice says 6. Before the split, both sides of the comparison read this same field.
    const facts = invoice({ tokenDecimals: 6 });
    const decision = checkPolicy(buildPolicy(facts), buildSourceFacts(facts));

    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.code, "TOKEN_DECIMALS_MISMATCH");
  });

  test("an invoice that states the right scale passes", () => {
    // The control. Without it the test above passes for a policy that refuses everything.
    const facts = invoice({ tokenDecimals: 18 });
    const decision = checkPolicy(buildPolicy(facts), buildSourceFacts(facts));

    assert.equal(decision.ok, true, decision.ok === false ? decision.code : "");
  });

  test("an invoice that states no scale at all still passes for the one known token", () => {
    // docs/live-invoices.json carries no tokenDecimals field, so all 38 recorded settlements
    // ran on the default. That must keep working or the fix breaks the existing evidence.
    const decision = checkPolicy(buildPolicy(invoice()), buildSourceFacts(invoice()));

    assert.equal(decision.ok, true, decision.ok === false ? decision.code : "");
  });

  test("an unknown token cannot inherit 18 and settle at a scale nobody checked", () => {
    const facts = invoice({ tokenAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" });
    const decision = checkPolicy(buildPolicy(facts), buildSourceFacts(facts));

    assert.equal(decision.ok, false);
    assert.equal(
      decision.ok === false && decision.code,
      "TOKEN_DECIMALS_MISMATCH",
      "an unknown token has no scale the operator has checked, so it cannot be settled",
    );
  });
});

describe("the plan hash addresses the effect, not one spelling of it", () => {
  const base = {
    obligationId: obligationId(NAMESPACE, "01req-case"),
    policy: buildPolicy(invoice()),
    facts: buildSourceFacts(invoice()),
    totalDebitBaseUnits: ONE,
    sourceFactsHash: "h",
  };
  const data = encodeCall(PAY_SIGNATURE, [FAU, PAYEE, ONE, REFERENCE, "0", FEE_ADDR]);
  const step = (d: string, to = ERC20_FEE_PROXY) => [{ kind: "PAY", to, data: d, value: "0" }];

  test("the same calldata in a different hex case is the same plan", () => {
    const lower = derivePlan({ ...base, steps: step(data.toLowerCase()) });
    const upper = derivePlan({ ...base, steps: step(`0x${data.slice(2).toUpperCase()}`) });

    assert.equal(
      lower.planHash,
      upper.planHash,
      "one instruction to the chain must not mint two idempotency keys",
    );
  });

  test("the same target in a different address case is the same plan", () => {
    const a = derivePlan({ ...base, steps: step(data, ERC20_FEE_PROXY) });
    const b = derivePlan({ ...base, steps: step(data, ERC20_FEE_PROXY.toLowerCase()) });

    assert.equal(a.planHash, b.planHash);
  });

  test("calldata that actually differs is still a different plan", () => {
    // The control, and the one that matters: folding case must not fold away a real change.
    const other = encodeCall(PAY_SIGNATURE, [FAU, PAYEE, TWO, REFERENCE, "0", FEE_ADDR]);
    const a = derivePlan({ ...base, steps: step(data) });
    const b = derivePlan({ ...base, steps: step(other) });

    assert.notEqual(a.planHash, b.planHash, "a different amount is a different debt");
  });

  test("the bytes handed on for dispatch are untouched", () => {
    // Only the hash input is normalised. The calldata gate downstream is byte identity between
    // what a human approved and what is sent, and that comparison must see the original.
    const shouted = `0x${data.slice(2).toUpperCase()}`;
    const steps = step(shouted);
    derivePlan({ ...base, steps });

    assert.equal(steps[0].data, shouted, "derivePlan must not mutate the plan it was given");
  });
});
