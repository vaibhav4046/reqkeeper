/**
 * A catch block must not assert what happened before the throw.
 *
 * `refusalForLostRace` recognises a lost race by the SIGNATURE of the error rather than by where
 * it was thrown, which is what lets one wrapper cover every site including ones not written yet.
 * The cost of that generality is that it is also reached from AFTER `provider.execute` has
 * broadcast — a concurrent winner moving the obligation on makes this call's next `setState`
 * throw ILLEGAL_TRANSITION — and the branch answered `providerWriteIssued: false` with the words
 * "Nothing sent".
 *
 * That is the single most dangerous sentence this system can say. Every caller, human or agent,
 * reads `providerWriteIssued: false` as "it is safe to propose again", and here it would be said
 * about a call that had already put a payment on the wire.
 *
 * The store knows what the catch block cannot: `markSent` writes `first_send_at` BEFORE the
 * provider call, precisely so the question survives a crash, so an attempt row carrying it is a
 * write that was issued. The refusal is derived from that row instead of from a constant.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { encodeCall } from "../src/abi.ts";
import { obligationId } from "../src/identity.ts";
import { toBaseUnits } from "../src/money.ts";
import { NAMESPACE, ERC20_FEE_PROXY, PAY_SIGNATURE, buildSourceFacts } from "../src/plan.ts";
import { FixtureProvider, type ExecuteResult } from "../src/provider.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";
import type { Policy } from "../src/policy.ts";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PAYEE = "0x0e2bB0000000000000000000000000000000F531";
const FEE_ADDR = "0xAaAa000000000000000000000000000000000001";
const REFERENCE = "0x0056a1b2c3d4e5f6";
const AMOUNT = toBaseUnits("50", 18).toString();

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

const facts = buildSourceFacts({
  requestId: "01req-lost-race",
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

const OID = obligationId(NAMESPACE, "01req-lost-race");

/**
 * Broadcasts, and while it is in flight another process reaches a state this call cannot move on
 * from. This is the real race, not a contrived one: the recovery worker sees the same payment and
 * escalates it, and our own `setState` to CHAIN_PENDING is then illegal.
 */
class WinnerRacesUsProvider extends FixtureProvider {
  #store: Store | undefined;

  bind(store: Store): void {
    this.#store = store;
  }

  override async execute(body: unknown, key: string): Promise<ExecuteResult> {
    const result = await super.execute(body, key); // the money moves here
    this.#store?.setState(OID, "EVIDENCE_CONFLICT", 1_000);
    return result;
  }
}

describe("a refusal thrown after the send must not say nothing was sent", () => {
  test("providerWriteIssued is read from the attempt row, not asserted by the catch", async () => {
    const store = new Store();
    const provider = new WinnerRacesUsProvider();
    provider.bind(store);

    const outcome = await settleObligation(
      { store, provider, policy, approvalAuthority: "caller" as const, sourceSaysPaid: async () => true },
      {
        namespace: NAMESPACE,
        requestId: "01req-lost-race",
        obligationId: OID,
        paymentReference: REFERENCE,
        facts,
        steps,
        approval: { approver: "human:owner", decision: "APPROVED" },
        now: 1_000,
      },
    );

    // The premise: a payment really went out on this call.
    assert.equal(provider.totalSends(), 1, "the premise is that this call broadcast");
    assert.ok(store.sentAttemptFor(OID), "and the attempt row records it");

    // The property. Getting this wrong tells the caller it is safe to pay again.
    assert.equal(
      outcome.providerWriteIssued,
      true,
      "a call that broadcast must never report providerWriteIssued: false",
    );
    assert.ok(
      !/Nothing sent/i.test(outcome.detail ?? ""),
      `the refusal must not say "Nothing sent" after a send, and said: ${outcome.detail}`,
    );
    store.close();
  });

});
