/**
 * The hosted agent surface. Read-only, and unable to move money by construction.
 *
 * The stdio server in `src/mcp.ts` can propose and settle, because it runs beside a durable
 * store and beside the human who approves. This one runs on someone else's machine, reachable
 * by anyone with the URL, and the correct number of payment tools for that situation is zero.
 * `propose_payment` and `settle_obligation` are not disabled here or permission-flagged: they
 * are absent, the same way `approve` is absent from the local server.
 *
 * What it does serve is the evidence — the live rows, the refusal vocabulary, and a chain read
 * anyone can reproduce without a credential. That is the half of the system a stranger has any
 * business calling.
 */

import { findPaymentByReference, verdictFor, type PaymentExpectation } from "./chain.ts";
import { EVIDENCE } from "./evidence.generated.ts";

export const PUBLIC_SERVER_INFO = { name: "reqkeeper-public", version: "0.1.0" };

export const PUBLIC_TOOLS = [
  {
    name: "settlement_evidence",
    description:
      "Every settlement this project has landed on Sepolia, with its refusal code, physical " +
      "send count and transaction hash. Optionally filtered by outcome. This is the harness's " +
      "own output, not a summary written by hand.",
    inputSchema: {
      type: "object",
      properties: {
        outcome: { type: "string", description: "e.g. SETTLED, ALREADY_SETTLED, PAYEE_NOT_ALLOWED" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "verify_payment",
    description:
      "Read the ERC20FeeProxy event log on Sepolia for a payment reference and report what is " +
      "actually there. No credential, no execution provider, so it can contradict both. A " +
      "reference on its own proves nothing — the proxy is permissionless and references are " +
      "public — so `paid` is true only when something corroborates the log: the `expect` you " +
      "pass (token, payee, amount), or this project's own recorded transaction for one of its " +
      "references.",
    inputSchema: {
      type: "object",
      properties: {
        paymentReference: { type: "string" },
        expect: {
          type: "object",
          description:
            "The payment you believe is owed. Without it a sighting is reported, never a payment.",
          properties: {
            tokenAddress: { type: "string", description: "0x address of the ERC-20 being paid" },
            to: { type: "string", description: "0x address the invoice is owed to" },
            amount: { type: "string", description: "amount in base units, decimal string" },
          },
          required: ["tokenAddress", "to", "amount"],
        },
      },
      required: ["paymentReference"],
    },
  },
  {
    name: "refusal_codes",
    description:
      "The refusal vocabulary: every code this system can answer with, what it means, and " +
      "whether retrying it can ever change the answer.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "how_it_works",
    description:
      "The settlement protocol in order: what is checked, when, and what each refusal protects. " +
      "Ask this before assuming what propose_payment would do on the local server.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

/** Named here rather than imported so the hosted bundle carries no store and no provider. */
const RETRY_GUIDANCE: Record<string, string> = {
  // Not "Request agrees": nothing in the settle path asks Request anything. Both signals are
  // read from a public RPC by this project -- the receipt, and the fee-proxy event for that
  // same transaction. Claiming another system vouched for our own read is the thing this
  // surface is least entitled to do, since a Request engineer is who would call it.
  SETTLED:
    "The receipt and the fee-proxy event for that same transaction both check out, read here " +
    "from a public RPC. Nothing to do.",
  ALREADY_SETTLED: "This debt is paid. A retry cannot pay it again and must not try.",
  ALREADY_DISPATCHED: "A payment for this obligation was already sent. Observe it; never resend.",
  REFERENCE_ALREADY_CLAIMED: "Another obligation holds this reference. It is the same debt renamed.",
  AWAITING_APPROVAL: "A human has not decided. Waiting is the only correct action.",
  REVIEW_REJECTED: "A human refused this exact plan. Asking again does not change it.",
  CALLDATA_MISMATCH: "The bytes mean something other than the invoice. Fix the bytes.",
  PAYEE_NOT_ALLOWED: "The recipient is not on the allowlist. Needs a human policy change.",
  LIMIT_EXCEEDED: "Above the ceiling a human set. Needs a human policy change.",
  FEE_EXCEEDS_CEILING: "The fee is above the ceiling a human set.",
  FEE_RECIPIENT_UNKNOWN: "The fee would go somewhere the policy does not name.",
  TOKEN_DECIMALS_MISMATCH: "The token's decimals disagree with policy. A retry repeats it.",
  SOURCE_ALREADY_PAID: "The chain already shows this reference paid.",
  PLAN_EXPIRED: "The approval aged out. Propose again.",
  PLAN_CHANGED: "The invoice changed after approval. Needs a new approval.",
  OBLIGATION_RESERVED: "Another plan holds this obligation. Do not race it.",
  SIMULATION_BLOCKED: "The payment would revert. A retry repeats the revert.",
  // Deliberately not "needs a new plan and approval": EXECUTION_REVERTED is terminal and NOT
  // replannable, so that sentence named a remedy no code path provides. A revert moves no
  // money -- the receipt says status 0 -- but this obligation keeps the payment reference, so
  // the debt cannot be re-proposed under it or under a second obligation without colliding
  // with the reference index. Raising a fresh Request invoice is the honest answer, because
  // that is the only route that yields a new reference.
  EXECUTION_REVERTED:
    "The transaction reverted on chain. Nothing moved, and this obligation is terminal: it " +
    "keeps its payment reference, so the same debt cannot be re-proposed here. Fix what made " +
    "it revert, raise a new Request invoice, and settle that.",
  EVIDENCE_CONFLICT: "The provider and the chain disagree. A human must look.",
  RECONCILIATION_PENDING: "Paid on chain, not yet indexed. Resolution, never a new payment.",
  EXECUTION_OUTCOME_UNKNOWN: "A send happened and its result is unknown. Observe it.",
  CACHED_FAILURE: "The provider replays a cached failure. Rotating the key would pay twice.",
  SIMULATE_EXECUTED: "A dry run really executed. Treat as a real send and stop.",
};

const PROTOCOL = [
  "0  One payment reference is one debt. A second obligation for the same reference is refused.",
  "0b An obligation past the point of no return is never re-entered; it is resolved by observation.",
  "1  Policy: payee, ceiling, fee, fee recipient, token decimals. Refused here costs no gas.",
  "1b The calldata is decoded and compared against the invoice the policy just cleared.",
  "2  The plan is hashed and stored. The hash covers the steps, so the bytes cannot change under it.",
  "3  Exactly one plan may hold an obligation. A rival plan is refused, not queued.",
  "4  A human approves that plan hash. No tool on any surface can write this decision.",
  "5  Re-checked at dispatch: the plan may have expired, the invoice may have changed.",
  "6  Simulation. Explicitly not a safety boundary — a dry run that returns a hash has executed.",
  "7  The attempt row and its job are committed in one transaction BEFORE anything is sent.",
  "8  Sent only if this attempt has never been sent. Local state, not the provider's cache.",
  "9  A receipt is read from a public RPC. A provider status string is never sufficient.",
  "10 The fee-proxy event for THAT transaction must carry this reference, token, payee and amount.",
  "   That is the query Request's own detection runs, run here -- not Request's word for it.",
];

export interface PublicDeps {
  readonly findPayment?: typeof findPaymentByReference;
  readonly rpcUrl?: string;
}

/**
 * This project's own settled references, compiled in with the evidence: reference → the
 * transaction that paid it.
 *
 * The second corroboration source, and the one that needs no argument from the caller. Every
 * reference this project publishes is in the README, and a fee-proxy log carrying one can be
 * emitted by anyone for a nominal amount of a worthless token. When we already know which
 * transaction paid a reference, a sighting in a different transaction is not weak evidence of
 * payment — it is evidence of a forgery, and it is reported as a conflict rather than swallowed.
 */
const OWN_PAYMENTS = new Map<string, string>();
for (const row of EVIDENCE.rows) {
  if (row.paymentReference && row.txHash) {
    OWN_PAYMENTS.set(row.paymentReference.toLowerCase(), row.txHash.toLowerCase());
  }
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE_UNITS = /^[0-9]+$/;

/**
 * The caller's claim about what this invoice owes, validated before it reaches a chain read.
 *
 * Untrusted input from a public endpoint, so every field is checked rather than coerced: an
 * `amount` of "1e18" or a `to` of "0x0" would silently never match and report a real payment
 * as unseen, which is the same wrong answer in the other direction.
 */
function readExpectation(raw: unknown): PaymentExpectation | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("expect must be an object");
  const e = raw as Record<string, unknown>;
  const tokenAddress = String(e.tokenAddress ?? "");
  const to = String(e.to ?? "");
  const amount = String(e.amount ?? "");
  if (!HEX_ADDRESS.test(tokenAddress)) throw new Error("expect.tokenAddress must be a 0x-prefixed 20-byte address");
  if (!HEX_ADDRESS.test(to)) throw new Error("expect.to must be a 0x-prefixed 20-byte address");
  if (!BASE_UNITS.test(amount)) throw new Error("expect.amount must be base units as a decimal string");
  return { tokenAddress, to, amount };
}

async function callTool(name: string, args: Record<string, unknown>, deps: PublicDeps): Promise<unknown> {
  switch (name) {
    case "settlement_evidence": {
      const outcome = typeof args.outcome === "string" ? args.outcome.toUpperCase() : null;
      const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 200) : 25;
      const rows = EVIDENCE.rows
        .filter((r) => (outcome ? String(r.actual).toUpperCase() === outcome : true))
        .slice(0, limit);
      return { totals: EVIDENCE.totals, generatedAt: EVIDENCE.generatedAt, matched: rows.length, rows };
    }

    case "verify_payment": {
      const reference = String(args.paymentReference ?? "");
      if (!/^0x[0-9a-fA-F]+$/.test(reference)) {
        throw new Error("paymentReference must be 0x-prefixed hex");
      }
      // Passed down so the chain read matches emitter, token, payee and amount rather than the
      // reference alone. Without it this tool answered "found" for any log carrying the
      // reference — and a red-team pass forged exactly that: a fee-proxy log with a victim's
      // reference paying the attacker one unit of a worthless token. The money path already
      // refused it on the fields; this surface reported it as the payment.
      const expect = readExpectation(args.expect);
      const find = deps.findPayment ?? findPaymentByReference;
      const seen = await find(reference, {
        rpcUrl: deps.rpcUrl,
        lookbackBlocks: 300_000,
        ...(expect ? { expect } : {}),
      });

      // With an expectation, `found` already means the fields agreed (chain.ts refuses the log
      // otherwise). Without one, the only thing that can corroborate a sighting here is this
      // project's own record of which transaction paid that reference.
      const ourTx = OWN_PAYMENTS.get(reference.toLowerCase()) ?? null;
      const sameTx = ourTx !== null && seen.txHash?.toLowerCase() === ourTx;
      const corroboratedBy = seen.found ? (expect ? "expectation" : sameTx ? "project-evidence" : null) : null;

      const conflicts = [
        ...(seen.conflicts ?? []),
        ...(ourTx !== null && seen.txHash !== undefined && !sameTx
          ? [`${seen.txHash} carries this reference, but this project's evidence records ${ourTx} as the payment`]
          : []),
      ];

      return {
        reference,
        // Only ever true on corroboration. A reference is derived from data anchored openly on
        // Sepolia and the ERC20FeeProxy is permissionless, so "a log carries this reference" is
        // a sighting, not a settlement, and must not be handed to an agent as one.
        paid: corroboratedBy !== null,
        corroboratedBy,
        referenceSeen: seen.found === true,
        txHash: seen.txHash ?? null,
        amountBaseUnits: seen.amount ?? null,
        tokenAddress: seen.tokenAddress ?? null,
        to: seen.to ?? null,
        conflicts: conflicts.length > 0 ? conflicts : null,
        scannedBlocks: seen.scannedBlocks ?? null,
        // A miss inside a bounded window is "not seen recently", never "unpaid".
        // Was `seen.found || seen.truncated !== true`, which called a scan conclusive whenever
        // the flag was merely absent -- the permissive inverse of the rule the money paths
        // use. One shared verdict answers it the same way everywhere.
        conclusive: verdictFor(seen).kind !== "UNKNOWN",
        caveat: !seen.found
          ? seen.truncated
            ? "not seen in the scanned window; this is not proof the invoice is unpaid"
            : "scanned the whole window; no payment carrying this reference was found"
          : corroboratedBy === null
            ? "a log carries this reference, but nothing corroborates that it pays this invoice. " +
              "Anyone can emit a fee-proxy log with a public reference: pass `expect` (token, to, " +
              "amount) to have the payment itself checked."
            : null,
        source: "ERC20FeeProxy event log, read from a public Sepolia RPC with no credential",
      };
    }

    case "refusal_codes":
      return { codes: RETRY_GUIDANCE };

    case "how_it_works":
      return {
        order: PROTOCOL,
        note:
          "This hosted surface cannot propose or settle. Those tools are absent, not disabled: " +
          "a public endpoint has no human beside it to approve, so it has no business holding " +
          "a payment path. Run the stdio server from the repository for those.",
      };

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/** One JSON-RPC request in, one response out. `null` means it was a notification. */
export async function handlePublic(
  req: { id?: string | number | null; method?: string; params?: Record<string, unknown> } | unknown,
  deps: PublicDeps = {},
): Promise<unknown | null> {
  if (!req || typeof req !== "object" || Array.isArray(req)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: expected JSON object" } };
  }
  const r = req as { id?: string | number | null; method?: string; params?: Record<string, unknown> };
  const id = r.id ?? null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  if (r.id === undefined && typeof r.method === "string" && r.method.startsWith("notifications/")) {
    return null;
  }

  switch (r.method) {
    case "initialize":
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: PUBLIC_SERVER_INFO,
        instructions:
          "Read-only evidence for ReqKeeper. There is no tool here that can move money, and " +
          "that is the point: approval belongs next to a human, not behind a URL.",
      });

    case "tools/list":
      return reply({ tools: PUBLIC_TOOLS });

    case "tools/call": {
      const name = String(r.params?.name ?? "");
      const args = (r.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const out = await callTool(name, args, deps);
        return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return reply({
          content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }, null, 2) }],
          isError: true,
        });
      }
    }

    case "ping":
      return reply({});

    default:
      return fail(-32601, `method not found: ${r.method}`);
  }
}
