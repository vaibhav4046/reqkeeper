import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { KeeperHubProvider } from "../src/keeperhub.ts";
import { ProviderError } from "../src/provider.ts";

// Every case here refuses BEFORE any network call, so none of it touches KeeperHub.
const provider = new KeeperHubProvider({
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

test("a selector outside the allowlist is refused before dispatch", async () => {
  // selfdestruct-shaped nonsense, correctly formed but not a call we will ever make
  const e = await refusal({ to: PROXY, data: `0xdeadbeef${"00".repeat(32)}`, value: "0" });
  assert.equal(e.code, "selector_not_allowed");
  assert.equal(e.retryable, false);
});

test("trailing bytes smuggled after the arguments are refused", async () => {
  const e = await refusal({ to: PROXY, data: `${PAY_CALLDATA}deadbeef`, value: "0" });
  assert.equal(e.code, "calldata_mismatch");
  assert.equal(e.retryable, false);
});

test("an address word with dirty high bytes is refused rather than masked", async () => {
  const dirty = PAY_CALLDATA.replace(
    "0000000000000000000000000e2bb1c8d52315cad63f341424c5a7dd81a50f53",
    "0000000000000000000000ff0e2bb1c8d52315cad63f341424c5a7dd81a50f53",
  );
  assert.notEqual(dirty, PAY_CALLDATA);
  const e = await refusal({ to: PROXY, data: dirty, value: "0" });
  assert.equal(e.code, "calldata_mismatch");
});

test("a step with no calldata is refused", async () => {
  const e = await refusal({ to: PROXY, data: "0x", value: "0" });
  assert.equal(e.code, "calldata_invalid");
});

test("executing without an idempotency key is refused", async () => {
  const e = await refusal({ to: PROXY, data: PAY_CALLDATA, value: "0" }, "");
  assert.equal(e.code, "no_idempotency_key");
  assert.equal(e.retryable, false);
});

test("a provider cannot be constructed without a credential", () => {
  assert.throws(
    () => new KeeperHubProvider({ apiKey: "", chainId: 11155111, rpcUrl: "x" }),
    (e: unknown) => e instanceof ProviderError && e.code === "no_credential",
  );
});

test("a receipt that cannot be read is never reported as success", async () => {
  // The RPC here is unreachable on purpose. An unreachable chain must not resolve to
  // "verified", because that is exactly how a fake settlement would slip through.
  const r = await provider.receipt(`0x${"ab".repeat(32)}`);
  assert.equal(r.verified, false);
  assert.equal(r.receiptStatus, "timeout");
});

describe("a receipt is read three ways, not two", () => {
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
  });

  /** Answer eth_getTransactionReceipt with this exact object, on a chain that checks out. */
  function receiptSays(result: unknown) {
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const { method } = JSON.parse(init.body) as { method: string };
      if (method === "eth_chainId") return { json: async () => ({ jsonrpc: "2.0", id: 1, result: "0xaa36a7" }) };
      if (method === "eth_blockNumber") return { json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x64" }) };
      return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    }) as unknown as typeof fetch;
  }

  const HASH = `0x${"cd".repeat(32)}`;
  const readable = new KeeperHubProvider({ apiKey: "kh_test", chainId: 11155111, rpcUrl: "http://127.0.0.1:1" });

  test("0x1 is success", async () => {
    receiptSays({ status: "0x1", gasUsed: "0x1234" });
    const r = await readable.receipt(HASH);
    assert.equal(r.receiptStatus, "success");
    assert.equal(r.verified, true);
  });

  test("0x0 is reverted", async () => {
    receiptSays({ status: "0x0", gasUsed: "0x1234" });
    const r = await readable.receipt(HASH);
    assert.equal(r.receiptStatus, "reverted");
    assert.equal(r.verified, true);
  });

  test("a receipt with no status is unread, NOT reverted", async () => {
    // `status === "0x1" ? success : reverted` called this a revert. EXECUTION_REVERTED is
    // terminal, so one malformed RPC response could permanently label a real payment failed.
    receiptSays({ gasUsed: "0x1234" });
    const r = await readable.receipt(HASH);
    assert.notEqual(r.receiptStatus, "reverted", "a receipt we could not read is not a failed payment");
    assert.equal(r.verified, false, "and it must not count as evidence either");
  });

  test("a receipt with a nonsense status is unread, NOT reverted", async () => {
    receiptSays({ status: "banana", gasUsed: "0x1234" });
    const r = await readable.receipt(HASH);
    assert.notEqual(r.receiptStatus, "reverted");
    assert.equal(r.verified, false);
  });
});

describe("what each HTTP status does to a dispatch", () => {
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
  });

  function platformAnswers(status: number, body: unknown) {
    globalThis.fetch = (async () => ({
      status,
      ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(body),
      json: async () => body,
    })) as unknown as typeof fetch;
  }

  const p = new KeeperHubProvider({ apiKey: "kh_test", chainId: 11155111, rpcUrl: "http://127.0.0.1:1" });
  const send = () => p.execute({ to: PROXY, data: PAY_CALLDATA, value: "0" }, "key-abc");

  async function dispositionOf(status: number, body: unknown) {
    platformAnswers(status, body);
    try {
      const r = await send();
      return { threw: false as const, result: r };
    } catch (e) {
      const err = e as { code?: string; retryable?: boolean };
      return { threw: true as const, code: err.code, retryable: err.retryable };
    }
  }

  test("a 401 with a JSON body is a rejection, not a send", async () => {
    // It used to resolve as status "pending", so settle wrote outcome: SENT and every
    // in-flight obligation became a manual investigation the moment a key was revoked.
    // Nothing ran, and the disposition must say so.
    const d = await dispositionOf(401, { error: "invalid api key" });
    assert.equal(d.threw, true, "a rejected request must never resolve as a dispatch");
    assert.equal(d.threw && d.retryable, false, "a bad credential does not fix itself on a retry");
  });

  test("a 400 with a JSON body is a rejection, not a send", async () => {
    const d = await dispositionOf(400, { error: "Missing required field", field: "functionName" });
    assert.equal(d.threw, true);
    assert.equal(d.threw && d.retryable, false);
  });

  test("a 200 carrying an error body is never a completed payment", async () => {
    const d = await dispositionOf(200, { error: "insufficient funds for gas" });
    assert.equal(d.threw, false);
    assert.notEqual(d.threw === false && d.result.status, "completed");
  });

  test("429 is retryable and holds the key", async () => {
    const d = await dispositionOf(429, { error: "rate limited" });
    assert.equal(d.threw && d.code, "rate_limited");
    assert.equal(d.threw && d.retryable, true);
  });

  test("a 409 still in progress is retryable; it is the same request, not a second one", async () => {
    // These two arrive as the same status and mean opposite things. Collapsing them made the
    // recoverable one terminal and dressed an ordinary wait up as an integrity incident.
    const d = await dispositionOf(409, { code: "idempotency_in_progress", error: "still working on this key" });
    assert.equal(d.threw && d.code, "idempotency_in_progress");
    assert.equal(d.threw && d.retryable, true);
  });

  test("a 409 conflict is NOT retryable — the key must never be rotated to make it pass", async () => {
    const d = await dispositionOf(409, { code: "idempotency_conflict", error: "same key, different body" });
    assert.equal(d.threw && d.code, "idempotency_conflict");
    assert.equal(d.threw && d.retryable, false, "rotating the key here is how the second payment happens");
  });

  test("5xx is retryable", async () => {
    const d = await dispositionOf(503, { error: "upstream unavailable" });
    assert.equal(d.threw && d.retryable, true);
  });

  test("a success with no execution id records null, not the word 'unknown'", async () => {
    // The placeholder used to be persisted into attempts.execution_id and would have been sent
    // as a path segment by observe(). Two stranded attempts recorded the same identifier.
    const d = await dispositionOf(202, { status: "completed" });
    assert.equal(d.threw, false);
    assert.notEqual(d.threw === false && d.result.executionId, "unknown");
  });
});
