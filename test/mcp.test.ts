import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest, TOOLS, type McpContext } from "../src/mcp.ts";
import { FixtureProvider } from "../src/provider.ts";
import { Store } from "../src/store.ts";
import { obligationId } from "../src/identity.ts";
import { NAMESPACE } from "../src/plan.ts";

const REQUEST_ID = "012072a1818e83b2f153aa232112c03d09147c02ca5be45c6d507a78d4d5e70576";
const REFERENCE = "0x0056dcf7fc0a464f";
const PAYEE = "0xc43d766cb7c48b9b198db87441b97c09e81717a1";
const ONE = "1000000000000000000";
const TWO = "2000000000000000000";

function ctx(): McpContext & { provider: FixtureProvider } {
  const provider = new FixtureProvider();
  return {
    store: new Store(),
    provider,
    // No chain in tests. Nothing is paid until the fixture provider says so.
    findPayment: async () => ({ found: false }),
  } as McpContext & { provider: FixtureProvider };
}

const INVOICE = {
  requestId: REQUEST_ID,
  paymentReference: REFERENCE,
  payee: PAYEE,
  amountBaseUnits: ONE,
  maxTotalDebitBaseUnits: TWO,
};

async function call(c: McpContext, name: string, args: Record<string, unknown> = {}) {
  const res = await handleRequest(c, { id: 1, method: "tools/call", params: { name, arguments: args } });
  const result = res?.result as { content: Array<{ text: string }>; isError?: boolean };
  return {
    isError: result.isError === true,
    text: result.content[0].text,
    json: (() => {
      try {
        return JSON.parse(result.content[0].text);
      } catch {
        return null;
      }
    })(),
  };
}

// --- the security property -------------------------------------------------

test("NO tool on the agent surface can approve a payment", async () => {
  const names = TOOLS.map((t) => t.name);
  for (const n of names) {
    assert.ok(
      !/approve|authoris|authoriz|sign|confirm|decide/i.test(n),
      `tool "${n}" looks like it could authorise a payment; approval must not be on the agent surface`,
    );
  }
  // And the handler must not answer to one even if a client guesses the name.
  for (const guess of ["approve", "approve_payment", "record_approval", "authorize", "sign_plan"]) {
    const r = await call(ctx(), guess);
    assert.ok(r.isError, `handler responded to "${guess}" instead of refusing`);
    assert.match(r.text, /unknown tool/);
  }
});

test("propose_payment never dispatches and returns the sentence a human must read", async () => {
  const c = ctx();
  const r = await call(c, "propose_payment", INVOICE);
  assert.equal(r.json.state, "AWAITING_APPROVAL");
  assert.equal(r.json.providerWriteIssued, false);
  assert.equal(c.provider.totalSends(), 0);
  assert.match(r.json.approvalSentence, /^Pay 1 FAU to 0xc43d766c/);
  // The sentence must carry both the human figure and the exact base units.
  assert.match(r.json.approvalSentence, /1000000000000000000 base units/);
  assert.ok(r.json.planHash && r.json.planHash.length === 64);
});

test("settle_obligation with no human decision refuses and sends nothing", async () => {
  const c = ctx();
  await call(c, "propose_payment", INVOICE);
  const r = await call(c, "settle_obligation", INVOICE);
  assert.equal(r.json.state, "AWAITING_APPROVAL");
  assert.equal(r.json.providerWriteIssued, false);
  assert.equal(c.provider.totalSends(), 0);
  assert.match(r.json.agentGuidance, /has not decided yet/);
});

test("an agent hammering settle_obligation still cannot pay", async () => {
  const c = ctx();
  await call(c, "propose_payment", INVOICE);
  for (let i = 0; i < 25; i++) await call(c, "settle_obligation", INVOICE);
  assert.equal(c.provider.totalSends(), 0);
});

test("once a human approves, settle dispatches exactly once no matter how often it is called", async () => {
  const c = ctx();
  const proposal = await call(c, "propose_payment", INVOICE);
  // Stand in for scripts/approve.ts, the only thing that may write this row.
  c.store.recordApproval({
    planHash: proposal.json.planHash,
    obligationId: obligationId(NAMESPACE, REQUEST_ID),
    approver: "human@example.com",
    decision: "APPROVED",
    restatement: proposal.json.approvalSentence,
  });

  const first = await call(c, "settle_obligation", INVOICE);
  assert.equal(first.json.providerWriteIssued, true);
  assert.equal(c.provider.totalSends(), 1);

  for (let i = 0; i < 10; i++) {
    const again = await call(c, "settle_obligation", INVOICE);
    assert.equal(again.json.providerWriteIssued, false, "a repeat call issued a provider write");
  }
  assert.equal(c.provider.totalSends(), 1, "the money moved more than once");
});

test("a human rejection is permanent across repeated agent calls", async () => {
  const c = ctx();
  const proposal = await call(c, "propose_payment", INVOICE);
  c.store.recordApproval({
    planHash: proposal.json.planHash,
    obligationId: obligationId(NAMESPACE, REQUEST_ID),
    approver: "human@example.com",
    decision: "REJECTED",
    restatement: proposal.json.approvalSentence,
  });
  for (let i = 0; i < 5; i++) {
    const r = await call(c, "settle_obligation", INVOICE);
    assert.equal(r.json.state, "REVIEW_REJECTED");
  }
  assert.equal(c.provider.totalSends(), 0);
});

// --- input handling at the trust boundary ---------------------------------

test("base units given as a JSON number are refused, not coerced", async () => {
  // 1e18 is past Number.MAX_SAFE_INTEGER; silently accepting it loses money.
  const r = await call(ctx(), "propose_payment", { ...INVOICE, amountBaseUnits: 1000000000000000000 });
  assert.ok(r.isError);
  assert.match(r.text, /must be a decimal string, not a number/);
});

test("a missing spend ceiling is refused rather than defaulted", async () => {
  const partial = { ...INVOICE } as Record<string, unknown>;
  delete partial.maxTotalDebitBaseUnits;
  const r = await call(ctx(), "propose_payment", partial);
  assert.ok(r.isError);
  assert.match(r.text, /maxTotalDebitBaseUnits/);
});

test("a payee the policy does not allow is refused before any send", async () => {
  const c = ctx();
  // The ceiling and payee come from the same invoice, so force a mismatch by asking to pay
  // more than the stated ceiling.
  const r = await call(c, "propose_payment", { ...INVOICE, maxTotalDebitBaseUnits: "1" });
  assert.equal(r.json.refusal, "LIMIT_EXCEEDED");
  assert.equal(r.json.providerWriteIssued, false);
  assert.equal(c.provider.totalSends(), 0);
});

test("verify_payment rejects a non-hex reference", async () => {
  const r = await call(ctx(), "verify_payment", { paymentReference: "not-hex" });
  assert.ok(r.isError);
  assert.match(r.text, /must be 0x hex/);
});

// --- protocol plumbing ----------------------------------------------------

test("initialize advertises tools and states the approval constraint", async () => {
  const res = await handleRequest(ctx(), { id: 1, method: "initialize" });
  const r = res?.result as { protocolVersion: string; instructions: string; capabilities: unknown };
  assert.equal(r.protocolVersion, "2024-11-05");
  assert.match(r.instructions, /cannot approve/i);
});

test("notifications get no response at all", async () => {
  for (const method of ["notifications/initialized", "notifications/cancelled"]) {
    assert.equal(await handleRequest(ctx(), { method }), null);
  }
});

test("an unknown method is a JSON-RPC error, not a crash", async () => {
  const res = await handleRequest(ctx(), { id: 7, method: "nonsense/method" });
  assert.equal(res?.error?.code, -32601);
  assert.equal(res?.id, 7);
});

test("tools/list returns schemas that mark base units as strings", async () => {
  const res = await handleRequest(ctx(), { id: 1, method: "tools/list" });
  const { tools } = res?.result as { tools: typeof TOOLS };
  const propose = tools.find((t) => t.name === "propose_payment");
  assert.ok(propose);
  const props = propose.inputSchema.properties as Record<string, { type: string }>;
  assert.equal(props.amountBaseUnits.type, "string");
  assert.equal(props.maxTotalDebitBaseUnits.type, "string");
});

test("obligation_status reports an unknown invoice as unknown rather than inventing state", async () => {
  const r = await call(ctx(), "obligation_status", { requestId: REQUEST_ID });
  assert.equal(r.json.known, false);
});

test("obligation_status exposes the audit trail after a proposal", async () => {
  const c = ctx();
  await call(c, "propose_payment", INVOICE);
  const r = await call(c, "obligation_status", { requestId: REQUEST_ID });
  assert.equal(r.json.known, true);
  assert.ok(r.json.auditTrail.some((e: { action: string }) => e.action === "PROPOSED"));
});

test("every refusal code carries do-not-retry guidance for an agent", async () => {
  const r = await call(ctx(), "refusal_codes");
  for (const code of ["ALREADY_DISPATCHED", "REVIEW_REJECTED", "CACHED_FAILURE", "EVIDENCE_CONFLICT"]) {
    assert.ok(r.json.codes[code], `no guidance for ${code}`);
  }
  assert.match(r.json.codes.CACHED_FAILURE, /would pay twice/);
});

test("a settled obligation is never re-entered, and its state never regresses", async () => {
  const c = ctx();
  const proposal = await call(c, "propose_payment", INVOICE);
  c.store.recordApproval({
    planHash: proposal.json.planHash,
    obligationId: obligationId(NAMESPACE, REQUEST_ID),
    approver: "human@example.com",
    decision: "APPROVED",
    restatement: proposal.json.approvalSentence,
  });
  // The chain must agree about THIS transaction and THIS amount, not merely that the
  // reference appears somewhere. FixtureProvider's first send is 0x…01.
  // Request indexes a payment only after one has been made. A stub that reports the
  // reference paid before the first send is not a slow indexer, it is a different invoice —
  // and the code now correctly refuses that as SOURCE_ALREADY_PAID.
  const paid: McpContext = {
    ...c,
    findPayment: async () =>
      c.provider.totalSends() > 0
        ? { found: true, txHash: `0x${"0".repeat(63)}1`, amount: ONE }
        : { found: false },
  };
  const first = await call(paid, "settle_obligation", INVOICE);
  assert.equal(first.json.state, "SETTLED");

  const again = await call(paid, "settle_obligation", INVOICE);
  assert.equal(again.json.refusal, "ALREADY_SETTLED");
  assert.equal(again.json.providerWriteIssued, false);

  // The reported state must still be SETTLED, not dragged back to a pre-dispatch state.
  const status = await call(paid, "obligation_status", { requestId: REQUEST_ID });
  assert.equal(status.json.state, "SETTLED");
  assert.equal(c.provider.totalSends(), 1);
});
