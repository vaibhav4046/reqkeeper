/**
 * One settlement, killed dead at one checkpoint.
 *
 * `REQKEEPER_CRASH_AT` names the moment. The process dies there by a real SIGKILL to its own
 * pid — not an exception, not `process.exit` — because a crash that unwinds cleanly is not a
 * crash: `finally` runs, the SQLite handle closes tidily, and the harness would be measuring
 * an orderly shutdown while claiming to measure a kill -9.
 *
 * The kill points cannot live inside `settleObligation`. Nothing in `src/` knows this harness
 * exists and it has to stay that way, or the thing under test stops being the shipped code.
 * So they are driven from outside, through the two collaborators settle actually calls:
 *
 *   the store     every method routed through a Proxy, so a checkpoint fires immediately
 *                 before or immediately after one specific durable write commits
 *   the provider  a wrapper around the real KeeperHubProvider, so `execute` can die on entry
 *                 (attempt row committed, provider never called) or die after the POST came
 *                 back (money moved, reply lost)
 *
 * The provider underneath is the real one, pointed at the counting fixture. The fixture runs
 * in the parent's process and counts every POST that reaches it, which is the only way "did
 * this crash send money?" can be answered honestly: an in-process stub dies with the process
 * it was counting, taking its count with it.
 *
 * Output is one JSON line written with `writeSync`, not `console.log`. stdout to a pipe is
 * asynchronous on Windows, so a buffered write followed by SIGKILL loses the line — and the
 * line is how the parent learns the checkpoint was reached at all.
 */

import { writeSync } from "node:fs";

import { obligationId } from "../src/identity.ts";
import { KeeperHubProvider } from "../src/keeperhub.ts";
import { buildPolicy, buildSourceFacts, buildSteps, NAMESPACE, type InvoiceFacts } from "../src/plan.ts";
import type { ExecutionProvider } from "../src/provider.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";

const [dbPath, baseUrl, rpcUrl, requestId, reference, payee, amount] = process.argv.slice(2);
const CRASH_AT = process.env.REQKEEPER_CRASH_AT ?? "";
const origin = rpcUrl.replace(/\/rpc$/, "");

const say = (o: Record<string, unknown>): void => {
  writeSync(1, `${JSON.stringify({ pid: process.pid, ...o })}\n`);
};

/**
 * Die here, if here is the chosen checkpoint.
 *
 * SIGKILL to self is delivered before the kill() syscall returns, so nothing after this line
 * runs. The unreachable spin below is the guarantee rather than a comment about one: if a
 * platform ever failed to honour the signal, the process must hang and be reaped by the
 * parent's spawn timeout, never quietly carry on past a checkpoint it claimed to crash at.
 */
function die(point: string): void {
  if (CRASH_AT !== point) return;
  say({ crashedAt: point });
  process.kill(process.pid, "SIGKILL");
  for (;;) {
    /* unreachable: the kill above is synchronous */
  }
}

/**
 * The store, with checkpoints on the writes that matter.
 *
 * A Proxy rather than a subclass because `Store` holds its database in a `#private` field:
 * every call is forwarded with the real instance as `this`, so the durable behaviour is the
 * shipped behaviour and only the timing of death is ours.
 */
function crashingStore(real: Store): Store {
  return new Proxy(real, {
    get(target, prop) {
      const member = Reflect.get(target, prop) as unknown;
      if (typeof member !== "function") return member;
      const call = member as (...a: unknown[]) => unknown;
      return (...args: unknown[]): unknown => {
        // The reservation is the first durable claim on the debt. Before it, an obligation row
        // and a plan exist and nothing owns them.
        if (prop === "reserveObligation") die("before_reservation");
        // Reconciliation has already answered yes; only the state write is missing.
        if (prop === "setState" && args[1] === "SETTLED") die("after_reconcile");
        const result = call.apply(target, args);
        if (prop === "reserveObligation") die("after_reservation");
        // The human decision is on the record and the obligation is APPROVED.
        if (prop === "setState" && args[1] === "APPROVED") die("after_approval");
        // The attempt row and its outbox job are committed; `first_send_at` is still null.
        if (prop === "openAttempt") die("after_open_attempt");
        return result;
      };
    },
  }) as Store;
}

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

let store: Store | undefined;
try {
  store = new Store(dbPath);
  const chain = new KeeperHubProvider({ apiKey: "kh_fixture", chainId: 11155111, rpcUrl, baseUrl });

  const provider: ExecutionProvider = {
    simulate: (body) => chain.simulate(body),
    async execute(body, key) {
      // `markSent` stamped `first_send_at` and the state is PAYMENT_EXECUTING, but the POST
      // has not left yet. This is the "did we send?" case, and the honest answer is no.
      die("after_mark_sent_before_execute");
      const executed = await chain.execute(body, key); // the money moves HERE
      die("after_execute_before_receipt"); // sent, and the reply never got home
      return executed;
    },
    observe: (id) => chain.observe(id),
    async receipt(hash) {
      // Polling the chain for a payment that has already been recorded as sent.
      die("while_polling");
      return chain.receipt(hash);
    },
  };

  const outcome = await settleObligation(
    {
      store: crashingStore(store),
      provider,
      policy: buildPolicy(facts),
      sourceSaysPaid: async (_requestId: string, txHash: string) => {
        // The receipt is read and confirmed; the independent source has not been asked yet.
        die("after_receipt_before_reconcile");
        const res = await fetch(
          `${origin}/paid?reference=${encodeURIComponent(reference)}&txHash=${encodeURIComponent(txHash)}`,
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

  // Only reached when the chosen checkpoint never fired. The parent reports that as
  // `reached: false` rather than scoring the row, because a checkpoint that did not happen
  // proves nothing about crashing there.
  say({ state: outcome.state, refusal: outcome.refusal ?? null, crashedAt: null });
} catch (e) {
  say({ state: "THREW", refusal: (e as Error).message.slice(0, 140), crashedAt: null });
} finally {
  store?.close();
}
