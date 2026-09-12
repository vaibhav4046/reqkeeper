/**
 * ATTACK 4 — can a missing tx hash after a possible send release the claim / re-broadcast?
 * ATTACK 5 — replay scope: is UNIQUE(payment_reference) global, and what does that cost?
 * ATTACK 7 — does any decision rest on an in-memory flag?
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/store.ts";
import { settleObligation } from "../../../src/settle.ts";
import { obligationId } from "../../../src/identity.ts";
import { NAMESPACE } from "../../../src/plan.ts";
import { invoice, policyFor, inputFor } from "./_fixture.ts";

const dir = mkdtempSync(join(tmpdir(), "rk-p4-"));

// ---------------------------------------------------------------- ATTACK 4
console.log("== ATTACK 4: provider returns success with NO transaction hash ==");
{
  const store = new Store(join(dir, "a4.sqlite"));
  let sends = 0;
  const provider = {
    simulate: async () => ({ status: "simulated" as const, wouldRevert: false, gasEstimate: "1" }),
    // Sent for real; the platform just does not tell us the hash.
    execute: async () => { sends++; return { executionId: "exec-1", status: "completed" as const }; },
    observe: async () => ({ executionId: "exec-1", status: "completed" as const }),
    receipt: async (hash: string) => ({ hash, verified: false, receiptStatus: "not_found" as const, gasUsed: "0" }),
  };
  const f = invoice();
  const r1 = await settleObligation({ store, provider, policy: policyFor(f), sourceSaysPaid: async () => false }, inputFor(f));
  const oid = obligationId(NAMESPACE, f.requestId);
  console.log("  first pass      :", r1.state, "/", r1.refusal, " sends =", sends);
  console.log("  pending jobs    :", store.pendingJobCount(), "<- anything left to observe it?");

  const { drainUntilQuiet } = await import("../../../src/worker.ts");
  await drainUntilQuiet(
    { store, provider, sourceSaysPaid: async () => false, findPaidReference: async () => null },
    { now: Date.now(), maxPasses: 6, stepMs: 0, lookaheadMs: 120_000 },
  );
  console.log("  after worker    :", store.obligationForRecovery(oid)!.state, " pending jobs =", store.pendingJobCount());
  const row = store.getObligation(oid)!;
  console.log("  reservation held:", row.reservedByPlan !== null);

  // An agent retries. Does the claim ever come back / does anything re-broadcast?
  const r2 = await settleObligation({ store, provider, policy: policyFor(f), sourceSaysPaid: async () => false }, inputFor(f, { now: Date.now() + 1000 }));
  console.log("  retry           :", r2.state, "/", r2.refusal, " sends =", sends, "<- a second send would make this 2");

  // And try the release path directly, as the holder, after the send.
  const planHash = r1.planHash!;
  console.log("  releaseObligation as holder after send:", JSON.stringify(store.releaseObligation(oid, planHash)));
  store.close();
}

console.log("\n== ATTACK 4b: releaseObligation's return value at the three settle call sites ==");
{
  const store = new Store(join(dir, "a4b.sqlite"));
  let simCalls = 0;
  const provider = {
    // A 429: ProviderError(retryable) out of simulate. settle calls releaseObligation here.
    simulate: async () => { simCalls++; const { ProviderError } = await import("../../../src/provider.ts"); throw new ProviderError("rate_limited", "429", true); },
    execute: async () => { throw new Error("must not be reached"); },
    observe: async () => ({ executionId: "x", status: "completed" as const }),
    receipt: async (hash: string) => ({ hash, verified: false, receiptStatus: "not_found" as const, gasUsed: "0" }),
  };
  const f = invoice({ requestId: "01req-release" });
  const r = await settleObligation({ store, provider, policy: policyFor(f), sourceSaysPaid: async () => false }, inputFor(f));
  const oid = obligationId(NAMESPACE, f.requestId);
  console.log("  outcome         :", r.state, "/", r.refusal);
  console.log("  detail says     :", JSON.stringify((r.detail ?? "").slice(0, 80)));
  console.log("  reservation now :", store.getObligation(oid)!.reservedByPlan === null ? "RELEASED" : "STILL HELD");
  console.log("  release attempt :", JSON.stringify(store.releaseObligation(oid, r.planHash!)));
  const r2 = await settleObligation({ store, provider, policy: policyFor(f), sourceSaysPaid: async () => false }, inputFor(f, { now: Date.now() + 1000 }));
  console.log("  'propose again later' actually gives:", r2.state, "/", r2.refusal);
  console.log("  simulate called again?", simCalls === 2);
  store.close();
}

// ---------------------------------------------------------------- ATTACK 5
console.log("\n== ATTACK 5: is UNIQUE(payment_reference) global across namespaces? ==");
{
  const store = new Store(join(dir, "a5.sqlite"));
  const REF = "0xdeadbeef";
  const a = { obligationId: obligationId("request-network:sepolia", "inv-1"), namespace: "request-network:sepolia", requestId: "inv-1" };
  const b = { obligationId: obligationId("acme-corp:mainnet", "totally-different"), namespace: "acme-corp:mainnet", requestId: "totally-different" };
  console.log("  tenant A imports ref", REF, "->", JSON.stringify(store.importObligation({ ...a, sourceFactsJson: "{}", sourceFactsHash: "h", paymentReference: REF, now: 1 })));
  try {
    store.importObligation({ ...b, sourceFactsJson: "{}", sourceFactsHash: "h", paymentReference: REF, now: 2 });
    console.log("  tenant B imports same ref -> ACCEPTED (index is NOT global)");
  } catch (e) {
    console.log("  tenant B imports same ref -> REFUSED:", (e as Error).message);
  }
  console.log("  tenant B can read A's obligation id via obligationForReference:",
    JSON.stringify(store.obligationForReference(REF)));
  // case folding
  console.log("  0xDEADBEEF resolves to the same row:", JSON.stringify(store.obligationForReference("0xDEADBEEF")));
  store.close();
}

rmSync(dir, { recursive: true, force: true });
