/**
 * The hosted `verify_payment` tool, against a forged sighting.
 *
 * The attack this covers, from a red-team pass: the ERC20FeeProxy is permissionless and a
 * payment reference is derived from data anchored openly on Sepolia, so anyone can read one of
 * this project's references off the README and emit a fee-proxy log carrying it that pays the
 * attacker one unit of a worthless token. The settlement path already refuses that log on the
 * fields (`matchPaymentLog`), and the whole argument for this tool is that a stranger can check
 * the chain for themselves — so a tool that answers "found" on the reference alone hands the
 * forgery back as the confirmation.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handlePublic } from "../src/mcp-public.ts";
import { EVIDENCE } from "../src/evidence.generated.ts";
import type { PaymentSighting } from "../src/chain.ts";

/** A reference this project really settled, with the transaction that really paid it. */
const OURS = EVIDENCE.rows.find((r) => r.paymentReference && r.txHash);
assert.ok(OURS?.paymentReference && OURS.txHash, "the compiled evidence must carry a settled row");
const REFERENCE = OURS.paymentReference;
const OUR_TX = OURS.txHash;

const ATTACKER = "0x00000000000000000000000000000000deadbeef";
const WORTHLESS_TOKEN = "0x000000000000000000000000000000000badc0de";
const FORGED_TX = `0x${"f0".repeat(32)}`;

/** What a chain read returns for the attacker's log: our reference, the attacker's payment. */
const FORGERY: PaymentSighting = {
  found: true,
  txHash: FORGED_TX,
  block: 11_700_000,
  scannedBlocks: 300_000,
  tokenAddress: WORTHLESS_TOKEN,
  to: ATTACKER,
  amount: "1",
  feeAmount: "0",
  feeAddress: "0x0000000000000000000000000000000000000000",
};

type FindOpts = { rpcUrl?: string; lookbackBlocks?: number; expect?: unknown };

/** Stands in for `findPaymentByReference`, recording the options it was handed. */
function chainSays(sighting: PaymentSighting) {
  const calls: FindOpts[] = [];
  const find = (async (_ref: string, opts: FindOpts = {}) => {
    calls.push(opts);
    return sighting;
  }) as never;
  return { find, calls };
}

async function verify(args: Record<string, unknown>, find: never): Promise<{ text: string; body: any; isError: boolean }> {
  const reply = (await handlePublic(
    { id: 1, method: "tools/call", params: { name: "verify_payment", arguments: args } },
    { findPayment: find, rpcUrl: "http://127.0.0.1:1/unused" },
  )) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  const text = reply.result.content[0].text;
  return { text, body: JSON.parse(text), isError: reply.result.isError === true };
}

describe("verify_payment will not confirm a payment on the reference alone", () => {
  test("a forged log carrying our reference is a sighting, never a payment", async () => {
    const { find } = chainSays(FORGERY);
    const { text, body } = await verify({ paymentReference: REFERENCE }, find);

    // `found: true` was the old answer, and it is the one an agent reads as "this invoice is
    // settled". No field in this reply may report a forgery as a positive.
    assert.notEqual(body.found, true, "the reply must not confirm a log that pays someone else");
    assert.equal(body.paid, false, "a log anyone could emit is not proof this invoice was paid");
    assert.equal(body.corroboratedBy, null);
    assert.equal(body.referenceSeen, true, "and the sighting is still reported, not hidden");
    assert.doesNotMatch(text, /"(paid|found)":\s*true/, "nothing in the reply may read as a confirmation");
  });

  test("the forgery is named as a conflict with our own recorded transaction", async () => {
    const { find } = chainSays(FORGERY);
    const { body } = await verify({ paymentReference: REFERENCE }, find);

    assert.ok(Array.isArray(body.conflicts) && body.conflicts.length > 0, "the disagreement must be surfaced");
    assert.match(body.conflicts.join(" "), new RegExp(OUR_TX, "i"));
    assert.match(body.conflicts.join(" "), new RegExp(FORGED_TX, "i"));
  });

  test("the expectation reaches the chain read, so the log is matched on the payment", async () => {
    // The fix is not a cosmetic rename of `found`: without this argument the scan compares the
    // reference and nothing else, and the forged log matches.
    const { find, calls } = chainSays(FORGERY);
    const expect = { tokenAddress: WORTHLESS_TOKEN, to: ATTACKER, amount: "1" };
    await verify({ paymentReference: REFERENCE, expect }, find);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].expect, expect, "token, payee and amount must be passed down to the matcher");
  });

  test("a reference this project settled, in the transaction that settled it, is paid", async () => {
    const { find } = chainSays({ ...FORGERY, txHash: OUR_TX, tokenAddress: "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C" });
    const { body } = await verify({ paymentReference: REFERENCE }, find);

    assert.equal(body.paid, true);
    assert.equal(body.corroboratedBy, "project-evidence");
    assert.equal(body.conflicts, null);
  });

  test("an expectation that is not an expectation is refused, not coerced", async () => {
    const { find } = chainSays(FORGERY);
    for (const bad of [
      { tokenAddress: "0x1", to: ATTACKER, amount: "1" },
      { tokenAddress: WORTHLESS_TOKEN, to: "not-an-address", amount: "1" },
      { tokenAddress: WORTHLESS_TOKEN, to: ATTACKER, amount: "1e18" },
    ]) {
      const { isError } = await verify({ paymentReference: REFERENCE, expect: bad }, find);
      assert.equal(isError, true, `${JSON.stringify(bad)} must be refused: it would silently never match`);
    }
  });
});
