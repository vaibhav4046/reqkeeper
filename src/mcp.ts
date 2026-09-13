/**
 * The agent-facing surface: an MCP server over stdio.
 *
 * The load-bearing design decision is a negative one. **There is no approve tool.** An agent
 * connected to this server can read an obligation, propose a payment, ask what happened, and
 * ask the chain to confirm it — and it cannot, by any sequence of calls, authorise the money
 * to move. Approval is written only by `scripts/approve.ts`, a separate human CLI that this
 * server does not expose and cannot invoke.
 *
 * That is not a policy toggle or a permission flag that could be misconfigured. The
 * capability is absent from the protocol surface, so "the agent approved its own proposal"
 * is not a state this system can reach. `test/mcp.test.ts` asserts the absence, so adding
 * such a tool later breaks the build.
 *
 * Everything else follows from that: `settle_obligation` is exposed, and is safe to expose,
 * because it reads the approval out of the store rather than accepting one as an argument.
 * An agent calling it before a human has decided gets `AWAITING_APPROVAL` and no send.
 */

import { findPaymentByReference, type PaymentExpectation } from "./chain.ts";
import { assertReferenceMatches, fetchInvoice } from "./request.ts";
import { obligationId } from "./identity.ts";
import type { ExecutionProvider } from "./provider.ts";
import { buildPolicy, buildSourceFacts, buildSteps, FAU, NAMESPACE, type InvoiceFacts } from "./plan.ts";
import { settleObligation } from "./settle.ts";
import { drainUntilQuiet } from "./worker.ts";
import type { Store } from "./store.ts";

export const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_INFO = { name: "reqkeeper", version: "0.1.0" };

export interface McpContext {
  readonly store: Store;
  readonly provider: ExecutionProvider;
  readonly rpcUrl?: string;
  /** Injectable so tests do not need a chain. */
  readonly findPayment?: typeof findPaymentByReference;
  /**
   * Read the invoice from Request itself.
   *
   * Injectable so tests do not need the gateway, and nullable so an offline caller can opt out
   * explicitly — `verifyAgainstRequest: false` — rather than by accident. Facts an agent supplies
   * are a claim; facts Request serves are the invoice.
   */
  readonly fetchInvoice?: typeof fetchInvoice;
  /**
   * Set false ONLY for offline work, and expect the evidence to be tagged TEST.
   *
   * When true (the default) a supplied payment reference that does not equal the one derived
   * from the invoice is refused before any write.
   */
  readonly verifyAgainstRequest?: boolean;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const INVOICE_SCHEMA = {
  type: "object",
  properties: {
    requestId: { type: "string", description: "The canonical Request Network request id." },
    paymentReference: { type: "string", description: "0x-prefixed 8-byte payment reference from the invoice." },
    payee: { type: "string", description: "Recipient address, exactly as the invoice states it." },
    amountBaseUnits: { type: "string", description: "Invoice amount in token base units, as a decimal string. Never a number." },
    maxTotalDebitBaseUnits: { type: "string", description: "Ceiling on the TOTAL debit including fees. Required: there is no safe default." },
    feeAmount: { type: "string", description: "Fee in base units. Defaults to \"0\"." },
    feeAddress: { type: "string", description: "Fee recipient. Defaults to the zero address." },
  },
  required: ["requestId", "paymentReference", "payee", "amountBaseUnits", "maxTotalDebitBaseUnits"],
} as const;

export const TOOLS = [
  {
    name: "propose_payment",
    description:
      "Build and persist a payment plan for a Request Network obligation, and return the exact " +
      "sentence a human must approve. Never dispatches. Always returns AWAITING_APPROVAL on a " +
      "fresh obligation. This is the only tool an agent needs to do its half of the job.",
    inputSchema: INVOICE_SCHEMA,
  },
  {
    name: "settle_obligation",
    description:
      "Attempt to settle an already-approved obligation. Reads the human decision from the " +
      "store; it cannot be supplied as an argument. With no approval recorded this refuses " +
      "with AWAITING_APPROVAL and sends nothing. Calling it twice cannot pay twice.",
    inputSchema: INVOICE_SCHEMA,
  },
  {
    name: "obligation_status",
    description: "Current state and full audit trail for an obligation, by request id.",
    inputSchema: {
      type: "object",
      properties: { requestId: { type: "string" } },
      required: ["requestId"],
    },
  },
  {
    name: "verify_payment",
    description:
      "Independently confirm a payment by reading the ERC20FeeProxy event log off-chain for a " +
      "payment reference. Does not consult the execution provider, so it can contradict it. " +
      "`paid` is true only when the log is corroborated — matched against the facts this " +
      "deployment imported for that reference, or against the transaction it recorded as the " +
      "payment. A bare sighting is reported as `referenceSeen`, because the proxy is " +
      "permissionless and references are public: anyone can emit a log carrying one.",
    inputSchema: {
      type: "object",
      properties: { paymentReference: { type: "string" } },
      required: ["paymentReference"],
    },
  },
  {
    name: "resolve_pending",
    description:
      "Close out a payment that already went out but has not finished: a receipt not yet " +
      "mined, or a Request indexer that has not caught up. Reads chain receipts and the " +
      "event log and moves state accordingly. It has no send path at all, so it can never " +
      "pay anything — which is why it is the correct answer to RECONCILIATION_PENDING and " +
      "EXECUTION_OUTCOME_UNKNOWN, and calling settle_obligation again is not.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "refusal_codes",
    description:
      "The refusal vocabulary: every code this system can answer with, and what it means. " +
      "Useful for an agent deciding whether a refusal is worth retrying.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

/** Refusals an agent must never retry, because retrying cannot change the answer. */
/**
 * A refusal in the same shape the settle path returns, for the checks that happen before it.
 *
 * `providerWriteIssued: false` is the load-bearing field: it is the "zero gas burned" claim,
 * and every refusal on this path is entitled to it because none of them has written anything.
 */
function refusedBeforeWrite(obligationId: string, refusal: string, detail: string) {
  return {
    obligationId,
    state: "POLICY_DENIED" as const,
    refusal,
    detail,
    planHash: null,
    txHash: null,
    providerWriteIssued: false,
    approvalSentence: null,
    agentGuidance:
      TERMINAL_FOR_AGENTS[refusal] ??
      "The invoice Request holds is not the one described. Do not retry with the same facts; re-read the invoice.",
  };
}

const TERMINAL_FOR_AGENTS: Record<string, string> = {
  REFERENCE_MISMATCH:
    "The payment reference does not match the one derived from this invoice. Do not retry: a " +
    "reference you supply is not evidence of a debt. Read the invoice from Request instead.",
  FACTS_DISAGREE_WITH_INVOICE:
    "The invoice Request holds describes a different payment. Do not retry with the same facts.",
  REQUEST_UNREADABLE:
    "The invoice could not be read from Request, so nothing was proposed. This is a read failure, " +
    "not a refusal of the payment; try again when the gateway answers.",
  AWAITING_APPROVAL: "A human has not decided yet. Do not retry; wait to be told.",
  REVIEW_REJECTED: "A human refused this payment. Never retry.",
  ALREADY_DISPATCHED: "This obligation was already sent. Retrying cannot pay it again, and must not try.",
  ALREADY_SETTLED: "Already settled. Nothing to do.",
  PAYEE_NOT_ALLOWED: "The recipient is not on the allowlist. Requires a human policy change.",
  LIMIT_EXCEEDED: "Total debit exceeds the ceiling a human set. Requires a human policy change.",
  TOKEN_DECIMALS_MISMATCH: "The token's decimals disagree with policy. A retry repeats the same mistake.",
  PLAN_CHANGED: "The invoice changed after approval. A new proposal and a new approval are required.",
  PLAN_EXPIRED: "The approval aged out. Propose again.",
  OBLIGATION_RESERVED: "Another plan holds this obligation. Do not race it.",
  CACHED_FAILURE: "The provider is replaying a cached failure. Rotating the key would pay twice; do not.",
  EVIDENCE_CONFLICT: "The provider and the chain disagree. A human must look before anything else happens.",
  RECONCILIATION_PENDING:
    "Paid on chain, not yet indexed by Request. Call resolve_pending; never settle_obligation.",
  EXECUTION_OUTCOME_UNKNOWN:
    "A send happened and its result is unknown. Call resolve_pending to observe it. A retry would pay twice.",
  CALLDATA_MISMATCH:
    "The calldata means something other than the invoice. Fix the bytes, not the retry count.",
  REFERENCE_ALREADY_CLAIMED:
    "Another obligation already holds this payment reference. It is the same debt under a different name.",
  SOURCE_ALREADY_PAID: "The chain already shows this reference paid. There is nothing left to pay.",
  SIMULATION_BLOCKED: "The payment would revert. A retry repeats the revert.",
  // Not "a new plan and a new approval": the state is terminal and not replannable, so that
  // was guidance for a route that does not exist. The reference stays attached to this
  // obligation, so a new invoice is what actually unblocks the debt.
  EXECUTION_REVERTED:
    "The transaction reverted on chain. Nothing moved. This obligation is terminal and keeps " +
    "its payment reference, so raise a new Request invoice for the debt and settle that.",
  SIMULATE_EXECUTED: "A dry run really executed. Treat as a real send and stop.",
};

function toInvoiceFacts(a: Record<string, unknown>): InvoiceFacts {
  const str = (k: string, fallback?: string): string => {
    const v = a[k];
    if (typeof v === "string" && v !== "") return v;
    if (fallback !== undefined) return fallback;
    throw new Error(`"${k}" is required and must be a non-empty string`);
  };
  // Numbers are refused rather than coerced: 1e18 already exceeds Number.MAX_SAFE_INTEGER.
  for (const k of ["amountBaseUnits", "maxTotalDebitBaseUnits", "feeAmount"]) {
    if (typeof a[k] === "number") {
      throw new Error(`"${k}" must be a decimal string, not a number — base units exceed float precision`);
    }
  }
  return {
    requestId: str("requestId"),
    paymentReference: str("paymentReference"),
    payee: str("payee"),
    amountBaseUnits: str("amountBaseUnits"),
    maxTotalDebitBaseUnits: str("maxTotalDebitBaseUnits"),
    feeAmount: str("feeAmount", "0"),
    feeAddress: str("feeAddress", `0x${"0".repeat(40)}`),
  };
}

async function callTool(ctx: McpContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  const findPayment = ctx.findPayment ?? findPaymentByReference;

  switch (name) {
    case "refusal_codes":
      return {
        codes: TERMINAL_FOR_AGENTS,
        note:
          "Every code above is terminal for an agent. If you receive one, the correct action is " +
          "to report it to a human, not to retry with different arguments.",
      };

    case "verify_payment": {
      const reference = String(args.paymentReference ?? "");
      if (!/^0x[0-9a-fA-F]+$/.test(reference)) throw new Error("paymentReference must be 0x hex");

      /**
       * What this deployment already knows about the debt that reference names.
       *
       * `paid: sighting.found` was the whole answer, and the ERC20FeeProxy is permissionless:
       * a red-team pass emitted a log carrying a victim's reference that paid the attacker one
       * unit of a worthless token, and this tool called it a payment. The money path refused
       * the same log on its fields, so the surface an agent asks contradicted the surface that
       * decides.
       *
       * The expectation is RECOVERED from the obligation's own imported facts rather than
       * accepted as an argument: this server has the store beside it, and a caller who could
       * hand over an expectation could hand over one shaped to fit the forgery.
       */
      const known = ctx.store.obligationForReference(reference);
      const recorded = known ? ctx.store.obligationForRecovery(known.obligationId) : undefined;
      const expect = recorded?.expectation ?? undefined;
      const ourTx = known ? (ctx.store.sentAttemptFor(known.obligationId)?.txHash ?? null) : null;

      const sighting = await findPayment(reference, {
        rpcUrl: ctx.rpcUrl,
        ...(expect ? { expect } : {}),
      });

      // With an expectation, `found` already means emitter, token, payee, amount and fee all
      // agreed. Without one — a reference this deployment has never imported — the only thing
      // that can corroborate a sighting is our own record of which transaction paid it.
      const sameTx = ourTx !== null && sighting.txHash?.toLowerCase() === ourTx.toLowerCase();
      const corroboratedBy = sighting.found
        ? expect
          ? "obligation-facts"
          : sameTx
            ? "recorded-transaction"
            : null
        : null;

      const conflicts = [
        ...(sighting.conflicts ?? []),
        ...(ourTx !== null && sighting.txHash !== undefined && !sameTx
          ? [`${sighting.txHash} carries this reference, but this deployment recorded ${ourTx} as the payment`]
          : []),
      ];

      return {
        reference,
        // Only ever true on corroboration. "A log carries this reference" is a sighting, not a
        // settlement, and must not be handed to an agent as one.
        paid: corroboratedBy !== null,
        corroboratedBy,
        referenceSeen: sighting.found === true,
        txHash: sighting.txHash ?? null,
        amountBaseUnits: sighting.amount ?? null,
        tokenAddress: sighting.tokenAddress ?? null,
        to: sighting.to ?? null,
        conflicts: conflicts.length > 0 ? conflicts : null,
        source: "ERC20FeeProxy event log, read directly from the chain",
        blocksScanned: sighting.scannedBlocks ?? null,
        // Said out loud so a false is not mistaken for proof of non-payment: the scan is a
        // bounded window, and a payment older than it would not be seen.
        caveat: !sighting.found
          ? sighting.truncated
            ? "not seen in the scanned window; this is not proof the invoice is unpaid"
            : "scanned to genesis; no payment matching this obligation was found"
          : corroboratedBy === null
            ? "a log carries this reference, but nothing here corroborates that it pays this " +
              "obligation: it was never imported, so there are no facts to match it against"
            : null,
      };
    }

    case "obligation_status": {
      const requestId = String(args.requestId ?? "");
      if (!requestId) throw new Error("requestId is required");
      const oid = obligationId(NAMESPACE, requestId);
      const row = ctx.store.getObligation(oid);
      if (!row) return { known: false, obligationId: oid };
      return {
        known: true,
        obligationId: oid,
        state: row.state,
        auditTrail: ctx.store.auditTrail(oid),
      };
    }

    case "resolve_pending": {
      // Deliberately takes no invoice: resolution is about payments already made, and an
      // agent that could re-describe the invoice here could steer the reconciliation.
      const passes = await drainUntilQuiet(
        {
          store: ctx.store,
          provider: ctx.provider,
          // Uncertainty intact, for the one decision that needs it: whether a simulation that
          // never came back actually executed.
          // The anchor makes a negative conclusive. Without it every negative comes back
          // truncated, the worker refuses to conclude from a truncated scan (correctly), and the
          // obligation stays wedged for ever -- safe, and never recovered.
          sightPayment: (reference: string, expect?: PaymentExpectation, anchorBlock?: number) =>
            findPayment(reference, { rpcUrl: ctx.rpcUrl, lookbackBlocks: 300_000, expect, anchorBlock }),
          sourceSaysPaid: async (requestId: string, txHash: string) => {
            const row = ctx.store.obligationForRecovery(obligationId(NAMESPACE, requestId));
            if (!row?.paymentReference) return false;
            const seen = await findPayment(row.paymentReference, {
              rpcUrl: ctx.rpcUrl,
              lookbackBlocks: 300_000,
              // Recovered from the facts stored at import, so the recovery path matches token,
              // payee and fee, not the reference and amount alone.
              expect: row.expectation ?? undefined,
            });
            // Same questions settle asks: our reference, our transaction, our payment. The
            // amount is re-checked here rather than left to `expect`, so an obligation stored
            // before the expectation existed is still matched on the value that moved.
            return (
              seen.found &&
              seen.txHash?.toLowerCase() === txHash.toLowerCase() &&
              (row.invoiceBaseUnits === null || seen.amount === row.invoiceBaseUnits)
            );
          },
        },
        // An agent asking to resolve is not a timer, so it does not wait out the retry
        // backoff. Everything it can do is still read-only.
        { now: Date.now(), maxPasses: 3, stepMs: 0, lookaheadMs: 60_000 },
      );
      return {
        advanced: passes.flatMap((r) => r.advanced),
        completed: passes.reduce((n, r) => n + r.completed, 0),
        stillPending: ctx.store.pendingJobCount(),
      };
    }

    case "propose_payment":
    case "settle_obligation": {
      const facts = toInvoiceFacts(args);
      const oid = obligationId(NAMESPACE, facts.requestId);

      // Ask the chain whether this reference has already been paid, rather than assuming it
      // has not. A read failure is not evidence of anything, so it leaves the flag false and
      // the later guards — the reference index, the attempt row — still refuse a duplicate.
      // A sighting only means "already paid" when it is not ours. Once this obligation has a
      // dispatched attempt, the same log entry is evidence of the payment we made, and the
      // earlier guards handle the replay. A read failure is not evidence, so it stays false.
      // --- the invoice comes from Request, not from the agent -------------
      //
      // Every guard in this system used to sit downstream of facts the CALLER supplied: the
      // payee, the amount, the fee and — worst of all — the payment reference. An agent that
      // handed over a reference it controlled would be protected, perfectly, all the way to a
      // send, on the wrong debt. Nothing re-derived it.
      //
      // So the invoice is read from Request's own gateway (unauthenticated, no key) and the
      // reference is re-derived as `last8Bytes(keccak256(requestId + salt + paymentAddress))`.
      // A supplied reference that does not equal the derived one is REFERENCE_MISMATCH, refused
      // here, before any write. So is a payee, amount, token or fee the invoice disagrees with.
      //
      // It fails CLOSED: a gateway that cannot be read is not permission to proceed on the
      // agent's word. Offline callers opt out explicitly with `verifyAgainstRequest: false`,
      // and that is a TEST-tagged path by policy.
      // Hoisted out of the verification block below so it survives into the stored facts. A
      // payment cannot predate its invoice, so this block is the floor that lets the recovery
      // scan return a CONCLUSIVE negative; without it every negative is truncated, the worker
      // refuses to conclude from a truncated scan, and an obligation whose dry run failed is
      // wedged for ever. Absent while Request has not confirmed the create, and omitted rather
      // than defaulted -- a zero floor would claim a scan to genesis that never happened.
      let anchorBlock: number | undefined;
      if (ctx.verifyAgainstRequest !== false) {
        const read = ctx.fetchInvoice ?? fetchInvoice;
        let invoice;
        try {
          invoice = await read(facts.requestId);
        } catch (e) {
          return refusedBeforeWrite(
            oid,
            "REQUEST_UNREADABLE",
            `the invoice could not be read from Request (${(e as Error).message}). ` +
              "Facts supplied by a caller are a claim, not an invoice, so nothing is proposed on them.",
          );
        }

        anchorBlock = invoice.anchor?.blockNumber;

        try {
          assertReferenceMatches(facts.paymentReference, invoice.paymentReference);
        } catch (e) {
          return refusedBeforeWrite(oid, "REFERENCE_MISMATCH", (e as Error).message);
        }

        const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
        const disagreements: string[] = [];
        if (!eq(facts.payee, invoice.payee)) {
          disagreements.push(`payee ${facts.payee}, the invoice is payable to ${invoice.payee}`);
        }
        if (facts.amountBaseUnits !== invoice.invoiceBaseUnits) {
          disagreements.push(`amount ${facts.amountBaseUnits}, the invoice is ${invoice.invoiceBaseUnits}`);
        }
        if (facts.feeAmount !== invoice.feeBaseUnits) {
          disagreements.push(`fee ${facts.feeAmount}, the invoice fee is ${invoice.feeBaseUnits}`);
        }
        if (!eq(facts.feeAddress, invoice.feeRecipient)) {
          disagreements.push(`fee recipient ${facts.feeAddress}, the invoice names ${invoice.feeRecipient}`);
        }
        if (!eq(FAU, invoice.tokenAddress)) {
          disagreements.push(`token ${invoice.tokenAddress}, which this deployment does not settle`);
        }
        if (disagreements.length > 0) {
          return refusedBeforeWrite(
            oid,
            "FACTS_DISAGREE_WITH_INVOICE",
            `the caller described a different payment from the one Request holds: ${disagreements.join("; ")}`,
          );
        }
      }

      // One statement of what paying this invoice looks like, shared by the pre-check and
      // the reconciler so the two cannot drift apart.
      const expectation = {
        tokenAddress: FAU,
        to: facts.payee,
        amount: facts.amountBaseUnits,
        feeAmount: facts.feeAmount,
        feeAddress: facts.feeAddress,
      };

      // The already-paid gate, and the one place a boolean is the wrong shape.
      //
      // This check exists SPECIFICALLY to catch a payment this store did not make -- the
      // reference index only ever sees obligations inside this database -- so it is the only
      // thing between the system and paying an invoice somebody already settled elsewhere. It
      // used to read `sighting?.found === true` and default to false on a throw, which collapsed
      // a deliberate tri-state into a boolean and answered "not paid" for BOTH "I looked and
      // nothing paid it" and "I could not look". chain.ts says so in as many words: `found:
      // false` means "I could not tell", never "unpaid".
      //
      // Two ways an unknown reached it. A truncated scan: `truncated` is true whenever the floor
      // sits above the invoice's anchor, and the anchor is absent for any invoice Request has not
      // confirmed yet, and on the whole `verifyAgainstRequest: false` path. And a throw: the
      // chain read raises on chain-id mismatch, on a dead endpoint, on an HTML error page, on a
      // timeout -- none of which is evidence about the invoice.
      //
      // So the outcome is carried as a tri-state and an unknown REFUSES, before any write, at
      // zero gas. Refusing to propose because the chain could not be read is recoverable in a
      // way that paying an invoice twice is not, and it matches what request.ts already does one
      // layer up: a gateway that did not answer is not an invoice that does not exist.
      let paidCheck: "PAID" | "NOT_PAID" | "UNKNOWN" = "NOT_PAID";
      if (!ctx.store.sentAttemptFor(oid)) {
        try {
          // Every field, not the reference and not the amount alone. Nothing has been
          // dispatched yet, so there is no transaction of ours to match against — but a
          // transfer carrying this reference to somebody else, or in another token, does not
          // satisfy this invoice, and treating it as settlement lets anyone who can read a
          // reference off-chain refuse payment of that invoice permanently. References are
          // public: they derive from data anchored openly on Sepolia.
          const sighting = await findPayment(facts.paymentReference, { expect: expectation, anchorBlock });
          // Only an EXPLICIT `truncated: false` is conclusive. An absent flag is not a promise
          // that the window was covered -- it is a reader that did not say, and the entire
          // lesson of this file is that absent must not read as "no".
          paidCheck = sighting?.found === true ? "PAID" : sighting?.truncated === false ? "NOT_PAID" : "UNKNOWN";
        } catch {
          paidCheck = "UNKNOWN";
        }
      }
      if (paidCheck === "UNKNOWN") {
        return refusedBeforeWrite(
          oid,
          "SOURCE_UNVERIFIABLE",
          "the chain could not be read far enough to establish whether this invoice has already " +
            "been paid, so nothing is proposed on it. A scan that did not reach the invoice's own " +
            "anchor block, or that could not run at all, is not evidence that the debt is unpaid. " +
            "Retry when an endpoint answers, or once Request has confirmed the invoice so its " +
            "anchor block bounds the search.",
        );
      }
      const sourceFacts = buildSourceFacts({
        ...facts,
        hasBeenPaid: paidCheck === "PAID",
        ...(anchorBlock === undefined ? {} : { anchorBlock }),
      });

      // propose_payment deliberately passes no approval, so settleObligation stops at the
      // human-authority check. settle_obligation reads whatever a human actually wrote.
      let approval: { approver: string; decision: "APPROVED" | "REJECTED" } | undefined;
      if (name === "settle_obligation") {
        // Approvals are keyed by plan hash, and the plan that reserved this obligation is the
        // one propose_payment persisted. A never-proposed obligation has no reservation, so
        // there is nothing to find and the settle stops at AWAITING_APPROVAL.
        const reserved = ctx.store.getObligation(oid)?.reservedByPlan;
        const recorded = reserved ? ctx.store.getApproval(reserved) : undefined;
        if (recorded?.decision === "APPROVED" || recorded?.decision === "REJECTED") {
          approval = { approver: recorded.approver, decision: recorded.decision };
        }
      }

      const outcome = await settleObligation(
        {
          store: ctx.store,
          provider: ctx.provider,
          policy: buildPolicy(facts),
          sourceSaysPaid: async (_requestId: string, txHash: string) => {
            // Not just "the reference appears somewhere": it must be OUR transaction for
            // OUR amount. A boolean over the reference alone accepts another payment's
            // evidence, which is how a duplicate obligation reported SETTLED.
            const seen = await findPayment(facts.paymentReference, {
              rpcUrl: ctx.rpcUrl,
              lookbackBlocks: 300_000,
              expect: expectation,
            });
            return seen.found && seen.txHash?.toLowerCase() === txHash.toLowerCase();
          },
        },
        {
          namespace: NAMESPACE,
          requestId: facts.requestId,
          paymentReference: facts.paymentReference,
          obligationId: oid,
          facts: sourceFacts,
          steps: buildSteps(facts),
          approval,
          // Milliseconds. planTtlSeconds is multiplied by 1000 downstream, so passing seconds here
    // would stretch a one-hour approval into roughly 41 days.
    now: Date.now(),
          factsAtDispatch: sourceFacts,
        },
      );

      return {
        obligationId: oid,
        state: outcome.state,
        refusal: outcome.refusal ?? null,
        detail: outcome.detail,
        planHash: outcome.planHash ?? null,
        txHash: outcome.txHash ?? null,
        providerWriteIssued: outcome.providerWriteIssued,
        approvalSentence: outcome.restatement ?? null,
        agentGuidance: outcome.refusal
          ? (TERMINAL_FOR_AGENTS[outcome.refusal] ?? "Report this to a human rather than retrying.")
          : outcome.state === "AWAITING_APPROVAL"
            ? TERMINAL_FOR_AGENTS.AWAITING_APPROVAL
            : null,
      };
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Returns null for notifications, which must not be answered. */
export async function handleRequest(
  ctx: McpContext,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions:
            "ReqKeeper settles Request Network invoices exactly once. You can propose a payment " +
            "and check on it. You cannot approve one — there is no tool for that, by design. " +
            "Call propose_payment, show the returned approvalSentence to a human verbatim, and " +
            "stop until they decide.",
        },
      };

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const payload = await callTool(ctx, name, args);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] },
        };
      } catch (e) {
        // Tool failures are reported in-band as isError, per MCP, so the agent can read them.
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `refused: ${(e as Error).message}` }],
            isError: true,
          },
        };
      }
    }

    default:
      if (req.method?.startsWith("notifications/")) return null;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${req.method}` } };
  }
}
