/**
 * An anchor block a gateway can choose is a second payment.
 *
 * The anchor is the floor of every payment scan for an invoice, and it is the only thing that
 * makes a negative conclusive: without one `findPaymentByReference` reports `truncated`, and the
 * already-paid gate refuses to propose. With one, a scan that found nothing means the invoice is
 * unpaid.
 *
 * So move the anchor forward, past a payment that really happened, and the scan truthfully reports
 * no payment over a window that never contained it. `hasBeenPaid: false`, `SOURCE_ALREADY_PAID`
 * never fires, and the invoice is proposed, approved and paid a second time. A reviewer
 * demonstrated it end to end against the real modules: honest anchor → PAID, no anchor → UNKNOWN,
 * moved anchor → **NOT_PAID**.
 *
 * The anchor arrives in `meta`, which the channel id does not hash. The first repair compared the
 * anchor's block against the receipt of the transaction it named — which proves a transaction with
 * that hash sits in that block, and any real recent Sepolia transaction satisfies that.
 *
 * What binds it is the CID. The anchoring transaction is the one that wrote this channel's bytes
 * into Request's storage contract, and that contract's event carries the IPFS CID of the bytes it
 * stored. A CID is a content hash: it cannot name this invoice's create unless it is this
 * invoice's create. The live shape is verified in `scripts/verify-signatures.ts`, which binds all
 * 46 of this deployment's invoices against the public gateway and public RPCs.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { keccak256Hex } from "../src/keccak.ts";
import { RequestError, fetchInvoice } from "../src/request.ts";
import { PAYER_KEY, addressOf, signAction } from "./signing.ts";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PAYEE = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const REQUEST_STORAGE = "0xd6c085a4d14e9e171f4af58f7f48bd81173f167e";
const ANCHOR_BLOCK = 11_665_964;
const ANCHOR_TX = `0x${"3f".repeat(32)}`;
const CID = "QmWyvcPd68b3M65KkA5xuye2WgoyQtUQCubbPFohNHWLJn";

const CREATE = {
  name: "create",
  version: "2.0.3",
  parameters: {
    currency: { type: "ERC20", value: FAU, network: "sepolia" },
    expectedAmount: "1000000000000000000",
    payee: { type: "ethereumAddress", value: PAYEE },
    payer: { type: "ethereumAddress", value: addressOf(PAYER_KEY) },
    timestamp: 1788932300,
    extensionsData: [
      {
        action: "create",
        id: "pn-erc20-fee-proxy-contract",
        version: "0.2.0",
        parameters: {
          feeAddress: `0x${"0".repeat(40)}`,
          feeAmount: "0",
          paymentAddress: PAYEE,
          paymentNetworkName: "sepolia",
          salt: "8682e8e726d1b4f1",
        },
      },
    ],
  },
};
/** Signed by the payer of record: the create is authenticated like every other action now. */
const SIGNED_CREATE = signAction(CREATE, PAYER_KEY);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const hexOf = (text: string) => `0x${Buffer.from(text, "utf8").toString("hex")}`;

function channelIdFor(signed: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
  return `01${keccak256Hex(JSON.stringify(sort(signed)).toLowerCase()).replace(/^0x/, "")}`;
}

/** A gateway serving this create, anchored where `claimedBlock` says, storing `cid`. */
function serve(claimedBlock: number, cid: string): string {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        meta: {
          transactionsStorageLocation: [cid],
          storageMeta: [
            {
              ethereum: {
                blockNumber: claimedBlock,
                networkName: "sepolia",
                smartContractAddress: REQUEST_STORAGE,
                transactionHash: ANCHOR_TX,
              },
              state: "confirmed",
              storageType: "ethereumIpfs",
            },
          ],
        },
        result: { transactions: [{ state: "confirmed", transaction: { data: JSON.stringify(SIGNED_CREATE) } }] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  return channelIdFor(SIGNED_CREATE);
}

/** The real anchoring transaction: Request's storage contract, this block, these bytes. */
const honestReceipt = async () => ({
  blockNumber: ANCHOR_BLOCK, blockTimestamp: 1788932300 + 60,
  logs: [{ address: REQUEST_STORAGE, data: hexOf(CID) }],
});

async function invoiceWith(claimedBlock: number, cid: string, readReceipt: () => Promise<unknown>) {
  const id = serve(claimedBlock, cid);
  return fetchInvoice(id, {
    gatewayUrl: "https://stub.invalid",
    readReceipt: readReceipt as never,
  });
}

async function refusalFrom(claimedBlock: number, cid: string, readReceipt: () => Promise<unknown>): Promise<string> {
  try {
    await invoiceWith(claimedBlock, cid, readReceipt);
    return "NO_REFUSAL";
  } catch (e) {
    return e instanceof RequestError ? e.code : `THREW:${(e as Error).message}`;
  }
}

describe("an anchor is believed only when its own transaction stored this invoice", () => {
  test("the honest anchor survives, so scans can still conclude", async () => {
    // The control. Without it every case below passes for a reader that drops every anchor, and a
    // reader that drops every anchor can never conclude an invoice is unpaid -- which is a wedge,
    // not a defence.
    const invoice = await invoiceWith(ANCHOR_BLOCK, CID, honestReceipt);
    assert.equal(invoice.anchor?.blockNumber, ANCHOR_BLOCK);
    assert.equal(invoice.anchor?.transactionHash, ANCHOR_TX);
  });

  test("an anchor moved forward onto a real, unrelated transaction is refused", async () => {
    // The attack, exactly. The gateway names a genuine recent Sepolia transaction -- it has a
    // receipt, it is in the block claimed, it is simply not the transaction that stored this
    // invoice. The block-number comparison passes it; the CID does not.
    const code = await refusalFrom(ANCHOR_BLOCK + 450_000, CID, async () => ({
      blockNumber: ANCHOR_BLOCK + 450_000, blockTimestamp: 1788932300 + 60,
      logs: [{ address: REQUEST_STORAGE, data: hexOf("QmSomeOtherChannelsBytesEntirely") }],
    }));
    assert.equal(code, "ANCHOR_UNBOUND");
  });

  test("a transaction that stored nothing at all is refused", async () => {
    // An ordinary transfer, say. It has a receipt and it is in the right block; it emitted nothing
    // from Request's storage contract, so it anchored no invoice.
    const code = await refusalFrom(ANCHOR_BLOCK, CID, async () => ({ blockNumber: ANCHOR_BLOCK, blockTimestamp: 1788932300 + 60, logs: [] }));
    assert.equal(code, "ANCHOR_UNBOUND");
  });

  test("the right bytes stored by the wrong contract is refused", async () => {
    // Anyone can emit an event carrying any data. Only Request's storage contract emitting it
    // means Request stored it.
    const code = await refusalFrom(ANCHOR_BLOCK, CID, async () => ({
      blockNumber: ANCHOR_BLOCK, blockTimestamp: 1788932300 + 60,
      logs: [{ address: `0x${"11".repeat(20)}`, data: hexOf(CID) }],
    }));
    assert.equal(code, "ANCHOR_UNBOUND");
  });

  test("a receipt in a different block from the one claimed is refused", async () => {
    const code = await refusalFrom(ANCHOR_BLOCK, CID, async () => ({
      blockNumber: ANCHOR_BLOCK + 1, blockTimestamp: 1788932300 + 60,
      logs: [{ address: REQUEST_STORAGE, data: hexOf(CID) }],
    }));
    assert.equal(code, "ANCHOR_UNBOUND");
  });

  test("a chain that cannot be read drops the anchor, and does not refuse the invoice", async () => {
    // The other direction, and the reason the refusals above are not simply "no receipt, no
    // invoice". An endpoint that will not answer has disproved nothing. Refusing would hand every
    // flaky RPC a veto over reading invoices; believing would hand a forged anchor the same trust
    // as a bound one. Unset is neither: scans stay inconclusive, which costs liveness, never money.
    const invoice = await invoiceWith(ANCHOR_BLOCK, CID, async () => {
      throw new Error("rpc unreachable");
    });
    assert.equal(invoice.anchor, undefined);
    assert.equal(invoice.requestId.startsWith("01"), true, "the rest of the invoice still reads");
  });

  test("a gateway that serves no CID gets no anchor, rather than an unbound one", async () => {
    const invoice = await invoiceWith(ANCHOR_BLOCK, "", honestReceipt);
    assert.equal(invoice.anchor, undefined);
  });
});

describe("the anchor is bound to the create's own signed timestamp", () => {
  /**
   * The CID check proves the named transaction stored SOME Request bytes identified by the CID
   * the gateway served -- and the CID comes from the same untrusted blob as the block and the
   * hash. A gateway that lies hands over any real storage transaction with its real CID, months
   * after this invoice, and the triple is self-consistent. Moved forward, the floor turns "paid
   * 460,000 blocks ago" into NOT_PAID. Reproduced by a red-team pass with block and CID moved
   * together; the existing test above moved only the block.
   *
   * The create's timestamp is signed and hash-bound to the channel id, so it cannot be moved.
   */
  test("a self-consistent anchor months after the create is refused", async () => {
    const code = await refusalFrom(ANCHOR_BLOCK + 792_000, CID, async () => ({
      blockNumber: ANCHOR_BLOCK + 792_000,
      blockTimestamp: 1788932300 + 110 * 24 * 3600,
      logs: [{ address: REQUEST_STORAGE, data: `0x${Buffer.from(CID, "utf8").toString("hex")}` }],
    }));
    assert.equal(code, "ANCHOR_UNBOUND");
  });

  test("a reader that cannot say when the block was mined binds nothing", async () => {
    // Unread, not disproved: no floor is the safe direction.
    const invoice = await invoiceWith(ANCHOR_BLOCK, CID, async () => ({
      blockNumber: ANCHOR_BLOCK,
      logs: [{ address: REQUEST_STORAGE, data: `0x${Buffer.from(CID, "utf8").toString("hex")}` }],
    }));
    assert.equal(invoice.anchor, undefined);
  });
});
