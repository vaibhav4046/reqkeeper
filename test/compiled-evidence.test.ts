/**
 * The hosted surface serves ALL the evidence, not the artifact that happened to be wired first.
 *
 * `src/evidence.generated.ts` is the table `verify_payment` corroborates a sighting against when
 * the caller passes no `expect`. It was generated from `docs/refusals-live.json` alone, whose
 * `generatedAt` predates the three MCP-transport settlements by three days — so on the live
 * deployment all three of those references answered `paid: false, corroboratedBy: null` while
 * the chain plainly showed the payment, the amount and the payee. The repository contradicted
 * its own hosted verifier.
 *
 * These tests fail if the generator ever narrows back to one artifact.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handlePublic } from "../src/mcp-public.ts";
import { EVIDENCE } from "../src/evidence.generated.ts";
import type { PaymentSighting } from "../src/chain.ts";

const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8")) as T;

interface LiveArtifact {
  rows: Array<{ case_id: string; tx_hash: string | null; payment_reference: string | null; physical_sends: number }>;
}
interface McpArtifact {
  rows: Array<{ paymentReference: string; txHash: string; token: string; payee: string; amountBaseUnits: string }>;
}

const live = read<LiveArtifact>("docs/refusals-live.json");
const mcp = read<McpArtifact>("docs/evidence/mcp-settlements.json");

/** What the hosted tool would see from the chain for a settlement it really made. */
function chainSays(row: McpArtifact["rows"][number]) {
  const sighting: PaymentSighting = {
    found: true,
    txHash: row.txHash,
    tokenAddress: row.token,
    to: row.payee,
    amount: row.amountBaseUnits,
    feeAmount: "0",
    feeAddress: "0x0000000000000000000000000000000000000000",
  };
  return (async () => sighting) as never;
}

async function verifyPayment(reference: string, find: never): Promise<Record<string, unknown>> {
  const reply = (await handlePublic(
    { id: 1, method: "tools/call", params: { name: "verify_payment", arguments: { paymentReference: reference } } },
    { findPayment: find, rpcUrl: "http://127.0.0.1:1/unused" },
  )) as { result: { content: Array<{ text: string }> } };
  return JSON.parse(reply.result.content[0].text) as Record<string, unknown>;
}

describe("the compiled evidence carries every settlement, whichever transport made it", () => {
  test("every settled row in both LIVE artifacts is in the compiled table", () => {
    const compiled = new Set(EVIDENCE.rows.map((r) => `${r.paymentReference}:${r.txHash}`.toLowerCase()));
    const expected = [
      ...live.rows.filter((r) => r.tx_hash).map((r) => `${r.payment_reference}:${r.tx_hash}`),
      ...mcp.rows.map((r) => `${r.paymentReference}:${r.txHash}`),
    ];
    const missing = expected.filter((k) => !compiled.has(k.toLowerCase()));
    assert.deepEqual(missing, [], "a settlement the repository publishes is absent from the table the hosted tool trusts");
    assert.equal(expected.length, live.rows.filter((r) => r.tx_hash).length + mcp.rows.length);
  });

  test("the totals are recomputed from the rows, not copied from a summary block", () => {
    assert.equal(EVIDENCE.totals.rows, EVIDENCE.rows.length);
    assert.equal(EVIDENCE.totals.payments, EVIDENCE.rows.filter((r) => r.txHash).length);
    assert.equal(
      EVIDENCE.totals.physicalSends,
      EVIDENCE.rows.reduce((n, r) => n + r.physicalSends, 0),
    );
  });

  test("verify_payment corroborates each MCP reference from the project's own evidence", async () => {
    for (const row of mcp.rows) {
      const body = await verifyPayment(row.paymentReference, chainSays(row));
      assert.equal(body.paid, true, `${row.paymentReference} is still uncorroborated by the hosted tool`);
      assert.equal(body.corroboratedBy, "project-evidence");
      assert.equal(body.txHash, row.txHash);
    }
  });

  test("a sighting in a transaction the project never made is still a conflict, not a payment", async () => {
    const row = mcp.rows[0];
    const forged = { ...row, txHash: `0x${"f0".repeat(32)}` };
    const body = await verifyPayment(row.paymentReference, chainSays(forged));
    assert.equal(body.paid, false);
    assert.match(String((body.conflicts as string[])?.[0] ?? ""), new RegExp(row.txHash, "i"));
  });
});
