/**
 * A forged fee-proxy log must not be reported as a payment by the tool an agent asks.
 *
 * The ERC20FeeProxy is permissionless and payment references derive from data anchored openly
 * on Sepolia, so emitting a log that carries somebody else's reference costs an attacker one
 * unit of a worthless token. `verify_payment` answered `paid: sighting.found` — the reference
 * alone — while the money path beside it refused the identical log on its fields. The surface
 * an agent consults contradicted the surface that decides, in the direction that says "this
 * debt is settled, stop".
 *
 * The fix takes the expectation from the obligation's OWN imported facts rather than from the
 * caller: this server has the store next to it, and a caller who could supply an expectation
 * could supply one shaped to fit the forgery.
 *
 * The chain reader here is a faithful stand-in for `scanForReference`: given an expectation it
 * applies `matchPaymentLog`, exactly as the real one does, so what is under test is what
 * src/mcp.ts asks for and how it reads the answer — not a stub that agrees with it.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  matchPaymentLog,
  type PaymentExpectation,
  type PaymentLogFields,
  type PaymentSighting,
} from "../src/chain.ts";
import { handleRequest, type McpContext } from "../src/mcp.ts";
import { FAU } from "../src/plan.ts";
import { FixtureProvider } from "../src/provider.ts";
import { Store } from "../src/store.ts";

const REQUEST_ID = "012072a1818e83b2f153aa232112c03d09147c02ca5be45c6d507a78d4d5e70576";
const REFERENCE = "0x0056dcf7fc0a464f";
const PAYEE = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const ONE = "1000000000000000000";
const TWO = "2000000000000000000";
const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const WORTHLESS_TOKEN = "0x00000000000000000000000000000000000dead1";

const INVOICE_AS_REQUEST_HOLDS_IT = {
  requestId: REQUEST_ID,
  chainId: 11155111,
  tokenAddress: FAU,
  payee: PAYEE,
  payeeOfRecord: PAYEE,
  invoiceBaseUnits: ONE,
  feeBaseUnits: "0",
  feeRecipient: `0x${"0".repeat(40)}`,
  salt: "8682e8e726d1b4f1",
  paymentReference: REFERENCE,
};

/** The log the red team emitted: our reference, their address, one unit of their own token. */
const FORGED_LOG: PaymentLogFields = {
  tokenAddress: WORTHLESS_TOKEN,
  to: ATTACKER,
  amount: "1",
  feeAmount: "0",
  feeAddress: `0x${"0".repeat(40)}`,
};

/** The honest payment of the same invoice, for the control. */
const HONEST_LOG: PaymentLogFields = {
  tokenAddress: FAU,
  to: PAYEE,
  amount: ONE,
  feeAmount: "0",
  feeAddress: `0x${"0".repeat(40)}`,
};

const FORGED_TX = `0x${"ee".repeat(32)}`;
const HONEST_TX = `0x${"11".repeat(32)}`;

/**
 * `scanForReference`, reduced to one log. With no expectation the log is returned on its
 * reference alone — which is precisely the behaviour that made the tool answer wrongly.
 */
function chainWith(log: PaymentLogFields, txHash: string) {
  const asked: Array<PaymentExpectation | undefined> = [];
  const find = async (
    _reference: string,
    opts: { expect?: PaymentExpectation } = {},
  ): Promise<PaymentSighting> => {
    asked.push(opts.expect);
    const seen: PaymentSighting = { found: true, txHash, block: 7, scannedBlocks: 450_000, ...log };
    if (!opts.expect) return seen;
    const verdict = matchPaymentLog(log, opts.expect);
    return verdict.ok
      ? seen
      : { found: false, scannedBlocks: 450_000, conflicts: [`${txHash}: ${verdict.conflicts.join("; ")}`] };
  };
  return { find, asked };
}

/**
 * The obligation is imported while the chain shows nothing, then the reader is swapped for the
 * one under test. Importing against the forged or honest log would refuse as SOURCE_ALREADY_PAID
 * — correctly — and there would be no obligation left to ask about.
 */
function ctx(): McpContext {
  return {
    store: new Store(),
    provider: new FixtureProvider(),
    findPayment: async () => ({ found: false }),
    fetchInvoice: async () => INVOICE_AS_REQUEST_HOLDS_IT,
  } as McpContext;
}

function useChain(c: McpContext, find: unknown): void {
  (c as { findPayment: unknown }).findPayment = find;
}

async function call(c: McpContext, name: string, args: Record<string, unknown> = {}) {
  const res = await handleRequest(c, { id: 1, method: "tools/call", params: { name, arguments: args } });
  const result = (res as { result: { content: Array<{ text: string }> } }).result;
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

/** Import the obligation the way an agent would, so the facts are the ones Request stated. */
async function withObligation(c: McpContext): Promise<void> {
  const proposed = await call(c, "propose_payment", {
    requestId: REQUEST_ID,
    paymentReference: REFERENCE,
    payee: PAYEE,
    amountBaseUnits: ONE,
    maxTotalDebitBaseUnits: TWO,
  });
  assert.equal(proposed.state, "AWAITING_APPROVAL", JSON.stringify(proposed));
}

describe("verify_payment will not call a forged log a payment", () => {
  test("no field reports the forgery as a payment of this obligation", async () => {
    const chain = chainWith(FORGED_LOG, FORGED_TX);
    const c = ctx();
    await withObligation(c);
    useChain(c, chain.find);

    const answer = await call(c, "verify_payment", { paymentReference: REFERENCE });

    // The claim an agent acts on.
    assert.equal(answer.paid, false, JSON.stringify(answer));
    assert.equal(answer.corroboratedBy, null, JSON.stringify(answer));
    // And not merely renamed: nothing in the whole answer asserts this obligation was paid.
    assert.equal(answer.referenceSeen, false, JSON.stringify(answer));
    assert.equal(answer.txHash, null, JSON.stringify(answer));
    assert.ok(Array.isArray(answer.conflicts) && answer.conflicts.length > 0, JSON.stringify(answer));
    assert.match(String((answer.conflicts as string[]).join(" ")), /pays 0x000000000000000000000000000000000000dEaD/i);

    // The expectation came from the store, not from the caller — the caller sent only a
    // reference, and the chain read still received every field of the real invoice.
    assert.equal(chain.asked.length, 1);
    assert.deepEqual(
      JSON.parse(JSON.stringify(chain.asked[0], (_k, v) => (typeof v === "string" ? v.toLowerCase() : v))),
      {
        tokenAddress: FAU.toLowerCase(),
        to: PAYEE.toLowerCase(),
        amount: ONE,
        feeAmount: "0",
        feeAddress: `0x${"0".repeat(40)}`,
      },
    );
    (c.store as Store).close();
  });

  test("the honest payment of the same invoice is still confirmed", async () => {
    // The control. Without it the test above passes for a tool that answers "no" to everything.
    const chain = chainWith(HONEST_LOG, HONEST_TX);
    const c = ctx();
    await withObligation(c);
    useChain(c, chain.find);

    const answer = await call(c, "verify_payment", { paymentReference: REFERENCE });

    assert.equal(answer.paid, true, JSON.stringify(answer));
    assert.equal(answer.corroboratedBy, "obligation-facts");
    assert.equal(answer.txHash, HONEST_TX);
    assert.equal(answer.conflicts, null);
    (c.store as Store).close();
  });

  test("a reference this deployment never imported is a sighting, never a payment", async () => {
    // Nothing to match against, so the honest answer is "a log carries this reference" plus
    // why that is not a settlement — not `paid: true`.
    const chain = chainWith(FORGED_LOG, FORGED_TX);
    const c = ctx();
    useChain(c, chain.find);

    const answer = await call(c, "verify_payment", { paymentReference: REFERENCE });

    assert.equal(answer.paid, false, JSON.stringify(answer));
    assert.equal(answer.corroboratedBy, null);
    assert.equal(answer.referenceSeen, true, "the sighting itself is not hidden");
    assert.match(String(answer.caveat), /nothing here corroborates/);
    assert.deepEqual(chain.asked, [undefined], "there were no imported facts to match against");
    (c.store as Store).close();
  });

  test("a log in a different transaction from the one we recorded is a conflict", async () => {
    // The obligation settled here, in HONEST_TX. A second log carrying the same reference —
    // even one that matches the fields — is somebody re-emitting our reference, and the
    // disagreement with our own record is surfaced rather than swallowed.
    const chain = chainWith(HONEST_LOG, `0x${"cc".repeat(32)}`);
    const c = ctx();
    await withObligation(c);
    useChain(c, chain.find);
    const store = c.store as Store;
    const oid = (store.obligationForReference(REFERENCE) as { obligationId: string }).obligationId;
    const { attemptId } = store.openAttempt({
      obligationId: oid,
      planHash: "a".repeat(64),
      stepIndex: 0,
      idempotencyKey: "b".repeat(64),
      endpoint: "test",
      bodyJson: "{}",
    });
    store.markSent(attemptId);
    store.recordOutcome(attemptId, { outcome: "SUCCESS", txHash: HONEST_TX });

    const answer = await call(c, "verify_payment", { paymentReference: REFERENCE });

    const conflicts = answer.conflicts as string[] | null;
    assert.ok(Array.isArray(conflicts) && conflicts.length > 0, JSON.stringify(answer));
    // Both transactions are named: the one seen, and the one we recorded as the payment.
    assert.ok(conflicts.join(" ").includes(`0x${"cc".repeat(32)}`), conflicts.join(" "));
    assert.ok(conflicts.join(" ").includes(HONEST_TX), conflicts.join(" "));
    store.close();
  });
});
