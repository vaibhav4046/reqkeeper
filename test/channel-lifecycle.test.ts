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
import { PAYEE_KEY, PAYER_KEY, addressOf, signAction } from "./signing.ts";

const REQUEST_ID = "01ee24955c76fd84d9ed61ed4ce540b5b38a8726b59dbcdb0179a03145ee590e24";
const PAYEE = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
// The PARTIES, which are not the payment address. Request names a payee and a payer of record and
// signs actions with their keys; the fee proxy pays `paymentAddress`, which stays the real one
// above so every derived reference in these tests is unchanged. Keeping them separate is also the
// honest shape: Request allows an invoice to be paid to an address neither party signs with.
const PAYEE_OF_RECORD = addressOf(PAYEE_KEY);
const PAYER_OF_RECORD = addressOf(PAYER_KEY);
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
    payee: { type: "ethereumAddress", value: PAYEE_OF_RECORD },
    payer: { type: "ethereumAddress", value: PAYER_OF_RECORD },
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
function serve(actions: Action[], signWith?: Record<number, bigint>): string {
  // Signed ONCE per action. `signDigest` picks a random k, so signing the create twice -- once for
  // the served bytes, once for the id derived from them -- produces two different envelopes and an
  // id the served create does not hash to.
  const envelopes = actions.map((a, i) => (signWith?.[i] === undefined ? signedBy(a) : signAction(a, signWith[i] as bigint)));
  const transactions = envelopes.map((envelope) => ({
    transaction: { data: JSON.stringify(envelope) },
    // The anchor the reader looks for. Only the create's matters, but every action carries one.
    blockNumber: 11_690_000,
    timestamp: 1_700_000_000,
  }));
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ result: { transactions } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const createAt = actions.findIndex((a) => a.name === "create");
  return createAt >= 0 ? channelIdFor(envelopes[createAt]) : REQUEST_ID;
}


/**
 * The signature each action really carries, from the party Request allows to take it.
 *
 * Every action after the create is authenticated now: the signer is recovered and checked against
 * the payee and payer the create names. A fixture carrying `0x1111…` on a cancel would prove only
 * that garbage is rejected, so these are signed for real by an implementation written separately
 * from the one that checks them (`test/signing.ts`).
 *
 * The create is signed too. It used to keep a placeholder, on the argument that the channel id
 * binds its bytes and Request permits a delegate signer -- but Request's own CreateAction refuses
 * a create signed by neither party, and the id binding proves the bytes rather than the authorship.
 */
function signedBy(action: Action): unknown {
  switch (action.name) {
    case "create":
      return signAction(action, PAYEE_KEY);
    case "increaseExpectedAmount":
    case "accept":
      return signAction(action, PAYER_KEY);
    default:
      // cancel and reduceExpectedAmount: the payee may take both.
      return signAction(action, PAYEE_KEY);
  }
}

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

  test("a reduction below zero is dropped and the amount kept, as Request keeps it", async () => {
    // `utils/src/amount.ts#reduceAmount` throws on a negative result and
    // `computeRequestFromTransactions` ignores the action, carrying the previous amount forward.
    // This used to refuse the whole invoice as malformed.
    const invoice = await read(serve([CREATE, { name: "reduceExpectedAmount", parameters: { deltaAmount: "9000000000000000000" } }]));
    assert.equal(invoice.invoiceBaseUnits, ONE);
    assert.equal(invoice.amountChangedBy, undefined);
    assert.match(String(invoice.ignoredActions?.[0]?.reason), /below zero/, JSON.stringify(invoice.ignoredActions));
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

describe("an invoice with no fee is an invoice", () => {
  /**
   * `feeAddress` and `feeAmount` are optional on Request's fee-proxy extension. Its
   * `fee-reference-based.ts#createCreationAction` validates each only when present and enforces
   * exactly one rule about the pair -- neither, or both -- so an invoice raised through Request's
   * own app with no fee carries neither field. This reader called every one of them malformed.
   *
   * The gap survived because every invoice this deployment created states `"0"` and the zero
   * address explicitly: the fixtures and the product agreed with each other, and neither had ever
   * met an invoice made by anybody else.
   */
  function createWithFee(fee: Record<string, unknown>): Action {
    const params = JSON.parse(JSON.stringify(CREATE.parameters)) as Record<string, unknown>;
    const ext = (params.extensionsData as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const extParams = ext.parameters as Record<string, unknown>;
    delete extParams.feeAmount;
    delete extParams.feeAddress;
    Object.assign(extParams, fee);
    return { name: "create", parameters: params };
  }

  test("neither field stated means no fee, to nobody", async () => {
    const invoice = await read(serve([createWithFee({})]));
    assert.equal(invoice.feeBaseUnits, "0");
    assert.equal(invoice.feeRecipient, `0x${"0".repeat(40)}`);
    // And the reference still derives from the payment address, which is what the fee proxy pays.
    assert.equal(invoice.invoiceBaseUnits, ONE);
  });

  test("a fee stated with no recipient is refused, because Request refuses to create one", async () => {
    assert.equal(
      await refusalCode(() => read(serve([createWithFee({ feeAmount: "500" })]))),
      "MALFORMED_TRANSACTION",
    );
  });

  test("and a recipient with no amount is refused the same way", async () => {
    assert.equal(
      await refusalCode(() => read(serve([createWithFee({ feeAddress: `0x${"11".repeat(20)}` })]))),
      "MALFORMED_TRANSACTION",
    );
  });

  test("a stated fee is still read exactly as stated", async () => {
    // The control: the common path must not have been turned into a default.
    const invoice = await read(serve([createWithFee({ feeAmount: "500", feeAddress: `0x${"11".repeat(20)}` })]));
    assert.equal(invoice.feeBaseUnits, "500");
    assert.equal(invoice.feeRecipient.toLowerCase(), `0x${"11".repeat(20)}`);
  });
});

describe("an invoice older than this reader is still an invoice", () => {
  /**
   * `request-logic/src/action.ts#getActionHash`, in one line of its own: "Before the version
   * 2.0.0, the hash was computed without the signature". So a create stating 2.0.0 or older hashes
   * to an id derived from its `data` alone, and this reader -- which always hashed the whole
   * envelope -- answered REQUEST_ID_MISMATCH for every one of them. That refusal means "the
   * invoice has been substituted somewhere between Request and here", said about invoices whose
   * ids are perfectly correct and which are still on the network.
   *
   * The signature is authenticated separately on both paths, so matching Request's older shape
   * does not take a weaker check with it.
   */
  function idForOldShape(signedCreate: { data: unknown }): string {
    return channelIdFor(signedCreate.data);
  }

  function oldCreate(version: string): Action {
    const params = JSON.parse(JSON.stringify(CREATE.parameters)) as Record<string, unknown>;
    return { name: "create", parameters: params, version } as Action & { version: string };
  }

  function serveUnder(id: string, signedCreate: unknown): void {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          result: {
            transactions: [
              { transaction: { data: JSON.stringify(signedCreate) }, blockNumber: 11_690_000, timestamp: 1_700_000_000 },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    void id;
  }

  for (const version of ["2.0.0", "1.0.0"]) {
    test(`a create stating version ${version} is read under the id its data hashes to`, async () => {
      const signed = signAction(oldCreate(version), PAYEE_KEY);
      const id = idForOldShape(signed);
      serveUnder(id, signed);
      assert.equal((await read(id)).invoiceBaseUnits, ONE);
    });
  }

  test("and a current create still hashes over the whole signed envelope", async () => {
    // The control. Taking the old shape for everything would drop the signature out of the id
    // binding on every modern invoice.
    const signed = signAction(oldCreate("2.0.3"), PAYEE_KEY);
    serveUnder(channelIdFor(signed), signed);
    assert.equal((await read(channelIdFor(signed))).invoiceBaseUnits, ONE);

    // ... and the data-only id is NOT accepted for it.
    serveUnder(idForOldShape(signed), signed);
    assert.equal(await refusalCode(() => read(idForOldShape(signed))), "REQUEST_ID_MISMATCH");
  });
});


describe("the channel is read the way Request reads it", () => {
  /**
   * Each divergence here was found by building a channel shape the corpus does not contain: every
   * one of this deployment's 46 live invoices is a single payee-signed `ecdsa` create with an
   * explicit fee and a `paymentNetworkName`, made by one generator. Fidelity to Request was being
   * measured against Request-shaped data this repository had produced itself.
   */
  function serveRaw(transactions: Array<{ signed: unknown; state?: string; timestamp?: number }>, id: string): string {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          result: {
            transactions: transactions.map((t, i) => ({
              transaction: { data: JSON.stringify(t.signed) },
              state: t.state ?? "confirmed",
              blockNumber: 11_690_000,
              timestamp: t.timestamp ?? 1_700_000_000 + i,
            })),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    return id;
  }

  test("deltas apply one step at a time: create 100, reduce 150, increase 100 owes 200", async () => {
    // Summed and sign-checked once at the end this read 50 -- a fourfold underpayment on a channel
    // where every signature and every role was right. Request drops the reduce that would go
    // negative and applies the increase to the original figure.
    const hundred = { name: "create", parameters: { ...CREATE.parameters, expectedAmount: "100" } } as Action;
    const invoice = await read(
      serve([
        hundred,
        { name: "reduceExpectedAmount", parameters: { deltaAmount: "150" } },
        { name: "increaseExpectedAmount", parameters: { deltaAmount: "100" } },
      ]),
    );
    assert.equal(invoice.invoiceBaseUnits, "200");
    assert.equal(invoice.amountChangedBy?.actions, 1);
    assert.equal(invoice.ignoredActions?.length, 1);
  });

  test("a PENDING increase is not applied, and is named", async () => {
    // Not anchored on Sepolia, free to post, and kept out of Request's confirmed state. A reader
    // that applies it hands the approver a number the chain has never seen.
    const create = signedBy(CREATE);
    const pending = signAction({ name: "increaseExpectedAmount", parameters: { deltaAmount: "9000" } }, PAYER_KEY);
    const id = serveRaw([{ signed: create }, { signed: pending, state: "pending" }], channelIdFor(create));
    const invoice = await read(id);
    assert.equal(invoice.invoiceBaseUnits, ONE);
    assert.match(String(invoice.ignoredActions?.[0]?.reason), /pending, not confirmed/, JSON.stringify(invoice.ignoredActions));
  });

  test("a PENDING cancel does not cancel", async () => {
    const create = signedBy(CREATE);
    const cancel = signAction({ name: "cancel", parameters: {} }, PAYEE_KEY);
    const id = serveRaw([{ signed: create }, { signed: cancel, state: "pending" }], channelIdFor(create));
    assert.equal((await read(id)).invoiceBaseUnits, ONE);
  });

  test("actions apply in timestamp order, not array order", async () => {
    // The same three actions as the 200 case, served with the increase FIRST in the array but
    // later by timestamp. Request sorts on timestamp; with per-step arithmetic the order changes
    // the answer, so array order gave 200 - 150 = 50 here.
    const hundred = signAction({ name: "create", parameters: { ...CREATE.parameters, expectedAmount: "100" } }, PAYEE_KEY);
    const reduce = signAction({ name: "reduceExpectedAmount", parameters: { deltaAmount: "150" } }, PAYEE_KEY);
    const increase = signAction({ name: "increaseExpectedAmount", parameters: { deltaAmount: "100" } }, PAYER_KEY);
    const id = serveRaw(
      [
        { signed: hundred, timestamp: 1 },
        { signed: increase, timestamp: 3 },
        { signed: reduce, timestamp: 2 },
      ],
      channelIdFor(hundred),
    );
    assert.equal((await read(id)).invoiceBaseUnits, "200");
  });

  test("a stranger's create served ahead of the genuine one does not wedge the invoice", async () => {
    // The create is the one that hashes to the channel id, wherever it sits in the array.
    const genuine = signedBy(CREATE);
    const strangers = signAction({ name: "create", parameters: { ...CREATE.parameters, expectedAmount: "5" } }, PAYEE_KEY);
    const id = serveRaw([{ signed: strangers }, { signed: genuine }], channelIdFor(genuine));
    assert.equal((await read(id)).invoiceBaseUnits, ONE);
  });

  test("a payer cannot cancel a request the payer created, because it starts ACCEPTED", async () => {
    // `create.ts`: a payer-created request starts in state ACCEPTED; `cancel.ts`: "A payer cancel
    // need to be done on a request with the state created". Request ignores it; so does this.
    const id = serve([CREATE, { name: "cancel", parameters: {} }], { 0: PAYER_KEY, 1: PAYER_KEY });
    const invoice = await read(id);
    assert.equal(invoice.invoiceBaseUnits, ONE, "a payer cancel from ACCEPTED cancelled the invoice");
    assert.match(String(invoice.ignoredActions?.[0]?.reason), /ACCEPTED/, JSON.stringify(invoice.ignoredActions));
  });

  test("but the payee may cancel from any state, and a payer may cancel from CREATED", async () => {
    // Payer-created (ACCEPTED), payee cancels: honoured.
    assert.equal(await refusalCode(() => read(serve([CREATE, { name: "cancel" }], { 0: PAYER_KEY, 1: PAYEE_KEY }))), "INVOICE_CANCELLED");
    // Payee-created (CREATED), payer cancels: honoured.
    assert.equal(await refusalCode(() => read(serve([CREATE, { name: "cancel" }], { 0: PAYEE_KEY, 1: PAYER_KEY }))), "INVOICE_CANCELLED");
  });

  test("an accept by the payee is ignored; by the payer from CREATED it is applied", async () => {
    const byPayee = await read(serve([CREATE, { name: "accept", parameters: {} }], { 0: PAYEE_KEY, 1: PAYEE_KEY }));
    assert.match(String(byPayee.ignoredActions?.[0]?.reason), /only allows payer to take it/, JSON.stringify(byPayee.ignoredActions));
    const byPayer = await read(serve([CREATE, { name: "accept", parameters: {} }], { 0: PAYEE_KEY, 1: PAYER_KEY }));
    assert.equal(byPayer.ignoredActions, undefined, JSON.stringify(byPayer.ignoredActions));
  });

  test("an addFee on a later action stops the settlement rather than stiffing the fee recipient", async () => {
    // `requestLogicCore` reduces `extensionsData` for EVERY action, so a payee-signed `addFee`
    // changes the fee the invoice declares. This reader applies the create's entry only; it used
    // to drop the later one silently and pay a fee of 0 to nobody.
    const id = serve(
      [
        CREATE,
        {
          name: "reduceExpectedAmount",
          parameters: {
            deltaAmount: "0",
            extensionsData: [
              { id: "pn-erc20-fee-proxy-contract", action: "addFee", parameters: { feeAddress: `0x${"fe".repeat(20)}`, feeAmount: "50" } },
            ],
          },
        },
      ],
      { 1: PAYEE_KEY },
    );
    assert.equal(await refusalCode(() => read(id)), "EXTENSION_ACTION_UNSUPPORTED");
  });

  test("a create without the optional paymentNetworkName is an invoice", async () => {
    const params = JSON.parse(JSON.stringify(CREATE.parameters)) as Record<string, unknown>;
    const ext = (params.extensionsData as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    delete (ext.parameters as Record<string, unknown>).paymentNetworkName;
    const invoice = await read(serve([{ name: "create", parameters: params }]));
    assert.equal(invoice.invoiceBaseUnits, ONE);
  });
});
