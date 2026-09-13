/**
 * The one-wei wedge, and the door out of it.
 *
 * Payment references are derived from data anchored openly on Sepolia, so anyone can read one and
 * emit an ERC20FeeProxy log carrying it — paying this invoice's payee, in this invoice's token,
 * for one wei. `verdictFor` reads that as CONFLICT_OURS, which is right: nobody else has a reason
 * to pay our payee in our token under our reference, so it is either the invoice being settled
 * outside this system or our own funds moving in a plan nobody made. Both are questions for a
 * human, and `propose_payment` refuses.
 *
 * Correctly, the first time. The defect was that there was no second time. `resolve.ts
 * --release-preflight` had a door for exactly this shape (`--reviewed-tx`) and the propose gate —
 * the one every payment starts from — had none, so one junk log bought a permanent refusal of a
 * real debt for the price of a testnet transfer.
 *
 * The door is a person at a separate command, one hash at a time, recorded in the hash-chained
 * audit trail beside their name. It is never an argument to the MCP tool: an agent that could
 * clear its own conflicts is not a gate.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { obligationId } from "../src/identity.ts";
import { handleRequest, type McpContext } from "../src/mcp.ts";
import { toBaseUnits } from "../src/money.ts";
import { NAMESPACE } from "../src/plan.ts";
import { FixtureProvider } from "../src/provider.ts";
import { Store } from "../src/store.ts";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PAYEE = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const FEE_ADDR = `0x${"0".repeat(40)}`;
const REQUEST_ID = "01b7cd715cfe60ac07f637ed0eb62bf5d1c00c56e3599b8ce6b0a962e8b7f49914";
const REFERENCE = "0x7a3496f145f70a31";
const AMOUNT = toBaseUnits("1", 18).toString();
const OID = obligationId(NAMESPACE, REQUEST_ID);
/** The attacker's log: our payee, our token, our reference, one wei. */
const JUNK_TX = `0x${"7b".repeat(32)}`;
const OTHER_TX = `0x${"5c".repeat(32)}`;

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
};

/** A scan that saw the junk log, and nothing that pays this invoice. */
function conflicted(txHashes: readonly (string | undefined)[]) {
  return {
    found: false,
    truncated: false,
    negativeCorroborations: 2,
    conflicts: txHashes.map((tx) => `${tx ?? "an unnamed log"}: moves 1, the invoice is ${AMOUNT}`),
    conflictingLogs: txHashes.map((txHash) => ({ ...(txHash === undefined ? {} : { txHash }), kinds: ["amount" as const] })),
  };
}

async function propose(store: Store, sighting: unknown) {
  const ctx = {
    store,
    provider: new FixtureProvider(),
    findPayment: async () => sighting,
    fetchInvoice: async () => invoice,
  } as unknown as McpContext;
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
  return JSON.parse(reply?.result?.content?.[0]?.text ?? "{}") as {
    state?: string;
    refusal?: string | null;
    detail?: string;
  };
}

function reviewAtTheCli(db: string, hashes: string, operator = "owner@reqkeeper.local"): string {
  return execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      "scripts/resolve.ts",
      `--db=${db}`,
      `--review-conflict=${OID}`,
      `--tx=${hashes}`,
      `--operator=${operator}`,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SEPOLIA_RPC: "http://127.0.0.1:1", REQKEEPER_RPC_ENDPOINTS: "http://127.0.0.1:1" },
    },
  );
}

function freshDb(): string {
  return join(mkdtempSync(join(tmpdir(), "reqkeeper-conflict-review-")), "live.sqlite");
}

describe("one junk log must not refuse a real debt for ever", () => {
  test("the first proposal refuses, names the transaction, and prints the way out", async () => {
    const db = freshDb();
    const store = new Store(db);
    const body = await propose(store, conflicted([JUNK_TX]));
    store.close();

    assert.equal(body.refusal, "SOURCE_UNVERIFIABLE");
    assert.ok(String(body.detail).includes(JUNK_TX), "the refusal does not name the transaction to read");
    assert.match(String(body.detail), /--review-conflict/, String(body.detail));
  });

  test("after a human reads it and says so, the same proposal goes through", async () => {
    const db = freshDb();
    const store = new Store(db);
    await propose(store, conflicted([JUNK_TX]));
    store.close();

    const printed = reviewAtTheCli(db, JUNK_TX);
    assert.match(printed, /recorded 1 reviewed transaction/, printed);

    const second = new Store(db);
    const body = await propose(second, conflicted([JUNK_TX]));
    const trail = second.auditTrail(OID);
    second.close();

    assert.equal(body.state, "AWAITING_APPROVAL", JSON.stringify(body).slice(0, 300));
    // And who cleared it is in the trail, beside the hash. An acknowledgement nobody signed is
    // the thing this door must not become.
    const review = trail.find((r) => r.action === "CONFLICT_REVIEWED");
    assert.equal(review?.actor, "owner@reqkeeper.local");
    assert.equal((review?.detail as { txHash?: string })?.txHash, JUNK_TX);
  });

  test("a DIFFERENT conflicting log still refuses, so the review clears one transaction and not a state", async () => {
    const db = freshDb();
    const store = new Store(db);
    await propose(store, conflicted([JUNK_TX]));
    store.close();
    reviewAtTheCli(db, JUNK_TX);

    const second = new Store(db);
    const body = await propose(second, conflicted([JUNK_TX, OTHER_TX]));
    second.close();

    assert.equal(body.refusal, "SOURCE_UNVERIFIABLE");
    assert.ok(String(body.detail).includes(OTHER_TX), "the second log was not named");
    assert.ok(!String(body.detail).includes(`read: ${JUNK_TX},`), "the cleared transaction is still being asked about");
  });

  test("a conflict the scan could not name by hash cannot be cleared at all", async () => {
    // Nothing to review, so nothing to acknowledge -- and clearing the named ones must not clear
    // the unnamed one by omission.
    const db = freshDb();
    const store = new Store(db);
    await propose(store, conflicted([JUNK_TX]));
    store.close();
    reviewAtTheCli(db, JUNK_TX);

    const second = new Store(db);
    const body = await propose(second, conflicted([JUNK_TX, undefined]));
    second.close();

    assert.equal(body.refusal, "SOURCE_UNVERIFIABLE");
    assert.match(String(body.detail), /named no transaction|to read/, String(body.detail));
  });

  test("the CLI refuses anything that is not a transaction hash", () => {
    const db = freshDb();
    const store = new Store(db);
    store.importObligation({
      obligationId: OID,
      namespace: NAMESPACE,
      requestId: REQUEST_ID,
      sourceFactsJson: "{}",
      sourceFactsHash: "h",
      paymentReference: REFERENCE,
      now: 1,
    });
    store.close();

    assert.throws(
      () => reviewAtTheCli(db, "the one I looked at"),
      /REFUSED|usage/,
      "a review is only as good as the transaction it names",
    );
  });
});
