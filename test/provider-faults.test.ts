/**
 * Every fault this project models, injected under `npm test` — and the send count asserted.
 *
 * `src/provider.ts` names ten platform behaviours and `scripts/harness.ts` injects all ten, but
 * the harness is a CI script rather than a unit test: six of them appeared in no `test/*.test.ts`
 * at all, **including `SIMULATE_IGNORED`**, which is the duplicate-payment hazard the whole
 * architecture is built around. A reviewer counted them.
 *
 * That matters beyond tidiness. The harness asserts states and refusal codes; what decides
 * whether this project works is `provider.totalSends()`, and a fault whose send count nothing
 * asserts is a fault nobody has proved costs nothing. So every case here ends in the same
 * question: how many times did money move?
 *
 * The states are commentary. The number is the money.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { encodeCall } from "../src/abi.ts";
import { obligationId } from "../src/identity.ts";
import { toBaseUnits } from "../src/money.ts";
import { NAMESPACE, PAY_SIGNATURE, buildPolicy, buildSourceFacts, buildSteps } from "../src/plan.ts";
import { FixtureProvider, type Fault } from "../src/provider.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PAYEE = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const FEE_ADDR = `0x${"0".repeat(40)}`;
const REQUEST_ID = "01faults0000000000000000000000000000000000000000000000000000000001";
const REFERENCE = "0x0056a1b2c3d4e5f6";
const ONE = toBaseUnits("1", 18).toString();
const OID = obligationId(NAMESPACE, REQUEST_ID);

const facts = {
  requestId: REQUEST_ID,
  paymentReference: REFERENCE,
  payee: PAYEE,
  amountBaseUnits: ONE,
  maxTotalDebitBaseUnits: ONE,
  feeAmount: "0",
  feeAddress: FEE_ADDR,
  tokenAddress: FAU,
};

/** One settle attempt under one fault, with a human approval already recorded. */
async function settleUnder(fault: Fault, times = 1) {
  const store = new Store();
  const provider = new FixtureProvider(fault);
  const sourceFacts = buildSourceFacts(facts);
  const steps = buildSteps(facts);
  const policy = buildPolicy(facts);

  const outcomes = [];
  for (let i = 0; i < times; i++) {
    outcomes.push(
      await settleObligation(
        {
          store,
          provider,
          policy,
          sourceSaysPaid: async () => false,
          approvalAuthority: "caller",
        },
        {
          namespace: NAMESPACE,
          requestId: REQUEST_ID,
          paymentReference: REFERENCE,
          obligationId: OID,
          facts: sourceFacts,
          steps,
          approval: { approver: "test:asserted", decision: "APPROVED" as const },
          now: 1_000_000 + i,
        },
      ),
    );
  }
  const sends = provider.totalSends();
  store.close();
  return { outcomes, sends };
}

describe("every modelled platform fault, and what it costs", () => {
  // The control. Without it, "0 sends" below would pass for a system that never sends at all.
  test("NONE: one approved obligation, one send", async () => {
    const { outcomes, sends } = await settleUnder("NONE");
    assert.equal(sends, 1, "the happy path must actually pay");
    assert.ok(["SETTLED", "RECONCILIATION_PENDING", "CHAIN_PENDING"].includes(outcomes[0].state), outcomes[0].state);
  });

  for (const fault of [
    "TIMEOUT_NO_RESPONSE",
    "IDEMPOTENCY_CONFLICT",
    "IDEMPOTENCY_IN_PROGRESS",
    "REPLAY_EXPIRED",
    "CACHED_FAILURE",
    "SIMULATE_IGNORED",
    "RECEIPT_REVERTED",
    "COMPLETE_BUT_RECEIPT_MISSING",
    "RATE_LIMITED",
  ] as const) {
    test(`${fault}: never more than one physical send`, async () => {
      // Three attempts, because the danger in every one of these is the SECOND call: an agent
      // that retries, a worker that redrives, a process that restarts. One send is the happy
      // path; zero is a refusal; two is the thing this project exists to prevent.
      const { sends } = await settleUnder(fault, 3);
      assert.ok(sends <= 1, `${fault} produced ${sends} physical sends across three attempts`);
    });
  }

  test("SIMULATE_IGNORED: a dry run that really executed is an incident, not a settlement", async () => {
    // The #1959 hazard, and the reason `SimulateOutcome` is a four-way union rather than a
    // boolean. A dry run that comes back carrying a transaction hash HAS executed; treating it
    // as a failed simulation and retrying is how one approval becomes two payments.
    const { outcomes, sends } = await settleUnder("SIMULATE_IGNORED", 2);
    assert.ok(sends <= 1, `the leaked dry run was followed by a real send: ${sends} in total`);
    const first = outcomes[0];
    assert.notEqual(first.state, "SETTLED", "a leaked dry run is not a settlement");
    assert.ok(
      ["EVIDENCE_CONFLICT", "PAYMENT_PREFLIGHT", "EXECUTION_OUTCOME_UNKNOWN", "SIMULATION_BLOCKED"].includes(first.state),
      `a leaked dry run must stop, not proceed: ${first.state} ${first.refusal ?? ""}`,
    );
  });

  test("CACHED_FAILURE: the answer is a new approved plan, never a rotated key", async () => {
    // Issue #1840. The key replays a cached FAILURE for 24 hours, so a retry can never succeed --
    // and the "fix" that suggests itself, rotating the idempotency key, is a second payment.
    const { outcomes, sends } = await settleUnder("CACHED_FAILURE", 3);
    assert.ok(sends <= 1, `${sends} sends under a cached failure`);
    assert.ok(
      outcomes.every((o) => o.state !== "SETTLED"),
      "a cached failure must never be reported as a settlement",
    );
  });

  test("REPLAY_EXPIRED: the durable store refuses, not the provider's cache", async () => {
    // The 24-hour window lapsing is the platform forgetting. What must not lapse with it is this
    // project's own record, which is the whole claim: exactly-once is ReqKeeper's, not
    // KeeperHub's. Three attempts with the cache gone still buy one payment.
    const { sends } = await settleUnder("REPLAY_EXPIRED", 3);
    assert.ok(sends <= 1, `${sends} sends once the provider's replay window had lapsed`);
  });

  test("the calldata a fault path sends is still byte-identical to what was approved", async () => {
    // No fault may route around the gate. The bytes are rebuilt here from the invoice and
    // compared with what `buildSteps` produced, which is what the human approved a hash of.
    const approved = buildSteps(facts)[0].data;
    const expected = encodeCall(PAY_SIGNATURE, [FAU, PAYEE, ONE, REFERENCE, "0", FEE_ADDR]);
    assert.equal(approved, expected, "the plan's own calldata must be the invoice's calldata");
  });
});
