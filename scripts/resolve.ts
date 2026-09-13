/**
 * Drain the outbox against the real chain. The operational half of settlement.
 *
 * `settle` gets a payment sent and durably recorded. It cannot finish the job on its own:
 * a transaction that has not been mined yet, or a log this deployment has not matched to the obligation yet,
 * leaves the obligation in RECONCILIATION_PENDING or EXECUTION_OUTCOME_UNKNOWN. Those are
 * honest states, not failures — but something has to come back and look, or they are
 * permanent. This is that something.
 *
 * It has no write path to the provider at all. It reads chain receipts and the fee-proxy
 * event log, and it moves state. The worst a bug in here can do is fail to advance an
 * obligation; it cannot pay anything.
 *
 * Usage:
 *   node --experimental-strip-types scripts/resolve.ts [--passes=5] [--db=.data/live.sqlite]
 */

import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_RPC, findPaymentByReference, readReceipt, rpcCall, type PaymentExpectation } from "../src/chain.ts";
import { obligationId } from "../src/identity.ts";
import { NAMESPACE } from "../src/plan.ts";
import { Store } from "../src/store.ts";
import { drainUntilQuiet } from "../src/worker.ts";
import { excludeByNonce, operatorReleaseDecision, payerAddress, payerIsDedicated } from "../src/exclusion.ts";
import { readPayerNonce } from "../src/chain.ts";
import type { Receipt } from "../src/provider.ts";

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

/**
 * `--key=value` and `--key value`, and keys may contain hyphens.
 *
 * The old pattern was `/^--([a-zA-Z]+)(?:=(.*))?$/`: no hyphen in the class, and no support for a
 * space-separated value. `--release-preflight` is the only hyphenated flag in this CLI, so it was
 * the only one bitten — and it is the documented way out of a wedged obligation. It never parsed,
 * so the command did nothing, printed "nothing moved", and exited 0. A reviewer ran the exact line
 * `docs/RUNBOOK.md` prints and watched it report success while the obligation stayed in
 * PAYMENT_PREFLIGHT. An escape hatch that reports success without opening is worse than none: it
 * is the state this system calls a permanent wedge, wearing a green tick.
 *
 * No test had ever spawned this CLI. `test/resolve-cli.test.ts` does now, with the argv the docs
 * print, character for character.
 */
const args = new Map<string, string>();
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([A-Za-z][A-Za-z0-9-]*)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    if (m[2] !== undefined) {
      args.set(m[1], m[2]);
      continue;
    }
    // A following token that is not itself a flag is this flag's value.
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args.set(m[1], next);
      i++;
    } else {
      args.set(m[1], "true");
    }
  }
}

const dbPath = args.get("db") ?? ".data/live.sqlite";
const passes = Number(args.get("passes") ?? 5);
const rpcUrl = process.env.SEPOLIA_RPC ?? DEFAULT_RPC;

if (!existsSync(dbPath)) {
  console.error(`\nno settlement database at ${dbPath}. Nothing has been settled from here.\n`);
  process.exit(1);
}

/**
 * A receipt read straight from a public node. No credentials, no provider.
 *
 * `verified` is only true when the node returned a receipt with a status we understand;
 * anything else stays unverified, which keeps the obligation short of SETTLED rather than
 * letting a transport hiccup look like confirmation.
 *
 * This was a private copy that returned `{hash, verified, receiptStatus, gasUsed}` and nothing
 * else -- no `blockNumber`, no `confirmations`, no `to`, no `logs`. The worker's depth gate reads
 * `confirmations`, so in `npm run resolve` it could never fire: the resolver would move an
 * obligation to SETTLED, which is terminal, on a receipt one block deep. `sourceSaysPaid` below
 * reads `eth_getLogs`, which sees a log at one confirmation too, so nothing else imposed depth
 * either.
 *
 * `src/chain.ts` says of its reader: "One reader, shared with the MCP transport and with every
 * script. There were four private copies of this and each one had to learn separately..." This
 * was the copy that consolidation missed, and it was the last one left in a path that can settle.
 */
const receipt = (hash: string): Promise<Receipt> => readReceipt(rpcUrl, hash);

const store = new Store(dbPath);

/**
 * Request's own view, read from the fee proxy's event log rather than an API.
 *
 * It must confirm THIS transaction. A boolean over the reference alone would accept some
 * other transaction's evidence, which is how a duplicate obligation once reported itself
 * settled using the first payment's log entry.
 */
async function sourceSaysPaid(requestId: string, txHash: string): Promise<boolean> {
  const obligation = store.obligationForRecovery(obligationId(NAMESPACE, requestId));
  const reference = obligation?.paymentReference;
  if (!reference) return false;
  const sighting = await findPaymentByReference(reference, {
    lookbackBlocks: 300_000,
    rpcUrl,
    // Token, payee and fee as well as the reference, from the facts stored at import.
    expect: obligation.expectation ?? undefined,
  });
  return (
    sighting.found === true &&
    sighting.txHash?.toLowerCase() === txHash.toLowerCase() &&
    (obligation.invoiceBaseUnits === null || sighting.amount === obligation.invoiceBaseUnits)
  );
}

/** Recovery for an attempt that was sent but never recorded. Read-only, like everything here. */
async function findPaidReference(reference: string, expect?: PaymentExpectation) {
  const seen = await findPaymentByReference(reference, { lookbackBlocks: 300_000, rpcUrl, expect });
  return seen.found && seen.txHash ? { txHash: seen.txHash, amount: seen.amount } : null;
}

/**
 * The same read, with its uncertainty intact.
 *
 * `findPaidReference` collapses "the chain says no" and "I could not tell" into null, which is
 * safe for recovering a hash and not safe for deciding whether a dead simulation executed.
 */
// The anchor is what lets a silence mean "not paid" rather than "not seen": a payment for an
// invoice cannot predate the invoice. Without it the scan floor is arbitrary, every negative is
// truncated, and this resolver can never release an obligation it was run to release.
const sightPayment = (reference: string, expect?: PaymentExpectation, anchorBlock?: number) =>
  findPaymentByReference(reference, { lookbackBlocks: 300_000, rpcUrl, expect, anchorBlock });

// Excluding a leaked dry run needs the payer's nonce, and the resolver is the one command whose
// whole job is to get stuck obligations moving again. Without this wired in it could never
// release one: `excludeByNonce` would answer NO_PAYER_CONFIGURED for ever, and the safest
// possible answer would have become a permanent wedge at zero payments -- which is the failure
// this project has fixed four times in other disguises. See docs/RUNBOOK.md for how to discover
// the address, and `--release-preflight` below for the way out when it is not configured.
const payer = payerAddress();
if (!payer) {
  console.log("  note: REQKEEPER_PAYER_ADDRESS is not set, so a dry run that never came back cannot be");
  console.log("        proven dead and its obligation will wait. See docs/RUNBOOK.md, or release one");
  console.log("        by hand with --release-preflight <obligationId> --operator <who>.");
}

// ---- clearing a conflicting transaction a human has actually read ------------
//
//   npm run resolve -- --review-conflict=<obligationId> --tx=<hash,...> --operator=<who>
//
// A log carrying this invoice's public payment reference, paying its payee in its token for one
// wei, reads as our own money moving in a plan nobody made -- and `propose_payment` refuses on it.
// Correctly, the first time. References are public, so a stranger can emit that log for the price
// of one transfer, and with no way to clear it the debt could never be proposed again: a permanent
// wedge, bought for one wei, at the gate every payment starts from.
//
// So a person reads the transaction and names it back, one hash at a time. It goes in the audit
// trail beside their name, and the trail is hash-chained, so it cannot be added retroactively. A
// blanket flag is deliberately not offered: it would wave away the leaked dry run that this
// refusal also exists to catch.
if (args.has("review-conflict")) {
  const target = args.get("review-conflict");
  const hashes = (args.get("tx") ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
  const operator = args.get("operator") ?? "";
  if (!target || target === "true" || hashes.length === 0 || !operator || operator === "true") {
    console.error("\n  usage: npm run resolve -- --review-conflict=<obligationId> --tx=<hash,...> --operator=<who>\n");
    store.close();
    process.exit(2);
  }
  const malformed = hashes.filter((h) => !/^0x[0-9a-f]{64}$/.test(h));
  if (malformed.length > 0) {
    console.error(`\n  REFUSED: not transaction hashes: ${malformed.join(", ")}`);
    console.error("  A review is only as good as the transaction it names, so a hash this tool cannot");
    console.error("  recognise is refused rather than recorded.\n");
    store.close();
    process.exit(2);
  }
  // A request id works as well as an obligation id, because the operator is most likely reading
  // this hash off a refusal for an invoice that has never been imported -- `propose_payment`
  // refuses this one BEFORE any write, by design, so there is usually no row to look up.
  const oid = /^[0-9a-f]{64}$/.test(target) ? target : obligationId(NAMESPACE, target);
  const known = store.getObligation(oid);
  store.recordConflictReview(oid, hashes, operator);
  if (!known) {
    console.log("\n  note: no obligation is imported under this id yet. That is the normal case here:");
    console.log("        a proposal refused before any write leaves no row, which is the point of");
    console.log("        refusing before the write. The review is recorded and will be found when a");
    console.log("        proposal for this obligation is next made.");
  }
  console.log(`\n  recorded ${hashes.length} reviewed transaction(s) for ${oid.slice(0, 14)}…, by ${operator}:`);
  for (const h of hashes) console.log(`    ${h}`);
  console.log("\n  A proposal for this obligation will no longer refuse on those logs. Any OTHER");
  console.log("  conflicting log, including one that appears later, still refuses.\n");
  store.close();
  process.exit(0);
}

// ---- reconciling an EVIDENCE_CONFLICT against the chain ------------------------
//
//   npm run resolve -- --reconcile=<obligationId> --tx=<hash> --operator=<who>
//
// EVIDENCE_CONFLICT is entered from six places and, until this existed, exited from none: the
// machine declared RECONCILING / SETTLED / EXECUTION_REVERTED legal and nothing shipped could take
// any of them, while `nextStep` said "a human has to reconcile it" and named no command. The only
// exit was a SQLite client. This is the command. It moves NOTHING on a human's word: the named
// transaction is re-read from public endpoints, and the obligation goes where the chain says --
// SETTLED only on a corroborated fee-proxy event paying this invoice in that very transaction,
// EXECUTION_REVERTED on a reverted receipt, and nowhere at all on anything less.
if (args.has("reconcile")) {
  const target = args.get("reconcile") ?? "";
  const tx = (args.get("tx") ?? "").trim().toLowerCase();
  const operator = args.get("operator") ?? "";
  if (!/^[0-9a-f]{64}$/.test(target) || !/^0x[0-9a-f]{64}$/.test(tx) || !operator || operator === "true") {
    console.error("\n  usage: npm run resolve -- --reconcile=<obligationId> --tx=<0x…64 hex> --operator=<who>\n");
    store.close();
    process.exit(2);
  }
  const row = store.obligationForRecovery(target);
  if (!row) {
    console.error(`\n  no such obligation locally: ${target}\n`);
    store.close();
    process.exit(1);
  }
  if (row.state !== "EVIDENCE_CONFLICT") {
    console.error(`\n  ${target.slice(0, 14)}… is ${row.state}, not EVIDENCE_CONFLICT — nothing to reconcile here.\n`);
    store.close();
    process.exit(2);
  }
  if (!row.paymentReference || !row.expectation) {
    console.error("\n  REFUSED: this obligation's stored facts cannot state what paying it looks like, so no log can be matched.\n");
    store.close();
    process.exit(1);
  }
  const receiptRead = await readReceipt(rpcUrl, tx);
  if (receiptRead.receiptStatus === "reverted") {
    store.setState(target, "EXECUTION_REVERTED", Date.now());
    store.audit(target, operator, "RECONCILED_BY_OPERATOR", { txHash: tx, outcome: "EXECUTION_REVERTED" });
    console.log(`\n  ${tx} reverted on chain. ${target.slice(0, 14)}… is EXECUTION_REVERTED; nothing was paid by it.\n`);
    store.close();
    process.exit(0);
  }
  if (receiptRead.receiptStatus !== "success") {
    console.error(`\n  REFUSED: the receipt for ${tx} reads ${receiptRead.receiptStatus}; nothing is concluded from a receipt that could not be read.\n`);
    store.close();
    process.exit(1);
  }
  const seen = await sightPayment(row.paymentReference, row.expectation, row.anchorBlock ?? undefined);
  const { verdictFor } = await import("../src/chain.ts");
  const verdict = verdictFor(seen, { requireCorroboration: true });
  if (verdict.kind !== "PAID" || verdict.txHash.toLowerCase() !== tx) {
    console.error(`\n  REFUSED: the chain does not show ${tx} paying this invoice (verdict ${verdict.kind}${"reason" in verdict ? `/${verdict.reason}` : ""}).`);
    console.error("  Nothing moves on a transaction the chain will not corroborate.\n");
    store.close();
    process.exit(1);
  }
  const attempt = store.sentAttemptFor(target);
  if (attempt && !attempt.txHash) store.recordOutcome(attempt.id, { outcome: "SENT", txHash: tx });
  store.setState(target, "RECONCILING", Date.now());
  store.setState(target, "SETTLED", Date.now());
  store.audit(target, operator, "RECONCILED_BY_OPERATOR", { txHash: tx, outcome: "SETTLED", scannedFrom: seen.scannedFrom ?? null, scannedTo: seen.scannedTo ?? null });
  console.log(`\n  ${tx} pays this invoice, corroborated. ${target.slice(0, 14)}… is SETTLED, on ${operator}'s reconciliation.\n`);
  store.close();
  process.exit(0);
}

// ---- what is actually open ---------------------------------------------------
//
//   npm run resolve -- --status
//   npm run resolve -- --status <obligationId or requestId>
//
// There was no way to ask this, and the RUNBOOK names states it never showed an operator how to
// observe. Without it the first step of every recovery was "open .data/live.sqlite with a SQLite
// client", which is not a recovery procedure. Read-only: it moves nothing and sends nothing.
if (args.has("status")) {
  const wanted = args.get("status");
  const rows = store.listObligations(200);
  const matching =
    wanted && wanted !== "true"
      ? rows.filter((r) => r.obligationId.startsWith(wanted) || r.requestId.startsWith(wanted))
      : rows;

  if (matching.length === 0) {
    console.log(rows.length === 0 ? "\n  no obligations in this database yet.\n" : `\n  nothing matches ${wanted}.\n`);
    store.close();
    process.exit(0);
  }

  console.log("");
  for (const r of matching) {
    console.log(`  ${r.obligationId}`);
    console.log(`    request      : ${r.requestId}`);
    console.log(`    state        : ${r.state}`);
    console.log(`    reference    : ${r.paymentReference ?? "-"}`);
    console.log(`    sent attempts: ${r.sentAttempts}${r.txHash ? ` (${r.txHash})` : ""}`);
    console.log(`    work owed    : ${r.jobsDue} job(s)`);
    console.log(`    what to do   : ${nextStep(r.state, r.jobsDue)}`);
    console.log("");
  }
  store.close();
  process.exit(0);
}

/** The one sentence an operator in this state needs. Every state the machine has, or a fallback. */
function nextStep(state: string, jobsDue: number): string {
  switch (state) {
    case "AWAITING_APPROVAL":
      return "a human has to approve or reject this plan: npm run approve -- --requestId … (see docs/RUNBOOK.md)";
    case "APPROVED":
    case "OBLIGATION_RESERVED":
      return "approved and not yet dispatched. npm run resolve drains it.";
    case "PAYMENT_PREFLIGHT":
      return "the dry run never came back. npm run resolve first; if it stays here, --release-preflight (docs/RUNBOOK.md).";
    case "PAYMENT_EXECUTING":
    case "CHAIN_PENDING":
    case "RECONCILING":
    case "RECONCILIATION_PENDING":
      return "money has moved and the outcome is not confirmed. npm run resolve, and never re-propose.";
    case "EXECUTION_OUTCOME_UNKNOWN":
      return "a send happened with no answer. npm run resolve reads the chain for it. Do not retry the send.";
    case "EVIDENCE_CONFLICT":
      return (
        "an integrity incident: the chain and this system disagree. A human reconciles it against the " +
        "transaction: npm run resolve -- --reconcile=<obligationId> --tx=<hash> --operator=<who> (or, if " +
        "nothing was ever sent, --release-preflight after --review-conflict)"
      );
    case "SETTLED":
      return "paid and closed. Nothing to do.";
    case "SOURCE_ALREADY_PAID":
      return "the invoice was already paid elsewhere. Nothing is owed.";
    case "PREFLIGHT_UNAVAILABLE":
    case "PLAN_EXPIRED":
    case "PLAN_CHANGED":
      return "replannable: propose it again when you want it paid.";
    case "POLICY_DENIED":
    case "REVIEW_REJECTED":
    case "CALLDATA_MISMATCH":
    case "SIMULATION_BLOCKED":
    case "EXECUTION_REVERTED":
    case "CANCELLED_BEFORE_PAYMENT":
      return "refused, and terminal. Nothing was sent; fix what it refused on and propose again.";
    default:
      return jobsDue > 0 ? "npm run resolve has work queued for it." : "no work queued; see docs/RUNBOOK.md.";
  }
}

// ---- the operator's way out --------------------------------------------------
//
// An obligation whose dry run never came back waits until a spent nonce proves the leak can
// never be mined. That is the right default -- the alternative was a timer, and a timer released
// obligations whose payment was still sitting in the mempool -- but "waits" must not mean
// "waits for ever". When no payer address is configured, or the relayer has rotated, or the
// operator simply knows more than the process does, this is the door.
//
// It is deliberately not a flag on the normal run. It names a single obligation, it demands a
// human's name for the audit trail, and it reads the chain BEFORE it agrees to anything: an
// operator who releases an obligation whose payment is sitting on chain has authorised paying
// it twice, and no amount of certainty on their part changes that.
const releaseTarget = args.get("release-preflight");
if (releaseTarget) {
  const operator = args.get("operator");
  if (!operator) {
    console.error("  --release-preflight needs --operator <who>: this goes in the audit trail as a human decision");
    process.exit(2);
  }
  const row = store.obligationForRecovery(releaseTarget);
  if (!row) {
    console.error(`  no obligation ${releaseTarget}`);
    process.exit(2);
  }
  if (!row.paymentReference) {
    console.error("  this obligation has no payment reference, so the chain cannot be asked about it");
    process.exit(2);
  }

  // A chain that will not answer is "I could not tell", not a crash. This threw an unhandled
  // rejection and killed the process before it printed anything about the obligation, so an
  // operator running the documented line on a bad connection got a stack trace and no decision.
  let seen;
  try {
    seen = await sightPayment(row.paymentReference, row.expectation ?? undefined, row.anchorBlock ?? undefined);
  } catch (e) {
    console.error(`  REFUSED for ${releaseTarget.slice(0, 14)}…: the chain could not be read (${String(e).slice(0, 120)}).`);
    console.error("  An unreadable chain cannot say this invoice is unpaid. Set REQKEEPER_RPC_ENDPOINTS");
    console.error("  to endpoints that answer, and run this again.");
    process.exit(1);
  }
  // The same leak-exclusion proof the worker demands, made here rather than skipped.
  //
  // This door used to apply only the chain read, and a chain read cannot see the mempool. On a
  // deployment whose payer is KeeperHub's shared relayer the automatic path can NEVER release --
  // the nonce proof is unavailable by construction -- so this door is the only exit, and the
  // stricter half of the test was in practice applied to nothing.
  let reading;
  if (payer) {
    try {
      reading = await readPayerNonce(payer, rpcUrl);
    } catch {
      // Unreadable is not excluded. Left undefined, which `excludeByNonce` reports as a gap.
      reading = undefined;
    }
  }
  const exclusion = excludeByNonce({
    reading,
    preflightNonce: row.preflightNonce,
    scannedTo: seen.scannedTo,
    payerConfigured: payer !== undefined,
    payerIsDedicated: payerIsDedicated(),
  });
  const decision = operatorReleaseDecision({
    state: row.state,
    // The door opens for an EVIDENCE_CONFLICT only when nothing was ever sent: see exclusion.ts.
    hasSentAttempt: store.sentAttemptFor(releaseTarget) !== undefined,
    exclusion,
    sighting: seen,
    // Typed by a human, on the command line, naming the risk. See the refusal below.
    acknowledgedMempoolRisk: args.has("accept-mempool-risk"),
    // And the transactions they have actually looked at, by hash. Comma-separated, never a
    // blanket flag: a release is only as good as the logs it accounted for.
    acknowledgedConflicts: (args.get("reviewed-tx") ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0),
  });
  switch (decision.kind) {
    case "REFUSE_STATE":
      console.error(`  ${releaseTarget.slice(0, 14)}… is ${decision.state}, not PAYMENT_PREFLIGHT — nothing to release`);
      if (decision.state === "EVIDENCE_CONFLICT") {
        console.error("  A send happened under this obligation. Reconcile it against the transaction instead:");
        console.error(`    npm run resolve -- --reconcile=${releaseTarget} --tx=<hash> --operator=<who>`);
      }
      process.exit(2);
      break;
    case "REFUSE_PAID":
      store.setState(releaseTarget, "EVIDENCE_CONFLICT", Date.now());
      store.audit(releaseTarget, operator, "SIMULATE_LEAKED_EXECUTION", { txHash: decision.txHash ?? null, via: "operator release attempt" });
      console.error(`  REFUSED: this invoice IS paid, in ${decision.txHash}`);
      console.error("  Releasing it would authorise a second payment. Moved to EVIDENCE_CONFLICT instead.");
      process.exit(1);
      break;
    case "REFUSE_CONFLICT":
      console.error("  REFUSED: a log carrying this reference pays this invoice's token and payee but");
      console.error("  disagrees about the amount or the fee. That is this deployment's money moving in a");
      console.error("  plan nobody made, not an unpaid invoice. Investigate it before releasing anything.");
      console.error("");
      if (decision.transactions.length > 0) {
        console.error("  The transaction(s) to look at:");
        for (const tx of decision.transactions) console.error(`    ${tx}`);
        console.error("");
        console.error("  If you have read them and they do NOT settle this invoice — a stranger can emit a");
        console.error("  log against a public reference for the price of one transfer — name them back:");
        console.error("");
        console.error(`    npm run resolve -- --release-preflight <id> --operator <who> \\`);
        console.error(`                       --reviewed-tx ${decision.transactions.join(",")}`);
        console.error("");
        console.error("  Each hash goes in the audit trail beside your name. A blanket flag is deliberately");
        console.error("  not offered: it would wave away the leaked dry run this refusal exists to catch.");
      } else {
        console.error("  The scan named no transaction for the conflicting log, so there is nothing to");
        console.error("  review by hash and nothing to acknowledge. Re-run against an endpoint that");
        console.error("  returns transaction hashes with its logs.");
      }
      process.exit(1);
      break;
    case "REFUSE_UNCORROBORATED":
      console.error("  REFUSED: only one endpoint returned this negative, and one endpoint's silence is not");
      console.error("  evidence that nothing was paid — publicnode has been observed returning an empty log");
      console.error("  query for a payment that demonstrably exists. Set REQKEEPER_RPC_ENDPOINTS to a");
      console.error("  comma-separated list of endpoints that answer, and run this again.");
      process.exit(1);
      break;
    case "REFUSE_INCONCLUSIVE":
      console.error("  REFUSED: the scan could not reach this invoice's anchor, so it cannot say the invoice is unpaid.");
      console.error("  Set REQKEEPER_RPC_ENDPOINTS to endpoints that answer, and run this again.");
      process.exit(1);
      break;
    case "REFUSE_LEAK_NOT_EXCLUDED":
      console.error(`  REFUSED: the chain says nothing was paid, and the chain cannot see the mempool.`);
      console.error("");
      console.error("  A dry run that executed and lost its reply leaves a transaction that may still be");
      console.error("  sitting unmined. `eth_getLogs` reads blocks, so it is invisible to every scan, and a");
      console.error("  transaction can sit pending with no bound at all. Releasing now authorises a second");
      console.error("  payment that lands when the first one mines.");
      console.error("");
      console.error(`  The proof that would settle it could not be made: ${decision.code}.`);
      console.error("");
      console.error("  Either make that proof -- point REQKEEPER_PAYER_ADDRESS at an account nothing else");
      console.error("  broadcasts from and set REQKEEPER_PAYER_IS_DEDICATED=true -- or, if you accept that");
      console.error("  this obligation may be paid twice, re-run with --accept-mempool-risk. Your name goes");
      console.error("  in the audit trail next to that decision.");
      process.exit(1);
      break;
    case "RELEASE":
      break;
    default: {
      const exhaustive: never = decision;
      throw new Error(`unhandled decision ${JSON.stringify(exhaustive)}`);
    }
  }

  store.setState(releaseTarget, "PREFLIGHT_UNAVAILABLE", Date.now());
  const heldBy = store.getObligation(releaseTarget)?.reservedByPlan;
  if (heldBy) store.releaseObligation(releaseTarget, heldBy);
  store.audit(releaseTarget, operator, "PREFLIGHT_RELEASED_BY_OPERATOR", {
    reason: "no payment for this reference on chain, across a scan that reached the invoice's anchor",
    scannedFrom: seen.scannedFrom ?? null,
    scannedTo: seen.scannedTo ?? null,
    // What the machine could prove, and what a human took on instead. An audit trail that
    // records only the release cannot tell the two apart later, and they are not the same event.
    leakExclusion: exclusion.kind,
    reviewedTransactions: (args.get("reviewed-tx") ?? "").split(",").map((h) => h.trim()).filter(Boolean),
    leakExclusionGap: exclusion.kind === "NOT_PROVEN" ? exclusion.code : null,
    mempoolRiskAcceptedBy: exclusion.kind === "NOT_PROVEN" ? operator : null,
  });
  if (exclusion.kind === "NOT_PROVEN") {
    console.log(`  NOTE: the leak could not be excluded (${exclusion.code}); ${operator} accepted that risk.`);
  }
  console.log(`  released ${releaseTarget.slice(0, 14)}… on ${operator}'s authority; the debt is payable again.`);
  console.log("  The release is in the audit trail under PREFLIGHT_RELEASED_BY_OPERATOR.");
  store.close();
  process.exit(0);
}

const results = await drainUntilQuiet(
  {
    store,
    provider: { receipt },
    sourceSaysPaid,
    findPaidReference,
    sightPayment,
    ...(payer ? { payer, readPayerNonce: (p: string) => readPayerNonce(p, rpcUrl) } : {}),
  },
  // Run by hand, this is an operator asking, not a timer polling: look past the retry
  // backoff rather than reporting "nothing moved" for work that is scheduled a moment out.
  { now: Date.now(), maxPasses: passes, stepMs: 0, lookaheadMs: 60_000 },
);

const claimed = results.reduce((n, r) => n + r.claimed, 0);
const completed = results.reduce((n, r) => n + r.completed, 0);
const deferred = results.reduce((n, r) => n + r.deferred, 0);
const advanced = results.flatMap((r) => r.advanced);

console.log(`\nresolve: ${claimed} jobs claimed, ${completed} completed, ${deferred} deferred\n`);
for (const a of advanced) {
  console.log(`  ${a.obligationId.slice(0, 14)}…  ${a.from} -> ${a.to}`);
}
if (advanced.length === 0) console.log("  nothing moved.");
console.log(`\n${store.pendingJobCount()} jobs still owed work.\n`);

store.close();
