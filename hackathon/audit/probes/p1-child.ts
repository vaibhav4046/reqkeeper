/** One racing proposer. Prints a JSON line. Counts real execute() calls. */
import { Store } from "../../../src/store.ts";
import { settleObligation } from "../../../src/settle.ts";
import { FixtureProvider } from "../../../src/provider.ts";
import { invoice, policyFor, inputFor, alwaysPaid } from "./_fixture.ts";

const [dbPath, startAtRaw] = process.argv.slice(2);
const startAt = Number(startAtRaw);

const store = new Store(dbPath);
const inner = new FixtureProvider("NONE");
let executeCalls = 0;
const provider = {
  simulate: (b: unknown) => inner.simulate(b),
  execute: (b: unknown, k: string) => { executeCalls++; return inner.execute(b, k); },
  observe: (id: string) => inner.observe(id),
  receipt: (h: string) => inner.receipt(h),
};

const f = invoice();
// Spin-wait to the shared start instant so both processes enter together.
while (Date.now() < startAt) { /* barrier */ }

try {
  const r = await settleObligation(
    { store, provider, policy: policyFor(f), sourceSaysPaid: alwaysPaid },
    inputFor(f, { now: Date.now() }),
  );
  console.log(JSON.stringify({ state: r.state, refusal: r.refusal ?? null, executeCalls, providerWriteIssued: r.providerWriteIssued }));
} catch (e) {
  console.log(JSON.stringify({ state: "THREW", error: (e as Error).message.slice(0, 120), executeCalls }));
}
store.close();
