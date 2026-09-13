/**
 * Unknown depth is not deep enough.
 *
 * Both sites that enforce the reorg depth spelled the gate as
 * `confirmations !== undefined && confirmations < min`, which skips it entirely when the depth is
 * unknown. `readReceipt` leaves `confirmations` undefined whenever its own `eth_blockNumber` call
 * throws — one rate-limited RPC — so a receipt one block deep settled terminally, and a reorg
 * after that leaves a SETTLED obligation citing a transaction that is no longer on the chain.
 *
 * Same defect as every duplicate-payment finding in this project, aimed at reorg safety rather
 * than at sends: a value that means "I could not tell" consumed as though it meant "deep enough".
 *
 * The fix is one shared predicate rather than two spellings, because two spellings is how the two
 * sites came to disagree in the first place. It discriminates on `blockNumber`: a receipt carrying
 * a block is chain-backed, so a missing depth is a failed read; a receipt with no block has no
 * chain behind it and no depth to be shallow at.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { handleRequest, type McpContext } from "../src/mcp.ts";
import { FixtureProvider, belowConfirmationDepth } from "../src/provider.ts";
import { Store } from "../src/store.ts";

const MIN = 3;

describe("a receipt that cannot state its depth is not settled on", () => {
  test("a chain-backed receipt with no depth is treated as too shallow", () => {
    // The live shape: eth_getTransactionReceipt answered, eth_blockNumber did not.
    assert.equal(
      belowConfirmationDepth({ blockNumber: 11_691_069, confirmations: undefined }, MIN),
      true,
      "a depth that could not be read must not pass the depth gate",
    );
  });

  test("a fixture receipt with no chain behind it is not held back", () => {
    // No block means no chain, so there is no depth to be shallow at. Without this the gate
    // wedges every fixture path, which is why the unsafe spelling was chosen in the first place.
    assert.equal(belowConfirmationDepth({ blockNumber: undefined, confirmations: undefined }, MIN), false);
  });

  test("a stated depth is compared, both ways", () => {
    assert.equal(belowConfirmationDepth({ blockNumber: 1, confirmations: 1 }, MIN), true);
    assert.equal(belowConfirmationDepth({ blockNumber: 1, confirmations: MIN - 1 }, MIN), true);
    assert.equal(belowConfirmationDepth({ blockNumber: 1, confirmations: MIN }, MIN), false);
    assert.equal(belowConfirmationDepth({ blockNumber: 1, confirmations: MIN + 10 }, MIN), false);
  });

  test("a zero depth is shallow, not falsy-absent", () => {
    // `confirmations: 0` is a real answer and the most dangerous one. A gate written with a
    // truthiness check would read it as "not stated" and let it through.
    assert.equal(belowConfirmationDepth({ blockNumber: 1, confirmations: 0 }, MIN), true);
  });
});

describe("the read-only surface says which kind of not-knowing it has", () => {
  /**
   * `verify_payment`'s caveat branched on `truncated` alone, so THREE different kinds of
   * not-knowing -- a scan that never said whether it was truncated, one no second endpoint would
   * corroborate, and one that never stated its conflicting logs -- all produced the most confident
   * sentence on the surface: "scanned to genesis; no payment matching this obligation was found".
   * That sentence is what an agent reads before deciding to pay.
   */
  async function caveatFrom(sighting: unknown): Promise<string | null> {
    const store = new Store();
    try {
      const ctx = {
        store,
        provider: new FixtureProvider(),
        findPayment: async () => sighting,
      } as unknown as McpContext;
      const reply = (await handleRequest(ctx, {
        id: 1,
        method: "tools/call",
        params: { name: "verify_payment", arguments: { paymentReference: "0x7a3496f145f70a31" } },
      })) as { result?: { content?: Array<{ text?: string }> } };
      return (JSON.parse(reply?.result?.content?.[0]?.text ?? "{}") as { caveat?: string | null }).caveat ?? null;
    } finally {
      store.close();
    }
  }

  test("a scan that did not say whether it was truncated does not claim to have scanned everything", async () => {
    const caveat = await caveatFrom({ found: false, conflictingLogs: [], negativeCorroborations: 2 });
    assert.match(String(caveat), /not proof the invoice is unpaid/i, String(caveat));
  });

  test("a negative no second endpoint confirmed says exactly that", async () => {
    const caveat = await caveatFrom({ found: false, truncated: false, conflictingLogs: [] });
    assert.match(String(caveat), /no other confirmed it/i, String(caveat));
  });

  test("a scan that never stated its conflicts blames the reader, not the invoice", async () => {
    const caveat = await caveatFrom({ found: false, truncated: false, negativeCorroborations: 2 });
    assert.match(String(caveat), /defect in the chain reader/i, String(caveat));
  });

  test("and a scan that really concluded says so, without claiming genesis", async () => {
    const caveat = await caveatFrom({
      found: false,
      truncated: false,
      conflictingLogs: [],
      negativeCorroborations: 2,
    });
    assert.match(String(caveat), /covered the window/i, String(caveat));
    assert.doesNotMatch(String(caveat), /genesis/i, "the scan is a bounded window and never reached genesis");
  });
});
