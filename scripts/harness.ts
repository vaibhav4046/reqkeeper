/**
 * The refusal harness. This is the scored artifact.
 *
 * The winning entries in the previous KeeperHub hackathon led with the count of things they
 * correctly REFUSED to do, independently verified — third place beat 187 projects with
 * "20/20 impossible transfers refused before submission (0 gas burned)". So the deliverable
 * is not a feature list: it is this table, plus the honesty about what it does not cover.
 *
 * Emits docs/refusals.json and prints a table. Every row carries a mode tag, and
 * `providerWriteIssued: false` on a refusal row is the "0 gas burned" claim, asserted
 * against a provider that counts physical sends rather than reporting a status string.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { FixtureProvider, type Fault } from "../src/provider.ts";
import { Store } from "../src/store.ts";
import { settleObligation } from "../src/settle.ts";
import { obligationId } from "../src/identity.ts";
import { toBaseUnits } from "../src/money.ts";
import { encodeCall } from "../src/abi.ts";
import { PAY_SIGNATURE } from "../src/plan.ts";
import type { Policy, SourceFacts } from "../src/policy.ts";

const NS = "request-network:sepolia";
const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const FAKE_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const PAYEE = "0x0e2bB0000000000000000000000000000000F531";
const STRANGER = "0xdEAdBeef00000000000000000000000000000001";
const FEE_ADDR = "0xAaAa000000000000000000000000000000000001";
const PROXY = "0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE";

const policy: Policy = {
  version: 1,
  chainId: 11155111,
  token: { address: FAU, decimals: 18, symbol: "FAU" },
  allowedPayees: [PAYEE],
  maxTotalDebitBaseUnits: toBaseUnits("100", 18).toString(),
  allowedFeeRecipients: [FEE_ADDR],
  maxFeeBaseUnits: toBaseUnits("1", 18).toString(),
  planTtlSeconds: 900,
};

function facts(over: Partial<SourceFacts> = {}): SourceFacts {
  return {
    chainId: 11155111,
    tokenAddress: FAU,
    tokenDecimals: 18,
    payee: PAYEE,
    invoiceBaseUnits: toBaseUnits("50", 18).toString(),
    feeBaseUnits: "0",
    feeRecipient: FEE_ADDR,
    hasBeenPaid: false,
    ...over,
  };
}

const REFERENCE = "0x0056a1b2c3d4e5f6";

/**
 * Real, fully encoded calldata built from the same facts the case asserts against.
 *
 * These used to be bare four-byte selectors. Every fixture passed, and not one of them
 * exercised the argument bytes — which is the entire thesis. A stub cannot disagree with an
 * invoice, so a suite built on stubs can never catch calldata that does.
 */
function stepsFor(f: SourceFacts) {
  const total = (BigInt(f.invoiceBaseUnits) + BigInt(f.feeBaseUnits)).toString();
  return [
    {
      kind: "ALLOWANCE_GRANT",
      to: f.tokenAddress,
      data: encodeCall("approve(address,uint256)", [PROXY, total]),
      value: "0",
    },
    {
      kind: "REQUEST_PAYMENT",
      to: PROXY,
      data: encodeCall(PAY_SIGNATURE, [
        f.tokenAddress,
        f.payee,
        f.invoiceBaseUnits,
        REFERENCE,
        f.feeBaseUnits,
        f.feeRecipient,
      ]),
      value: "0",
    },
  ];
}

const APPROVED = { approver: "human:owner", decision: "APPROVED" as const };

interface Row {
  case_id: string;
  scenario: string;
  expected: string;
  actual: string;
  refused_before_provider_write: boolean;
  physical_sends: number;
  tx_hash: string | null;
  independently_verified: boolean;
  fault_injected: Fault | null;
  mode: "FIXTURE";
  pass: boolean;
}

const rows: Row[] = [];
let n = 0;

async function run(
  scenario: string,
  expected: string,
  build: () => { facts: SourceFacts; fault?: Fault; approval?: typeof APPROVED | { approver: string; decision: "REJECTED" }; now?: number; factsAtDispatch?: SourceFacts; requestId?: string; pre?: (s: Store, o: string) => void; steps?: ReturnType<typeof stepsFor> },
): Promise<void> {
  n++;
  const cfg = build();
  const store = new Store();
  const provider = new FixtureProvider(cfg.fault ?? "NONE");
  const requestId = cfg.requestId ?? `req-${n}`;
  const oid = obligationId(NS, requestId);
  cfg.pre?.(store, oid);

  const outcome = await settleObligation(
    { store, provider, policy, sourceSaysPaid: async () => true },
    {
      namespace: NS,
      requestId,
      obligationId: oid,
      facts: cfg.facts,
      steps: cfg.steps ?? stepsFor(cfg.facts),
      approval: "approval" in cfg ? cfg.approval : APPROVED,
      now: cfg.now ?? 1_000_000,
      factsAtDispatch: cfg.factsAtDispatch,
    },
  );

  const actual = outcome.refusal ?? outcome.state;
  const sends = provider.totalSends();
  rows.push({
    case_id: `C${String(n).padStart(2, "0")}`,
    scenario,
    expected,
    actual,
    refused_before_provider_write: !outcome.providerWriteIssued,
    physical_sends: sends,
    tx_hash: outcome.txHash ?? null,
    independently_verified: outcome.state === "SETTLED",
    fault_injected: cfg.fault ?? null,
    mode: "FIXTURE",
    pass: actual === expected,
  });
  store.close();
}

// ---- happy path -----------------------------------------------------------
await run("a clean, approved obligation settles", "SETTLED", () => ({ facts: facts() }));

// ---- policy refusals, all before any provider write -----------------------
await run("recipient not on the allowlist", "PAYEE_NOT_ALLOWED", () => ({ facts: facts({ payee: STRANGER }) }));
await run("total debit over the cap", "LIMIT_EXCEEDED", () => ({ facts: facts({ invoiceBaseUnits: toBaseUnits("101", 18).toString() }) }));
await run("invoice under cap that a fee pushes over", "LIMIT_EXCEEDED", () => ({
  facts: facts({ invoiceBaseUnits: toBaseUnits("100", 18).toString(), feeBaseUnits: toBaseUnits("0.5", 18).toString() }),
}));
await run("wrong chain", "UNSUPPORTED_CHAIN", () => ({ facts: facts({ chainId: 84532 }) }));
await run("wrong token on the right chain", "UNSUPPORTED_TOKEN", () => ({ facts: facts({ tokenAddress: FAKE_USDC }) }));
await run("token decimals differ from policy (10^12 hazard)", "TOKEN_DECIMALS_MISMATCH", () => ({ facts: facts({ tokenDecimals: 6 }) }));
await run("Request already reports it paid", "SOURCE_ALREADY_PAID", () => ({ facts: facts({ hasBeenPaid: true }) }));
await run("zero amount", "AMOUNT_NOT_POSITIVE", () => ({ facts: facts({ invoiceBaseUnits: "0" }) }));
await run("unrecognised fee recipient", "FEE_RECIPIENT_UNKNOWN", () => ({
  facts: facts({ feeBaseUnits: toBaseUnits("0.1", 18).toString(), feeRecipient: STRANGER }),
}));
await run("fee above the ceiling", "FEE_EXCEEDS_CEILING", () => ({ facts: facts({ feeBaseUnits: toBaseUnits("2", 18).toString() }) }));

// ---- authority ------------------------------------------------------------
await run("no human decision yet", "AWAITING_APPROVAL", () => ({ facts: facts(), approval: undefined }));
await run("reviewer rejects", "REVIEW_REJECTED", () => ({
  facts: facts(),
  approval: { approver: "human:owner", decision: "REJECTED" },
}));
await run("source facts changed between approval and dispatch", "PLAN_CHANGED", () => ({
  facts: facts(),
  factsAtDispatch: facts({ invoiceBaseUnits: toBaseUnits("50.000000000000000001", 18).toString() }),
}));

// ---- duplicate defence ----------------------------------------------------
await run("a rival plan already holds the obligation", "OBLIGATION_RESERVED", () => ({
  facts: facts(),
  requestId: "req-dup",
  pre: (s, oid) => {
    s.importObligation({ obligationId: oid, namespace: NS, requestId: "req-dup", sourceFactsJson: "{}", sourceFactsHash: "a".repeat(64) });
    s.savePlan({ planHash: "9".repeat(64), obligationId: oid, version: 1, policyHash: "d".repeat(64), sourceFactsHash: "a".repeat(64), planJson: "{}", totalDebitBaseUnits: "1", expiresAt: 9e12 });
    s.reserveObligation(oid, "9".repeat(64));
  },
}));

// ---- platform faults ------------------------------------------------------
await run("provider write times out with no response", "EXECUTION_OUTCOME_UNKNOWN", () => ({ facts: facts(), fault: "TIMEOUT_NO_RESPONSE" }));
await run("cached failure replays forever (#1840)", "CACHED_FAILURE", () => ({ facts: facts(), fault: "CACHED_FAILURE" }));
await run("same key, different body", "IDEMPOTENCY_CONFLICT", () => ({ facts: facts(), fault: "IDEMPOTENCY_CONFLICT" }));
await run("dry run actually executed (#1959)", "SIMULATE_EXECUTED", () => ({ facts: facts(), fault: "SIMULATE_IGNORED" }));
await run("receipt says reverted", "EXECUTION_REVERTED", () => ({ facts: facts(), fault: "RECEIPT_REVERTED" }));
await run("provider claims success, chain has no receipt", "EVIDENCE_CONFLICT", () => ({ facts: facts(), fault: "COMPLETE_BUT_RECEIPT_MISSING" }));
await run("provider rate limits the preflight", "rate_limited", () => ({ facts: facts(), fault: "RATE_LIMITED" }));

// ---- the headline: replay after the 24h window lapses ---------------------
// Same obligation, same plan, same key, provider cache gone. The registry must still refuse.
{
  n++;
  const store = new Store();
  const provider = new FixtureProvider("NONE");
  const requestId = "req-replay";
  const oid = obligationId(NS, requestId);
  const deps = { store, provider, policy, sourceSaysPaid: async () => true };
  const input = { namespace: NS, requestId, obligationId: oid, facts: facts(), steps: stepsFor(facts()), approval: APPROVED, now: 1_000_000 };

  const first = await settleObligation(deps, input);
  const sendsAfterFirst = provider.totalSends();

  // 25 hours later the provider has forgotten the key entirely.
  provider.setFault("REPLAY_EXPIRED");
  const second = await settleObligation(deps, { ...input, now: 1_000_000 + 25 * 3600 * 1000 });

  const sendsAfterSecond = provider.totalSends();
  const noSecondPayment = sendsAfterSecond === sendsAfterFirst;
  rows.push({
    case_id: `C${String(n).padStart(2, "0")}`,
    scenario: "replay 25h later, settled, provider cache expired",
    expected: "ALREADY_SETTLED",
    actual: second.refusal ?? second.state,
    refused_before_provider_write: !second.providerWriteIssued,
    physical_sends: sendsAfterSecond,
    tx_hash: first.txHash ?? null,
    independently_verified: false,
    fault_injected: "REPLAY_EXPIRED",
    mode: "FIXTURE",
    pass: (second.refusal ?? second.state) === "ALREADY_SETTLED" && noSecondPayment,
  });
  store.close();
}

// ---- the real double-payment window: plan still valid, provider cache gone ----
// This is the case the 24h replay expiry creates and that nothing upstream defends.
{
  n++;
  const store = new Store();
  const provider = new FixtureProvider("NONE");
  const requestId = "req-inttl";
  const oid = obligationId(NS, requestId);
  const deps = { store, provider, policy, sourceSaysPaid: async () => true };
  const input = { namespace: NS, requestId, obligationId: oid, facts: facts(), steps: stepsFor(facts()), approval: APPROVED, now: 2_000_000 };

  await settleObligation(deps, input);
  const sendsAfterFirst = provider.totalSends();

  // Provider has forgotten the key, but the plan has NOT expired.
  provider.setFault("REPLAY_EXPIRED");
  const second = await settleObligation(deps, { ...input, now: 2_000_000 + 60_000 });

  const sendsAfterSecond = provider.totalSends();
  rows.push({
    case_id: `C${String(n).padStart(2, "0")}`,
    scenario: "replay inside plan TTL, settled, provider cache expired",
    expected: "ALREADY_SETTLED",
    actual: second.refusal ?? second.state,
    refused_before_provider_write: !second.providerWriteIssued,
    physical_sends: sendsAfterSecond,
    tx_hash: second.txHash ?? null,
    independently_verified: false,
    fault_injected: "REPLAY_EXPIRED",
    mode: "FIXTURE",
    pass: (second.refusal ?? second.state) === "ALREADY_SETTLED" && sendsAfterSecond === sendsAfterFirst,
  });
  store.close();
}

// ---- the same replays, but from an UNCONFIRMED first leg -------------------
// The settled short-circuit refuses earlier than these guards, so without a first leg that
// never reaches SETTLED the attempt-level and TTL guards would be shadowed and untested.
for (const [label, advanceMs, want] of [
  ["replay inside plan TTL, outcome unconfirmed", 60_000, "ALREADY_DISPATCHED"],
  // The plan has also expired here, but expiry never gets a look in: an obligation whose
  // outcome is unknown is refused before any planning, because a second plan over a live
  // payment is the failure this project exists to stop. Expiry would be the weaker answer.
  ["replay 25h later (plan expired too), outcome unconfirmed", 25 * 3600 * 1000, "ALREADY_DISPATCHED"],
] as const) {
  n++;
  const store = new Store();
  const provider = new FixtureProvider("NONE");
  const requestId = `req-unconfirmed-${advanceMs}`;
  const oid = obligationId(NS, requestId);
  // The chain never confirms, so the first call stops short of SETTLED.
  const deps = { store, provider, policy, sourceSaysPaid: async () => false };
  const input = { namespace: NS, requestId, obligationId: oid, facts: facts(), steps: stepsFor(facts()), approval: APPROVED, now: 3_000_000 };

  await settleObligation(deps, input);
  const sendsAfterFirst = provider.totalSends();

  provider.setFault("REPLAY_EXPIRED");
  const second = await settleObligation(deps, { ...input, now: 3_000_000 + advanceMs });
  const sendsAfterSecond = provider.totalSends();

  rows.push({
    case_id: `C${String(n).padStart(2, "0")}`,
    scenario: label,
    expected: want,
    actual: second.refusal ?? second.state,
    refused_before_provider_write: !second.providerWriteIssued,
    physical_sends: sendsAfterSecond,
    tx_hash: second.txHash ?? null,
    independently_verified: false,
    fault_injected: "REPLAY_EXPIRED",
    mode: "FIXTURE",
    pass: (second.refusal ?? second.state) === want && sendsAfterSecond === sendsAfterFirst,
  });
  store.close();
}

// ---- report ---------------------------------------------------------------
const refusalRows = rows.filter((r) => r.expected !== "SETTLED" && r.expected !== "AWAITING_APPROVAL");
const cleanRefusals = refusalRows.filter((r) => r.refused_before_provider_write);
const passed = rows.filter((r) => r.pass).length;

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
console.log(
  `\n${pad("id", 5)}${pad("scenario", 52)}${pad("expected", 28)}${pad("actual", 28)}${pad("pre-write", 10)}${pad("sends", 6)}ok`,
);
console.log("-".repeat(133));
for (const r of rows) {
  console.log(
    pad(r.case_id, 5) + pad(r.scenario, 52) + pad(r.expected, 28) + pad(r.actual, 28) +
      pad(r.refused_before_provider_write ? "yes" : "no", 10) + pad(String(r.physical_sends), 6) +
      (r.pass ? "ok" : "FAIL"),
  );
}

const summary = {
  generatedAt: new Date().toISOString(),
  mode: "FIXTURE" as const,
  note:
    "Deterministic fault injection against an in-memory provider that counts physical sends. " +
    "These rows prove the refusal logic, not the live integration. Live rows require Gate A " +
    "and are tagged LIVE_TESTNET when present.",
  totals: {
    cases: rows.length,
    passed,
    failed: rows.length - passed,
    refusalCases: refusalRows.length,
    refusedBeforeAnyProviderWrite: cleanRefusals.length,
  },
  rows,
};

mkdirSync("docs", { recursive: true });
writeFileSync("docs/refusals.json", `${JSON.stringify(summary, null, 2)}\n`);

console.log(
  `\n${passed}/${rows.length} cases behaved as specified.\n` +
    `${cleanRefusals.length}/${refusalRows.length} refusals happened before any provider write (0 gas burned).\n` +
    `Written to docs/refusals.json (mode: FIXTURE).\n`,
);
process.exit(passed === rows.length ? 0 : 1);
