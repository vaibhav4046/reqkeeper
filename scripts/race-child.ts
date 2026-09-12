/**
 * One racing worker. Own process, own SQLite connection, own provider.
 *
 * Prints a single JSON line and exits. Everything the parent reports comes from these lines and
 * from the fixture's own counters — never from anything this process asserts about itself.
 */

import { obligationId } from "../src/identity.ts";
import { KeeperHubProvider } from "../src/keeperhub.ts";
import { buildPolicy, buildSourceFacts, buildSteps, NAMESPACE, type InvoiceFacts } from "../src/plan.ts";
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
  const provider = new KeeperHubProvider({
    apiKey: "kh_fixture",
    chainId: 11155111,
    rpcUrl,
    baseUrl,
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
