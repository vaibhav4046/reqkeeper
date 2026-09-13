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
import { toHuman } from "../src/money.ts";
import { fetchInvoice } from "../src/request.ts";
import { derivePlan, restate } from "../src/settle.ts";
import { Store } from "../src/store.ts";

/** Printed on any missing argument. A money gate that answers "go and read the source" is not one. */
const USAGE = [
  "usage:",
  "  npm run approve -- --requestId <id> --reference <0x…8 bytes> --payee <0x…>",
  "                     --amount <baseUnits> --max <baseUnits> --approver <you@example.com>",
  "                     [--reject] [--yes] [--db .data/live.sqlite]",
  "",
  "  The plan hash is RECOMPUTED from what you type and compared with the one reserved for this",
  "  obligation. It is never accepted as an argument: if they disagree, something proposed a",
  "  payment other than the one you are being shown, and nothing is recorded.",
].join("\n");

const args = new Map<string, string>();
{
  // `--key=value` AND `--key value`, with hyphens in the key.
  //
  // The pattern without a hyphen silently broke `--release-preflight` in `scripts/resolve.ts`:
  // the flag never matched, the command took the ordinary path and reported success. The pattern
  // without a space form broke `npm run approve` in a worse way -- every flag became the string
  // "true", `new Store("true")` created a settlement database in a file called `true`, and then
  // it crashed converting "true" to a BigInt. That is the one command in this repository that
  // can authorise money, invoked exactly as its own usage text and docs/RUNBOOK.md print it.
  //
  // One parser, in every script. `test/liveness-and-flags.test.ts` reads this pattern out of each
  // script's source and runs every documented flag through it, so a third spelling has to fail a
  // test rather than a user.
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-zA-Z][a-zA-Z0-9-]*)(?:=(.*))?$/.exec(argv[i] as string);
    if (!m) continue;
    if (m[2] !== undefined) {
      args.set(m[1] as string, m[2]);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args.set(m[1] as string, next);
      i += 1;
    } else {
      args.set(m[1] as string, "true");
    }
  }
}

function need(flag: string): string {
  const v = args.get(flag);
  if (!v) {
    console.error(`\nmissing --${flag}\n\n${USAGE}\n`);
    process.exit(2);
  }
  return v;
}

const typed: InvoiceFacts = {
  requestId: need("requestId"),
  paymentReference: need("reference"),
  payee: need("payee"),
  amountBaseUnits: need("amount"),
  maxTotalDebitBaseUnits: need("max"),
  feeAmount: args.get("fee") ?? "0",
  feeAddress: args.get("feeAddress") ?? `0x${"0".repeat(40)}`,
};

/**
 * The facts about the invoice that no operator can type, read from Request at the door.
 *
 * A plan hash covers every source fact, and three of them come from Request rather than from a
 * flag: the anchor block, an amount changed by later signed channel actions, and a payment
 * address that is not the party of record. This door recomputed the hash from the flags ALONE,
 * so the hash it produced for any invoice Request had confirmed -- which is every invoice worth
 * paying -- did not equal the one the proposal reserved, and the operator was told "no such plan
 * locally" for a plan that was sitting in the table. The human approval step could not be
 * completed at all for an anchored invoice; that is measured, not inferred (see
 * `test/approve-door.test.ts`).
 *
 * Reading Request here is not the same as trusting the proposer. The whole point of this tool is
 * that it does not believe the agent's summary; Request's gateway is the source the agent had to
 * agree with in the first place, and every flag typed below is still checked against it. A
 * gateway that will not answer refuses the approval rather than falling back to the flags: an
 * approval recorded against a hash nothing proposed authorises nothing, which is the failure this
 * block exists to end.
 */
let invoice;
try {
  invoice = await fetchInvoice(typed.requestId);
} catch (e) {
  console.error(
    `\nREFUSED: the invoice could not be read from Request (${(e as Error).message}).\n\n` +
      "This tool recomputes the plan hash from the invoice as Request holds it -- including the\n" +
      "anchor block and any signed amendments, which you cannot type. Without that read the hash\n" +
      "would not match the plan the proposal reserved and the approval would authorise nothing.\n" +
      "Run this again when the gateway answers. Nothing recorded.\n",
  );
  process.exit(1);
}

// Typed against held. A flag that disagrees with Request is the case this tool was written for.
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const disagreements: string[] = [];
if (!eq(typed.paymentReference, invoice.paymentReference)) {
  disagreements.push(`reference ${typed.paymentReference}, Request derives ${invoice.paymentReference}`);
}
if (!eq(typed.payee, invoice.payee)) {
  disagreements.push(`payee ${typed.payee}, the invoice is payable to ${invoice.payee}`);
}
if (typed.amountBaseUnits !== invoice.invoiceBaseUnits) {
  disagreements.push(`amount ${typed.amountBaseUnits}, the invoice is ${invoice.invoiceBaseUnits}`);
}
if (typed.feeAmount !== invoice.feeBaseUnits) {
  disagreements.push(`fee ${typed.feeAmount}, the invoice fee is ${invoice.feeBaseUnits}`);
}
if (!eq(typed.feeAddress, invoice.feeRecipient)) {
  disagreements.push(`fee recipient ${typed.feeAddress}, the invoice names ${invoice.feeRecipient}`);
}
if (disagreements.length > 0) {
  console.error(
    `\nREFUSED: what you typed is not the invoice Request holds: ${disagreements.join("; ")}.\n\n` +
      "Nothing recorded.\n",
  );
  process.exit(1);
}

const facts: InvoiceFacts = {
  ...typed,
  ...(invoice.anchor === undefined ? {} : { anchorBlock: invoice.anchor.blockNumber }),
  ...(invoice.amountChangedBy === undefined ? {} : { amountChangedBy: invoice.amountChangedBy }),
  ...(invoice.payeeDiffersFromRecord ? { payeeDiffersFromRecord: true } : {}),
};

/**
 * A flag's VALUE, not its presence. `--yes=false` skipped the human prompt and `--reject=false`
 * recorded a rejection, on the one command in this repository that can authorise money: the
 * parser keeps `--key=value` verbatim, and `args.has` read every spelling of "no" as "yes".
 */
const truthy = (flag: string): boolean => args.has(flag) && !/^(false|0|no|off)$/i.test(args.get(flag) ?? "true");
const reject = truthy("reject");
const approver = args.get("approver") ?? "owner@reqkeeper.local";

if (!existsSync(".data")) mkdirSync(".data");
// --db must exist here, not only in the tools that print approval commands. watch-request.ts
// prints a ready-to-run approve command and takes --db itself; without the same flag here that
// command would record an approval in a different database from the one holding the plan, and
// the approval would silently apply to nothing.
// The same workspace every other script honours. This was the one DB-touching script that
// ignored REQKEEPER_DB, so an approval could land in a database the operator was not looking at.
const dbPath = args.get("db") ?? process.env.REQKEEPER_DB ?? ".data/live.sqlite";
const store = new Store(dbPath);

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

// An obligation can exist with no saved plan: a proposal refused by policy imports the row
// and stops before the plan is written. Recording an approval against a plan hash that is
// not in the plans table used to surface as a raw SQLite foreign-key error, which reads like
// a crash rather than the refusal it is.
if (!store.getPlan(planHash)) {
  console.error(
    `\nno such plan locally: ${planHash}\n` +
      "The invoice you typed hashes to a plan nothing has proposed. Either the numbers differ\n" +
      "from what the agent proposed, or the proposal was refused before a plan was written.\n" +
      "Nothing recorded.\n",
  );
  store.close();
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

// The same identity the MCP surface puts in its sentence, so a human comparing what an agent
// showed them against what this prints is comparing the same string rather than two paraphrases.
const sentence = restate(policy, sourceFacts, decision.totalDebitBaseUnits, {
  requestId: facts.requestId,
  paymentReference: facts.paymentReference,
  ...(invoice.ignoredActions?.length ? { ignoredActions: invoice.ignoredActions.length } : {}),
});

console.log("\n" + "=".repeat(78));
console.log(reject ? "REJECT this payment?" : "APPROVE this payment?");
console.log("=".repeat(78));
console.log(`\n  ${sentence}\n`);
console.log(`  request id  : ${facts.requestId}`);
console.log(`  reference   : ${facts.paymentReference}`);
console.log(`  obligation  : ${oid}`);
console.log(`  plan hash   : ${planHash}`);
console.log(`  calldata    : ${steps[0].data}`);
// An amount that moved since the invoice was raised gets its own line, not a clause at the end
// of a paragraph. It is the one figure on this screen the approver cannot check against what the
// creditor first showed them, and a person skimming a confirmation prompt reads the shape of it
// before the words: a banner is seen, a subordinate clause is not.
// The address receiving the money is not the party the invoice names. Request allows it and this
// tool does not refuse it -- and it is the one line on this screen that distinguishes paying your
// counterparty from paying whoever last edited the payment address. Banner, for the same reason
// the amendment below gets one: a person skimming a confirmation prompt reads shapes, not clauses.
if (sourceFacts.payeeDiffersFromRecord) {
  console.log("\n" + "!".repeat(78));
  console.log("  THE PAYMENT ADDRESS IS NOT THE PARTY OF RECORD on this invoice.");
  console.log(`    paying      : ${sourceFacts.payee}`);
  console.log(`    of record   : ${invoice.payeeOfRecord}`);
  console.log("  Request permits this. Confirm with the creditor that the address is the one they");
  console.log("  meant before approving.");
  console.log("!".repeat(78));
}
if (sourceFacts.amountChangedBy) {
  const from = toHuman(BigInt(sourceFacts.amountChangedBy.fromBaseUnits), policy.token.decimals);
  const now = toHuman(BigInt(sourceFacts.invoiceBaseUnits), policy.token.decimals);
  console.log("\n" + "!".repeat(78));
  console.log(`  THE AMOUNT CHANGED after this invoice was raised.`);
  console.log(`    raised at   : ${from} ${policy.token.symbol}`);
  console.log(`    now         : ${now} ${policy.token.symbol}`);
  console.log(`    changed by  : ${sourceFacts.amountChangedBy.actions} later signed action(s) on the Request channel`);
  console.log(`  Each of those carries a signature this tool verified, by the party Request allows`);
  console.log(`  to take that action. That is not the same as you expecting it. Check with the`);
  console.log(`  creditor before approving.`);
  console.log("!".repeat(78));
}
console.log(`\n  recomputed from the invoice you typed, not from what the agent claimed.`);
console.log("=".repeat(78) + "\n");

async function confirm(): Promise<boolean> {
  if (truthy("yes")) {
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
