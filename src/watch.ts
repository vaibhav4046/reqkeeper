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
 * **It cannot approve. It CAN dispatch what a human has approved — and that is the point.**
 *
 * This docblock used to say "it cannot pay, by construction", reasoning that no `approval` is
 * passed to `settleObligation` and no argument on this path could supply one. That argument
 * described the caller-authority model, which was removed: `settleObligation` reads the decision
 * from the STORE, keyed by plan hash, so the approval `scripts/approve.ts` writes is picked up on
 * this poller's next tick. Not passing one changes nothing. A reviewer demonstrated it in two
 * passes — propose, a human approves at the CLI, and the next tick dispatched.
 *
 * That behaviour is correct and is the documented workflow: `watchPass` prints the approve
 * command itself. What was wrong was the claim. The real property is narrower and worth stating
 * exactly: **this module can never be the thing that decides.** It writes no approval, imports
 * nothing that can, and every payment it dispatches was authorised by a person at a separate
 * command, against a plan hash recomputed from the invoice rather than taken from the proposal.
 *
 * The shipped wiring also defaults `deps.provider` to one that refuses every write
 * (`NO_DISPATCH_PROVIDER`), so a deployment that has not deliberately handed this loop a real
 * provider cannot dispatch at all. That is a belt, not the braces, and it is named as a belt
 * here because the braces in the old paragraph did not exist.
 */

import { matchPaymentLog, verdictFor, type PaymentExpectation, type PaymentSighting } from "./chain.ts";
import { fetchInvoice } from "./request.ts";
import { obligationId } from "./identity.ts";
import type { State } from "./machine.ts";
import { buildPolicy, buildSourceFacts, buildSteps, FAU, NAMESPACE, type InvoiceFacts } from "./plan.ts";
import type { ExecuteResult, ExecutionProvider, Receipt, SimulateOutcome } from "./provider.ts";
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
  /** The token this invoice is denominated in, as Request states it. FAU when unstated. */
  readonly tokenAddress?: string;
  /** The payment address is not the party of record. Carried to the sentence a human reads. */
  readonly payeeDiffersFromRecord?: boolean;
  /** Actions on the channel that did not authenticate, ignored as Request ignores them. */
  readonly ignoredActions?: number;
  /**
   * Where Request anchored this invoice on Sepolia, when the caller knows it.
   *
   * A payment cannot predate its invoice, so this is the floor that lets a negative chain scan be
   * CONCLUSIVE rather than merely unobserved -- which is what the recovery path needs before it
   * may release an obligation whose dry run never answered. The watcher is handed a list rather
   * than reading the gateway itself, so whether an anchor exists depends on the feed:
   * `docs/live-invoices.json` records none, so obligations proposed from that list carry none and
   * their recovery needs an anchor from a resolver that has read the invoice. That is a gap in
   * the feed, not a hole in the guard -- with no anchor the negative stays inconclusive and
   * nothing is released.
   */
  readonly anchorBlock?: number;
}

export interface WatchRow {
  readonly requestId: string;
  readonly paymentReference: string;
  /** What the ERC20FeeProxy log says, not what any API or local row claims. */
  readonly chainSaysPaid: boolean;
  readonly state: State | "PAID_ON_CHAIN" | "UNREAD";
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
   * Read one invoice from Request. Injectable so a test never touches the gateway.
   *
   * The facts a proposal is built from come from HERE, not from the caller's list. The list is a
   * list of request ids; everything that decides money -- the reference, the payee, the amount
   * with every signed channel action applied, the token, the bound anchor -- is re-derived from
   * what Request serves.
   */
  readonly fetchInvoice?: typeof fetchInvoice;
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
    /**
     * The invoice's own anchor block, the floor below which no payment for it can exist.
     *
     * There was no parameter for it, so every scan on this path was truncated by construction and
     * the already-paid screen could never conclude -- on the surface that hands a human an
     * approve command.
     */
    anchorBlock?: number,
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
  async simulate(): Promise<SimulateOutcome> {
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
    ...(inv.tokenAddress === undefined ? {} : { tokenAddress: inv.tokenAddress }),
    ...(inv.payeeDiffersFromRecord ? { payeeDiffersFromRecord: true } : {}),
    ...(inv.anchorBlock === undefined ? {} : { anchorBlock: inv.anchorBlock }),
  };
}

/** What paying this invoice has to look like. One statement, used by the scan and the check. */
function expectationFor(f: InvoiceFacts): PaymentExpectation {
  return {
    // The invoice's token, with FAU only as the fallback for a caller that names none. It was
    // hardcoded, so a scan for a payment in any other token matched on everything but the token
    // and then compared FAU against FAU -- a check comparing a constant with itself.
    tokenAddress: f.tokenAddress ?? FAU,
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

  for (const listed of invoices) {
    // The invoice comes from Request, not from the file.
    //
    // This path read `docs/live-invoices.json` verbatim -- reference, payee, amount, fee -- and
    // never asked Request anything, while its own docblock said Request's state is what causes a
    // proposal to exist. `src/request.ts` exists because "a single wrong paymentReference in a
    // local file does not break the machine; it aims it", and this was the one caller aiming it.
    //
    // The file is a list of request ids now. Everything else is re-derived: the reference against
    // the invoice's own salt and payment address, the amount with every signed channel action
    // applied, the anchor bound to the transaction that stored it. A gateway that will not answer
    // means this invoice is skipped this pass, which costs a poll, never a payment.
    let inv: WatchInvoice;
    try {
      const read = await (deps.fetchInvoice ?? fetchInvoice)(listed.requestId);
      inv = {
        requestId: read.requestId,
        paymentReference: read.paymentReference,
        payee: read.payee,
        amountBaseUnits: read.invoiceBaseUnits,
        feeAmount: read.feeBaseUnits,
        feeAddress: read.feeRecipient,
        tokenAddress: read.tokenAddress,
        ...(read.anchor === undefined ? {} : { anchorBlock: read.anchor.blockNumber }),
        // Carried to the approval sentence. `src/request.ts` computes this and says it reaches
        // the human; both production callers dropped it, so the control existed only in prose.
        ...(read.payeeDiffersFromRecord ? { payeeDiffersFromRecord: true } : {}),
        ...(read.ignoredActions?.length ? { ignoredActions: read.ignoredActions.length } : {}),
      };
    } catch (e) {
      rows.push({
        requestId: listed.requestId,
        paymentReference: listed.paymentReference,
        chainSaysPaid: false,
        state: "UNREAD",
        refusal: "REQUEST_UNREADABLE",
        detail: `Request did not answer for this invoice (${(e as Error).message.slice(0, 140)}); nothing proposed`,
        planHash: null,
        providerWriteIssued: false,
        approvalCommand: null,
      });
      continue;
    }
    const facts = factsFor(inv);
    // With the anchor the invoice was just read with. Without it every scan on this path was
    // truncated by construction -- `truncated = floor > 0` -- so the watcher's already-paid screen
    // could never conclude anything, and the answer it could never reach was the one that decides
    // whether an invoice is proposed at all. The anchor was read three lines above and dropped.
    const sighting = await deps.findPayment(
      inv.paymentReference,
      expectationFor(facts),
      inv.anchorBlock,
    );
    // Through the shared verdict, with corroboration required. Reading `sighting.found` directly
    // meant a positive only ONE endpoint could see -- the primary having already said no --
    // marked the invoice PAID_ON_CHAIN and suppressed it from ever being proposed again.
    // chain.ts reports that case as uncorroborated precisely so it cannot settle anything, and
    // this was the caller treating it as settlement. Suppressing a real debt for ever is the
    // mirror of paying it twice, and just as permanent.
    const verdict = verdictFor(sighting, { requireCorroboration: true });

    // Four answers, four rows. This collapsed all of them but PAID into one branch that wrote
    // `chainSaysPaid: false` -- rendered to an operator as the word "unpaid" -- and attached a
    // ready-to-paste approve command.
    //
    // So a scan that could not reach the invoice's anchor, a positive no second endpoint would
    // confirm, and a log paying OUR payee in OUR token for the wrong amount were all presented to
    // a human as "this debt is unpaid, here is the command to approve it". The MCP surface
    // refuses exactly those sightings (SOURCE_UNVERIFIABLE) and the live settle script exits 2 on
    // them. Same sighting, three readings, and the weakest one had a person's finger on the
    // button. That is the defect this whole codebase is organised against, on the one path where
    // the machine is not the last line.
    // A log that pays SOMEBODY ELSE says nothing about this debt, whoever saw it.
    //
    // Narrow on purpose. Diverting every non-PAID verdict would hand the grief case back its
    // win: a stranger emits one log carrying this invoice's public reference, the scan returns a
    // positive that pays somebody else, and the invoice is refused for ever -- never proposed,
    // never approved, never paid, with no refusal anywhere that explains the silence. That is the
    // damage this row exists to prevent, and it fails safe on money, which is exactly why it
    // survived so long. Foreign logs fall through to the proposal below, named in the detail.
    const foreignPositive = sighting.found === true && !paysThisInvoice(sighting, facts).ok;
    // A conflict a human has already read and cleared, hash by hash, is not a conflict here
    // either -- the same reading the propose gate and the worker take.
    const clearedConflict = (() => {
      if (verdict.kind !== "CONFLICT_OURS") return false;
      const reviewed = deps.store.reviewedConflicts(obligationId(NAMESPACE, inv.requestId));
      const named = (verdict.conflictingLogs ?? []).map((log) => log.txHash);
      return named.length > 0 && named.every((h) => typeof h === "string" && reviewed.has(h.toLowerCase()));
    })();
    if (!foreignPositive && !clearedConflict && (verdict.kind === "UNKNOWN" || verdict.kind === "CONFLICT_OURS")) {
      rows.push({
        requestId: inv.requestId,
        paymentReference: inv.paymentReference,
        chainSaysPaid: false,
        state: "UNREAD",
        refusal: "SOURCE_UNVERIFIABLE",
        detail:
          verdict.kind === "CONFLICT_OURS"
            ? `${verdict.detail}. Nobody else has a reason to pay this payee, in this token, under ` +
              "this reference: that is either this invoice settled outside this system or our own " +
              "funds moving in a plan nobody made. Not proposed, and no approval command offered."
            : `the chain could not say whether this invoice is already paid (${verdict.reason}): ` +
              `${verdict.detail}. Nothing is proposed on a scan that did not conclude.`,
        planHash: null,
        providerWriteIssued: false,
        // Deliberately null. The command is the dangerous half: a human who is handed one reads
        // the row as a decision waiting to be made rather than a question nobody answered.
        approvalCommand: null,
      });
      continue;
    }

    const paid = verdict.kind === "PAID" ? paysThisInvoice(sighting, facts) : { ok: false, conflicts: [] };
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
    // What the chain just said, carried into the plan rather than discarded.
    //
    // `hasBeenPaid` was never set here, so `plan.ts` defaulted it to false and `SOURCE_ALREADY_PAID`
    // was structurally unreachable on this path -- while `plan.ts` says in as many words that a
    // caller which can read the chain must read it and pass the answer. This caller read it and
    // threw the answer away.
    // `paid.ok`, not `verdict.kind === "PAID"`: a corroborated log that pays somebody ELSE is a
    // payment, just not of this invoice, and marking the debt settled on it is how a real
    // obligation disappears.
    const sourceFacts = buildSourceFacts({ ...facts, hasBeenPaid: paid.ok });
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
        ...(inv.ignoredActions ? { ignoredActions: inv.ignoredActions } : {}),
        requestId: inv.requestId,
        paymentReference: inv.paymentReference,
        obligationId: obligationId(NAMESPACE, inv.requestId),
        facts: sourceFacts,
        steps: buildSteps(facts),
        // No `approval` key -- but that is no longer what stops a dispatch, and pretending it is
        // was the bug in this file's own docblock. `settleObligation` reads the decision from the
        // store by plan hash, so a human who approved this exact plan at the CLI is honoured on
        // the next tick. What this line does mean is that the POLLER never supplies one: every
        // payment from here traces to a person at a separate command.
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
