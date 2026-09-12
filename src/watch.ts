/**
 * Request Network's own state, used as the thing that starts the work.
 *
 * Everywhere else in this repository the work begins with a human typing a command —
 * `settle-live.ts`, `live-harness.ts`, an agent calling the MCP server — and the invoice is
 * consulted only afterwards, to reconcile. That makes the integration one-directional:
 * KeeperHub executes what somebody already asked for, and Request never triggers anything.
 *
 * This is the other direction. An invoice the chain has never seen paid is the trigger: read
 * the invoices this deployment knows about, ask a public RPC which of their payment
 * references are absent from the ERC20FeeProxy log, and propose exactly those. Request's own
 * state is what causes a proposal to exist.
 *
 * **It cannot pay, by construction.** No approval is passed to `settleObligation`, so every
 * proposal stops at the human gate with `AWAITING_APPROVAL` and nothing is dispatched — and
 * there is no argument on this path that could supply one, because approvals are written
 * only by `scripts/approve.ts`, which this module neither imports nor can invoke. The
 * provider it runs with refuses every write outright, so an edit that somehow reached
 * dispatch would fail loudly rather than quietly pay. A poller that could approve its own
 * proposals would be an agent paying invoices on a timer, which is the exact thing this
 * project exists to make impossible.
 */

import { matchPaymentLog, type PaymentExpectation, type PaymentSighting } from "./chain.ts";
import { obligationId } from "./identity.ts";
import type { State } from "./machine.ts";
import { buildPolicy, buildSourceFacts, buildSteps, FAU, NAMESPACE, type InvoiceFacts } from "./plan.ts";
import type { ExecuteResult, ExecutionProvider, Receipt, SimulateResult } from "./provider.ts";
import { settleObligation } from "./settle.ts";
import type { StandingPolicy } from "./standing-policy.ts";
import type { Store } from "./store.ts";

/**
 * What one entry of `docs/live-invoices.json` has to carry for this to run. The file holds
 * more than this (a salt, an index, a creation state); none of it belongs in a payment plan,
 * so none of it is read here.
 */
export interface WatchInvoice {
  readonly requestId: string;
  readonly paymentReference: string;
  readonly payee: string;
  readonly amountBaseUnits: string;
  readonly feeAmount?: string;
  readonly feeAddress?: string;
}

export interface WatchRow {
  readonly requestId: string;
  readonly paymentReference: string;
  /** What the ERC20FeeProxy log says, not what any API or local row claims. */
  readonly chainSaysPaid: boolean;
  readonly state: State | "PAID_ON_CHAIN";
  readonly refusal: string | null;
  readonly detail: string;
  readonly planHash: string | null;
  /** Must be false on every row. A poller that issued a provider write is a bug, not a poll. */
  readonly providerWriteIssued: boolean;
  /** The exact `scripts/approve.ts` invocation for a row waiting on a human; null otherwise. */
  readonly approvalCommand: string | null;
}

export interface WatchDeps {
  readonly store: Store;
  /**
   * Injected so a test never touches the network, and so the caller decides which RPC and
   * how far back to look. A read that fails is not evidence of anything and must throw
   * rather than resolve to "unpaid": a swallowed RPC error would look exactly like an
   * invoice nobody has paid, and this loop's answer to that is to propose one.
   *
   * `expect` is what paying THIS invoice looks like, passed through so the scan can skip a
   * log that merely carries the reference. An implementation that ignores it is not a
   * shortcut to a wrong verdict — `watchPass` re-checks the returned fields itself.
   */
  readonly findPayment: (
    paymentReference: string,
    expect: PaymentExpectation,
  ) => Promise<PaymentSighting>;
  /**
   * Where the plans this pass writes actually live.
   *
   * Only used to print an approval command that points at the same database. approve.ts
   * defaults to .data/live.sqlite, so a --db run that did not pass this along would print a
   * command recording an approval against a store with no such plan in it.
   */
  readonly dbPath?: string;
  /** Defaults to the provider that refuses to write. Tests pass a counting one instead. */
  readonly provider?: ExecutionProvider;
  /**
   * The operator's ceilings, read once by the caller rather than per invoice, so a run
   * cannot be half-governed by an env var that changed underneath it.
   */
  readonly standing?: StandingPolicy;
}

function refuse(): never {
  throw new Error(
    "the Request watcher has no dispatch path: it proposes, a human approves with " +
      "scripts/approve.ts, and only then may anything be sent",
  );
}

/**
 * A provider that cannot execute anything.
 *
 * `settleObligation` requires one, and with no approval it never reaches simulate or execute
 * — but "never reaches" is an argument about the current code, and this is the same argument
 * enforced by the object itself. If a later edit lets an unapproved plan fall through to
 * dispatch, this throws where a real provider would have paid.
 */
export const NO_DISPATCH_PROVIDER: ExecutionProvider = {
  async simulate(): Promise<SimulateResult> {
    refuse();
  },
  async execute(): Promise<ExecuteResult> {
    refuse();
  },
  async observe(): Promise<ExecuteResult> {
    refuse();
  },
  async receipt(): Promise<Receipt> {
    refuse();
  },
};

/**
 * The ceiling for an invoice nobody has typed a number for.
 *
 * `InvoiceFacts.maxTotalDebitBaseUnits` has no safe default, and a poller has no human in
 * the room to supply one. So the cap is exactly what the invoice asks for and not a unit
 * more: an invoice can never authorise more than it states, and the operator's standing
 * `REQKEEPER_MAX_DEBIT` still clamps it downward — `buildPolicy` takes the lower of the two.
 * Anything looser here would be this file inventing a ceiling on a human's behalf.
 */
function factsFor(inv: WatchInvoice): InvoiceFacts {
  const fee = inv.feeAmount ?? "0";
  return {
    requestId: inv.requestId,
    paymentReference: inv.paymentReference,
    payee: inv.payee,
    amountBaseUnits: inv.amountBaseUnits,
    feeAmount: fee,
    feeAddress: inv.feeAddress ?? `0x${"0".repeat(40)}`,
    maxTotalDebitBaseUnits: (BigInt(inv.amountBaseUnits) + BigInt(fee)).toString(),
  };
}

/** What paying this invoice has to look like. One statement, used by the scan and the check. */
function expectationFor(f: InvoiceFacts): PaymentExpectation {
  return {
    tokenAddress: FAU,
    to: f.payee,
    amount: f.amountBaseUnits,
    feeAmount: f.feeAmount,
    feeAddress: f.feeAddress,
  };
}

/**
 * Does the sighting actually pay this invoice, or does it merely carry its reference?
 *
 * `found` alone used to be the whole test, and references are public: they derive from data
 * anchored openly on Sepolia, so anyone can read one off-chain and emit a fee-proxy event
 * carrying it. That event would have marked this invoice PAID_ON_CHAIN on every future pass —
 * never proposed, never approved, never paid, with no refusal anywhere to explain why. It
 * fails safe on money, which is exactly why it is easy to miss: the damage is a real debt
 * suppressed rather than a wrong one paid.
 *
 * A sighting missing the payment fields is not evidence either, and is treated as unpaid —
 * the cost of being wrong in that direction is a proposal a human looks at. The emitter is
 * not among the fields a sighting carries; `findPaymentByReference` pins it by querying the
 * ERC20FeeProxy address directly, and `expect` is passed down so it applies the same match.
 */
function paysThisInvoice(s: PaymentSighting, f: InvoiceFacts): { ok: boolean; conflicts: string[] } {
  const { tokenAddress, to, amount, feeAmount, feeAddress } = s;
  if (
    tokenAddress === undefined ||
    to === undefined ||
    amount === undefined ||
    feeAmount === undefined ||
    feeAddress === undefined
  ) {
    return { ok: false, conflicts: ["the sighting carries no payment fields, so it corroborates nothing"] };
  }
  return matchPaymentLog({ tokenAddress, to, amount, feeAmount, feeAddress }, expectationFor(f));
}

/**
 * The command a human runs next, with the numbers this proposal actually used.
 *
 * `approve.ts` recomputes the plan hash from these arguments and refuses if it does not
 * match the plan that reserved the obligation. So printing a convenient-looking command with
 * a rounder `--max` than the one above would produce a hash for a plan nothing proposed and
 * a refusal the operator cannot explain. Every flag here is the value that was hashed.
 */
function approvalCommand(f: InvoiceFacts, dbPath?: string): string {
  return (
    "node --experimental-strip-types scripts/approve.ts" +
    // The store the plan actually lives in. Printing this only when it is not the default
    // keeps the common case short, and stops a --db run from handing the operator a command
    // that records an approval in a different database from the one holding the plan.
    (dbPath && dbPath !== ".data/live.sqlite" ? ` --db=${dbPath}` : "") +
    ` --requestId=${f.requestId}` +
    ` --reference=${f.paymentReference}` +
    ` --payee=${f.payee}` +
    ` --amount=${f.amountBaseUnits}` +
    ` --max=${f.maxTotalDebitBaseUnits}` +
    ` --fee=${f.feeAmount}` +
    ` --feeAddress=${f.feeAddress}`
  );
}

/**
 * One pass over the invoices. Sequential on purpose: these are chain reads against a public
 * node with a rate limit, and forty parallel scans is how a free RPC starts answering 429 to
 * a loop whose whole job is to read.
 */
export async function watchPass(
  deps: WatchDeps,
  invoices: readonly WatchInvoice[],
  now = Date.now(),
): Promise<WatchRow[]> {
  const provider = deps.provider ?? NO_DISPATCH_PROVIDER;
  const rows: WatchRow[] = [];

  for (const inv of invoices) {
    const facts = factsFor(inv);
    const sighting = await deps.findPayment(inv.paymentReference, expectationFor(facts));
    const paid = sighting.found ? paysThisInvoice(sighting, facts) : { ok: false, conflicts: [] };
    if (paid.ok) {
      // Paid means there is no obligation to propose, so nothing is imported and no
      // obligation row is created. Proposing here would be harmless — the policy gate would
      // refuse it as SOURCE_ALREADY_PAID — but it would fill the store with settled debts
      // this deployment never owed, and the point of the trigger is that it fires on unpaid
      // invoices only.
      rows.push({
        requestId: inv.requestId,
        paymentReference: inv.paymentReference,
        chainSaysPaid: true,
        state: "PAID_ON_CHAIN",
        refusal: null,
        detail:
          `already paid on chain in ${sighting.txHash ?? "an unnamed transaction"}, for this ` +
          "invoice's token, payee, amount and fee; nothing to propose",
        planHash: null,
        providerWriteIssued: false,
        approvalCommand: null,
      });
      continue;
    }

    // A miss inside a truncated window means "not seen recently", never "unpaid" — and so
    // does a log that carries the reference but pays somebody else. The consequence of being
    // wrong here is a proposal, not a payment, and the reference index and the attempt guard
    // both still refuse a duplicate further down. So a short window, or a forged log, costs
    // an extra row for a human to look at, and cannot cost money.
    const sourceFacts = buildSourceFacts(facts);
    const outcome = await settleObligation(
      {
        store: deps.store,
        provider,
        policy: buildPolicy(facts, deps.standing),
        // Unreachable without an approval, and it is the caller after the human — the
        // resolver, or the MCP server — that owns reconciliation. Answering false rather
        // than throwing keeps a long-running poller alive if that assumption ever breaks.
        sourceSaysPaid: async () => false,
      },
      {
        namespace: NAMESPACE,
        requestId: inv.requestId,
        paymentReference: inv.paymentReference,
        obligationId: obligationId(NAMESPACE, inv.requestId),
        facts: sourceFacts,
        steps: buildSteps(facts),
        // No `approval` key. Not undefined-because-nothing-was-found: absent, always, on
        // every pass. This is the line that makes the poller a proposer.
        now,
      },
    );

    rows.push({
      requestId: inv.requestId,
      paymentReference: inv.paymentReference,
      chainSaysPaid: false,
      state: outcome.state,
      refusal: outcome.refusal ?? null,
      // A log that carried the reference and paid something else is not a footnote: it is
      // either an attack or a misconfiguration, and it is the reason this row exists at all.
      detail:
        paid.conflicts.length > 0
          ? `${outcome.detail} (a log carries this reference but does not pay this invoice: ${paid.conflicts.join("; ")})`
          : outcome.detail,
      planHash: outcome.planHash ?? null,
      providerWriteIssued: outcome.providerWriteIssued,
      approvalCommand: outcome.state === "AWAITING_APPROVAL" ? approvalCommand(facts, deps.dbPath) : null,
    });
  }

  return rows;
}
