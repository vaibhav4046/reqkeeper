/**
 * Facts come from Request, not from a file and not from an agent.
 *
 * Every guard in this system sits downstream of one 8-byte payment reference, and none of
 * them re-derives it. Swap a single `paymentReference` in the invoice file and the whole
 * machine still works perfectly — canonical id, policy gate, calldata seam, approval
 * sentence, exactly-once — against the wrong debt. The payee check does not catch it either,
 * because the payee lives in the same file.
 *
 * So the anchor test below is the one that matters: `derivePaymentReference` must reproduce
 * `0x050562a52ec69fa2` from the requestId, salt and payment address of an invoice that exists
 * on Sepolia. That value is not a fixture somebody typed — it is the reference recorded for
 * request `0108b3f7…c142`, whose create action is anchored in Sepolia block 11665964.
 *
 * No test here touches the network; `globalThis.fetch` is stubbed and restored.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import {
  assertReferenceMatches,
  derivePaymentReference,
  fetchInvoice,
  RequestError,
  SEPOLIA_CHAIN_ID,
  toInvoiceFacts,
  type InvoiceFactsFromRequest,
} from "../src/request.ts";

/** The real invoice: requestId, salt, payment address and the reference they derive. */
const REQUEST_ID = "0108b3f7d7d7d3c1fd21d37ba996b21d019c59cbaaa75c5cb5801fc3d9a371c142";
const SALT = "8682e8e726d1b4f1";
const PAYMENT_ADDRESS = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const REFERENCE = "0x050562a52ec69fa2";
const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const ONE_FAU = "1000000000000000000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ANCHOR_TX = "0x3f028b50a0db700274855770781e672fa118271e37582998a064419eb5bea495";
const STRANGER = "0xdEAdBeef00000000000000000000000000000001";

/** The `create` action exactly as the gateway serves it, before it is stringified. */
function createAction() {
  return {
    data: {
      name: "create",
      version: "2.0.3",
      parameters: {
        currency: { type: "ERC20", value: FAU, network: "sepolia" },
        expectedAmount: ONE_FAU,
        payee: { type: "ethereumAddress", value: PAYMENT_ADDRESS },
        payer: { type: "ethereumAddress", value: "0x027D54A692e0e80173141777BdB847c1726FA1F3" },
        timestamp: 1788932300,
        extensionsData: [
          {
            action: "create",
            id: "pn-erc20-fee-proxy-contract",
            version: "0.2.0",
            parameters: {
              feeAddress: ZERO_ADDRESS,
              feeAmount: "0",
              paymentAddress: PAYMENT_ADDRESS,
              paymentNetworkName: "sepolia",
              salt: SALT,
            },
          },
        ],
      },
    },
    signature: { method: "ecdsa", value: `0x${"11".repeat(65)}` },
  };
}

/**
 * The gateway response shape, verified against the live endpoint on 2026-09-12.
 * `transaction.data` is a JSON string, not an object — the single most likely thing for a
 * future reader to get wrong.
 */
function gatewayBody(action: unknown = createAction()) {
  return {
    meta: {
      transactionsStorageLocation: ["QmFixtureCid"],
      storageMeta: [
        {
          ethereum: {
            blockConfirmation: 24625,
            blockNumber: 11665964,
            blockTimestamp: 1788932316,
            networkName: "sepolia",
            smartContractAddress: "0xd6c085a4d14e9e171f4af58f7f48bd81173f167e",
            transactionHash: ANCHOR_TX,
          },
          state: "confirmed",
          storageType: "ethereumIpfs",
        },
      ],
    },
    result: {
      transactions: [
        { state: "confirmed", timestamp: 1788932316, transaction: { data: JSON.stringify(action) } },
      ],
    },
  };
}

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** Answers every request with one status and one body, and records the URL asked for. */
function stubGateway(body: unknown, status = 200): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as unknown as typeof fetch;
  return { urls };
}

describe("derivePaymentReference reproduces a reference that exists on Sepolia", () => {
  test("the anchor: the real triple derives 0x050562a52ec69fa2", () => {
    // If this ever fails, nothing downstream is protecting the debt it thinks it is.
    assert.equal(derivePaymentReference(REQUEST_ID, SALT, PAYMENT_ADDRESS), REFERENCE);
  });

  test("spelling is not identity: an uppercase triple derives the same reference", () => {
    assert.equal(
      derivePaymentReference(REQUEST_ID.toUpperCase(), SALT.toUpperCase(), PAYMENT_ADDRESS.toUpperCase()),
      REFERENCE,
    );
  });

  test("a different salt is a different debt", () => {
    // The control: without it the two tests above would pass for a function that returns a
    // constant.
    assert.notEqual(derivePaymentReference(REQUEST_ID, "0000000000000000", PAYMENT_ADDRESS), REFERENCE);
  });

  test("a 0x-prefixed requestId is refused, not silently stripped", () => {
    // The prefix is part of the hashed text, so stripping it would be a guess that yields a
    // plausible wrong answer.
    assert.throws(
      () => derivePaymentReference(`0x${REQUEST_ID}`, SALT, PAYMENT_ADDRESS),
      (e: RequestError) => e.code === "BAD_IDENTIFIER" && /drop the 0x/.test(e.message),
    );
  });
});

describe("fetchInvoice reads the invoice the gateway actually serves", () => {
  test("the real payload parses into whole facts", async () => {
    const { urls } = stubGateway(gatewayBody());
    const facts = await fetchInvoice(REQUEST_ID);

    assert.match(urls[0], /getTransactionsByChannelId\?channelId=0108b3f7/);
    assert.equal(facts.requestId, REQUEST_ID);
    assert.equal(facts.chainId, SEPOLIA_CHAIN_ID);
    assert.equal(facts.tokenAddress, FAU);
    assert.equal(facts.payee, PAYMENT_ADDRESS);
    assert.equal(facts.invoiceBaseUnits, ONE_FAU);
    assert.equal(facts.feeBaseUnits, "0");
    assert.equal(facts.feeRecipient, ZERO_ADDRESS);
    assert.equal(facts.salt, SALT);
    assert.deepEqual(facts.anchor, { blockNumber: 11665964, transactionHash: ANCHOR_TX });
  });

  test("the reference is derived from what was read, and matches the recorded one", async () => {
    stubGateway(gatewayBody());
    const facts = await fetchInvoice(REQUEST_ID);
    assert.equal(facts.paymentReference, REFERENCE);
  });

  test("the payee is the extension's paymentAddress, not parameters.payee", async () => {
    // They are usually equal, and are allowed to differ. The fee proxy pays the payment
    // address and the reference is derived from it, so reading the creditor field instead
    // produces a transfer the reconciler cannot match — and a reference for a different debt.
    const action = createAction();
    action.data.parameters.payee.value = STRANGER;
    stubGateway(gatewayBody(action));

    const facts = await fetchInvoice(REQUEST_ID);
    assert.equal(facts.payee, PAYMENT_ADDRESS);
    assert.equal(facts.payeeOfRecord, STRANGER);
    assert.equal(facts.paymentReference, REFERENCE, "the reference follows the payment address");
  });

  test("an unconfirmed create yields facts with no storage anchor, not a zero block", async () => {
    const body = gatewayBody();
    body.meta.storageMeta = [];
    stubGateway(body);

    const facts = await fetchInvoice(REQUEST_ID);
    assert.equal(facts.anchor, undefined);
    assert.equal(facts.paymentReference, REFERENCE);
  });

  test("a custom gateway URL without a trailing slash still forms one path", async () => {
    const { urls } = stubGateway(gatewayBody());
    await fetchInvoice(REQUEST_ID, { gatewayUrl: "https://gateway.example" });
    assert.match(urls[0], /^https:\/\/gateway\.example\/getTransactionsByChannelId\?/);
  });
});

describe("fetchInvoice refuses rather than returning half an invoice", () => {
  const refuses = async (body: unknown, code: string, status = 200) => {
    stubGateway(body, status);
    await assert.rejects(
      () => fetchInvoice(REQUEST_ID),
      (e: RequestError) => {
        assert.ok(e instanceof RequestError, `expected RequestError, got ${e?.constructor?.name}`);
        assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
        return true;
      },
    );
  };

  test("HTTP 500 is not an empty invoice", async () => {
    await refuses({ error: "boom" }, "GATEWAY_UNAVAILABLE", 500);
  });

  test("an empty channel is refused", async () => {
    await refuses({ meta: {}, result: { transactions: [] } }, "CHANNEL_EMPTY");
  });

  test("a channel with no create action is refused", async () => {
    const action = createAction();
    action.data.name = "accept";
    await refuses(gatewayBody(action), "NO_CREATE_ACTION");
  });

  test("transaction.data that is not JSON is refused", async () => {
    const body = gatewayBody();
    body.result.transactions[0].transaction.data = "{not json";
    await refuses(body, "MALFORMED_TRANSACTION");
  });

  test("a non-Sepolia currency network is refused", async () => {
    const action = createAction();
    action.data.parameters.currency.network = "mainnet";
    await refuses(gatewayBody(action), "WRONG_NETWORK");
  });

  test("a Sepolia currency paid on another network is still refused", async () => {
    // Both network fields are checked: agreeing with one of them is not agreeing.
    const action = createAction();
    action.data.parameters.extensionsData[0].parameters.paymentNetworkName = "matic";
    await refuses(gatewayBody(action), "WRONG_NETWORK");
  });

  test("a non-ERC20 invoice is refused", async () => {
    const action = createAction();
    action.data.parameters.currency.type = "ETH";
    await refuses(gatewayBody(action), "WRONG_NETWORK");
  });

  test("an invoice with no fee-proxy extension is refused", async () => {
    const action = createAction();
    action.data.parameters.extensionsData[0].id = "pn-erc20-proxy-contract";
    await refuses(gatewayBody(action), "NO_FEE_PROXY_EXTENSION");
  });

  test("a fee-proxy extension with no salt is refused", async () => {
    const action = createAction();
    action.data.parameters.extensionsData[0].parameters.salt = "";
    await refuses(gatewayBody(action), "BAD_IDENTIFIER");
  });

  test("an amount that is not a base-unit decimal is refused", async () => {
    const action = createAction();
    action.data.parameters.expectedAmount = "1.0";
    await refuses(gatewayBody(action), "MALFORMED_TRANSACTION");
  });

  test("a gateway that does not answer at all is refused", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ETIMEDOUT");
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => fetchInvoice(REQUEST_ID),
      (e: RequestError) => e.code === "GATEWAY_UNAVAILABLE" && /ETIMEDOUT/.test(e.message),
    );
  });
});

describe("assertReferenceMatches is the refusal the settle path uses", () => {
  test("a case variant of the same reference is the same debt", () => {
    assert.doesNotThrow(() => assertReferenceMatches(REFERENCE.toUpperCase(), REFERENCE));
  });

  test("a different reference is REFERENCE_MISMATCH, and names both values", () => {
    const supplied = "0xfaac1220a314c4a9"; // a real reference — for a different invoice
    assert.throws(
      () => assertReferenceMatches(supplied, REFERENCE),
      (e: RequestError) => {
        assert.equal(e.code, "REFERENCE_MISMATCH");
        assert.ok(e.message.includes(supplied) && e.message.includes(REFERENCE));
        return true;
      },
    );
  });
});

describe("toInvoiceFacts maps onto the shape the rest of the codebase passes around", () => {
  const facts: InvoiceFactsFromRequest = {
    requestId: REQUEST_ID,
    chainId: SEPOLIA_CHAIN_ID,
    tokenAddress: FAU,
    payee: PAYMENT_ADDRESS,
    payeeOfRecord: PAYMENT_ADDRESS,
    invoiceBaseUnits: ONE_FAU,
    feeBaseUnits: "0",
    feeRecipient: ZERO_ADDRESS,
    salt: SALT,
    paymentReference: REFERENCE,
  };

  test("the payee carried over is the payment address, and the ceiling is the human's", () => {
    const plain = toInvoiceFacts(facts, "2000000000000000000");
    assert.equal(plain.payee, PAYMENT_ADDRESS);
    assert.equal(plain.amountBaseUnits, ONE_FAU);
    assert.equal(plain.feeAddress, ZERO_ADDRESS);
    assert.equal(plain.paymentReference, REFERENCE);
    assert.equal(plain.maxTotalDebitBaseUnits, "2000000000000000000");
  });

  test("a ceiling that is not a base-unit decimal is refused", () => {
    // There is no safe default for a ceiling, so there is no safe coercion of one either.
    assert.throws(() => toInvoiceFacts(facts, "2.0"), (e: RequestError) => e.code === "MALFORMED_TRANSACTION");
  });
});
