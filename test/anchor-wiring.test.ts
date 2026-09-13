/**
 * The anchor has to be PUT there, not merely accepted.
 *
 * `findPaymentByReference` takes an anchor block, the worker forwards one, and both production
 * `sightPayment` callers pass one through. All of that was true while the number was still never
 * being stored: the agent surface read the real invoice, used it to check the payment reference,
 * and dropped the one field the recovery path needs. Every signature in the chain was correct and
 * the chain carried nothing, so `obligationForRecovery` returned `anchorBlock: null`, every scan
 * came back truncated, and no failed dry run could ever be resolved.
 *
 * A test that only checked the parameter exists would have passed throughout that bug. This one
 * drives the real MCP entry point and reads the value back out the way the worker reads it.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { obligationId } from "../src/identity.ts";
import { handleRequest, type McpContext } from "../src/mcp.ts";
import { toBaseUnits } from "../src/money.ts";
import { NAMESPACE, buildSourceFacts } from "../src/plan.ts";
import { FixtureProvider } from "../src/provider.ts";
import { Store } from "../src/store.ts";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PAYEE = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const FEE_ADDR = `0x${"0".repeat(40)}`;
const REQUEST_ID = "01b7cd715cfe60ac07f637ed0eb62bf5d1c00c56e3599b8ce6b0a962e8b7f49914";
const REFERENCE = "0x7a3496f145f70a31";
const ANCHOR_BLOCK = 11_690_123;
const AMOUNT = toBaseUnits("1", 18).toString();

/** The invoice as Request's gateway returns it, anchor included. */
const invoice = {
  requestId: REQUEST_ID,
  chainId: 11155111,
  tokenAddress: FAU,
  payee: PAYEE,
  payeeOfRecord: PAYEE,
  invoiceBaseUnits: AMOUNT,
  feeBaseUnits: "0",
  feeRecipient: FEE_ADDR,
  salt: "0123456789abcdef",
  paymentReference: REFERENCE,
  anchor: { blockNumber: ANCHOR_BLOCK, transactionHash: `0x${"ab".repeat(32)}` },
};

function proposeArgs() {
  return {
    requestId: REQUEST_ID,
    paymentReference: REFERENCE,
    payee: PAYEE,
    amountBaseUnits: AMOUNT,
    maxTotalDebitBaseUnits: AMOUNT,
    feeAmount: "0",
    feeAddress: FEE_ADDR,
    tokenAddress: FAU,
  };
}

describe("the invoice anchor is actually stored, not just accepted", () => {
  test("the MCP surface keeps the anchor it read from Request", async () => {
    const store = new Store();
    const ctx = {
      store,
      provider: new FixtureProvider(),
      // Nothing on chain, so the propose path runs through instead of refusing ALREADY_PAID.
      findPayment: async () => ({ found: false, corroborated: true, scannedBlocks: 1, truncated: false }),
      fetchInvoice: async () => invoice,
    } as unknown as McpContext;

    const reply = await handleRequest(ctx, {
      id: 1,
      method: "tools/call",
      params: { name: "propose_payment", arguments: proposeArgs() },
    });
    assert.ok(reply, "the tool call should have answered");

    // Read back exactly the way the recovery path reads it.
    const recovered = store.obligationForRecovery(obligationId(NAMESPACE, REQUEST_ID));
    assert.equal(
      recovered?.anchorBlock,
      ANCHOR_BLOCK,
      "the anchor Request supplied must survive into the stored facts, or recovery can never conclude",
    );
    store.close();
  });

  test("an invoice Request has not anchored yet stores none, rather than inventing one", async () => {
    // Absent, not zero. A zero floor would claim a scan to genesis that never happened, which is
    // the unsafe direction: it would turn "I did not look far enough" into "nothing ever paid".
    const store = new Store();
    const { anchor: _dropped, ...unanchored } = invoice;
    const ctx = {
      store,
      provider: new FixtureProvider(),
      findPayment: async () => ({ found: false, corroborated: true, scannedBlocks: 1, truncated: false }),
      fetchInvoice: async () => unanchored,
    } as unknown as McpContext;

    await handleRequest(ctx, {
      id: 1,
      method: "tools/call",
      params: { name: "propose_payment", arguments: proposeArgs() },
    });

    const recovered = store.obligationForRecovery(obligationId(NAMESPACE, REQUEST_ID));
    assert.equal(recovered?.anchorBlock, null, "no anchor was known, so none may be claimed");
    store.close();
  });

  test("an absent anchor is not persisted as a key at all", () => {
    const facts = buildSourceFacts({
      requestId: REQUEST_ID,
      paymentReference: REFERENCE,
      payee: PAYEE,
      amountBaseUnits: AMOUNT,
      maxTotalDebitBaseUnits: AMOUNT,
      feeAmount: "0",
      feeAddress: FEE_ADDR,
      tokenAddress: FAU,
    });
    assert.equal(facts.anchorBlock, undefined);
    assert.ok(!("anchorBlock" in JSON.parse(JSON.stringify(facts))));
  });

  test("the watcher carries an anchor when its feed has one", () => {
    // The watcher is handed invoices rather than reading the gateway, so this is a wire test by
    // necessity. The feed it ships with (docs/live-invoices.json) records no anchor, which is
    // recorded as a gap in the feed rather than papered over.
    const facts = buildSourceFacts({
      requestId: REQUEST_ID,
      paymentReference: REFERENCE,
      payee: PAYEE,
      amountBaseUnits: AMOUNT,
      maxTotalDebitBaseUnits: AMOUNT,
      feeAmount: "0",
      feeAddress: FEE_ADDR,
      anchorBlock: ANCHOR_BLOCK,
    });
    assert.equal(facts.anchorBlock, ANCHOR_BLOCK);
  });
});
