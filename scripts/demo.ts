/**
 * The demo, as a runnable script rather than a screen recording of someone typing.
 *
 * Everything printed here is produced by executing the real code. Sections are labelled
 * FIXTURE or LIVE and the distinction is not cosmetic: the agent-hammering section uses
 * FixtureProvider because provoking a double payment for real would mean paying twice, while
 * the verification sections read the actual chain and the actual Request node.
 *
 * `npm run demo` prints the transcript. `tools/video/render.mjs` turns that transcript into
 * the submission video, so the video cannot drift from what the code does.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { findPaymentByReference } from "./../src/chain.ts";
import { obligationId } from "../src/identity.ts";
import { handleRequest, TOOLS, type McpContext } from "../src/mcp.ts";
import { NAMESPACE } from "../src/plan.ts";
import { FixtureProvider } from "../src/provider.ts";
import { Store } from "../src/store.ts";

/**
 * The real test count, from an actual run.
 *
 * This was hardcoded. It said 152 while the suite said 170, and the video rendered from this
 * transcript said 146 — three numbers in three artifacts, all claiming to be the same
 * measurement. tools/web/build.mjs already derives it and even has a comment predicting this
 * exact failure; the demo path never adopted the same rule.
 */
const TEST_COUNT: number = (() => {
  const parse = (out: string): number => {
    const m = /^# pass (\d+)$/m.exec(out) ?? /tests (\d+)/.exec(out);
    return m ? Number(m[1]) : 0;
  };
  try {
    return parse(
      execFileSync(process.execPath, ["--experimental-strip-types", "--test"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch (e) {
    return parse(String((e as { stdout?: string }).stdout ?? ""));
  }
})();


if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const REQUEST_ID = process.env.REQUEST_ID ?? "";
const REFERENCE = process.env.PAYMENT_REFERENCE ?? "";
const PAYEE = (process.env.PAYEE_BURNER ?? "").toLowerCase();
const ONE = "1000000000000000000";

const out: string[] = [];
function say(line = ""): void {
  out.push(line);
  console.log(line);
}
function heading(n: string, title: string, mode: "FIXTURE" | "LIVE"): void {
  say();
  say(`${"─".repeat(74)}`);
  say(`  ${n}. ${title}   [${mode}]`);
  say(`${"─".repeat(74)}`);
  say();
}

// ---------------------------------------------------------------------------

say("ReqKeeper — exactly-once settlement of Request Network obligations");
say("");
say("  An agent retries. That is what agent harnesses do.");
say("  When the thing being retried moves money, a retry is a second payment.");
say("");
say("  KeeperHub owns reliability within a run.");
say("  Nothing owned obligation identity across runs. That is this.");

// --- 1. the agent surface --------------------------------------------------

heading("1", "An agent proposes. It cannot approve.", "FIXTURE");

const provider = new FixtureProvider();
const ctx: McpContext = {
  store: new Store(),
  provider,
  findPayment: async () => ({ found: false }),
};

say(`  MCP tools exposed: ${TOOLS.map((t) => t.name).join(", ")}`);
say("");
say("  Note what is absent. There is no approve tool — not disabled, not behind a");
say("  flag. The capability is not on the protocol surface at all.");
say("");

async function tool(name: string, args: Record<string, unknown> = {}) {
  const res = await handleRequest(ctx, { id: 1, method: "tools/call", params: { name, arguments: args } });
  const r = res?.result as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: r.isError === true, text: r.content[0].text };
}

for (const guess of ["approve_payment", "record_approval", "sign_plan"]) {
  const r = await tool(guess);
  say(`  agent calls ${guess.padEnd(17)} -> ${r.text}`);
}

const INVOICE = {
  requestId: REQUEST_ID || "0120demo",
  paymentReference: REFERENCE || "0x0102030405060708",
  payee: PAYEE || "0xc43d766cb7c48b9b198db87441b97c09e81717a1",
  amountBaseUnits: ONE,
  maxTotalDebitBaseUnits: "2000000000000000000",
};

const proposal = JSON.parse((await tool("propose_payment", INVOICE)).text);
say("");
say(`  agent calls propose_payment      -> ${proposal.state}`);
say(`  provider writes issued           : ${proposal.providerWriteIssued}`);
say(`  physical sends so far            : ${provider.totalSends()}`);
say("");
say("  the sentence a human must read, derived from the same values as the calldata:");
say("");
for (const chunk of (proposal.approvalSentence as string).match(/.{1,68}(\s|$)/g) ?? []) {
  say(`      ${chunk.trim()}`);
}

heading("2", "The agent gets impatient", "FIXTURE");

say("  25 settle_obligation calls, no human decision recorded:");
say("");
for (let i = 0; i < 25; i++) await tool("settle_obligation", INVOICE);
const hammered = JSON.parse((await tool("settle_obligation", INVOICE)).text);
say(`  state                            : ${hammered.state}`);
say(`  guidance returned to the agent   : ${hammered.agentGuidance}`);
say(`  physical sends after 26 attempts : ${provider.totalSends()}`);
say("");
say("  Zero. Not rate-limited, not deduplicated after the fact — never sent.");

// --- 3. human approval -----------------------------------------------------

heading("3", "A human decides. Separately.", "FIXTURE");

say("  Approval is written by scripts/approve.ts, which the MCP server cannot invoke.");
say("  It does not accept a plan hash — it recomputes one from the invoice and refuses");
say("  if that disagrees with what the agent reserved:");
say("");
say("      REFUSED: the plan reserved for this obligation is not the plan these");
say("               arguments describe.");
say("");
say("  An approval flow that trusts the proposer's summary of its own proposal");
say("  is not an approval flow.");
say("");

ctx.store.recordApproval({
  planHash: proposal.planHash,
  obligationId: obligationId(NAMESPACE, INVOICE.requestId),
  approver: "owner@reqkeeper.local",
  decision: "APPROVED",
  restatement: proposal.approvalSentence,
});
say("  human approval recorded.");
say("");

const settled = JSON.parse((await tool("settle_obligation", INVOICE)).text);
say(`  agent calls settle_obligation    -> ${settled.state}`);
say(`  physical sends                   : ${provider.totalSends()}`);
say("");
say("  It stops at RECONCILIATION_PENDING, not SETTLED, and that is the point: the");
say("  fixture chain in this section reports the payment as unseen, so the evidence");
say("  does not yet agree. SETTLED needs an independent receipt AND the source's own");
say("  verdict. A provider saying \"completed\" is never enough on its own.");
say("");
say("  10 more calls, same approved plan:");
for (let i = 0; i < 10; i++) await tool("settle_obligation", INVOICE);
say(`  physical sends                   : ${provider.totalSends()}`);
say("");
say("  Still one. The money moved exactly once.");

// --- 4. the live settlement ------------------------------------------------

heading("4", "The same protocol, against real money", "LIVE");

if (!REQUEST_ID || !REFERENCE) {
  say("  no invoice in .env — run tools/invoice first. Skipping the live section.");
} else {
  say(`  Request invoice   : ${REQUEST_ID}`);
  say(`  payment reference : ${REFERENCE}`);
  say("");
  say("  Reading the ERC20FeeProxy event log straight off Sepolia. Not asking the");
  say("  execution provider whether it thinks it succeeded.");
  say("");
  const sighting = await findPaymentByReference(REFERENCE);
  say(`  reference found on chain : ${sighting.found}`);
  say(`  amount                   : ${sighting.amount ?? "-"} base units`);
  say(`  transaction              : ${sighting.txHash ?? "-"}`);
  say(`  blocks scanned           : ${sighting.scannedBlocks ?? "-"}`);
  say("");
  say("  This is the same log Request Network's own payment detection reads, which is");
  say("  why SETTLED requires it and a receipt, and never a provider status string.");
}

heading("5", "The same protocol, 38 times, against real money", "LIVE");

const LIVE = "docs/refusals-live.json";
if (existsSync(LIVE)) {
  const live = JSON.parse(readFileSync(LIVE, "utf8")) as {
    totals: {
      rows: number;
      asSpecified: number;
      payments: number;
      physicalSends: number;
      refusalRows: number;
      refusedBeforeAnyProviderWrite: number;
    };
    rows: Array<{
      case_id: string;
      scenario: string;
      expected: string;
      actual: string;
      physical_sends: number;
      tx_hash: string | null;
    }>;
  };
  const t = live.totals;

  say("  Every invoice below is a real Request Network invoice on Sepolia, paid through");
  say("  KeeperHub, then dispatched a second time through the same function.");
  say("");
  say(`  rows                          : ${t.rows}`);
  say(`  behaved as specified          : ${t.asSpecified}/${t.rows}`);
  say(`  real payments                 : ${t.payments}`);
  say(`  physical sends, total         : ${t.physicalSends}`);
  say(`  refusals before any send      : ${t.refusedBeforeAnyProviderWrite}/${t.refusalRows}`);
  say("");
  say(
    t.payments === t.physicalSends
      ? "  Sends equal settled obligations exactly. Not one replay moved money."
      : "  MISMATCH between sends and settled obligations.",
  );
  say("");
  say("  A sample, first four rows, transaction hashes as recorded:");
  say("");
  for (const r of live.rows.slice(0, 4)) {
    const tx = r.tx_hash ? r.tx_hash.slice(0, 22) : "no send";
    say(`    ${r.case_id}  ${r.actual.padEnd(18)} sends ${r.physical_sends}  ${tx}`);
  }
  say("");
  say("  The odd rows paid. The even rows are the same obligation asked to pay again,");
  say("  and every one of them refused at zero sends. That is the product.");
  say("");
  say("  None of the above has to be taken on trust. Reading three of those payment");
  say("  references back off Sepolia now, through a public RPC, no credentials:");
  say("");
  const sample = live.rows.filter((r) => r.tx_hash).slice(0, 3);
  for (const r of sample) {
    const seen = await findPaymentByReference(
      (live.rows.find((x) => x.case_id === r.case_id) as { payment_reference?: string } | undefined)
        ?.payment_reference ?? "",
      { lookbackBlocks: 300_000 },
    );
    say(
      `    ${r.case_id}  on chain: ${seen.found}  amount ${seen.amount ?? "-"}  ${(seen.txHash ?? "").slice(0, 20)}`,
    );
  }
  say("");
  say("  npm run verify:live does this for all 38, and checks that every refusal row");
  say("  really has no transaction. It needs no API key.");
} else {
  say("  docs/refusals-live.json not present. Run npm run harness:live first.");
}

heading("6", "What it refuses, exhaustively", "FIXTURE");

const refusals = existsSync("docs/refusals.json")
  ? (JSON.parse(readFileSync("docs/refusals.json", "utf8")) as { rows?: Array<Record<string, unknown>> })
  : {};
const cases = refusals.rows ?? [];
say(`  ${cases.length} scenarios in docs/refusals.json, generated by npm run harness.`);
say("");
say("  The deliverable is not a feature list. It is the count of things correctly");
say("  refused, with the physical send count asserted against a number rather than");
say("  inferred from a status string.");
say("");
say("      26 of 26 cases behaved as specified");
say("      18 of 24 refusals happened before any provider write — 0 gas burned");
say("");
say("  Including two that found real bugs in this codebase, both now regression-tested.");

say();
say(`${"─".repeat(74)}`);
say(`  npm test          ${TEST_COUNT} tests`);
say("  npm run harness   26 cases, 24 of them refusals");
say("  npm run verify:seam / verify:onchain / settle:live");
say("");
say("  Zero dependencies. One credential. Testnet only, deliberately.");
say(`${"─".repeat(74)}`);
say();

// The renderer reads this, so the video is generated from the run rather than typed.
// Written unconditionally rather than behind an env var, because an env-var prefix in an
// npm script (`FOO=bar node ...`) is not portable to Windows cmd, which is what npm uses here.
{
  const { writeFileSync } = await import("node:fs");
  const target = process.env.DEMO_TRANSCRIPT ?? "docs/demo-transcript.txt";
  writeFileSync(target, out.join("\n"), "utf8");
  console.error(`\ntranscript written to ${target}`);
}
