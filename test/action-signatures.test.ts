/**
 * A channel action is only worth as much as the signature under it.
 *
 * `assertChannelIdBindsCreate` proved the CREATE: the bytes hash to the id that was asked for, so
 * a forged invoice cannot be served under a genuine request id. Everything after the create had
 * no such binding. A gateway — the real one compromised, one reached through `REQUEST_GATEWAY_URL`,
 * or anything between — could append an action to a real channel and this reader would apply it:
 *
 *   - an `increaseExpectedAmount` raises what is about to be paid, out of the payer's funds
 *   - a `cancel` makes a real debt permanently unpayable, which is the mirror and just as final
 *
 * Both are now refused unless the signature recovers to the party Request allows to take that
 * action. The asymmetry is the point: only the party who OWES more can agree to owe more, so an
 * increase signed by the party being PAID is refused even though that party is real, named on the
 * invoice, and signed it perfectly.
 *
 * The signatures here are real, produced by `test/signing.ts` — a second implementation of the
 * curve, written separately from the one under test, so a bug in either cannot cancel itself out.
 * The scheme itself is pinned against the live gateway by `scripts/verify-signatures.ts`
 * (46 of 46 actions recover to the party the invoice names) and by the recorded vector below.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { keccak256Hex } from "../src/keccak.ts";
import { RequestError, fetchInvoice } from "../src/request.ts";
import { recoverAddress } from "../src/secp256k1.ts";
import { PAYEE_KEY, PAYER_KEY, STRANGER_KEY, actionDigest, addressOf, signAction } from "./signing.ts";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PAYMENT_ADDRESS = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const ONE = "1000000000000000000";
const PAYEE_OF_RECORD = addressOf(PAYEE_KEY);
const PAYER_OF_RECORD = addressOf(PAYER_KEY);

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
    extensionsData: [
      {
        id: "pn-erc20-fee-proxy-contract",
        action: "create",
        version: "0.2.0",
        parameters: {
          paymentAddress: PAYMENT_ADDRESS,
          salt: "094a62d8a5188270",
          feeAmount: "0",
          feeAddress: "0x0000000000000000000000000000000000000000",
          paymentNetworkName: "sepolia",
        },
      },
    ],
  },
};

const CREATE_SIGNATURE = { method: "ecdsa", value: `0x${"ab".repeat(65)}` };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function channelIdFor(signedCreate: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
  return `01${keccak256Hex(JSON.stringify(sort(signedCreate)).toLowerCase()).replace(/^0x/, "")}`;
}

/** A channel whose create is genuine and whose later actions are exactly these signed envelopes. */
function serve(later: ReadonlyArray<unknown>): string {
  const signedCreate = { data: CREATE, signature: CREATE_SIGNATURE };
  const transactions = [signedCreate, ...later].map((signed) => ({
    transaction: { data: JSON.stringify(signed) },
    blockNumber: 11_690_000,
    timestamp: 1_700_000_000,
  }));
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ result: { transactions } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  return channelIdFor(signedCreate);
}

const increase = (delta: string): Action => ({ name: "increaseExpectedAmount", parameters: { deltaAmount: delta } });
const reduce = (delta: string): Action => ({ name: "reduceExpectedAmount", parameters: { deltaAmount: delta } });
const cancel: Action = { name: "cancel", parameters: {} };

async function read(id: string) {
  return fetchInvoice(id, { gatewayUrl: "https://stub.invalid" });
}

async function messageFrom(id: string): Promise<string> {
  try {
    await read(id);
    return "NO_REFUSAL";
  } catch (e) {
    return (e as Error).message;
  }
}

async function refusalFrom(id: string): Promise<string> {
  try {
    await read(id);
    return "NO_REFUSAL";
  } catch (e) {
    return e instanceof RequestError ? e.code : `THREW:${(e as Error).message}`;
  }
}

describe("an action only counts if the right party signed it", () => {
  test("an increase signed by the PAYER raises the debt, because that is who owes it", async () => {
    // The control, and it has to come first: without it every test below passes for a reader
    // that refuses everything.
    const id = serve([signAction(increase("500"), PAYER_KEY)]);
    const invoice = await read(id);
    assert.equal(invoice.invoiceBaseUnits, (BigInt(ONE) + 500n).toString());
    assert.equal(invoice.amountChangedBy?.actions, 1);
  });

  test("the same increase signed by the PAYEE is refused", async () => {
    // The forgery that costs money, and the one a signature check alone would not catch: the
    // payee is real, is named on this invoice, and signed this action perfectly. Request does not
    // let the party being paid raise what it is owed, and neither does this.
    const id = serve([signAction(increase("500"), PAYEE_KEY)]);
    assert.equal(await refusalFrom(id), "ACTION_ROLE_VIOLATION");
  });

  test("a reduction signed by the PAYEE lowers the debt", async () => {
    const id = serve([signAction(reduce("400"), PAYEE_KEY)]);
    const invoice = await read(id);
    assert.equal(invoice.invoiceBaseUnits, (BigInt(ONE) - 400n).toString());
  });

  test("a reduction signed by the PAYER is refused, even though it would pay LESS", async () => {
    // Refused in the direction that costs nothing, deliberately. An invoice whose history cannot
    // be authenticated is not one whose amount can be trusted in either direction, and a reader
    // that only checks the actions it dislikes is a reader an attacker gets to choose for.
    const id = serve([signAction(reduce("400"), PAYER_KEY)]);
    assert.equal(await refusalFrom(id), "ACTION_ROLE_VIOLATION");
  });

  test("an action signed by a stranger is refused whoever it claims to be", async () => {
    const id = serve([signAction(cancel, STRANGER_KEY)]);
    assert.equal(await refusalFrom(id), "ACTION_SIGNATURE_INVALID");
  });

  test("a stranger cannot cancel a real invoice, so a real debt cannot be wedged", async () => {
    // The availability half. A forged cancel makes a genuine debt permanently unpayable and
    // nothing downstream would question it: cancellation is supposed to be final.
    const forged = serve([signAction(cancel, STRANGER_KEY)]);
    assert.equal(await refusalFrom(forged), "ACTION_SIGNATURE_INVALID");

    // And a real one still cancels. The check must not have turned cancellation off.
    const genuine = serve([signAction(cancel, PAYEE_KEY)]);
    assert.equal(await refusalFrom(genuine), "INVOICE_CANCELLED");
  });

  test("an action whose bytes changed after signing is refused", async () => {
    // The signature is genuine and the party is genuine; only the amount moved. This is what a
    // man-in-the-middle on the gateway actually does -- it does not forge a key, it edits a
    // number -- and it is the case a reader that merely CHECKS FOR a signature would pass.
    const signed = signAction(increase("500"), PAYER_KEY) as { data: Action; signature: unknown };
    const tampered = { data: increase("5000000000000000000"), signature: signed.signature };
    const id = serve([tampered]);
    assert.equal(await refusalFrom(id), "ACTION_SIGNATURE_INVALID");
  });

  test("a signature method this reader cannot check is refused, not skipped", async () => {
    // `ecdsa-typed-data` is a real Request method and this reader does not implement it. Reading
    // the action anyway would mean acting on bytes nothing authenticated, which is the state this
    // whole file exists to leave behind.
    const id = serve([{ data: increase("500"), signature: { method: "ecdsa-typed-data", value: "0x00" } }]);
    assert.equal(await refusalFrom(id), "ACTION_UNSIGNED");
  });

  test("garbage where a signature should be is refused, and says which failure it was", async () => {
    const id = serve([{ data: increase("500"), signature: { method: "ecdsa", value: `0x${"11".repeat(65)}` } }]);
    assert.equal(await refusalFrom(id), "ACTION_SIGNATURE_INVALID");
    // Not just the code. "Recovers to no address" and "recovers to somebody who is not a party"
    // are different failures with different next steps -- one is corrupt bytes, the other is an
    // impostor -- and a refusal that reports the second for the first sends the reader looking
    // for an attacker who does not exist.
    const message = await messageFrom(id);
    assert.match(message, /recovers to no address/, message);
    assert.doesNotMatch(message, /signed by null/, message);
  });

  test("an action carrying no signature at all is refused", async () => {
    const id = serve([{ data: increase("500") }]);
    assert.equal(await refusalFrom(id), "ACTION_UNSIGNED");
  });
});

describe("the recovery itself, against something this project did not produce", () => {
  test("a real Request signature recovers to the payee that invoice names", () => {
    // Recorded from Request's public gateway on 2026-09-13, channel
    // 01b7cd715cfe60ac07f637ed0eb62bf5d1c00c56e3599b8ce6b0a962e8b7f49914. This is the vector that
    // says the SCHEME is right, not just self-consistent: the digest is keccak256 over the
    // action's data with keys deep-sorted and the whole JSON lowercased, and nothing in this
    // repository chose that -- it was recovered by trying candidates until one produced the
    // address the invoice itself names. `scripts/verify-signatures.ts` does this over all 46.
    const data = {
      name: "create",
      parameters: {
        currency: { type: "ERC20", value: "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C", network: "sepolia" },
        expectedAmount: "1000000000000000000",
        payee: { type: "ethereumAddress", value: "0xc43d766CB7c48B9B198db87441b97c09e81717A1" },
        payer: { type: "ethereumAddress", value: "0x027D54A692e0e80173141777BdB847c1726FA1F3" },
        timestamp: 1789244893,
        extensionsData: [
          {
            action: "create",
            id: "pn-erc20-fee-proxy-contract",
            parameters: {
              feeAddress: "0x0000000000000000000000000000000000000000",
              feeAmount: "0",
              paymentAddress: "0xc43d766CB7c48B9B198db87441b97c09e81717A1",
              paymentNetworkName: "sepolia",
              salt: "3f6069b15b3813e2",
            },
            version: "0.2.0",
          },
        ],
      },
      version: "2.0.3",
    };
    const signature =
      "0xc204799b7304d56000145c2762ef7148c5f1f99d3e0a7399c9f60e0d72a7c33c" +
      "3e5e253445f666be8be2fd4a9277a4b37fb3e0bb56be91e2abc8aa7be241f5b71c";

    assert.equal(
      recoverAddress(actionDigest(data), signature),
      "0xc43d766cb7c48b9b198db87441b97c09e81717a1",
      "the recorded Request signature no longer recovers to the payee, so the scheme this reader implements is wrong",
    );
  });

  test("one bit of that signature moved recovers to somebody else, or to nobody", () => {
    // The negative control. Recovery almost always SUCCEEDS on a corrupted signature -- it just
    // yields a different address -- so "it recovered" is never the assertion. Which address is.
    const data = { name: "cancel", parameters: {} };
    const genuine = signAction(data, PAYEE_KEY).signature.value;
    const flipped = `${genuine.slice(0, -3)}${genuine[genuine.length - 3] === "0" ? "1" : "0"}${genuine.slice(-2)}`;
    assert.notEqual(recoverAddress(actionDigest(data), flipped), PAYEE_OF_RECORD);
  });

  test("a signature over a DIFFERENT action never recovers to the signer", () => {
    const value = signAction({ name: "cancel", parameters: {} }, PAYEE_KEY).signature.value;
    assert.notEqual(recoverAddress(actionDigest({ name: "accept", parameters: {} }), value), PAYEE_OF_RECORD);
  });

  test("malformed input is null, not a thrown error and never an address", () => {
    const digest = actionDigest({ name: "cancel" });
    assert.equal(recoverAddress(digest, "0x"), null);
    assert.equal(recoverAddress(digest, "not hex"), null);
    assert.equal(recoverAddress(digest, `0x${"00".repeat(65)}`), null);
    assert.equal(recoverAddress(new Uint8Array(31), `0x${"ab".repeat(65)}`), null);
  });
});

describe("a signature authorises one action, on one invoice", () => {
  test("the same signed increase served five times raises the debt once, or not at all", async () => {
    // Measured by a reviewer against the real reader: one authorised increase of 500 became
    // 2,500. Every copy is genuinely signed by the payer and every copy is genuinely an increase;
    // what nobody checked was how many times one authorisation may be spent.
    const signed = signAction(increase("500"), PAYER_KEY);
    const id = serve([signed, signed, signed, signed, signed]);
    assert.equal(await refusalFrom(id), "ACTION_REPLAYED");
  });

  test("two DIFFERENT increases, each signed once, both apply", async () => {
    // The control. A payer who really agreed twice has agreed twice, and refusing that would make
    // every amended invoice unpayable.
    const id = serve([signAction(increase("500"), PAYER_KEY), signAction(increase("300"), PAYER_KEY)]);
    const invoice = await read(id);
    assert.equal(invoice.invoiceBaseUnits, (BigInt(ONE) + 800n).toString());
    assert.equal(invoice.amountChangedBy?.actions, 2);
  });

  test("an increase signed for ANOTHER invoice cannot be lifted onto this one", async () => {
    // A real signature, a real party, the wrong debt. Request's actions name the request they act
    // on; nothing compared that to the channel being read, so a payer's genuine increase on their
    // own invoice was portable onto somebody else's.
    const foreign = signAction(
      { name: "increaseExpectedAmount", parameters: { deltaAmount: "500", requestId: `01${"ff".repeat(32)}` } },
      PAYER_KEY,
    );
    const id = serve([foreign]);
    assert.equal(await refusalFrom(id), "ACTION_FOREIGN");
  });

  test("and one that names this invoice is fine", async () => {
    const id = serve([]);
    const mine = signAction(
      { name: "increaseExpectedAmount", parameters: { deltaAmount: "500", requestId: id } },
      PAYER_KEY,
    );
    const sameChannel = serve([mine]);
    // `serve` rebuilds the channel from the same create, so the id is stable and `mine` names it.
    assert.equal(sameChannel, id);
    const invoice = await read(sameChannel);
    assert.equal(invoice.invoiceBaseUnits, (BigInt(ONE) + 500n).toString());
  });
});

describe("one authorisation has one meaning, however it is spelled", () => {
  /**
   * The replay guard keyed on the signature STRING, and one authorised signature has at least
   * four accepted spellings: with or without the `0x` prefix, and with `s` or `N - s`, because
   * ECDSA is malleable and the recovery accepts both. So a gateway holding one payer-signed
   * increase of 500 could serve it four times and apply 2,000 -- defeating, by dropping two
   * characters, the guard added because a reviewer measured exactly that inflation.
   *
   * What a signature authorises is one action by one party. The key is the digest and the signer.
   */
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

  /** The same authorisation, re-spelled: `s` flipped to `N - s`, recovery parity flipped with it. */
  function malleate(signature: string): string {
    const raw = signature.replace(/^0x/, "");
    const r = raw.slice(0, 64);
    const s = BigInt(`0x${raw.slice(64, 128)}`);
    const v = Number.parseInt(raw.slice(128, 130), 16);
    const flipped = (N - s).toString(16).padStart(64, "0");
    const parity = (v === 27 ? 28 : 27).toString(16).padStart(2, "0");
    return `0x${r}${flipped}${parity}`;
  }

  test("the same increase, re-signed as N - s, is still one authorisation", async () => {
    const action = increase("500");
    const original = signAction(action, PAYER_KEY);
    const respelled = { data: action, signature: { method: "ecdsa", value: malleate(original.signature.value) } };
    // The premise: both spellings must actually be accepted signatures, or this proves nothing.
    assert.notEqual(original.signature.value, respelled.signature.value);
    assert.equal(
      recoverAddress(actionDigest(action), respelled.signature.value),
      addressOf(PAYER_KEY),
      "the malleated signature must still recover to the payer, or the test is about a broken signature",
    );

    assert.equal(await refusalFrom(serve([original, respelled])), "ACTION_REPLAYED");
  });

  test("and the same increase with the 0x dropped is still one authorisation", async () => {
    const action = increase("500");
    const original = signAction(action, PAYER_KEY);
    const bare = { data: action, signature: { method: "ecdsa", value: original.signature.value.replace(/^0x/, "") } };
    assert.equal(await refusalFrom(serve([original, bare])), "ACTION_REPLAYED");
  });

  test("all four spellings of one signature apply one delta, or none", async () => {
    const action = increase("500");
    const original = signAction(action, PAYER_KEY);
    const flipped = malleate(original.signature.value);
    const spellings = [
      original.signature.value,
      flipped,
      original.signature.value.replace(/^0x/, ""),
      flipped.replace(/^0x/, ""),
    ].map((value) => ({ data: action, signature: { method: "ecdsa", value } }));
    assert.equal(await refusalFrom(serve(spellings)), "ACTION_REPLAYED");
  });

  test("but two genuinely different authorisations still both apply", async () => {
    // The control. A payer who really agreed twice has agreed twice, and refusing that would make
    // every amended invoice unpayable.
    const id = serve([signAction(increase("500"), PAYER_KEY), signAction(increase("300"), PAYER_KEY)]);
    const invoice = await read(id);
    assert.equal(invoice.invoiceBaseUnits, (BigInt(ONE) + 800n).toString());
  });
});
