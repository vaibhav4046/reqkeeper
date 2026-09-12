/**
 * One racing worker. Own process, own SQLite connection, own provider.
 *
 * Prints a single JSON line and exits. Everything the parent reports comes from these lines and
 * from the fixture's own counters — never from anything this process asserts about itself.
 */

import { obligationId } from "../src/identity.ts";
import { KeeperHubProvider } from "../src/keeperhub.ts";
import { findPaymentByReference } from "../src/chain.ts";
import { buildPolicy, buildSourceFacts, buildSteps, FAU, NAMESPACE, type InvoiceFacts } from "../src/plan.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";

const [dbPath, baseUrl, rpcUrl, requestId, reference, payee, amount, startAtRaw, orderRaw] = process.argv.slice(2);
const startAt = Number(startAtRaw);

const facts: InvoiceFacts = {
  requestId,
  paymentReference: reference,
  payee,
  amountBaseUnits: amount,
  maxTotalDebitBaseUnits: amount,
  feeAmount: "0",
  feeAddress: `0x${"0".repeat(40)}`,
  hasBeenPaid: false,
};

const say = (o: Record<string, unknown>) =>
  console.log(JSON.stringify({ pid: process.pid, startOrder: Number(orderRaw), ...o }));

let store: Store | undefined;
try {
  // Opening is itself contended — two processes creating one schema at the same instant is the
  // exact scenario, and the constructor retries rather than dying on `database is locked`.
  store = new Store(dbPath);

  // `baseUrl === "LIVE"` means the real platform and the real chain. Everything else is the
  // counting fixture. The provider, the calldata gate and the settle path are identical either
  // way — only where the bytes go changes, which is the point: a live run that exercised a
  // different code path would prove nothing about the fixture runs.
  const live = baseUrl === "LIVE";
  const apiKey = process.env.KEEPERHUB_API_KEY ?? "";
  if (live && !apiKey) throw new Error("--live needs KEEPERHUB_API_KEY");
  const provider = new KeeperHubProvider({
    apiKey: live ? apiKey : "kh_fixture",
    chainId: 11155111,
    rpcUrl,
    ...(live ? {} : { baseUrl }),
  });

  // Barrier. Both processes are already warm; they enter settleObligation on the same tick.
  while (Date.now() < startAt) {
    /* spin */
  }

  const outcome = await settleObligation(
    {
      store,
      provider,
      policy: buildPolicy(facts),
      // Reconciliation asks the fixture the same three questions the real path asks the chain:
      // our reference, our transaction, our amount.
      sourceSaysPaid: async (_requestId: string, txHash: string) => {
        // Three questions, whichever chain is behind it: our reference, our transaction, our
        // amount. A boolean over the reference alone accepts another payment's evidence.
        if (live) {
          const seen = await findPaymentByReference(reference, {
            rpcUrl,
            lookbackBlocks: 300_000,
            expect: { tokenAddress: FAU, to: payee, amount },
          });
          return seen.found && seen.txHash?.toLowerCase() === txHash.toLowerCase();
        }
        const res = await fetch(
          `${rpcUrl.replace(/\/rpc$/, "")}/paid?reference=${encodeURIComponent(reference)}&txHash=${encodeURIComponent(txHash)}`,
        );
        const body = (await res.json()) as { paid?: boolean; amount?: string };
        return body.paid === true && body.amount === amount;
      },
    },
    {
      namespace: NAMESPACE,
      requestId,
      paymentReference: reference,
      obligationId: obligationId(NAMESPACE, requestId),
      facts: buildSourceFacts(facts),
      steps: buildSteps(facts),
      approval: { approver: "human:owner", decision: "APPROVED" },
      now: Date.now(),
    },
  );

  say({
    state: outcome.state,
    refusal: outcome.refusal ?? null,
    providerWriteIssued: outcome.providerWriteIssued,
    txHash: outcome.txHash ?? null,
    planHash: outcome.planHash ?? null,
  });
} catch (e) {
  // A thrown refusal is still a refusal. It is reported, never swallowed, because a worker that
  // died is a worker that did not pay and the artifact has to be able to say which.
  say({ state: "THREW", refusal: (e as Error).message.slice(0, 140), providerWriteIssued: false, txHash: null });
} finally {
  store?.close();
}
