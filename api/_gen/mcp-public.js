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
import { findPaymentByReference } from "./chain.js";
import { EVIDENCE } from "./evidence.generated.js";
export const PUBLIC_SERVER_INFO = { name: "reqkeeper-public", version: "0.1.0" };
export const PUBLIC_TOOLS = [
    {
        name: "settlement_evidence",
        description: "Every settlement this project has landed on Sepolia, with its refusal code, physical " +
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
        description: "Read the ERC20FeeProxy event log on Sepolia for a payment reference and report what is " +
            "actually there. No credential, no execution provider, so it can contradict both.",
        inputSchema: {
            type: "object",
            properties: { paymentReference: { type: "string" } },
            required: ["paymentReference"],
        },
    },
    {
        name: "refusal_codes",
        description: "The refusal vocabulary: every code this system can answer with, what it means, and " +
            "whether retrying it can ever change the answer.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "how_it_works",
        description: "The settlement protocol in order: what is checked, when, and what each refusal protects. " +
            "Ask this before assuming what propose_payment would do on the local server.",
        inputSchema: { type: "object", properties: {} },
    },
];
/** Named here rather than imported so the hosted bundle carries no store and no provider. */
const RETRY_GUIDANCE = {
    SETTLED: "Both the chain receipt and Request agree. Nothing to do.",
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
    EXECUTION_REVERTED: "The transaction reverted on chain. Needs a new plan and approval.",
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
    "10 Request must independently confirm this transaction, for this amount. Only then: SETTLED.",
];
async function callTool(name, args, deps) {
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
            const find = deps.findPayment ?? findPaymentByReference;
            const seen = await find(reference, { rpcUrl: deps.rpcUrl, lookbackBlocks: 300_000 });
            return {
                reference,
                found: seen.found,
                txHash: seen.txHash ?? null,
                amountBaseUnits: seen.amount ?? null,
                scannedBlocks: seen.scannedBlocks ?? null,
                // A miss inside a bounded window is "not seen recently", never "unpaid".
                conclusive: seen.found || seen.truncated !== true,
                source: "ERC20FeeProxy event log, read from a public Sepolia RPC with no credential",
            };
        }
        case "refusal_codes":
            return { codes: RETRY_GUIDANCE };
        case "how_it_works":
            return {
                order: PROTOCOL,
                note: "This hosted surface cannot propose or settle. Those tools are absent, not disabled: " +
                    "a public endpoint has no human beside it to approve, so it has no business holding " +
                    "a payment path. Run the stdio server from the repository for those.",
            };
        default:
            throw new Error(`unknown tool: ${name}`);
    }
}
/** One JSON-RPC request in, one response out. `null` means it was a notification. */
export async function handlePublic(req, deps = {}) {
    if (!req || typeof req !== "object" || Array.isArray(req)) {
        return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: expected JSON object" } };
    }
    const r = req;
    const id = r.id ?? null;
    const reply = (result) => ({ jsonrpc: "2.0", id, result });
    const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (r.id === undefined && typeof r.method === "string" && r.method.startsWith("notifications/")) {
        return null;
    }
    switch (r.method) {
        case "initialize":
            return reply({
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: PUBLIC_SERVER_INFO,
                instructions: "Read-only evidence for ReqKeeper. There is no tool here that can move money, and " +
                    "that is the point: approval belongs next to a human, not behind a URL.",
            });
        case "tools/list":
            return reply({ tools: PUBLIC_TOOLS });
        case "tools/call": {
            const name = String(r.params?.name ?? "");
            const args = (r.params?.arguments ?? {});
            try {
                const out = await callTool(name, args, deps);
                return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
            }
            catch (e) {
                return reply({
                    content: [{ type: "text", text: JSON.stringify({ error: e.message }, null, 2) }],
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
