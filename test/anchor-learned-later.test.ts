/**
 * An anchor learned after import must reach the store, or the obligation is wedged for ever.
 *
 * The anchor is the invoice's storage block, and it is what makes a negative conclusive: a payment
 * cannot predate the invoice it pays, so a scan that reaches the anchor has seen every block a
 * payment for it could be in. Without one, `findPaymentByReference` reports `truncated: true`, the
 * worker refuses to conclude from a truncated scan — correctly — and the obligation waits.
 *
 * It lived only inside `source_facts_json`, which means it could only ever arrive at the moment
 * the obligation was created. An obligation fed by the watcher from `docs/live-invoices.json`,
 * which carries no anchors, therefore had no floor and never could: every scan truncated, nothing
 * concluded, nothing released. Permanently wedged at zero sends — the shape this project has now
 * found in four separate places, where the safe answer has no path out of itself.
 *
 * Learning it later could not be done by rewriting the facts: they are hashed, and a changed hash
 * reads as PLAN_CHANGED and invalidates the human's approval. So the anchor gets its own column,
 * immutable once set, written whenever the gateway is next reachable.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { obligationId } from "../src/identity.ts";
import { NAMESPACE } from "../src/plan.ts";
import { Store } from "../src/store.ts";

const OID = obligationId(NAMESPACE, "01req-anchor-later");
const ANCHOR = 11_690_278;

function imported(factsJson: string): Store {
  const store = new Store();
  store.importObligation({
    obligationId: OID,
    namespace: NAMESPACE,
    requestId: "01req-anchor-later",
    sourceFactsJson: factsJson,
    sourceFactsHash: "h",
    paymentReference: "0x0056a1b2c3d4e5f6",
    now: 1,
  });
  return store;
}

describe("the anchor can be learned after the obligation exists", () => {
  test("a watcher-fed obligation with no anchor can still be given one", () => {
    // Exactly `docs/live-invoices.json`: an invoice with no anchor in it.
    const store = imported(JSON.stringify({ invoiceBaseUnits: "1" }));
    assert.equal(store.obligationForRecovery(OID)?.anchorBlock, null, "the premise: no floor");

    store.learnAnchor(OID, ANCHOR);

    assert.equal(
      store.obligationForRecovery(OID)?.anchorBlock,
      ANCHOR,
      "without this every scan for this obligation stays truncated and it never concludes",
    );
    store.close();
  });

  test("an anchor in the facts is seeded at import, with no second call", () => {
    const store = imported(JSON.stringify({ anchorBlock: ANCHOR }));
    assert.equal(store.obligationForRecovery(OID)?.anchorBlock, ANCHOR);
    store.close();
  });

  test("the first anchor wins and a disagreement is recorded, not applied", () => {
    // An anchor is a fact about a block that was already written, so it does not change. A later
    // read that disagrees means this is a different invoice — and silently moving the floor would
    // move it under conclusions already drawn against it.
    const store = imported(JSON.stringify({ anchorBlock: ANCHOR }));
    store.learnAnchor(OID, ANCHOR + 5_000);

    assert.equal(store.obligationForRecovery(OID)?.anchorBlock, ANCHOR, "the stored anchor is kept");
    assert.ok(
      store.auditTrail(OID).some((r) => r.action === "ANCHOR_DISAGREES"),
      "and the disagreement is in the trail rather than swallowed",
    );
    store.close();
  });

  test("a nonsense anchor is refused rather than stored", () => {
    // Zero is the dangerous one: as a floor it means "scan to genesis", which no scan reaches, so
    // it would turn every negative back into truncated while looking like a configured anchor.
    const store = imported(JSON.stringify({ invoiceBaseUnits: "1" }));
    store.learnAnchor(OID, 0);
    store.learnAnchor(OID, -1);
    assert.equal(store.obligationForRecovery(OID)?.anchorBlock, null);
    store.close();
  });
});
