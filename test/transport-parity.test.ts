/**
 * One fault list, both transports, identical verdicts.
 *
 * `hackathon/audit/STATUS.md` closed a row saying the two KeeperHub transports "now enforce the
 * same things" and "cannot drift apart again". They had drifted, twice, in the direction the
 * claim denied: `Retry-After` and `originalExecutionId` were both read on REST and silently
 * dropped on MCP. A reviewer found them by probing, because nothing tested the parity — the REST
 * tests covered both affordances and the MCP tests asked for neither, so the suite passed by not
 * asking.
 *
 * An assertion in a document is not a property. This is the property: every disposition either
 * transport can produce, produced by both, compared field for field. The verdicts are built by
 * shared functions now (`rateLimitVerdict`, `priorExecutionFrom`, `idempotencyVerdict`), so a
 * third transport that forgets them has to fail here rather than ship quietly.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { encodeCall } from "../src/abi.ts";
import { KeeperHubProvider, retryAfterSeconds } from "../src/keeperhub.ts";
import { KeeperHubMcpProvider } from "../src/keeperhub-mcp.ts";
import { PAY_SIGNATURE } from "../src/plan.ts";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PROXY = "0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE";
const PAYEE = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const FEE_ADDR = `0x${"0".repeat(40)}`;
const CALLDATA = encodeCall(PAY_SIGNATURE, [FAU, PAYEE, "1000000000000000000", "0x0056a1b2c3d4e5f6", "0", FEE_ADDR]);
const STEP = { to: PROXY, data: CALLDATA, value: "0" };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * The platform answers the WRITE with this status, and answers anything before it normally.
 *
 * The MCP transport opens a session before it calls a tool, and REST has no such step. Without
 * this distinction the first stubbed failure lands on the handshake and the two transports
 * disagree for a reason that is not a defect -- `no_credential` from a refused handshake against
 * `bad_response` from a refused write. What has to match is how each disposes of the same answer
 * to the same question.
 */
function platformAnswers(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  let handshakesLeft = 2; // initialize, then notifications/initialized
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const method = (() => {
      try {
        return (JSON.parse(String(init?.body ?? "{}")) as { method?: string }).method;
      } catch {
        return undefined;
      }
    })();
    if (method !== undefined && method !== "tools/call" && handshakesLeft > 0) {
      handshakesLeft -= 1;
      return {
        status: 200,
        ok: true,
        headers: { get: (k: string) => (k.toLowerCase() === "mcp-session-id" ? "session-parity" : null) },
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } }),
        json: async () => ({}),
      };
    }
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      text: async () => text,
      json: async () => (typeof body === "string" ? {} : body),
    };
  }) as unknown as typeof fetch;
}

interface Disposition {
  readonly threw: boolean;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
  readonly executionId?: string;
}

async function dispositionOf(
  provider: { execute(step: unknown, key: string): Promise<unknown> },
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Disposition> {
  platformAnswers(status, body, headers);
  try {
    await provider.execute(STEP, "key-parity");
    return { threw: false };
  } catch (e) {
    const err = e as { code?: string; retryable?: boolean; retryAfterSeconds?: number; executionId?: string };
    return {
      threw: true,
      code: err.code,
      retryable: err.retryable,
      retryAfterSeconds: err.retryAfterSeconds,
      executionId: err.executionId,
    };
  }
}

const rest = new KeeperHubProvider({ apiKey: "kh_test", chainId: 11155111, rpcUrl: "http://127.0.0.1:1" });
const mcp = new KeeperHubMcpProvider({ apiKey: "kh_test", chainId: 11155111, rpcUrl: "http://127.0.0.1:1" });

/**
 * Every shape the platform can answer a write with.
 *
 * `compare` lists the fields both transports must agree on. Message text is deliberately not
 * among them: the transports name themselves differently and always have, and forcing identical
 * prose would be a test about strings rather than about behaviour.
 */
const CASES: Array<{ name: string; status: number; body: unknown; headers?: Record<string, string> }> = [
  { name: "400 with a JSON body", status: 400, body: { error: "bad request" } },
  { name: "401, a revoked or wrong key", status: 401, body: { error: "invalid api key" } },
  { name: "403", status: 403, body: { error: "forbidden" } },
  { name: "404", status: 404, body: { error: "no such route" } },
  { name: "429 with no Retry-After", status: 429, body: { error: "rate limited" } },
  { name: "429 carrying Retry-After", status: 429, body: { error: "rate limited" }, headers: { "retry-after": "42" } },
  { name: "429 with an unparseable Retry-After", status: 429, body: { error: "slow down" }, headers: { "retry-after": "soon" } },
  {
    name: "409 still in progress",
    status: 409,
    body: { code: "idempotency_in_progress", error: "still working on this key" },
  },
  {
    name: "409 conflict, naming the prior execution",
    status: 409,
    body: { code: "idempotency_conflict", error: "different body", originalExecutionId: "exec_9f21" },
  },
  { name: "409 conflict naming nothing", status: 409, body: { code: "idempotency_conflict", error: "different body" } },
  { name: "409 that says neither thing", status: 409, body: {} },
  { name: "500", status: 500, body: { error: "boom" } },
  { name: "503", status: 503, body: { error: "unavailable" } },
  // Bodies that are not JSON. Every case above parsed, which is how the REST transport threw
  // `bad_response` before any status branch ran and nobody noticed: an HTML 429 from an edge
  // rate limiter lost its Retry-After and came back non-retryable, an empty 409 never reached the
  // branch written for it, and the two transports disagreed on identical bytes while this file
  // said they could not.
  { name: "429 as an HTML page, carrying Retry-After", status: 429, body: "<html>Too Many Requests</html>", headers: { "retry-after": "120" } },
  { name: "409 as an HTML page", status: 409, body: "<html>Conflict</html>" },
  { name: "409 with an empty body", status: 409, body: "" },
  { name: "503 as an HTML page", status: 503, body: "<html>Service Unavailable</html>" },
];

describe("both KeeperHub transports answer the same way", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const a = await dispositionOf(rest, c.status, c.body, c.headers ?? {});
      const b = await dispositionOf(mcp, c.status, c.body, c.headers ?? {});
      assert.deepEqual(
        { threw: b.threw, code: b.code, retryable: b.retryable, retryAfterSeconds: b.retryAfterSeconds, executionId: b.executionId },
        { threw: a.threw, code: a.code, retryable: a.retryable, retryAfterSeconds: a.retryAfterSeconds, executionId: a.executionId },
        `the MCP transport disposes of "${c.name}" differently from REST`,
      );
      // And neither may resolve: a write that did not clearly succeed must never look like one.
      assert.equal(a.threw, true, `REST resolved ${c.name} as a dispatch`);
    });
  }

  test("the platform's backoff reaches the caller on both", async () => {
    // Named separately from the parity check above, because "identical" would also be satisfied
    // by both transports dropping it -- which is exactly what one of them used to do.
    for (const [label, provider] of [["rest", rest], ["mcp", mcp]] as const) {
      const d = await dispositionOf(provider, 429, { error: "rate limited" }, { "retry-after": "42" });
      assert.equal(d.retryAfterSeconds, 42, `${label} discarded the platform's Retry-After`);
    }
  });

  test("the prior execution reaches the caller on both", async () => {
    for (const [label, provider] of [["rest", rest], ["mcp", mcp]] as const) {
      const d = await dispositionOf(provider, 409, {
        code: "idempotency_conflict",
        error: "different body",
        originalExecutionId: "exec_9f21",
      });
      assert.equal(d.executionId, "exec_9f21", `${label} discarded the execution KeeperHub named`);
    }
  });

  test("and an MCP 4xx says which status it was", async () => {
    // It used to surface as `mcp_error: "undefined: undefined"` -- failing closed, and telling an
    // operator debugging a revoked key absolutely nothing.
    platformAnswers(401, { error: "invalid api key" });
    await assert.rejects(mcp.execute(STEP, "key-parity"), /401/);
  });
});


describe("what the platform's answer means, whatever the body looks like", () => {
  test("an HTML 429 keeps its Retry-After on REST", async () => {
    const d = await dispositionOf(rest, 429, "<html>Too Many Requests</html>", { "retry-after": "120" });
    assert.equal(d.code, "rate_limited");
    assert.equal(d.retryable, true);
    assert.equal(d.retryAfterSeconds, 120);
  });

  test("an empty 409 is the unlabelled case, and retryable, on REST", async () => {
    const d = await dispositionOf(rest, 409, "");
    assert.equal(d.code, "idempotency_unlabelled", JSON.stringify(d));
    assert.equal(d.retryable, true);
  });

  test("Retry-After in the HTTP-date form is honoured, and a long one is not shortened to five minutes", () => {
    const now = Date.parse("2026-09-13T12:00:00Z");
    assert.equal(retryAfterSeconds("Sun, 13 Sep 2026 12:02:00 GMT", now), 120);
    assert.equal(retryAfterSeconds("3600", now), 3600);
    assert.equal(retryAfterSeconds("Sun, 13 Sep 2026 11:00:00 GMT", now), undefined, "a date in the past is no hint");
    assert.equal(retryAfterSeconds("soon", now), undefined);
  });
});

describe("a streamable-HTTP reply is one JSON-RPC message among several frames", () => {
  /**
   * The old reader took the first `data:` line of the whole text. A notification frame ahead of
   * the reply, an `id:` line first, or a `:ping` heartbeat turned a payment that had SUCCEEDED
   * into a non-retryable transport failure. Fail-closed, and recovered later from the chain, but
   * a transport that works only when the server sends exactly one frame works by luck.
   */
  const result = (id: number) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify({ executionId: "e1", status: "completed", transactionHash: "0xdead" }) }] },
    });
  const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } });

  function mcpAnswersStream(streamFor: (requestId: number) => string) {
    let ids = 0;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const req = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      if (req.method !== "tools/call") {
        return {
          status: 200,
          ok: true,
          headers: { get: (k: string) => (k.toLowerCase() === "mcp-session-id" ? `s-${++ids}` : null) },
          text: async () => JSON.stringify({ jsonrpc: "2.0", id: req.id ?? 1, result: { protocolVersion: "2024-11-05" } }),
          json: async () => ({}),
        };
      }
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => streamFor(req.id ?? 0),
        json: async () => ({}),
      };
    }) as unknown as typeof fetch;
  }

  const fresh = () => new KeeperHubMcpProvider({ apiKey: "kh_test", chainId: 11155111, rpcUrl: "http://127.0.0.1:1" });

  const shapes: Array<[string, (id: number) => string]> = [
    ["a single data frame", (id) => `event: message\ndata: ${result(id)}\n\n`],
    ["a notification frame before the reply", (id) => `event: message\ndata: ${notification}\n\nevent: message\ndata: ${result(id)}\n\n`],
    ["an id line first", (id) => `id: 7\nevent: message\ndata: ${result(id)}\n\n`],
    ["a ping heartbeat first", (id) => `:ping\n\nevent: message\ndata: ${result(id)}\n\n`],
    // Split where a newline is whitespace to JSON: between two members, never inside a string.
    ["a multi-line data frame", (id) => {
      const r = result(id);
      const cut = r.indexOf('"id"');
      return `data: ${r.slice(0, cut)}
data: ${r.slice(cut)}

`;
    }],    ["bare JSON, no stream at all", (id) => result(id)],
  ];
  for (const [name, stream] of shapes) {
    test(`${name}: the successful execution is read as completed`, async () => {
      mcpAnswersStream(stream);
      const out = (await fresh().execute(STEP, "key-sse")) as { status?: string; executionId?: string | null };
      assert.equal(out.status, "completed", JSON.stringify(out));
      assert.equal(out.executionId, "e1");
    });
  }

  test("a frame answering a DIFFERENT request id is not this request's answer", async () => {
    mcpAnswersStream((id) => `event: message\ndata: ${result(id + 100)}\n\n`);
    await assert.rejects(fresh().execute(STEP, "key-sse-other"), (e: { code?: string }) => e.code === "bad_response");
  });
});
