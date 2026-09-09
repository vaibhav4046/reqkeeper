import { test } from "node:test";
import assert from "node:assert/strict";
import { KeeperHubMcpProvider } from "../src/keeperhub-mcp.ts";
import { ProviderError } from "../src/provider.ts";

// Every case refuses before any network call, so none of this reaches KeeperHub. The live
// handshake and dry run are covered by `npm run verify:mcp` instead, because asserting a
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
