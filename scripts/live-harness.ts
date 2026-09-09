/**
 * The refusal table, run against real money.
 *
 * `scripts/harness.ts` proves the refusal logic against a fixture provider. This proves the
 * same protocol against the live KeeperHub API and real Request invoices on Sepolia, and
 * every row it writes carries either a real transaction hash or a physically-counted zero.
 *
 * Two kinds of row, and the distinction is the whole point:
 *
 *   settled / replayed   one real payment per invoice, then the same obligation dispatched
 *                        again through the same function. The second call must not send.
 *                        This is the only kind that spends anything.
 *   pre-dispatch refusal a live provider, a live policy, and a refusal that happens before
 *                        any provider write. Nothing is spent, and the send counter proves it
 *                        rather than a status string asserting it.
 *
 * Sends are counted by wrapping the provider, so "0 gas burned" is a number this script
 * observed and not a claim the provider made about itself.
 *
 * Usage: node --experimental-strip-types scripts/live-harness.ts [--limit N]
 * Requires docs/live-invoices.json from tools/invoice/create-batch.mjs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { encodeCall } from "../src/abi.ts";
import { DEFAULT_RPC, findPaymentByReference } from "../src/chain.ts";
import { obligationId } from "../src/identity.ts";
import { KeeperHubProvider } from "../src/keeperhub.ts";
import {
  buildPolicy,
  buildSourceFacts,
  buildSteps,
  ERC20_FEE_PROXY,
  FAU,
  NAMESPACE,
  PAY_SIGNATURE,
  SEPOLIA,
  type InvoiceFacts,
} from "../src/plan.ts";
import type {
  ExecuteResult,
  ExecutionProvider,
  Receipt,
  SimulateResult,
} from "../src/provider.ts";
import { settleObligation } from "../src/settle.ts";
import { Store } from "../src/store.ts";

// ---- env ------------------------------------------------------------------

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const API_KEY = process.env.KEEPERHUB_API_KEY ?? "";
if (!API_KEY) {
  console.error("KEEPERHUB_API_KEY is required for a live run");
  process.exit(2);
}

const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Number.POSITIVE_INFINITY;

const INVOICES = "docs/live-invoices.json";
if (!existsSync(INVOICES)) {
  console.error(`${INVOICES} not found. Run tools/invoice/create-batch.mjs first.`);
  process.exit(2);
}
const batch = JSON.parse(readFileSync(INVOICES, "utf8")) as {
  invoices: Array<{
    requestId: string;
    paymentReference: string;
    payee: string;
    amountBaseUnits: string;
    feeAmount: string;
    feeAddress: string;
  }>;
};

// ---- a provider that counts what it physically sent ------------------------

/**
 * Wraps the real provider and counts execute() calls that actually reached the network.
 * A refusal row's "0" is this counter, not an inference.
 */
class CountingProvider implements ExecutionProvider {
  #inner: ExecutionProvider;
  sends = 0;
  simulations = 0;

  constructor(inner: ExecutionProvider) {
    this.#inner = inner;
  }
  async simulate(body: unknown): Promise<SimulateResult> {
    this.simulations++;
    return await this.#inner.simulate(body);
  }
  async execute(body: unknown, key: string): Promise<ExecuteResult> {
    // Counted before the await: a call that throws mid-flight may still have sent.
    this.sends++;
    return await this.#inner.execute(body, key);
  }
  async observe(id: string): Promise<ExecuteResult> {
    return await this.#inner.observe(id);
  }
  async receipt(hash: string): Promise<Receipt> {
    return await this.#inner.receipt(hash);
  }
}

const APPROVED = { approver: "owner@reqkeeper.local", decision: "APPROVED" as const };

type Row = {
  case_id: string;
  scenario: string;
  expected: string;
  actual: string;
  refused_before_provider_write: boolean;
  physical_sends: number;
  tx_hash: string | null;
  independently_verified: boolean;
  request_id: string | null;
  payment_reference: string | null;
  mode: "LIVE_TESTNET";
};

const rows: Row[] = [];
let n = 0;
const nextId = (): string => `L${String(++n).padStart(3, "0")}`;

function factsFor(inv: (typeof batch.invoices)[number], overrides: Partial<InvoiceFacts> = {}): InvoiceFacts {
  return {
    requestId: inv.requestId,
    paymentReference: inv.paymentReference,
    payee: inv.payee,
    amountBaseUnits: inv.amountBaseUnits,
    // Twice the invoice, so the ceiling is real but not the thing under test.
    maxTotalDebitBaseUnits: "2000000000000000000",
    feeAmount: inv.feeAmount,
    feeAddress: inv.feeAddress,
    ...overrides,
  };
}

function newProvider(): CountingProvider {
  return new CountingProvider(
    new KeeperHubProvider({ apiKey: API_KEY, chainId: SEPOLIA, rpcUrl: DEFAULT_RPC }),
  );
}

if (!existsSync(".data")) mkdirSync(".data");
const store = new Store(".data/live-harness.sqlite");

// ---- 1. settle for real, then replay --------------------------------------

// Resumable, and for a reason that matters: an invoice this store has already settled was
// really paid, so re-settling it must never be attempted. Skipping is the only safe
// behaviour, and it makes a partial run cheap to finish rather than something to redo.
const alreadySettled: string[] = [];
const unsettled = batch.invoices.filter((inv) => {
  const state = store.getObligation(obligationId(NAMESPACE, inv.requestId))?.state;
  if (state === "SETTLED") {
    alreadySettled.push(inv.requestId);
    return false;
  }
  return true;
});
const payable = unsettled.slice(0, Number.isFinite(LIMIT) ? LIMIT : unsettled.length);

console.log(`\nLive harness: ${payable.length} invoices, real payments on Sepolia`);
if (alreadySettled.length > 0) {
  console.log(`Skipping ${alreadySettled.length} already settled by an earlier run.`);
}
console.log("");
console.log(`${"id".padEnd(6)}${"scenario".padEnd(34)}${"actual".padEnd(22)}${"sends".padEnd(7)}tx`);
console.log("-".repeat(110));

function record(row: Row): void {
  rows.push(row);
  const ok = row.actual === row.expected ? "" : "  <- UNEXPECTED";
  console.log(
    row.case_id.padEnd(6) +
      row.scenario.slice(0, 33).padEnd(34) +
      row.actual.padEnd(22) +
      String(row.physical_sends).padEnd(7) +
      (row.tx_hash ? `${row.tx_hash.slice(0, 18)}…` : "-") +
      ok,
  );
}

for (const inv of payable) {
  const facts = factsFor(inv);
  const oid = obligationId(NAMESPACE, inv.requestId);
  const sourceFacts = buildSourceFacts(facts);
  const provider = newProvider();
  const deps = {
    store,
    provider,
    policy: buildPolicy(facts),
    sourceSaysPaid: async (_requestId: string, txHash: string) => {
            // Not just "the reference appears somewhere": it must be OUR transaction for
            // OUR amount. A boolean over the reference alone accepts another payment's
            // evidence, which is how a duplicate obligation reported SETTLED.
            const seen = await findPaymentByReference(inv.paymentReference, { lookbackBlocks: 300_000 });
            return (
              seen.found &&
              seen.txHash?.toLowerCase() === txHash.toLowerCase() &&
              seen.amount === inv.amountBaseUnits
            );
          },
  };
  const input = {
    namespace: NAMESPACE,
    requestId: inv.requestId,
    paymentReference: inv.paymentReference,
    obligationId: oid,
    facts: sourceFacts,
    steps: buildSteps(facts),
    approval: APPROVED,
    now: Date.now(),
    factsAtDispatch: sourceFacts,
  };

  const first = await settleObligation(deps, input);
  record({
    case_id: nextId(),
    scenario: "approved obligation settles",
    expected: "SETTLED",
    actual: first.refusal ?? first.state,
    refused_before_provider_write: !first.providerWriteIssued,
    physical_sends: provider.sends,
    tx_hash: first.txHash ?? null,
    independently_verified: first.state === "SETTLED",
    request_id: inv.requestId,
    payment_reference: inv.paymentReference,
    mode: "LIVE_TESTNET",
  });

  // The replay. Same obligation, same approved plan, a second dispatch attempt.
  const sendsBefore = provider.sends;
  const second = await settleObligation(deps, { ...input, now: Date.now() });
  record({
    case_id: nextId(),
    scenario: "same obligation dispatched again",
    expected: "ALREADY_SETTLED",
    actual: second.refusal ?? second.state,
    refused_before_provider_write: !second.providerWriteIssued,
    physical_sends: provider.sends - sendsBefore,
    tx_hash: second.txHash ?? null,
    independently_verified: false,
    request_id: inv.requestId,
    payment_reference: inv.paymentReference,
    mode: "LIVE_TESTNET",
  });
}

// ---- 2. live refusals that never reach the provider -----------------------
//
// A live provider and a live policy, on a fresh unpaid invoice. Each of these must refuse
// before any provider write, so the send counter is the evidence that nothing was spent.

const spare = batch.invoices[payable.length] ?? batch.invoices.at(-1);
if (spare) {
  type Case = {
    scenario: string;
    expected: string;
    // What the invoice says.
    mutate: (f: InvoiceFacts) => InvoiceFacts;
    // What the human's policy says. Separate from the invoice on purpose: every one of
    // these refusals is a disagreement between the two, and collapsing them into one
    // object cannot express that.
    policyMutate?: (f: InvoiceFacts) => InvoiceFacts;
    noApproval?: boolean;
    badCalldata?: "trailing" | "selector";
  };

  const cases: Case[] = [
    {
      scenario: "recipient not on the allowlist",
      expected: "PAYEE_NOT_ALLOWED",
      // The policy allowlists the invoice's payee, so paying anyone else must refuse.
      mutate: (f) => ({ ...f, payee: "0x000000000000000000000000000000000000dEaD" }),
    },
    {
      scenario: "invoice exceeds the total debit cap",
      expected: "LIMIT_EXCEEDED",
      mutate: (f) => f,
      policyMutate: (f) => ({ ...f, maxTotalDebitBaseUnits: "1" }),
    },
    {
      // A separate refusal from the one above, and it fires first: the fee has its own
      // ceiling, so a quoted fee cannot be smuggled in under a generous total cap.
      scenario: "quoted fee exceeds its own ceiling",
      expected: "FEE_EXCEEDS_CEILING",
      mutate: (f) => ({ ...f, feeAmount: "1" }),
    },
    {
      scenario: "token decimals disagree with policy",
      expected: "TOKEN_DECIMALS_MISMATCH",
      mutate: (f) => ({ ...f, tokenDecimals: 6 }),
    },
    {
      scenario: "no human decision recorded",
      expected: "AWAITING_APPROVAL",
      mutate: (f) => f,
      noApproval: true,
    },
    {
      scenario: "bytes appended after the arguments",
      expected: "calldata_mismatch",
      mutate: (f) => f,
      badCalldata: "trailing",
    },
    {
      scenario: "selector not on the allowlist",
      expected: "selector_not_allowed",
      mutate: (f) => f,
      badCalldata: "selector",
    },
  ];

  for (const c of cases) {
    const facts = c.mutate(factsFor(spare));
    // A distinct namespace per case so each gets a fresh obligation rather than colliding
    // with the settled one, without inventing a fake request id.
    const ns = `${NAMESPACE}:live-refusal:${c.expected}`;
    const oid = obligationId(ns, spare.requestId);
    const provider = newProvider();
    const sourceFacts = buildSourceFacts(facts);

    let steps = buildSteps(facts);
    if (c.badCalldata === "trailing") {
      steps = [{ ...steps[0], data: `${steps[0].data}deadbeef` }];
    } else if (c.badCalldata === "selector") {
      steps = [
        {
          ...steps[0],
          to: ERC20_FEE_PROXY,
          data: `0xdeadbeef${encodeCall(PAY_SIGNATURE, [
            FAU,
            facts.payee.toLowerCase(),
            facts.amountBaseUnits,
            facts.paymentReference,
            "0",
            facts.feeAddress.toLowerCase(),
          ]).slice(10)}`,
        },
      ];
    }

    const out = await settleObligation(
      {
        store,
        provider,
        policy: buildPolicy((c.policyMutate ?? ((f) => f))(factsFor(spare))),
        sourceSaysPaid: async () => false,
      },
      {
        namespace: ns,
        requestId: spare.requestId,
        paymentReference: spare.paymentReference,
        obligationId: oid,
        facts: sourceFacts,
        steps,
        ...(c.noApproval ? {} : { approval: APPROVED }),
        now: Date.now(),
        factsAtDispatch: sourceFacts,
      },
    );

    record({
      case_id: nextId(),
      scenario: c.scenario,
      expected: c.expected,
      actual: out.refusal ?? out.state,
      refused_before_provider_write: !out.providerWriteIssued,
      physical_sends: provider.sends,
      tx_hash: out.txHash ?? null,
      independently_verified: false,
      request_id: spare.requestId,
      payment_reference: spare.paymentReference,
      mode: "LIVE_TESTNET",
    });
  }
}

store.close();

// ---- report ---------------------------------------------------------------

const asSpecified = rows.filter((r) => r.actual === r.expected).length;
const refusals = rows.filter((r) => r.expected !== "SETTLED");
const clean = refusals.filter((r) => r.refused_before_provider_write);
const paid = rows.filter((r) => r.expected === "SETTLED" && r.actual === "SETTLED");
const totalSends = rows.reduce((a, r) => a + r.physical_sends, 0);

console.log(`\n${asSpecified}/${rows.length} rows behaved as specified.`);
console.log(`${clean.length}/${refusals.length} refusals happened before any provider write (0 gas burned).`);
console.log(`${paid.length} real payments, ${totalSends} physical sends in total.`);
console.log(
  paid.length === totalSends
    ? "Every send is accounted for by exactly one settled obligation.\n"
    : "MISMATCH: sends do not equal settled obligations.\n",
);

const out = {
  generatedAt: new Date().toISOString(),
  mode: "LIVE_TESTNET",
  note:
    "Every row ran against the live KeeperHub API and real Request Network invoices on " +
    "Ethereum Sepolia. Sends are counted by wrapping the provider, so a zero is observed " +
    "rather than asserted. Settled rows carry the real transaction hash; refusal rows carry " +
    "the request id they refused.",
  chainId: SEPOLIA,
  totals: {
    rows: rows.length,
    asSpecified,
    payments: paid.length,
    physicalSends: totalSends,
    refusalRows: refusals.length,
    refusedBeforeAnyProviderWrite: clean.length,
  },
  rows,
};
writeFileSync("docs/refusals-live.json", `${JSON.stringify(out, null, 2)}\n`, "utf8");
console.log("Written to docs/refusals-live.json\n");
process.exit(asSpecified === rows.length ? 0 : 1);
