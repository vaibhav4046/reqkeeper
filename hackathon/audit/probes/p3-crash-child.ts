/** Runs settleObligation and hard-kills the process at a chosen point. */
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { Store } from "../../../src/store.ts";
import { settleObligation } from "../../../src/settle.ts";
import { invoice, policyFor, inputFor } from "./_fixture.ts";

const [dbPath, sidecar, point] = process.argv.slice(2);
const store = new Store(dbPath);

/** The chain, such as it is: a file the crash cannot erase. */
function chainAppend(txHash: string, amount: string): void {
  const rows = existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, "utf8")) : [];
  rows.push({ txHash, amount });
  writeFileSync(sidecar, JSON.stringify(rows));
}
function sends(): number {
  return existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, "utf8")).length : 0;
}

const die = (p: string) => { if (point === p) { console.log(`CRASH@${p}`); process.exit(9); } };

const provider = {
  async simulate() { die("SIMULATE"); return { status: "simulated" as const, wouldRevert: false, gasEstimate: "21000" }; },
  async execute(_b: unknown, _k: string) {
    die("BEFORE_SEND");
    const txHash = "0x" + (sends() + 1).toString(16).padStart(64, "0");
    chainAppend(txHash, "1000000000000000000");       // the money moves HERE
    die("AFTER_SEND");                                 // response lost
    return { executionId: "exec-1", status: "completed" as const, transactionHash: txHash };
  },
  async observe() { return { executionId: "exec-1", status: "completed" as const }; },
  async receipt(hash: string) {
    die("RECEIPT");
    const known = (existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, "utf8")) : [])
      .some((r: { txHash: string }) => r.txHash === hash);
    return known
      ? { hash, verified: true, receiptStatus: "success" as const, gasUsed: "1" }
      : { hash, verified: false, receiptStatus: "not_found" as const, gasUsed: "0" };
  },
};

const f = invoice();
try {
  const r = await settleObligation(
    { store, provider, policy: policyFor(f), sourceSaysPaid: async () => { die("RECONCILE"); return true; } },
    inputFor(f, { now: Date.now() }),
  );
  console.log(JSON.stringify({ state: r.state, refusal: r.refusal ?? null, sends: sends() }));
} catch (e) {
  console.log(JSON.stringify({ state: "THREW", error: (e as Error).message.slice(0, 140), sends: sends() }));
}
store.close();
