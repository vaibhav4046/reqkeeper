/**
 * The same settlement protocol, dispatched through KeeperHub's own MCP server.
 *
 * This exists to answer a question honestly. `src/keeperhub.ts` talks to one REST endpoint,
 * and "we integrated with KeeperHub" meaning a single POST is a thin claim. KeeperHub ships
 * an MCP server with 44 tools at https://app.keeperhub.com/mcp, so this implements the same
 * `ExecutionProvider` against it: `settle()` does not change, the refusal table does not
 * change, and the calldata gate is literally the same module. Only the transport moves.
 *
 * That is also the argument for the interface. A guarded signer whose safety depends on
 * which transport it happens to be using is not a guarded signer, and swapping the whole
 * execution surface without touching the protocol is the demonstration of it.
 *
 * Four things about this server that are easy to get wrong, each verified against it:
 *
 *   1. The handshake is sequential. `tools/list` or `tools/call` before
 *      `notifications/initialized` fails with -32003 "Session not initialized".
 *   2. Authentication failure does not look like one. A bad key still returns HTTP 200 on
 *      `initialize`, just with no `mcp-session-id` header. Absence of the header is the
 *      signal; the 401 only arrives on the next call.
 *   3. The session id rotates. An expired-but-in-grace token is silently re-minted and
 *      returned in a rewritten header, so the latest response's header wins rather than the
 *      one `initialize` handed back.
 *   4. `simulate` is compared with `=== true`. The string "true" does not dry-run: it signs
 *      and broadcasts. Anything that reaches this file sends a real boolean or nothing.
 */

import { decodeAllowedCall, type CallStep } from "./calldata-gate.ts";
import type {
  ExecuteResult,
  ExecutionProvider,
  Receipt,
  SimulateResult,
} from "./provider.ts";
import { ProviderError } from "./provider.ts";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "reqkeeper", version: "0.1.0" };

export interface KeeperHubMcpConfig {
  readonly apiKey: string;
  readonly chainId: number;
  /** Public RPC for the independent receipt read. Never the provider. */
  readonly rpcUrl: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

interface JsonRpcReply {
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string; data?: unknown };
}

interface ExecutePayload {
  executionId?: string;
  execution_id?: string;
  status?: string;
  transactionHash?: string;
  transaction_hash?: string;
  transactionLink?: string;
  success?: boolean;
  wouldRevert?: boolean;
  gasEstimate?: string;
  error?: string;
  idempotentReplay?: boolean;
  receipts?: Array<{ verified?: boolean; receiptStatus?: string; gasUsed?: string }>;
}

export class KeeperHubMcpProvider implements ExecutionProvider {
  readonly #cfg: KeeperHubMcpConfig;
  readonly #endpoint: string;
  readonly #timeout: number;
  #session: string | null = null;
  #nextId = 1;

  constructor(cfg: KeeperHubMcpConfig) {
    if (!cfg.apiKey) {
      throw new ProviderError("no_credential", "KEEPERHUB_API_KEY is required", false);
    }
    this.#cfg = cfg;
    this.#endpoint = cfg.endpoint ?? "https://app.keeperhub.com/mcp";
    this.#timeout = cfg.timeoutMs ?? 60_000;
  }

  // --- transport -----------------------------------------------------------

  async #post(body: unknown): Promise<{ res: Response; text: string }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#cfg.apiKey}`,
      "content-type": "application/json",
      // Both are required; the server negotiates a stream even for unary calls.
      accept: "application/json, text/event-stream",
    };
    if (this.#session) headers["mcp-session-id"] = this.#session;

    let res: Response;
    try {
      res = await fetch(this.#endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch (e) {
      // The call may or may not have executed. Retryable at the transport level; the state
      // machine decides whether retrying is actually safe.
      throw new ProviderError("timeout", `no response from KeeperHub MCP: ${String(e)}`, true);
    }

    // The session id rotates on renewal, so the newest header always wins.
    const rotated = res.headers.get("mcp-session-id");
    if (rotated) this.#session = rotated;

    return { res, text: await res.text() };
  }

  /** initialize, then notifications/initialized. Must be sequential, not concurrent. */
  async #handshake(): Promise<void> {
    if (this.#session) return;

    const { res, text } = await this.#post({
      jsonrpc: "2.0",
      id: this.#nextId++,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    });

    // A rejected key still answers 200 here. The missing session header is the tell.
    if (!this.#session) {
      throw new ProviderError(
        "no_credential",
        `MCP server issued no session (HTTP ${res.status}); the API key was not accepted: ${text.slice(0, 200)}`,
        false,
      );
    }

    await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /** Parse the tool result, which arrives as JSON inside a text content block. */
  async #callTool(name: string, args: Record<string, unknown>): Promise<ExecutePayload> {
    await this.#handshake();

    const { res, text } = await this.#post({
      jsonrpc: "2.0",
      id: this.#nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });

    if (res.status === 429) throw new ProviderError("rate_limited", "429 from KeeperHub MCP", true);
    if (res.status >= 500) {
      throw new ProviderError("provider_error", `HTTP ${res.status}: ${text.slice(0, 200)}`, true);
    }

    let reply: JsonRpcReply;
    try {
      // A streamable-HTTP reply may arrive as an SSE frame rather than bare JSON.
      const payload = text.startsWith("event:") || text.startsWith("data:")
        ? (/^data:\s*(.*)$/m.exec(text)?.[1] ?? "")
        : text;
      reply = JSON.parse(payload) as JsonRpcReply;
    } catch {
      throw new ProviderError("bad_response", `unparseable MCP reply: ${text.slice(0, 200)}`, false);
    }

    if (reply.error) {
      // -32003 is the un-initialized session; the handshake is wrong, not the request.
      const retryable = reply.error.code === -32003 || reply.error.code === -32603;
      throw new ProviderError("mcp_error", `${reply.error.code}: ${reply.error.message}`, retryable);
    }

    const body = reply.result?.content?.find((c) => c.type === "text")?.text ?? "";
    let parsed: ExecutePayload;
    try {
      parsed = JSON.parse(body) as ExecutePayload;
    } catch {
      // A tool that refuses returns prose rather than JSON. Surface it as-is.
      if (reply.result?.isError) {
        throw new ProviderError("tool_refused", body.slice(0, 300) || "tool returned an error", false);
      }
      throw new ProviderError("bad_response", `non-JSON tool result: ${body.slice(0, 200)}`, false);
    }

    if (reply.result?.isError) {
      // insufficient_scope is a credential problem and will not fix itself on a retry.
      const code = typeof parsed.error === "string" ? parsed.error : "tool_error";
      throw new ProviderError(code, body.slice(0, 300), false);
    }
    return parsed;
  }

  // --- the arguments this server accepts -----------------------------------

  /**
   * Everything is sent as a string even where numbers are coerced server-side, because the
   * idempotency guard hashes the request body: letting a number re-serialize differently on
   * a retry turns a safe replay into an `idempotency_conflict`.
   */
  #args(step: CallStep): Record<string, unknown> {
    const call = decodeAllowedCall(step);
    return {
      contract_address: step.to,
      chain_id: String(this.#cfg.chainId),
      function_name: call.functionName,
      // A JSON string, not an array. Same requirement as the REST route.
      function_args: JSON.stringify(call.args),
      value: "0",
    };
  }

  // --- ExecutionProvider ---------------------------------------------------

  async simulate(body: unknown): Promise<SimulateResult> {
    const payload = await this.#callTool("execute_contract_call", {
      ...this.#args(body as CallStep),
      // A real boolean. `"true"` here would sign and broadcast.
      simulate: true,
    });
    const hash = payload.transactionHash ?? payload.transaction_hash;
    return {
      status: "simulated",
      wouldRevert: payload.wouldRevert === true || payload.success === false,
      gasEstimate: payload.gasEstimate ?? "0",
      // Passed through deliberately: a hash from a dry run means it really executed, and
      // settle.ts treats that as a real send.
      ...(hash ? { transactionHash: hash } : {}),
    };
  }

  async execute(body: unknown, idempotencyKey: string): Promise<ExecuteResult> {
    if (!idempotencyKey) {
      throw new ProviderError(
        "no_idempotency_key",
        "refusing to execute without an idempotency key",
        false,
      );
    }
    const payload = await this.#callTool("execute_contract_call", {
      ...this.#args(body as CallStep),
      idempotency_key: idempotencyKey,
    });
    return this.#toExecuteResult(payload);
  }

  async observe(executionId: string): Promise<ExecuteResult> {
    // get_execution is workflow runs only; a direct execution needs this tool or it 404s.
    const payload = await this.#callTool("get_direct_execution_status", {
      execution_id: executionId,
    });
    return this.#toExecuteResult(payload);
  }

  /**
   * The independent read. Deliberately a public RPC and not KeeperHub, whichever surface
   * dispatched the payment: a provider reporting on its own success is not evidence.
   */
  async receipt(hash: string): Promise<Receipt> {
    let body: { result?: { status?: string; gasUsed?: string } | null; error?: unknown };
    try {
      const res = await fetch(this.#cfg.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [hash],
        }),
        signal: AbortSignal.timeout(this.#timeout),
      });
      body = (await res.json()) as typeof body;
    } catch {
      return { hash, verified: false, receiptStatus: "timeout", gasUsed: "0" };
    }
    if (body.error) return { hash, verified: false, receiptStatus: "timeout", gasUsed: "0" };
    const r = body.result;
    if (!r) return { hash, verified: false, receiptStatus: "not_found", gasUsed: "0" };
    const gasUsed = r.gasUsed ? BigInt(r.gasUsed).toString(10) : "0";
    // Three outcomes, not two. `status === "0x1" ? success : reverted` calls anything that is
    // not exactly 0x1 a revert — including a receipt whose status is missing or malformed —
    // and EXECUTION_REVERTED is terminal, so a malformed RPC response could permanently label
    // a real payment as failed. Only 0x0 means the chain said no; anything else means this
    // read did not answer, which is `verified: false` and stays open for another look.
    if (r.status === "0x1") return { hash, verified: true, receiptStatus: "success", gasUsed };
    if (r.status === "0x0") return { hash, verified: true, receiptStatus: "reverted", gasUsed };
    return { hash, verified: false, receiptStatus: "not_found", gasUsed };
  }

  /** Unrecognised statuses become "pending", never "completed". */
  #toExecuteResult(payload: ExecutePayload): ExecuteResult {
    const hash = payload.transactionHash ?? payload.transaction_hash;
    const id = payload.executionId ?? payload.execution_id ?? hash ?? "unknown";
    const status = payload.status;

    let mapped: ExecuteResult["status"];
    if (payload.success === false || status === "failed" || status === "reverted") {
      mapped = "failed";
    } else if (status === "completed" || status === "success" || status === "confirmed") {
      mapped = "completed";
    } else {
      mapped = "pending";
    }

    return {
      executionId: id,
      status: mapped,
      ...(hash ? { transactionHash: hash } : {}),
      ...(payload.idempotentReplay === true ? { idempotentReplay: true } : {}),
    };
  }
}
