import { test } from "node:test";
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
