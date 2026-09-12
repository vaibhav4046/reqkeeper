/**
 * ATTACK 3 — crash at every point. Does restart converge, and without a second send?
 * The child process is really killed (process.exit) mid-settle. The "chain" is a sidecar
 * file the crash cannot erase, so a send that happened stays happened.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Store } from "../../../src/store.ts";
import { drainUntilQuiet } from "../../../src/worker.ts";
import { settleObligation } from "../../../src/settle.ts";
import { obligationId } from "../../../src/identity.ts";
import { NAMESPACE } from "../../../src/plan.ts";
import { invoice, policyFor, inputFor } from "./_fixture.ts";

const dir = mkdtempSync(join(tmpdir(), "rk-p3-"));
const POINTS = ["NONE", "SIMULATE", "BEFORE_SEND", "AFTER_SEND", "RECEIPT", "RECONCILE"];

function run(db: string, sidecar: string, point: string): Promise<string> {
  return new Promise((res) => {
    const p = spawn(process.execPath,
      ["--experimental-strip-types", join(import.meta.dirname, "p3-crash-child.ts"), db, sidecar, point],
      { stdio: ["ignore", "pipe", "pipe"] });
    let b = ""; p.stdout.on("data", (d) => (b += d)); p.stderr.on("data", (d) => (b += d));
    p.on("close", () => res(b.trim()));
  });
}

const rows: string[][] = [];
for (const point of POINTS) {
  const db = join(dir, `${point}.sqlite`);
  const sidecar = join(dir, `${point}.chain.json`);
  const crashLine = (await run(db, sidecar, point)).split("\n").filter((l) => l.trim()).pop() ?? "";

  const chain = () => (existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, "utf8")) as Array<{ txHash: string; amount: string }> : []);
  const sendsAfterCrash = chain().length;

  // --- restart: operator runs `resolve` (the worker), read-only by construction ---
  const store = new Store(db);
  const recover = {
    store,
    provider: {
      receipt: async (hash: string) => chain().some((r) => r.txHash === hash)
        ? { hash, verified: true, receiptStatus: "success" as const, gasUsed: "1" }
        : { hash, verified: false, receiptStatus: "not_found" as const, gasUsed: "0" },
    },
    sourceSaysPaid: async (_r: string, txHash: string) => chain().some((r) => r.txHash === txHash),
    findPaidReference: async () => { const c = chain(); return c.length ? { txHash: c[0].txHash, amount: c[0].amount } : null; },
  };
  await drainUntilQuiet(recover, { now: Date.now(), maxPasses: 8, stepMs: 0, lookaheadMs: 120_000 });
  const oid = obligationId(NAMESPACE, invoice().requestId);
  const afterWorker = store.obligationForRecovery(oid)?.state ?? "(no row)";
  const jobsAfterWorker = store.pendingJobCount();

  // --- and the agent retries settle, which is what an agent actually does ---
  let retry = "-";
  const f = invoice();
  try {
    const r = await settleObligation(
      {
        store,
        provider: {
          simulate: async () => ({ status: "simulated" as const, wouldRevert: false, gasEstimate: "1" }),
          execute: async () => { chain(); throw new Error("SECOND_SEND_ATTEMPTED"); },
          observe: async () => ({ executionId: "x", status: "completed" as const }),
          receipt: recover.provider.receipt,
        },
        policy: policyFor(f),
        sourceSaysPaid: recover.sourceSaysPaid,
      },
      inputFor(f, { now: Date.now() }),
    );
    retry = `${r.state}/${r.refusal ?? "-"}`;
  } catch (e) { retry = "THREW:" + (e as Error).message.slice(0, 60); }

  const final = store.obligationForRecovery(oid)?.state ?? "(no row)";
  store.close();
  rows.push([point, crashLine.slice(0, 46), String(sendsAfterCrash), afterWorker, String(jobsAfterWorker), retry, final, String(chain().length)]);
}

const head = ["crash point", "child said", "sends", "after worker", "jobs", "agent retry", "final", "total sends"];
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r: string[]) => r.map((c, i) => c.padEnd(w[i])).join("  ");
console.log(line(head));
console.log(w.map((n) => "-".repeat(n)).join("  "));
for (const r of rows) console.log(line(r));
rmSync(dir, { recursive: true, force: true });
