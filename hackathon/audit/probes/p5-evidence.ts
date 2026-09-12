/**
 * ATTACK 6 — evidence spoofing. Two questions:
 *   (a) can the recorded tx hash be replaced after the fact?
 *   (b) does the live reconciler bind the receipt to OUR transaction and OUR amount?
 * Uses the real worker. The only thing injected is the shape of `sourceSaysPaid`, copied
 * verbatim from the two implementations that exist in this repo.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/store.ts";
import { drainUntilQuiet } from "../../../src/worker.ts";
import { obligationId, idempotencyKey } from "../../../src/identity.ts";
import { NAMESPACE } from "../../../src/plan.ts";

const dir = mkdtempSync(join(tmpdir(), "rk-p5-"));
const OURS = "0x" + "11".repeat(32);
const FOREIGN = "0x" + "ff".repeat(32);   // some unrelated successful transaction

function build(name: string) {
  const store = new Store(join(dir, `${name}.sqlite`));
  const rid = "01req-evidence";
  const oid = obligationId(NAMESPACE, rid);
  store.importObligation({
    obligationId: oid, namespace: NAMESPACE, requestId: rid,
    sourceFactsJson: JSON.stringify({ invoiceBaseUnits: "1000000000000000000" }),
    sourceFactsHash: "h", paymentReference: "0xcc01", now: 1,
  });
  const planHash = "c".repeat(64);
  const { attemptId } = store.openAttempt({
    obligationId: oid, planHash, stepIndex: 0,
    idempotencyKey: idempotencyKey(oid, planHash, 0),
    endpoint: "/api/execute/contract-call", bodyJson: "{}", now: 1,
  });
  for (const s of ["VALIDATING", "AWAITING_APPROVAL", "APPROVED", "PAYMENT_PREFLIGHT", "PAYMENT_EXECUTING"] as const) store.setState(oid, s, 1);
  store.markSent(attemptId, 1);
  store.recordOutcome(attemptId, { outcome: "SENT", executionId: "exec-1", txHash: OURS });
  store.setState(oid, "CHAIN_PENDING", 1);
  store.enqueue({ kind: "OBSERVE_EXECUTION", dedupeKey: `observe:${planHash}:0`, obligationId: oid, attemptId, dueAt: 1, now: 1 });
  return { store, oid, attemptId };
}

// (a) Can the recorded hash be replaced? No fencing, no compare-and-set on recordOutcome.
{
  const { store, oid, attemptId } = build("swap");
  console.log("== (a) overwrite the recorded transaction hash ==");
  console.log("  before:", store.getAttempt(attemptId)!.txHash);
  store.recordOutcome(attemptId, { outcome: "SENT", executionId: "exec-EVIL", txHash: FOREIGN });
  const after = store.getAttempt(attemptId)!;
  console.log("  after :", after.txHash, " executionId:", after.executionId);
  console.log("  overwritten:", after.txHash === FOREIGN, "  (UPDATE ... tx_hash = COALESCE(?, tx_hash) -> new value wins)");

  // The worker now reads a receipt for the FOREIGN hash. Reconciler shape #1:
  // scripts/settle-live.ts:147  ->  sourceSaysPaid: async () => (await proxySawPayment(startBlock)).found
  console.log("\n== (b1) a reconciler that ignores its arguments (settle-live.ts:147 before the mid-audit fix) ==");
  drainUntilQuiet(
    {
      store,
      provider: { receipt: async (hash: string) => ({ hash, verified: true, receiptStatus: "success" as const, gasUsed: "1" }) },
      sourceSaysPaid: async () => true,        // "the reference appears in the proxy log"
    },
    { now: 2, maxPasses: 6, stepMs: 0, lookaheadMs: 120_000 },
  ).then(() => {
    const r = store.obligationForRecovery(oid)!;
    console.log("  final state:", r.state, " evidence hash:", store.getAttempt(attemptId)!.txHash);
    console.log("  SETTLED on a transaction nobody checked belonged to this invoice:", r.state === "SETTLED");
    store.close();

    // Reconciler shape #2: src/mcp.ts:288-297 and scripts/resolve.ts:85-87 compare hash AND amount.
    const b = build("bound");
    b.store.recordOutcome(b.attemptId, { outcome: "SENT", txHash: FOREIGN });
    drainUntilQuiet(
      {
        store: b.store,
        provider: { receipt: async (hash: string) => ({ hash, verified: true, receiptStatus: "success" as const, gasUsed: "1" }) },
        sourceSaysPaid: async (_rid: string, txHash: string) => txHash.toLowerCase() === OURS,
      },
      { now: 2, maxPasses: 6, stepMs: 0, lookaheadMs: 120_000 },
    ).then(() => {
      console.log("\n== (b2) a reconciler that binds hash + amount (mcp.ts, resolve.ts, and settle-live.ts now) ==");
      console.log("  final state:", b.store.obligationForRecovery(b.oid)!.state, "<- refuses to settle on the foreign hash");
      b.store.close();
      rmSync(dir, { recursive: true, force: true });
    });
  });
}
