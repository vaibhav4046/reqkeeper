import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { KeeperHubMcpProvider } from "../src/keeperhub-mcp.ts";
import { ProviderError } from "../src/provider.ts";

// Every case refuses before any network call, so none of this reaches KeeperHub. The live
// handshake and dry run are covered by `npm run probe:mcp` instead, because asserting a
// remote server's behaviour from a unit test only proves the mock.
const provider = new KeeperHubMcpProvider({
  apiKey: "kh_test_key_not_real",
  chainId: 11155111,
  rpcUrl: "http://127.0.0.1:1/unused",
});

const PAY_CALLDATA =
  "0xc219a14d" +
  "000000000000000000000000370de27fdb7d1ff1e1baa7d11c5820a324cf623c" +
  "0000000000000000000000000e2bb1c8d52315cad63f341424c5a7dd81a50f53" +
  "0000000000000000000000000000000000000000000000000de0b6b3a7640000" +
  "00000000000000000000000000000000000000000000000000000000000000c0" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000e2bb1c8d52315cad63f341424c5a7dd81a50f53" +
  "0000000000000000000000000000000000000000000000000000000000000008" +
  "0102030405060708000000000000000000000000000000000000000000000000";

const PROXY = "0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE";

async function refusal(step: unknown, key = "k"): Promise<ProviderError> {
  try {
    await provider.execute(step, key);
  } catch (e) {
    assert.ok(e instanceof ProviderError, `expected ProviderError, got ${String(e)}`);
    return e;
  }
  throw new Error("expected a refusal, but the call was dispatched");
}

test("the calldata gate holds on the MCP transport too", async () => {
  // The whole argument for one shared gate: a second surface must not be a second policy.
  const e = await refusal({ to: PROXY, data: `${PAY_CALLDATA}deadbeef`, value: "0" });
  assert.equal(e.code, "calldata_mismatch");
  assert.equal(e.retryable, false);
});

test("a selector outside the allowlist is refused on the MCP transport", async () => {
  const e = await refusal({ to: PROXY, data: `0xdeadbeef${"00".repeat(32)}`, value: "0" });
  assert.equal(e.code, "selector_not_allowed");
});

test("an address word with dirty high bytes is refused, not masked", async () => {
  const dirty = PAY_CALLDATA.replace(
    "0000000000000000000000000e2bb1c8d52315cad63f341424c5a7dd81a50f53",
    "0000000000000000000000ff0e2bb1c8d52315cad63f341424c5a7dd81a50f53",
  );
  assert.notEqual(dirty, PAY_CALLDATA);
  const e = await refusal({ to: PROXY, data: dirty, value: "0" });
  assert.equal(e.code, "calldata_mismatch");
});

test("executing without an idempotency key is refused", async () => {
  const e = await refusal({ to: PROXY, data: PAY_CALLDATA, value: "0" }, "");
  assert.equal(e.code, "no_idempotency_key");
  assert.equal(e.retryable, false);
});

test("a provider cannot be constructed without a credential", () => {
  assert.throws(
    () => new KeeperHubMcpProvider({ apiKey: "", chainId: 11155111, rpcUrl: "x" }),
    (e: unknown) => e instanceof ProviderError && e.code === "no_credential",
  );
});

test("an unreadable receipt is never reported as success", async () => {
  // The RPC is unreachable on purpose. Whichever transport dispatched the payment, an
  // unreachable chain must not resolve to verified.
  const r = await provider.receipt(`0x${"ab".repeat(32)}`);
  assert.equal(r.verified, false);
  assert.equal(r.receiptStatus, "timeout");
});

/**
 * The transport's guards, with the server stubbed.
 *
 * These are the cases where the two KeeperHub surfaces had drifted: the same reply shape that
 * the REST transport refuses was being accepted here, on the surface that carries the live
 * settlements.
 */
describe("what a reply from the MCP server does to a dispatch", () => {
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
  });

  /** Handshake, then one `tools/call` answered with this status and this tool payload. */
  function mcpAnswers(status: number, toolPayload: unknown, opts: { isError?: boolean; raw?: string } = {}) {
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body) as { method?: string };
      if (sent.method === "initialize") {
        return {
          status: 200,
          ok: true,
          headers: { get: (h: string) => (h.toLowerCase() === "mcp-session-id" ? "session-under-test" : null) },
          text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
        };
      }
      if (sent.method === "notifications/initialized") {
        return { status: 202, ok: true, headers: { get: () => null }, text: async () => "" };
      }
      const envelope = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: JSON.stringify(toolPayload) }],
          ...(opts.isError ? { isError: true } : {}),
        },
      });
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: () => null },
        text: async () => opts.raw ?? envelope,
      };
    }) as unknown as typeof fetch;
  }

  /** A fresh provider every time: the session id is cached for the life of one instance. */
  const fresh = () =>
    new KeeperHubMcpProvider({ apiKey: "kh_test", chainId: 11155111, rpcUrl: "http://127.0.0.1:1" });

  const STEP = { to: PROXY, data: PAY_CALLDATA, value: "0" };

  async function dispatch(): Promise<{ threw: boolean; code?: string; retryable?: boolean }> {
    try {
      await fresh().execute(STEP, "key-abc");
      return { threw: false };
    } catch (e) {
      const err = e as { code?: string; retryable?: boolean };
      return { threw: true, code: err.code, retryable: err.retryable };
    }
  }

  test("a tool payload carrying an error is never a clean dry run", async () => {
    // No `wouldRevert`, no `success`: both other comparisons are false, so without the third
    // term this reads as "would not revert" and the preflight gate lets a real payment through.
    mcpAnswers(200, { error: "execution reverted: ERC20: insufficient allowance" });
    const sim = await fresh().simulate(STEP);
    assert.equal(sim.wouldRevert, true, "a simulation that failed to run is not a simulation that passed");
  });

  test("a 409 conflict is an integrity incident on this transport too", async () => {
    // settle() keys its integrity branch on this exact code. Surfaced as anything else — it
    // used to arrive as `bad_response` — the incident is filed as an ordinary unknown outcome.
    mcpAnswers(409, {}, { raw: JSON.stringify({ code: "idempotency_conflict", error: "same key, different body" }) });
    const d = await dispatch();
    assert.equal(d.code, "idempotency_conflict");
    assert.equal(d.retryable, false, "rotating the key here is how the second payment happens");
  });

  test("a 409 still in progress is retryable here, as it is on REST", async () => {
    mcpAnswers(409, {}, { raw: JSON.stringify({ code: "idempotency_in_progress", error: "still working on this key" }) });
    const d = await dispatch();
    assert.equal(d.code, "idempotency_in_progress");
    assert.equal(d.retryable, true, "asking again about the same request is not a second request");
  });

  test("an in-progress answer returned as a tool error is retryable, not terminal", async () => {
    // The shape this server actually uses: HTTP 200, `isError`, the code in the text body.
    mcpAnswers(200, { error: "idempotency_in_progress" }, { isError: true });
    const d = await dispatch();
    assert.equal(d.code, "idempotency_in_progress");
    assert.equal(d.retryable, true, "an ordinary wait must not be dressed up as a terminal failure");
  });
});
