/**
 * The Request channel is an append-only log, and reading only its first action reads a different
 * invoice from the one that exists now.
 *
 * A request can be cancelled after it is raised, and its expected amount increased or reduced.
 * Paying a cancelled debt or paying the pre-reduction amount are both unrecoverable: the money has
 * moved. The reader handles all three — and had no test at all, across the whole suite, because
 * every one of the 46 recorded live invoices carries nothing but a `create`. A reviewer replaying
 * real channel JSON with actions appended was the first thing ever to exercise it, and it broke on
 * the first try: a `cancel` that appeared BEFORE the create in array order was silently dropped
 * and the invoice came back payable.
 *
 * That was the same assumption twice. The code refuses to assume the create comes first, then
 * assumed everything before it was irrelevant. There is no un-cancelling, so position cannot
 * matter.
 *
 * These drive the real `fetchInvoice` against a stubbed gateway, because the channel reading is
 * what is under test and the transport is not.
 */

import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";

import { keccak256Hex } from "../src/keccak.ts";
import { RequestError, fetchInvoice } from "../src/request.ts";

const REQUEST_ID = "01ee24955c76fd84d9ed61ed4ce540b5b38a8726b59dbcdb0179a03145ee590e24";
const PAYEE = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const ONE = "1000000000000000000";

interface Action {
  readonly name: string;
  readonly parameters?: Record<string, unknown>;
}

const CREATE: Action = {
  name: "create",
  parameters: {
    currency: { type: "ERC20", value: FAU, network: "sepolia" },
    expectedAmount: ONE,
    payee: { type: "ethereumAddress", value: PAYEE },
    // Copied from the live gateway's own response for this request id, field for field: a stub
    // that does not match the real shape tests the stub.
    extensionsData: [
      {
        id: "pn-erc20-fee-proxy-contract",
        action: "create",
        version: "0.2.0",
        parameters: {
          paymentAddress: PAYEE,
          salt: "094a62d8a5188270",
          feeAmount: "0",
          feeAddress: "0x0000000000000000000000000000000000000000",
          paymentNetworkName: "sepolia",
        },
      },
    ],
  },
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Serve a channel whose actions are exactly these, in exactly this order, under the channel id
 * its own create hashes to.
 *
 * The id is not free: Request derives it as `01` + keccak256 of the signed create, normalised, and
 * `fetchInvoice` re-derives and refuses a mismatch. So a stub cannot hand back arbitrary bytes
 * under a borrowed id — which is the property under test in `a forged create is refused` below,
 * and the reason every other case here has to build a self-consistent channel.
 */
function serve(actions: Action[]): string {
  const transactions = actions.map((a) => ({
    transaction: { data: JSON.stringify({ data: a, signature: SIGNATURE }) },
    // The anchor the reader looks for. Only the create's matters, but every action carries one.
    blockNumber: 11_690_000,
    timestamp: 1_700_000_000,
  }));
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ result: { transactions } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const create = actions.find((a) => a.name === "create");
  return create ? channelIdFor({ data: create, signature: SIGNATURE }) : REQUEST_ID;
}

const SIGNATURE = { method: "ecdsa", value: `0x${"ab".repeat(65)}` };

/** Request's normalisation before hashing: keys deep-sorted, then the whole string lowercased. */
function channelIdFor(signedCreate: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
  return `01${keccak256Hex(JSON.stringify(sort(signedCreate)).toLowerCase()).replace(/^0x/, "")}`;
}

const read = (id: string) => fetchInvoice(id, { gatewayUrl: "https://stub.invalid/" });

async function refusalCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof RequestError) return e.code;
    return `threw ${String(e).slice(0, 60)}`;
  }
  return "DID NOT REFUSE";
}

describe("the whole channel decides what is owed", () => {
  test("a plain create is payable at its stated amount", async () => {
    // The control: everything below must refuse for its own reason, not because the reader cannot
    // read a channel at all.
    const id = serve([CREATE]);
    const invoice = await read(id);
    assert.equal(invoice.invoiceBaseUnits, ONE);
    assert.equal(invoice.payee.toLowerCase(), PAYEE.toLowerCase());
  });

  test("a cancel AFTER the create refuses", async () => {
    const id = serve([CREATE, { name: "cancel" }]);
    assert.equal(await refusalCode(() => read(id)), "INVOICE_CANCELLED");
  });

  test("a cancel BEFORE the create in array order still refuses", async () => {
    // The reviewer's case. Dropping it returned a payable invoice for a debt that had been
    // cancelled — a payment nobody could take back.
    const id = serve([{ name: "cancel" }, CREATE]);
    assert.equal(await refusalCode(() => read(id)), "INVOICE_CANCELLED");
  });

  test("an increase raises the amount by its delta, not to it", async () => {
    // Request states deltas, not new totals. Reading the delta as a total would underpay by the
    // original amount, which is just as wrong and much quieter.
    const id = serve([CREATE, { name: "increaseExpectedAmount", parameters: { deltaAmount: "500000000000000000" } }]);
    assert.equal((await read(id)).invoiceBaseUnits, "1500000000000000000");
  });

  test("a reduction lowers it, and the debt settles at the reduced figure", async () => {
    const id = serve([CREATE, { name: "reduceExpectedAmount", parameters: { deltaAmount: "250000000000000000" } }]);
    assert.equal((await read(id)).invoiceBaseUnits, "750000000000000000");
  });

  test("increases and reductions apply in channel order", async () => {
    const id = serve([
      CREATE,
      { name: "increaseExpectedAmount", parameters: { deltaAmount: ONE } },
      { name: "reduceExpectedAmount", parameters: { deltaAmount: "500000000000000000" } },
    ]);
    assert.equal((await read(id)).invoiceBaseUnits, "1500000000000000000");
  });

  test("a changed amount is reported, so the sentence a human approves can name it", async () => {
    // Nothing here authenticates a channel action. Every one carries an ECDSA signature and this
    // reader recovers no signer, so a reviewer raised an amount with sixty-five bytes of 0xab and
    // watched it apply. The human and the policy ceiling are what bound it — so the human is told,
    // rather than shown a figure indistinguishable from the one the creditor first asked for.
    const id = serve([CREATE, { name: "increaseExpectedAmount", parameters: { deltaAmount: ONE } }]);
    const invoice = await read(id);
    assert.deepEqual(invoice.amountChangedBy, { actions: 1, fromBaseUnits: ONE });
  });

  test("an unchanged invoice says nothing about changes", async () => {
    // The control: a note on every invoice is a note nobody reads.
    const id = serve([CREATE]);
    assert.equal((await read(id)).amountChangedBy, undefined);
  });

  test("a reduction below zero refuses rather than guessing", async () => {
    const id = serve([CREATE, { name: "reduceExpectedAmount", parameters: { deltaAmount: "9000000000000000000" } }]);
    assert.equal(await refusalCode(() => read(id)), "MALFORMED_TRANSACTION");
  });

  test("a delta placed before the create refuses", async () => {
    // There is nothing to adjust yet. Applying it would take the create's amount as a base the
    // channel never had.
    const id = serve([{ name: "increaseExpectedAmount", parameters: { deltaAmount: ONE } }, CREATE]);
    assert.equal(await refusalCode(() => read(id)), "MALFORMED_TRANSACTION");
  });

  test("an action name this reader does not understand refuses", async () => {
    // Skipping it asserts that it leaves the debt unchanged — a claim about Request's whole action
    // set that this file is in no position to make.
    const id = serve([CREATE, { name: "someFutureAmountAction", parameters: { deltaAmount: ONE } }]);
    assert.equal(await refusalCode(() => read(id)), "MALFORMED_TRANSACTION");
  });

  test("a forged create served under a genuine request id is refused", async () => {
    // The attack a reviewer demonstrated: nothing here recovers an ECDSA signer, so a gateway —
    // or anything that can set REQUEST_GATEWAY_URL — could serve a create naming an attacker's
    // payment address and any amount, under a request id that really exists. The reference then
    // derived self-consistently from the forgery and every downstream guard protected the wrong
    // debt.
    //
    // The request id is a hash of the signed create, so the bytes cannot be swapped under it.
    const genuine = serve([CREATE]);

    const forged: Action = {
      name: "create",
      parameters: {
        ...(CREATE.parameters as Record<string, unknown>),
        expectedAmount: "99000000000000000000",
        extensionsData: [
          {
            id: "pn-erc20-fee-proxy-contract",
            action: "create",
            version: "0.2.0",
            parameters: {
              paymentAddress: "0x000000000000000000000000000000000000dEaD",
              salt: "094a62d8a5188270",
              feeAmount: "0",
              feeAddress: "0x0000000000000000000000000000000000000000",
              paymentNetworkName: "sepolia",
            },
          },
        ],
      },
    };
    serve([forged]); // served under the GENUINE id below, not its own

    assert.equal(await refusalCode(() => read(genuine)), "REQUEST_ID_MISMATCH");
  });

  test("an accept does not change the amount", async () => {
    // The control on the other side: refusing every unfamiliar name would refuse ordinary
    // invoices, so the names that genuinely leave the debt alone must pass.
    const id = serve([CREATE, { name: "accept" }]);
    assert.equal((await read(id)).invoiceBaseUnits, ONE);
  });
});
