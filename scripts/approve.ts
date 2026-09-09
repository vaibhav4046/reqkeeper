/**
 * The human approval CLI. This is the only thing in the repository that can authorise money
 * to move, and it is deliberately not reachable from the MCP server.
 *
 * It does not accept a plan hash. It recomputes one from the invoice facts you type, and
 * compares that against the plan the agent actually reserved. If they differ, the agent
 * proposed something other than what you are being shown, and no approval is recorded. That
 * check is the reason this tool takes the invoice as arguments rather than an id: an approval
 * flow that trusts the proposer's own summary is not an approval flow.
 *
 * Usage:
 *   node --experimental-strip-types scripts/approve.ts \
 *     --requestId=0120... --reference=0x0056... --payee=0xc43d... \
 *     --amount=1000000000000000000 --max=2000000000000000000 [--reject] [--yes]
 */

import { createInterface } from "node:readline";
import { existsSync, mkdirSync } from "node:fs";
import { obligationId, sourceFactsHash } from "../src/identity.ts";
import { checkPolicy } from "../src/policy.ts";
import { buildPolicy, buildSourceFacts, buildSteps, NAMESPACE, type InvoiceFacts } from "../src/plan.ts";
import { derivePlan, restate } from "../src/settle.ts";
import { Store } from "../src/store.ts";

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([a-zA-Z]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1], m[2] ?? "true");
}

function need(flag: string): string {
  const v = args.get(flag);
  if (!v) {
    console.error(`\nmissing --${flag}\n\nsee the header of scripts/approve.ts for usage\n`);
    process.exit(2);
  }
  return v;
}

const facts: InvoiceFacts = {
  requestId: need("requestId"),
  paymentReference: need("reference"),
  payee: need("payee"),
  amountBaseUnits: need("amount"),
  maxTotalDebitBaseUnits: need("max"),
  feeAmount: args.get("fee") ?? "0",
  feeAddress: args.get("feeAddress") ?? `0x${"0".repeat(40)}`,
};

const reject = args.has("reject");
const approver = args.get("approver") ?? "owner@reqkeeper.local";

if (!existsSync(".data")) mkdirSync(".data");
const store = new Store(".data/live.sqlite");

const policy = buildPolicy(facts);
const sourceFacts = buildSourceFacts(facts);
const steps = buildSteps(facts);
const oid = obligationId(NAMESPACE, facts.requestId);

// Recompute the decision from the invoice, so the ceiling is enforced here too and not
// merely reported by whatever proposed the plan.
const decision = checkPolicy(policy, sourceFacts);
if (!decision.ok) {
  console.error(`\nrefusing to offer this for approval: ${decision.code} — ${decision.detail}\n`);
  process.exit(1);
}

const { planHash } = derivePlan({
  obligationId: oid,
  policy,
  facts: sourceFacts,
  steps,
  totalDebitBaseUnits: decision.totalDebitBaseUnits,
  sourceFactsHash: sourceFactsHash(sourceFacts),
});

const obligation = store.getObligation(oid);
if (!obligation) {
  console.error(
    `\nno such obligation locally: ${oid}\n` +
      "nothing has proposed a payment for this invoice yet, so there is nothing to approve.\n",
  );
  process.exit(1);
}

const reserved = obligation.reservedByPlan;
if (reserved && reserved !== planHash) {
  console.error(
    "\nREFUSED: the plan reserved for this obligation is not the plan these arguments describe.\n" +
      `  reserved by : ${reserved}\n` +
      `  you typed   : ${planHash}\n\n` +
      "Something proposed a different payment than the one you are approving. Investigate\n" +
      "before recording any decision.\n",
  );
  process.exit(1);
}

const sentence = restate(policy, sourceFacts, decision.totalDebitBaseUnits);

console.log("\n" + "=".repeat(78));
console.log(reject ? "REJECT this payment?" : "APPROVE this payment?");
console.log("=".repeat(78));
console.log(`\n  ${sentence}\n`);
console.log(`  request id  : ${facts.requestId}`);
console.log(`  reference   : ${facts.paymentReference}`);
console.log(`  obligation  : ${oid}`);
console.log(`  plan hash   : ${planHash}`);
console.log(`  calldata    : ${steps[0].data}`);
console.log(`\n  recomputed from the invoice you typed, not from what the agent claimed.`);
console.log("=".repeat(78) + "\n");

async function confirm(): Promise<boolean> {
  if (args.has("yes")) {
    console.log("--yes supplied, recording the decision without prompting.\n");
    return true;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const want = reject ? "reject" : "approve";
  const answer = await new Promise<string>((resolve) =>
    rl.question(`Type "${want}" to confirm, anything else to abort: `, resolve),
  );
  rl.close();
  return answer.trim().toLowerCase() === want;
}

if (!(await confirm())) {
  console.log("\naborted. nothing recorded.\n");
  store.close();
  process.exit(1);
}

store.recordApproval({
  planHash,
  obligationId: oid,
  approver,
  decision: reject ? "REJECTED" : "APPROVED",
  restatement: sentence,
});
store.audit(oid, approver, reject ? "HUMAN_REJECTED" : "HUMAN_APPROVED", { planHash });

console.log(
  reject
    ? `\nrecorded REJECTED for plan ${planHash.slice(0, 12)}…. This obligation can never be settled.\n`
    : `\nrecorded APPROVED for plan ${planHash.slice(0, 12)}….\n` +
        "An agent may now call settle_obligation. It still cannot pay twice.\n",
);
store.close();
