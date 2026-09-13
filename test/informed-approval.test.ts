/**
 * The sentence a human approves has to carry what a human would want to know — through the path
 * they actually use, not only in the function that builds it.
 *
 * Two controls were computed, documented as reaching the approver, and dropped by every
 * production caller:
 *
 *   - `payeeDiffersFromRecord`: the money goes to an address that is NOT the party the invoice
 *     names as the payee. Request allows that, so it is never a refusal — and it is precisely the
 *     thing the person about to send funds would want to be told. `src/request.ts` computed it
 *     and said "it reaches the sentence a human approves"; `src/mcp.ts` and `src/watch.ts` both
 *     built their facts without it, so the control existed only as a sentence in a docblock.
 *
 *   - the reason a chain read could not conclude. `verdictFor` produces a precise reason and a
 *     detail naming the transaction it saw; the propose path replaced both with a four-way
 *     disjunction, so an agent whose scan HAD been answered by one endpoint was told to "retry
 *     when an endpoint answers" — advice that cannot work, for a cause that was not the one.
 *
 * These are end-to-end: they drive `propose_payment` and read what comes back, because a caller
 * dropping a field is exactly what the unit tests could not see.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { handleRequest, type McpContext } from "../src/mcp.ts";
import { toBaseUnits } from "../src/money.ts";
import { FixtureProvider } from "../src/provider.ts";
import { Store } from "../src/store.ts";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PAYMENT_ADDRESS = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const PARTY_OF_RECORD = "0x5555000000000000000000000000000000005555";
const FEE_ADDR = `0x${"0".repeat(40)}`;
const REQUEST_ID = "01b7cd715cfe60ac07f637ed0eb62bf5d1c00c56e3599b8ce6b0a962e8b7f49914";
const REFERENCE = "0x7a3496f145f70a31";
const AMOUNT = toBaseUnits("1", 18).toString();

/** A scan that concluded: covered window, conflicts stated, a second endpoint agreed. */
const CLEAN_NEGATIVE = { found: false, truncated: false, conflictingLogs: [], negativeCorroborations: 2 };

function invoiceHeldByRequest(over: Record<string, unknown> = {}) {
  return {
    requestId: REQUEST_ID,
    chainId: 11155111,
    tokenAddress: FAU,
    payee: PAYMENT_ADDRESS,
    payeeOfRecord: PAYMENT_ADDRESS,
    invoiceBaseUnits: AMOUNT,
    feeBaseUnits: "0",
    feeRecipient: FEE_ADDR,
    salt: "0123456789abcdef",
    paymentReference: REFERENCE,
    ...over,
  };
}

async function propose(over: Record<string, unknown>, sighting: unknown = CLEAN_NEGATIVE) {
  const store = new Store();
  const provider = new FixtureProvider();
  try {
    const ctx = {
      store,
      provider,
      findPayment: async () => sighting,
      fetchInvoice: async () => invoiceHeldByRequest(over),
    } as unknown as McpContext;
    const reply = (await handleRequest(ctx, {
      id: 1,
      method: "tools/call",
      params: {
        name: "propose_payment",
        arguments: {
          requestId: REQUEST_ID,
          paymentReference: REFERENCE,
          payee: PAYMENT_ADDRESS,
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
      refusal?: string | null;
      detail?: string;
      approvalSentence?: string | null;
    };
    return { body, sends: provider.totalSends() };
  } finally {
    store.close();
  }
}

describe("what the human approving is told", () => {
  test("a payment address that is not the party of record is named in the sentence", async () => {
    const { body } = await propose({ payeeOfRecord: PARTY_OF_RECORD, payeeDiffersFromRecord: true });
    assert.equal(body.state, "AWAITING_APPROVAL", JSON.stringify(body).slice(0, 300));
    assert.ok(body.approvalSentence, "an obligation awaiting a decision must carry the sentence");
    assert.match(body.approvalSentence, /NOT the party of record/i, body.approvalSentence);
    assert.match(body.approvalSentence, new RegExp(PAYMENT_ADDRESS, "i"), body.approvalSentence);
  });

  test("and an ordinary invoice carries no such note, or nobody reads them", async () => {
    const { body } = await propose({});
    assert.equal(body.state, "AWAITING_APPROVAL", JSON.stringify(body).slice(0, 300));
    assert.ok(body.approvalSentence);
    assert.doesNotMatch(body.approvalSentence, /NOT the party of record/i, body.approvalSentence);
  });
});

describe("what the agent is told when the chain could not conclude", () => {
  test("an uncorroborated positive names the transaction and the fix that works", async () => {
    // One endpoint saw a log, no second confirmed it. The refusal this replaced told the agent to
    // "retry when an endpoint answers" -- but one had, and retrying returns the same thing.
    const tx = `0x${"8a".repeat(32)}`;
    const { body, sends } = await propose({}, { found: true, txHash: tx, corroborated: false });
    assert.equal(body.refusal, "SOURCE_UNVERIFIABLE");
    assert.equal(sends, 0);
    assert.match(String(body.detail), /UNCORROBORATED/, String(body.detail));
    assert.match(String(body.detail), new RegExp(tx), "the refusal must name the transaction it saw");
    assert.match(String(body.detail), /REQKEEPER_RPC_ENDPOINTS/, "and the thing that actually fixes it");
  });

  test("a truncated scan says THAT, and prescribes the anchor instead", async () => {
    const { body } = await propose({}, { found: false, truncated: true, scannedBlocks: 450_000 });
    assert.equal(body.refusal, "SOURCE_UNVERIFIABLE");
    assert.match(String(body.detail), /TRUNCATED/, String(body.detail));
    assert.match(String(body.detail), /anchor/i, String(body.detail));
    assert.doesNotMatch(
      String(body.detail),
      /REQKEEPER_RPC_ENDPOINTS/,
      "prescribing a second endpoint for a window problem is the wrong advice, confidently given",
    );
  });

  test("a scan that never stated its conflicts says so, and blames the reader", async () => {
    const { body } = await propose({}, { found: false, truncated: false, negativeCorroborations: 2 });
    assert.equal(body.refusal, "SOURCE_UNVERIFIABLE");
    assert.match(String(body.detail), /CONFLICTS_NOT_STATED/, String(body.detail));
    assert.match(String(body.detail), /defect in the chain reader/i, String(body.detail));
  });
});

describe("what the approver is told about the channel itself", () => {
  test("actions that could not be authenticated are named, and change no figure", async () => {
    // Request ignores an action whose application throws -- "if an error occurs while applying we
    // ignore the action" -- and so does this reader, because refusing the invoice instead let any
    // stranger wedge a real debt by appending junk to a public channel. Ignoring it quietly would
    // be the other half of that mistake: somebody has been appending to the channel of an invoice
    // about to be paid, and the person deciding is entitled to hear it from us.
    const { body } = await propose({
      ignoredActions: [
        { index: 1, name: "increaseExpectedAmount", reason: "signed by 0xdead…, who is neither the payee nor the payer" },
      ],
    });
    assert.equal(body.state, "AWAITING_APPROVAL", JSON.stringify(body).slice(0, 300));
    assert.ok(body.approvalSentence);
    assert.match(body.approvalSentence, /1 action\(s\).*could not be\s+authenticated|could not be authenticated/i, body.approvalSentence);
    // And the amount is the create's, untouched.
    assert.match(body.approvalSentence, /Pay 1 FAU/, body.approvalSentence);
  });

  test("a clean channel says nothing about ignored actions", async () => {
    const { body } = await propose({});
    assert.ok(body.approvalSentence);
    assert.doesNotMatch(body.approvalSentence, /could not be authenticated/i, body.approvalSentence);
  });
});
