/**
 * The already-paid gate: the fifth and sixth instances of the class, in the one check that
 * guards against paying an invoice somebody settled OUTSIDE this store.
 *
 * The reference index only ever sees obligations inside this database, so nothing else covers
 * that case. The gate used to read:
 *
 *     alreadyPaid = sighting?.found === true;   // and, on a throw, `alreadyPaid = false`
 *
 * `findPaymentByReference` returns a deliberate tri-state and `chain.ts` documents it in as many
 * words: `found: false` means "I could not tell", never "unpaid". Both lines above collapse that
 * into a boolean, and both collapse it in the unsafe direction — "I could not look" becomes "not
 * paid", which becomes `hasBeenPaid: false`, which is the input `SOURCE_ALREADY_PAID` is derived
 * from. The invoice is then paid a second time.
 *
 * Two ways an unknown reached it, neither hypothetical:
 *   - a truncated scan, which is what you get for any invoice Request has not confirmed yet (no
 *     anchor block, so no floor), and on the whole `verifyAgainstRequest: false` path;
 *   - a throw, which the chain read does on a chain-id mismatch, a dead endpoint, an HTML error
 *     page, or a timeout.
 *
 * An unknown now refuses before any write, at zero gas. Refusing to propose because the chain
 * could not be read is recoverable; paying twice is not.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { handleRequest, type McpContext } from "../src/mcp.ts";
import { toBaseUnits } from "../src/money.ts";
import { FixtureProvider } from "../src/provider.ts";
import { Store } from "../src/store.ts";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PAYEE = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const FEE_ADDR = `0x${"0".repeat(40)}`;
const REQUEST_ID = "01b7cd715cfe60ac07f637ed0eb62bf5d1c00c56e3599b8ce6b0a962e8b7f49914";
const REFERENCE = "0x7a3496f145f70a31";
const AMOUNT = toBaseUnits("1", 18).toString();

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
  anchor: { blockNumber: 11_690_123, transactionHash: `0x${"ab".repeat(32)}` },
};

async function propose(findPayment: McpContext["findPayment"]) {
  const store = new Store();
  const provider = new FixtureProvider();
  const ctx = { store, provider, findPayment, fetchInvoice: async () => invoice } as unknown as McpContext;
  const reply = (await handleRequest(ctx, {
    id: 1,
    method: "tools/call",
    params: {
      name: "propose_payment",
      arguments: {
        requestId: REQUEST_ID,
        paymentReference: REFERENCE,
        payee: PAYEE,
        amountBaseUnits: AMOUNT,
        maxTotalDebitBaseUnits: AMOUNT,
        feeAmount: "0",
        feeAddress: FEE_ADDR,
        tokenAddress: FAU,
      },
    },
  })) as { result?: { content?: Array<{ text?: string }> } };
  const body = JSON.parse(reply?.result?.content?.[0]?.text ?? "{}") as {
    state?: string;
    refusal?: string;
    providerWriteIssued?: boolean;
  };
  return { body, provider, store };
}

describe("a chain read that could not conclude is not evidence the invoice is unpaid", () => {
  test("a truncated scan refuses before any write", async () => {
    // The shape you get for an invoice Request has not anchored yet: the scan ran, but its floor
    // sits above the window a payment could be in.
    const { body, provider, store } = await propose(async () => ({
      found: false,
      truncated: true,
      scannedBlocks: 450_000,
    }));

    assert.equal(body.refusal, "SOURCE_UNVERIFIABLE");
    assert.equal(body.providerWriteIssued, false);
    assert.equal(provider.totalSends(), 0);
    store.close();
  });

  test("a chain read that throws refuses, rather than defaulting to unpaid", async () => {
    // A dead endpoint, an HTML error page, a timeout, a chain-id mismatch. None of it is
    // evidence about the invoice, and the old `catch { alreadyPaid = false }` said it was.
    const { body, provider, store } = await propose(async () => {
      throw new Error("no endpoint answered");
    });

    assert.equal(body.refusal, "SOURCE_UNVERIFIABLE");
    assert.equal(provider.totalSends(), 0);
    store.close();
  });

  test("a sighting that does not say whether it was truncated is treated as unknown", async () => {
    // An absent flag is not a promise that the window was covered. It is a reader that did not
    // say, and this whole file exists because absent kept reading as "no".
    const { body, provider, store } = await propose(async () => ({ found: false }));

    assert.equal(body.refusal, "SOURCE_UNVERIFIABLE");
    assert.equal(provider.totalSends(), 0);
    store.close();
  });

  test("a conclusive scan that found a payment refuses as already paid", async () => {
    const { body, provider, store } = await propose(async () => ({
      found: true,
      truncated: false,
    conflictKinds: [],
    negativeCorroborations: 2,
      txHash: `0x${"cd".repeat(32)}`,
      amount: AMOUNT,
      to: PAYEE,
      tokenAddress: FAU,
      corroborated: true,
    }));

    assert.equal(body.refusal, "SOURCE_ALREADY_PAID");
    assert.equal(provider.totalSends(), 0);
    store.close();
  });

  test("a conclusive scan that found nothing proposes normally", async () => {
    // The control. The gate must refuse an unknown without refusing the ordinary case, or it is
    // just a different way of being broken.
    const { body, provider, store } = await propose(async () => ({
      found: false,
      truncated: false,
    conflictKinds: [],
    negativeCorroborations: 2,
      scannedBlocks: 450_000,
    }));

    assert.equal(body.state, "AWAITING_APPROVAL");
    assert.equal(body.refusal, null);
    assert.equal(provider.totalSends(), 0);
    store.close();
  });
});
