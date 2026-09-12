/**
 * The preflight gate must never read a failure as a clean dry run.
 *
 * `simulate()` answers one question: would this call revert? The settle path treats
 * `wouldRevert: false` as permission to spend money. So every response that is not an
 * affirmative "it simulated and it is fine" has to come back as unsafe, or as a throw.
 *
 * The defect these cover: `#post` threw only on 409, 429 and 5xx, so a 401 — or an HTTP 200
 * carrying `{"error": ...}` — returned as an ordinary body. Such a body has neither
 * `wouldRevert` nor `success`, both comparisons evaluated false, and the gate read
 * `wouldRevert: false`. A failure to simulate at all was indistinguishable from a clean
 * simulation, in the one direction that spends.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { encodeCall } from "../src/abi.ts";
import { KeeperHubProvider } from "../src/keeperhub.ts";
import { ERC20_FEE_PROXY, FAU, PAY_SIGNATURE } from "../src/plan.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer every request with one canned HTTP response. */
function stubFetch(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
}

function provider(): KeeperHubProvider {
  // rpcUrl is required by the config but unreachable here: fetch is stubbed, and
  // simulate() never performs a chain read.
  return new KeeperHubProvider({
    apiKey: "test-key",
    chainId: 11155111,
    rpcUrl: "https://rpc.invalid",
  });
}

/** A real, gate-valid fee-proxy payment: the calldata gate runs before any HTTP call. */
const STEP = {
  kind: "PAY" as const,
  to: ERC20_FEE_PROXY,
  data: encodeCall(PAY_SIGNATURE, [
    FAU,
    "0x0e2bb1c8d52315cad63f341424c5a7dd81a50f53",
    "1000000000000000000",
    "0x050562a52ec69fa2",
    "0",
    `0x${"0".repeat(40)}`,
  ]),
  value: "0",
};

describe("simulate() fails closed", () => {
  test("an HTTP 200 carrying an error body is not a clean simulation", async () => {
    stubFetch(200, { error: "insufficient funds" });
    const out = await provider().simulate(STEP);
    assert.equal(
      out.wouldRevert,
      true,
      "an error body must read as unsafe — reading it as wouldRevert:false lets the gate dispatch a real payment",
    );
  });

  test("an unauthorised response throws rather than returning a clean simulation", async () => {
    stubFetch(401, { error: "unauthorized" });
    await assert.rejects(
      () => provider().simulate(STEP),
      (e: Error) => {
        assert.match(e.message, /401/);
        return true;
      },
      "a 401 must not fall through and be reported as a simulation that passed",
    );
  });

  test("a 403 and a 400 also throw", async () => {
    for (const status of [400, 403, 404]) {
      stubFetch(status, { error: "nope" });
      await assert.rejects(
        () => provider().simulate(STEP),
        new RegExp(String(status)),
        `HTTP ${status} must not be treated as a successful simulation`,
      );
    }
  });

  test("a genuine clean simulation still reports wouldRevert false", async () => {
    // The guard must not be so broad that the working path breaks: no error field,
    // and an explicit negative, is the one shape that means "safe to proceed".
    stubFetch(200, { wouldRevert: false, gasEstimate: "74618" });
    const out = await provider().simulate(STEP);
    assert.equal(out.wouldRevert, false);
    assert.equal(out.gasEstimate, "74618");
  });

  test("an explicit revert is still reported", async () => {
    stubFetch(200, { wouldRevert: true, gasEstimate: "0" });
    assert.equal((await provider().simulate(STEP)).wouldRevert, true);
  });

  test("success:false is still reported", async () => {
    stubFetch(200, { success: false });
    assert.equal((await provider().simulate(STEP)).wouldRevert, true);
  });
});
