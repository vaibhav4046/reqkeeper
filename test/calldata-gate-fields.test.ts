/**
 * Every field of the calldata gate, pinned one at a time.
 *
 * This is the seam the project is named for: approved bytes must be the signed bytes, so the
 * calldata that will be dispatched is compared field by field against the facts the human
 * approved. A reviewer deleted the token comparison from `calldataDisagreesWithFacts`, ran the
 * whole suite, and got 435 passing tests and exit 0. Then the payee comparison. Same result. The
 * gate that stops the Lobstar failure mode — $4 intended, $441,780 sent — was asserted nowhere.
 *
 * The tests that exercised this path went through `settleObligation`, and every one of them used
 * calldata that agreed with its facts, so they proved the gate lets good plans through and
 * nothing about what it stops. One fixture per field is a lot of setup and so nobody wrote them;
 * a table costs one line each, which is the whole point.
 *
 * Each row states a single disagreement and the words the refusal must name. Naming the field in
 * the assertion matters: a gate that refuses everything would satisfy "it refused", and that is
 * the failure mode on the other side — a gate so blunt no correct plan survives it.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { encodeCall } from "../src/abi.ts";
import { toBaseUnits } from "../src/money.ts";
import { ERC20_FEE_PROXY, PAY_SIGNATURE, buildSourceFacts } from "../src/plan.ts";
import { calldataDisagreesWithFacts } from "../src/settle.ts";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const OTHER_TOKEN = "0x1111111111111111111111111111111111111111";
const PAYEE = "0x0e2bB0000000000000000000000000000000F531";
const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const FEE_ADDR = "0xAaAa000000000000000000000000000000000001";
const OTHER_FEE_ADDR = "0xbBbB000000000000000000000000000000000002";
const REFERENCE = "0x0056a1b2c3d4e5f6";
const OTHER_REFERENCE = "0x00ffffffffffffff";

const AMOUNT = toBaseUnits("50", 18).toString();
const FEE = toBaseUnits("0.5", 18).toString();
const TOTAL = toBaseUnits("100", 18).toString();
const APPROVE_SIGNATURE = "approve(address,uint256)";

const facts = buildSourceFacts({
  requestId: "01req-calldata-fields",
  paymentReference: REFERENCE,
  payee: PAYEE,
  amountBaseUnits: AMOUNT,
  maxTotalDebitBaseUnits: TOTAL,
  feeAmount: FEE,
  feeAddress: FEE_ADDR,
  tokenAddress: FAU,
  anchorBlock: 11_690_000,
});

/** The plan that agrees with the invoice in every field. Each row below breaks exactly one. */
function payStep(over: Partial<{
  token: string;
  payee: string;
  amount: string;
  reference: string;
  fee: string;
  feeRecipient: string;
}> = {}) {
  const a = {
    token: FAU,
    payee: PAYEE,
    amount: AMOUNT,
    reference: REFERENCE,
    fee: FEE,
    feeRecipient: FEE_ADDR,
    ...over,
  };
  return {
    kind: "REQUEST_PAYMENT",
    to: ERC20_FEE_PROXY,
    data: encodeCall(PAY_SIGNATURE, [a.token, a.payee, a.amount, a.reference, a.fee, a.feeRecipient]),
    value: "0",
  };
}

function approveStep(spender = ERC20_FEE_PROXY, amount = AMOUNT) {
  return {
    kind: "ERC20_APPROVE",
    to: FAU,
    data: encodeCall(APPROVE_SIGNATURE, [spender, amount]),
    value: "0",
  };
}

const check = (steps: ReadonlyArray<{ kind: string; to: string; data: string; value: string }>) =>
  calldataDisagreesWithFacts(steps, facts, TOTAL, REFERENCE);

describe("the calldata gate refuses each field it is supposed to compare", () => {
  test("a plan that agrees in every field passes", () => {
    // The control, and it is not optional: without it every row below is satisfied by a gate
    // that refuses unconditionally, which would be just as broken in the other direction.
    assert.equal(check([payStep()]), null);
    assert.equal(check([approveStep(), payStep()]), null);
  });

  const rows: Array<{ field: string; steps: ReturnType<typeof payStep>[]; names: string[] }> = [
    {
      field: "token — pays in a different ERC-20 than the invoice",
      steps: [payStep({ token: OTHER_TOKEN })],
      names: [OTHER_TOKEN.toLowerCase(), FAU.toLowerCase()],
    },
    {
      field: "payee — pays an address the invoice does not name",
      steps: [payStep({ payee: ATTACKER })],
      names: [ATTACKER.toLowerCase(), PAYEE.toLowerCase()],
    },
    {
      field: "amount — moves a different number of base units",
      steps: [payStep({ amount: toBaseUnits("50.000001", 18).toString() })],
      names: [toBaseUnits("50.000001", 18).toString(), AMOUNT],
    },
    {
      field: "fee — pays a different fee than the invoice states",
      steps: [payStep({ fee: toBaseUnits("5", 18).toString() })],
      names: [toBaseUnits("5", 18).toString(), FEE],
    },
    {
      field: "fee recipient — sends the fee somewhere else",
      steps: [payStep({ feeRecipient: OTHER_FEE_ADDR })],
      names: [OTHER_FEE_ADDR.toLowerCase(), FEE_ADDR.toLowerCase()],
    },
    {
      field: "reference — carries another debt's payment reference",
      steps: [payStep({ reference: OTHER_REFERENCE })],
      names: [OTHER_REFERENCE.toLowerCase(), REFERENCE.toLowerCase()],
    },
    {
      field: "approve spender — approves something other than the payment proxy",
      steps: [approveStep(ATTACKER), payStep()],
      names: [ATTACKER.toLowerCase()],
    },
    {
      field: "approve amount — approves more than the plan may debit",
      steps: [approveStep(ERC20_FEE_PROXY, toBaseUnits("1000", 18).toString()), payStep()],
      names: [toBaseUnits("1000", 18).toString(), TOTAL],
    },
  ];

  for (const row of rows) {
    test(row.field, () => {
      const refusal = check(row.steps);
      assert.notEqual(refusal, null, "this disagreement must be refused, and it was not");
      // The refusal has to name the disagreement. "Refused" with no field named is how a gate
      // that refuses everything passes a suite like this one.
      for (const name of row.names) {
        assert.ok(
          refusal!.toLowerCase().includes(name),
          `the refusal must name ${name}, and said: ${refusal}`,
        );
      }
    });
  }

  test("an empty plan authorises nothing and is refused", () => {
    const refusal = check([]);
    assert.match(refusal ?? "", /no steps/);
  });

  test("a plan whose last step is not the payment is refused", () => {
    // Only the last step is dispatched, so an approve-last plan reports a settled invoice while
    // the payee was never paid.
    const refusal = check([payStep(), approveStep()]);
    assert.match(refusal ?? "", /last step/);
  });

  test("a plan carrying two payments is refused: one obligation is one payment", () => {
    const refusal = check([payStep(), payStep()]);
    assert.match(refusal ?? "", /more than one payment/);
  });

  test("a function no invoice authorises is refused by name", () => {
    const steps = [
      {
        kind: "REQUEST_PAYMENT",
        to: FAU,
        data: encodeCall("transfer(address,uint256)", [ATTACKER, AMOUNT]),
        value: "0",
      },
    ];
    const refusal = check(steps);
    assert.notEqual(refusal, null, "an unknown function must never reach a signer");
  });

  test("comparisons are case-insensitive on addresses but exact on amounts", () => {
    // A checksummed address and its lowercase spelling are the same account, and refusing one
    // would make every correct plan fail. A single base unit is NOT a rounding difference.
    assert.equal(check([payStep({ payee: PAYEE.toLowerCase() })]), null);
    assert.equal(check([payStep({ token: FAU.toUpperCase().replace("0X", "0x") })]), null);
    assert.notEqual(check([payStep({ amount: (BigInt(AMOUNT) + 1n).toString() })]), null);
    assert.notEqual(check([payStep({ fee: (BigInt(FEE) - 1n).toString() })]), null);
  });
});
