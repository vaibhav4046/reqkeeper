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

import { readReceipt } from "./chain.ts";
import { decodeAllowedCall, type CallStep } from "./calldata-gate.ts";
import { idempotencyVerdict, priorExecutionFrom, rateLimitVerdict } from "./keeperhub.ts";
import type {
  ExecuteResult,
  ExecutionProvider,
  Receipt,
  SimulateOutcome,
} from "./provider.ts";
import { classifySimulateReply, ProviderError } from "./provider.ts";

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
  /** The REST transport's spelling of the same thing. Recognised here so a cached FAILURE is
   * reported as CACHED_FAILURE on both transports -- which is what carries the "do not rotate
   * the key" guidance, and rotating the key is how you pay twice. */
  replayed?: boolean;
  receipts?: Array<{ verified?: boolean; receiptStatus?: string; gasUsed?: string }>;
}

/**
 * The 409's own words, not 300 characters of whatever came back.
 *
 * The REST transport matches on the parsed `code` and `error` fields. This one matched on the raw
 * body, which is a far wider surface: a stack trace or a documentation URL containing the words
 * "in progress" flips a conflict into a retry, and the two verdicts decide whether a payment that
 * may already have happened is retried or handed to a human.
 */
function labelFrom(body: string): string {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: unknown; message?: unknown };
    const fields = [parsed.code, parsed.error, parsed.message].filter((v) => typeof v === "string");
    if (fields.length > 0) return fields.join(" ");
  } catch {
    // Not JSON. An unparseable 409 is exactly the unlabelled case, and `idempotencyVerdict` has a
    // third answer for it. Returning the page text here made an edge's generic "<html>Conflict"
    // read as a labelled conflict on this transport and unlabelled on REST -- the parity this
    // file exists to keep.
  }
  return "";
}

/**
 * One JSON-RPC reply out of whatever a streamable-HTTP server sent back.
 *
 * The server may answer with bare JSON, or with an SSE stream: frames separated by blank lines,
 * each frame zero or more `event:` / `id:` / `:comment` lines and one or more `data:` lines whose
 * values join with newlines. The previous reader took the FIRST `data:` line of the whole text and
 * nothing else -- so a `notifications/message` frame ahead of the reply, an `id:` line first, or
 * a `:ping` heartbeat made a payment that had SUCCEEDED come back as a non-retryable transport
 * failure. Fail-closed, and recovered later from the chain, but a transport that works only when
 * the server sends exactly one frame is a transport that works by luck.
 *
 * The reply is selected by the request id it answers. On a shared session another request's
 * frame was accepted as this one's answer, which is the wrong money moved for the wrong reason.
 * `null` means no frame answered this id, which the caller reports as unparseable.
 */
export function parseReply(text: string, requestId: number): JsonRpcReply | null {
  const trimmed = text.trim();
  const looksLikeStream = /^(event:|data:|id:|:)/m.test(trimmed) && !trimmed.startsWith("{");
  const candidates: string[] = [];
  if (!looksLikeStream) {
    candidates.push(trimmed);
  } else {
    for (const frame of trimmed.split(/\r?\n\r?\n/)) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
      if (data.length > 0) candidates.push(data.join("\n"));
    }
  }
  let fallback: JsonRpcReply | null = null;
  for (const candidate of candidates) {
    let reply: JsonRpcReply;
    try {
      reply = JSON.parse(candidate) as JsonRpcReply;
    } catch {
      continue;
    }
    if (typeof reply !== "object" || reply === null) continue;
    const id = (reply as { id?: unknown }).id;
    if (id === requestId || String(id) === String(requestId)) return reply;
    // A frame with no id is a notification, never a reply. A frame with ANOTHER id is somebody
    // else's reply. Neither answers this request; only a bare JSON body with no id at all is
    // taken on trust, and only when nothing better was in the text.
    if (!looksLikeStream && id === undefined && fallback === null) fallback = reply;
  }
  return fallback;
}

export class KeeperHubMcpProvider implements ExecutionProvider {
  readonly transport = "mcp" as const;
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

    const initializeId = this.#nextId++;
    const { res, text } = await this.#post({
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    });

    // The status first. Every failed handshake used to be reported as "the API key was not
    // accepted", because the only test was whether a session header arrived -- so a transient
    // 429 or 503 on `initialize` became a permanent, wrongly diagnosed credential failure, and a
    // handshake the server REJECTED with a JSON-RPC error (an unsupported protocol version, say)
    // was indistinguishable from one it accepted, because the reply body was never read.
    if (res.status === 429) throw rateLimitVerdict(res.headers);
    if (res.status >= 500) {
      throw new ProviderError("provider_error", `initialize: HTTP ${res.status}: ${text.slice(0, 200)}`, true);
    }
    // A rejected key still answers 200 here. The missing session header is the tell.
    if (!this.#session) {
      throw new ProviderError(
        "no_credential",
        `MCP server issued no session (HTTP ${res.status}); the API key was not accepted: ${text.slice(0, 200)}`,
        false,
      );
    }
    const reply = parseReply(text, initializeId);
    if (reply === null) {
      this.#session = null;
      throw new ProviderError("bad_response", `unparseable initialize reply: ${text.slice(0, 200)}`, false);
    }
    if (reply.error) {
      // A session was issued and then the handshake was refused. The session is not usable.
      this.#session = null;
      throw new ProviderError("mcp_error", `initialize: ${reply.error.code}: ${reply.error.message}`, false);
    }

    const initialized = await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" });
    if (initialized.res.status === 429) throw rateLimitVerdict(initialized.res.headers);
    if (!initialized.res.ok && initialized.res.status !== 202) {
      this.#session = null;
      throw new ProviderError(
        "bad_response",
        `notifications/initialized: HTTP ${initialized.res.status}: ${initialized.text.slice(0, 200)}`,
        initialized.res.status >= 500,
      );
    }
  }

  /** Parse the tool result, which arrives as JSON inside a text content block. */
  async #callTool(name: string, args: Record<string, unknown>): Promise<ExecutePayload> {
    await this.#handshake();

    const requestId = this.#nextId++;
    const { res, text } = await this.#post({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: { name, arguments: args },
    });

    // The same verdict the REST transport throws, from the same function, so the platform's own
    // backoff cannot be honoured on one surface and guessed at on the other.
    if (res.status === 429) throw rateLimitVerdict(res.headers);
    // The REST route has discriminated 409s since the day one of them was mistaken for the
    // other; this transport had no 409 branch at all, so an idempotency answer fell through to
    // the JSON-RPC parse below and surfaced as `bad_response`. settle() keys the integrity
    // branch on the literal code `idempotency_conflict`, so on this surface "the platform holds
    // a different body for this key" was being recorded as an ordinary unknown outcome instead
    // of the incident it is.
    if (res.status === 409) {
      const verdict = idempotencyVerdict(labelFrom(text));
      // And the execution the platform says this key already started. Read on REST and dropped
      // here, so `PROVIDER_NAMED_PRIOR_EXECUTION` could never fire on the transport that carries
      // this deployment's MCP settlements.
      const named = priorExecutionFrom(text);
      if (named) verdict.executionId = named;
      throw verdict;
    }
    if (res.status >= 500) {
      throw new ProviderError("provider_error", `HTTP ${res.status}: ${text.slice(0, 200)}`, true);
    }
    // Every other non-2xx, with its status. REST has had this since a 401 resolved as "pending"
    // and every in-flight obligation became a manual investigation the moment a key was revoked.
    // Here a 400 or a 401 fell through to the JSON-RPC parse and surfaced as
    // `mcp_error: "undefined: undefined"` -- which fails closed, and tells an operator nothing.
    if (!res.ok) {
      throw new ProviderError("bad_response", `HTTP ${res.status}: ${text.slice(0, 200)}`, false);
    }

    const reply = parseReply(text, requestId);
    if (reply === null) {
      throw new ProviderError("bad_response", `unparseable MCP reply: ${text.slice(0, 200)}`, false);
    }

    if (reply.error) {
      // -32003 is the un-initialized session; the handshake is wrong, not the request.
      const retryable = reply.error.code === -32003 || reply.error.code === -32603;
      if (reply.error.code === -32003) {
        // Retryable was a promise this code could not keep. `#handshake()` returns early
        // whenever `#session` is non-null and nothing ever cleared it, so a retry on the same
        // provider re-sent the dead session id and failed identically, for ever. Dropping the
        // session is what makes the next call re-handshake — which is what "retryable" was
        // always supposed to mean.
        //
        // Safe on a write path: this is the server saying it has no session and therefore did
        // nothing with the request. The idempotency key is unchanged and travels with the
        // retry, so even if that reading is wrong the platform's own replay window catches it.
        this.#session = null;
      }
      throw new ProviderError("mcp_error", `${reply.error.code}: ${reply.error.message}`, retryable);
    }

    const body = reply.result?.content?.find((c) => c.type === "text")?.text ?? "";

    // An MCP tool reports most failures as a 200 carrying `isError`, so the 409 semantics
    // arrive as text rather than as an HTTP status. Routed through the same verdict as the REST
    // path: without this, `idempotency_in_progress` — an ordinary wait — was thrown
    // non-retryable, which is exactly the collapse the REST transport was fixed for.
    if (reply.result?.isError) {
      // A tool's refusal is prose more often than JSON, so the text itself is the label here.
      const label = labelFrom(body) || body;
      // A rate limit reported the MCP way: HTTP 200, `isError`, the words in the body. The
      // headers are still the platform's, so the backoff hint is still there to honour.
      if (/rate.?limit|too many requests/i.test(label)) throw rateLimitVerdict(res.headers);
      // "already in progress" and "different body for this key" arrive as prose here, not as a
      // 409 -- and only a body containing the literal "idempotenc" used to reach the verdict, so
      // `{"error":"a request for this key is already in progress"}` became a non-retryable error
      // whose CODE was that whole sentence, and every downstream branch keyed on a code missed it.
      if (/idempotenc|in progress|already (started|running|exists)|conflict/i.test(label)) {
        const verdict = idempotencyVerdict(label);
        const named = priorExecutionFrom(body);
        if (named) verdict.executionId = named;
        throw verdict;
      }
    }

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
      // A code is an identifier, not a sentence. `parsed.error` is free text from the tool, and
      // it used to become the ProviderError CODE verbatim -- so `settle.ts`, which keys branches
      // on literal codes, was comparing against English. Known identifiers pass through; anything
      // else is `tool_error` with the text kept in the message where a human reads it.
      const raw = typeof parsed.error === "string" ? parsed.error : "";
      const code = /^[a-z][a-z0-9_]{2,40}$/.test(raw) ? raw : "tool_error";
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
      // The validated target, not `step.to` -- see the note in src/keeperhub.ts#KeeperHubProvider.
      // Sending the step's own field made the allowlist depend on `decodeAllowedCall` throwing
      // first, which is an ordering accident rather than a guarantee.
      contract_address: call.to,
      chain_id: String(this.#cfg.chainId),
      function_name: call.functionName,
      // A JSON string, not an array. Same requirement as the REST route.
      function_args: JSON.stringify(call.args),
      value: call.value,
    };
  }

  // --- ExecutionProvider ---------------------------------------------------

  async simulate(body: unknown): Promise<SimulateOutcome> {
    const payload = await this.#callTool("execute_contract_call", {
      ...this.#args(body as CallStep),
      // A real boolean. `"true"` here would sign and broadcast.
      simulate: true,
    });
    // The same classifier REST uses. This transport spent a whole round missing a guard REST
    // already had, because each one decided for itself what a reply meant; there is now one
    // answer to that question and both surfaces get it from the same place.
    return classifySimulateReply({
      ...payload,
      transactionHash: payload.transactionHash ?? payload.transaction_hash,
    });
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
    // The same shared reader the REST transport uses. This was the last private `fetch` for a
    // receipt in the codebase, and it had none of the RPC fallback: on this transport a pruned
    // `result: null` became `not_found`, which settle reads as EVIDENCE_CONFLICT — a real
    // settlement reported as missing, on the path that had just moved money.
    return readReceipt(this.#cfg.rpcUrl, hash, this.#timeout);
  }

  /** Unrecognised statuses become "pending", never "completed". */
  #toExecuteResult(payload: ExecutePayload): ExecuteResult {
    const hash = payload.transactionHash ?? payload.transaction_hash;
    // No placeholder standing where a resource identifier belongs. See provider.ts.
    const id = payload.executionId ?? payload.execution_id ?? hash ?? null;
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
      ...(payload.idempotentReplay === true || payload.replayed === true ? { idempotentReplay: true } : {}),
    };
  }
}
