/**
 * One command, no credentials, every public claim.
 *
 *   npm run verify:all
 *
 * This is the command in the README's first screen and the one a judge is invited to run. It
 * therefore has two hard properties:
 *
 *   1. It needs nothing. No API key, no wallet, no .env. Anything that requires a credential is
 *      reported BLOCKED with the reason, never silently skipped and never counted as a pass.
 *   2. It cannot move money. It reads local evidence files and public Sepolia RPCs. There is no
 *      provider import in this file at all.
 *
 * The design rule that matters: **totals are recomputed from rows, never read from the totals
 * field.** An artifact that states `duplicates: 0` in a summary block proves nothing — that is
 * the number a bug would get wrong. Every check below re-derives the claim from the underlying
 * rows and compares, so a hand-edited summary fails here rather than passing quietly.
 *
 * Writes `docs/evidence/verify.json` and `docs/TRUTH.md`, then exits non-zero if any check
 * failed. A verification that cannot fail is decoration.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  EVENT_TOPIC,
  assertChainId,
  currentBlock,
  decodePaymentLogFields,
  matchPaymentLog,
  readReceipt,
  referenceTopic,
  rpcCall,
  type PaymentExpectation,
} from "../src/chain.ts";
import { derivePaymentReference } from "../src/request.ts";
import { ERC20_FEE_PROXY, FAU } from "../src/plan.ts";

const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const JSON_ONLY = process.argv.includes("--json");

type Status = "ok" | "FAIL" | "BLOCKED";
interface Check {
  readonly id: string;
  readonly claim: string;
  status: Status;
  detail: string;
}
const checks: Check[] = [];
const record = (id: string, claim: string, status: Status, detail: string): void => {
  checks.push({ id, claim, status, detail });
};

const readJson = <T>(path: string): T | null => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
};

// ---- 1. the race -----------------------------------------------------------

interface RaceArtifact {
  generatedAt: string;
  workers: number;
  totals: Record<string, number>;
  waves: Array<{ label: string; workers: Array<{ state: string; refusal: string | null; txHash: string | null; providerWriteIssued: boolean }>; counters: Record<string, number> }>;
}
const race = readJson<RaceArtifact>("docs/evidence/race.json");
if (!race) {
  record("race", "N processes, one obligation, one payment", "BLOCKED", "docs/evidence/race.json is absent — run `npm run race`");
} else {
  // Recomputed from the per-wave counters rather than trusting totals.
  const broadcasts = race.waves.reduce((n, w) => n + (w.counters.broadcasts ?? 0), 0);
  const posts = race.waves.reduce((n, w) => n + (w.counters.posts ?? 0), 0);
  const deduped = race.waves.reduce((n, w) => n + (w.counters.dedupedByKey ?? 0), 0);
  const second = race.waves.find((w) => w.label === "second wave")?.counters.broadcasts ?? -1;
  const hashes = new Set(race.waves.flatMap((w) => w.workers.map((x) => x.txHash).filter(Boolean) as string[]));
  const threw = race.waves.flatMap((w) => w.workers).filter((x) => x.state === "THREW" || x.state === "NO_OUTPUT").length;

  const agrees = broadcasts === race.totals.broadcasts && second === race.totals.secondWaveBroadcasts;
  record(
    "race.totals",
    "the artifact's summary matches its own rows",
    agrees ? "ok" : "FAIL",
    agrees ? `recomputed broadcasts=${broadcasts}, secondWave=${second}` : "summary disagrees with the rows it summarises",
  );
  record(
    "race.exactly-once",
    `${race.workers} concurrent workers, one payment`,
    broadcasts === 1 ? "ok" : "FAIL",
    `${broadcasts} broadcast, ${hashes.size} distinct transaction(s)`,
  );
  record(
    "race.not-the-provider",
    "exactly-once is ReqKeeper's, not KeeperHub's idempotency cache",
    posts === 1 && deduped === 0 ? "ok" : posts === broadcasts ? "ok" : "FAIL",
    `${posts} post(s) reached the provider, ${deduped} deduped by key — the losers never got that far`,
  );
  record(
    "race.second-wave",
    "the same plan and key, after every process exited, sends nothing",
    second === 0 ? "ok" : "FAIL",
    `${second} broadcast in the second wave`,
  );
  record(
    "race.no-crashes",
    "every worker reached a designed outcome",
    threw === 0 ? "ok" : "FAIL",
    threw === 0 ? "no worker threw or produced no output" : `${threw} worker(s) threw instead of refusing`,
  );
}

// ---- 1b. the live race -----------------------------------------------------

interface LiveRaceWorker {
  state: string;
  refusal: string | null;
  txHash: string | null;
  providerWriteIssued?: boolean;
}
interface LiveRace {
  mode?: string;
  workers: number;
  invoice?: { requestId?: string; reference?: string; payee?: string };
  totals: Record<string, number>;
  waves: Array<{ label: string; workers: LiveRaceWorker[] }>;
}
const liveRace = readJson<LiveRace>("docs/evidence/race-live.json");
if (!liveRace) {
  record("race.live", "the race, once, against the real platform", "BLOCKED", "docs/evidence/race-live.json is absent");
} else {
  const ref = liveRace.invoice?.reference;

  /**
   * Recomputed from the worker rows, like the fixture race above it, and for the reason stated
   * at the top of this file: this check used to read `totals.broadcasts` and `totals.duplicates`
   * straight out of the summary block. Two separate passes walked through it — one injected a
   * second broadcast into the rows, one forged a SETTLED row with a transaction hash that was
   * never sent — and both were told "0 duplicate(s)", exit 0, because the summary still said so.
   *
   * A worker counts as a broadcast if it says it issued a provider write OR it carries a
   * transaction hash. Either alone is enough: a forged row that sets only `txHash` is claiming a
   * payment, and a row that admits `providerWriteIssued` while hiding the hash is still a send.
   */
  const allWorkers = liveRace.waves.flatMap((w) => w.workers);
  const broadcast = (w: LiveRaceWorker): boolean => w.providerWriteIssued === true || Boolean(w.txHash);
  const broadcasts = allWorkers.filter(broadcast).length;
  const hashes = new Set(allWorkers.map((w) => w.txHash).filter(Boolean) as string[]);
  const secondWave = (liveRace.waves.find((w) => w.label === "second wave")?.workers ?? []).filter(broadcast).length;
  // One obligation, so every broadcast past the first IS the duplicate payment.
  const duplicates = Math.max(0, broadcasts - 1);
  const summaryAgrees =
    liveRace.totals.broadcasts === broadcasts &&
    liveRace.totals.duplicates === duplicates &&
    (liveRace.totals.secondWaveBroadcasts ?? 0) === secondWave &&
    liveRace.totals.distinctTransactions === hashes.size;

  record(
    "race.live",
    `${liveRace.workers} concurrent workers against real KeeperHub and real Sepolia`,
    broadcasts === 1 && duplicates === 0 && hashes.size === 1 && secondWave === 0 && summaryAgrees ? "ok" : "FAIL",
    `${broadcasts} payment(s) carrying ${ref ?? "?"}, ${duplicates} duplicate(s)` +
      `, ${hashes.size} distinct transaction(s), ${secondWave} in the second wave` +
      (summaryAgrees ? " — recomputed from the worker rows" : " — and the summary block disagrees with the rows it summarises"),
  );
}

// ---- 1c. the second KeeperHub surface --------------------------------------

interface McpRow {
  transport?: string;
  token?: string;
  payee?: string;
  amountBaseUnits?: string;
  keeperhubExecutionId?: string;
  txHash?: string;
  paymentReference?: string;
  finalState?: string;
  physicalSends?: number;
}
const mcp = readJson<{ rows?: McpRow[] }>("docs/evidence/mcp-settlements.json");
if (!mcp?.rows?.length) {
  record("keeperhub.mcp", "value moved through KeeperHub's MCP surface too", "BLOCKED", "docs/evidence/mcp-settlements.json is absent");
} else {
  const rows = mcp.rows;
  const viaMcp = rows.filter((r) => r.transport === "mcp");
  const withExecId = viaMcp.filter((r) => r.keeperhubExecutionId);
  const settledOnce = viaMcp.filter((r) => r.finalState === "SETTLED" && r.physicalSends === 1);
  record(
    "keeperhub.mcp",
    "value moved through KeeperHub's MCP surface, not only REST",
    viaMcp.length >= 3 && settledOnce.length === viaMcp.length ? "ok" : "FAIL",
    `${viaMcp.length} settlement(s) via mcp, ${settledOnce.length} settled at one send each`,
  );
  record(
    "keeperhub.mcp.execution-ids",
    "each carries the KeeperHub execution id that produced it",
    withExecId.length === viaMcp.length ? "ok" : "FAIL",
    withExecId.map((r) => r.keeperhubExecutionId).join(", ") || "none",
  );

  // The per-row chain read that corroborates these rows lives in section 5, with every other
  // LIVE row in the repository. It used to live here, covering these three and nothing else.
}

// ---- 2. the crash matrix ---------------------------------------------------

interface CrashArtifact {
  generatedAt: string;
  rows: Array<{ checkpoint: string; reached?: boolean; duplicate: boolean; totalBroadcasts: number; finalState: string }>;
}
const crash = readJson<CrashArtifact>("docs/evidence/crash.json");
if (!crash || !Array.isArray(crash.rows)) {
  record("crash", "no crash checkpoint produces a duplicate payment", "BLOCKED", "docs/evidence/crash.json is absent — run `npm run crash`");
} else {
  const dupes = crash.rows.filter((r) => r.duplicate === true || r.totalBroadcasts > 1);
  const reached = crash.rows.filter((r) => r.reached !== false).length;
  record(
    "crash.no-duplicates",
    "no crash checkpoint produces a duplicate payment",
    dupes.length === 0 ? "ok" : "FAIL",
    dupes.length === 0
      ? `${reached} checkpoint(s) reached, zero duplicates`
      : `duplicates at: ${dupes.map((d) => d.checkpoint).join(", ")}`,
  );
}

// ---- 3. the recorded live run ----------------------------------------------

interface LiveArtifact {
  generatedAt: string;
  totals: Record<string, number>;
  rows: Array<{ case_id: string; actual: string; physical_sends: number; tx_hash: string | null; payment_reference: string | null; refused_before_provider_write: boolean }>;
}
const live = readJson<LiveArtifact>("docs/refusals-live.json");
if (!live) {
  record("live", "the recorded settlement run", "BLOCKED", "docs/refusals-live.json is absent");
} else {
  const settled = live.rows.filter((r) => r.actual === "SETTLED");
  const sends = live.rows.reduce((n, r) => n + (r.physical_sends ?? 0), 0);
  const withHash = live.rows.filter((r) => r.tx_hash);
  const distinctHashes = new Set(withHash.map((r) => r.tx_hash as string));
  const distinctRefs = new Set(live.rows.map((r) => r.payment_reference).filter(Boolean) as string[]);
  const refusedClean = live.rows.filter((r) => r.refused_before_provider_write);
  const replaySends = live.rows.filter((r) => r.actual === "ALREADY_SETTLED").reduce((n, r) => n + (r.physical_sends ?? 0), 0);

  record(
    "live.one-send-per-settlement",
    "every recorded settlement cost exactly one send",
    settled.length === sends ? "ok" : "FAIL",
    `${settled.length} settled, ${sends} physical send(s)`,
  );
  record(
    "live.distinct",
    "no transaction and no payment reference is reused",
    distinctHashes.size === withHash.length && distinctRefs.size === settled.length ? "ok" : "FAIL",
    `${distinctHashes.size} distinct transactions over ${withHash.length} rows, ${distinctRefs.size} distinct references`,
  );
  record(
    "live.replays-cost-nothing",
    "replays of a settled obligation send nothing",
    replaySends === 0 ? "ok" : "FAIL",
    `${live.rows.filter((r) => r.actual === "ALREADY_SETTLED").length} replays, ${replaySends} send(s)`,
  );
  record(
    "live.refused-before-write",
    "refusals happen before any provider write",
    refusedClean.length > 0 ? "ok" : "FAIL",
    `${refusedClean.length} row(s) refused at zero gas`,
  );
}

// ---- 4. the chain itself, credential-free ----------------------------------

interface InvoiceRow {
  requestId: string;
  salt?: string;
  paymentSalt?: string;
  payee?: string;
  paymentAddress?: string;
  paymentReference: string;
  /** What the invoice owes. The rows in `docs/refusals-live.json` carry none of this. */
  amountBaseUnits?: string;
  feeAmount?: string;
  feeAddress?: string;
}
// The file is `{ createdAt, payee, invoices: [...] }`, but an older cut was a bare array and a
// sibling artifact uses `rows`. All three are accepted; what is NOT accepted is silently
// reading zero rows and reporting BLOCKED, which is how a check quietly stops checking.
const invoiceFile = readJson<InvoiceRow[] | { invoices?: InvoiceRow[]; rows?: InvoiceRow[] }>("docs/live-invoices.json");
const invoiceRows: InvoiceRow[] = Array.isArray(invoiceFile)
  ? invoiceFile
  : (invoiceFile?.invoices ?? invoiceFile?.rows ?? []);

if (invoiceRows.length === 0) {
  record("request.derivation", "payment references are derived, not trusted", "BLOCKED", "docs/live-invoices.json is absent or empty");
} else {
  let derived = 0;
  for (const inv of invoiceRows) {
    const salt = inv.salt ?? inv.paymentSalt ?? "";
    const payee = inv.payee ?? inv.paymentAddress ?? "";
    if (!salt || !payee) continue;
    if (derivePaymentReference(inv.requestId, salt, payee).toLowerCase() === inv.paymentReference.toLowerCase()) derived++;
  }
  record(
    "request.derivation",
    "every recorded payment reference re-derives from its invoice",
    derived === invoiceRows.length ? "ok" : "FAIL",
    `${derived}/${invoiceRows.length} reproduce from keccak256(requestId + salt + paymentAddress)`,
  );
}

const sample = live?.rows.find((r) => r.tx_hash && r.payment_reference);
if (!sample) {
  record("chain", "a recorded payment is still on chain", "BLOCKED", "no recorded row carries both a hash and a reference");
} else {
  try {
    const receipt = await readReceipt(RPC, sample.tx_hash as string);
    record(
      "chain.receipt",
      `${sample.case_id}'s transaction has a successful receipt`,
      receipt.receiptStatus === "success" ? "ok" : "FAIL",
      `${sample.tx_hash?.slice(0, 18)}… → ${receipt.receiptStatus}, block ${receipt.blockNumber ?? "?"}, gas ${receipt.gasUsed}`,
    );

    const feeProxyLog = (receipt.logs ?? []).find((l) => l.address && l.address.toLowerCase() === ERC20_FEE_PROXY.toLowerCase());
    if (!feeProxyLog) {
      record("chain.receipt-log", "the receipt's own logs contain the fee-proxy payment", "FAIL", "no ERC20FeeProxy event in the receipt");
    } else {
      record("chain.receipt-log", "the receipt's own logs contain the fee-proxy payment", "ok", `emitted by ${ERC20_FEE_PROXY.slice(0, 10)}…`);
    }
  } catch (e) {
    record("chain", "a recorded payment is still on chain", "BLOCKED", `RPC unavailable: ${(e as Error).message.slice(0, 90)}`);
  }
}

// ---- 5. every LIVE row, against the chain ----------------------------------
//
// One claim, made by every settled row in every artifact: "transaction T paid reference R, and
// what it paid is what the invoice owed." One function checks it, over every row that makes it.
//
// It used to be a loop inside section 1c, covering the three MCP rows and nothing else. A
// KeeperHub reviewer replaced all 37 non-sampled transaction hashes in `docs/refusals-live.json`
// with fabricated values and this command answered `21 ok · 0 failed · 0 blocked`, exit 0 —
// because `L001` was the only row of the 38 anything ever read from the chain. A verification
// that samples one row verifies one row.

interface Corroborand {
  /** Names the row in the check detail, so a failure says which one failed. */
  readonly label: string;
  readonly reference: string | null;
  readonly txHash: string | null;
  /**
   * What the invoice owed. `null` means the evidence cannot state token, payee and amount — a
   * failure, never a fallback to matching on the reference alone. References are public and the
   * ERC20FeeProxy is permissionless, so "a log carries this reference" is a sighting, not a
   * payment: an earlier cut of this check matched on the reference only, and a review inflated
   * an amount 999x and set the payee to `0x…dEaD` and still got a green run.
   */
  readonly expect: PaymentExpectation | null;
  /** How badly a null `expect` counts, and what to say about it. */
  readonly unstated: { readonly status: Status; readonly detail: string };
}

/**
 * publicnode answers `eth_getLogs` for fee-proxy logs that demonstrably exist with an empty
 * array and no error — every one of the 41 references below comes back empty from it, and comes
 * back from Tenderly in one call — so one endpoint's silence is not evidence of absence. The
 * sweep unions endpoints in order and stops as soon as every reference has been seen.
 */
const SWEEP_ENDPOINTS = [...new Set([RPC, "https://sepolia.gateway.tenderly.co", "https://sepolia.drpc.org"])];
const SWEEP_LOOKBACK = 300_000;
/** publicnode answers `exceed maximum block range: 50000`, so ranges are chunked below its cap. */
const SWEEP_RANGE = 45_000;

interface SweptLog {
  readonly txHash: string;
  readonly emitter: string;
  readonly data: string;
}

/**
 * One `eth_getLogs` filter for every reference at once (`topics: [event, [ref1, ref2, …]]`)
 * rather than one scan per row. 41 rows scanned one at a time is upwards of a hundred RPC
 * calls and a rate limit; batched, the whole set is two calls, because every payment this
 * project has made falls inside one 45,000-block window.
 */
async function sweepPayments(references: readonly string[]): Promise<Map<string, SweptLog[]>> {
  const wantedTopics = new Map<string, string>();
  for (const r of references) wantedTopics.set(referenceTopic(r).toLowerCase(), r.toLowerCase());

  let head: number | null = null;
  let lastError: Error | null = null;
  for (const endpoint of SWEEP_ENDPOINTS) {
    try {
      head = await currentBlock(endpoint);
      break;
    } catch (e) {
      lastError = e as Error;
    }
  }
  if (head === null) throw lastError ?? new Error("no endpoint answered eth_blockNumber");
  const floor = Math.max(0, head - SWEEP_LOOKBACK);

  const found = new Map<string, SweptLog[]>();
  const seen = new Set<string>();
  const hex = (n: number) => `0x${n.toString(16)}`;

  for (const endpoint of SWEEP_ENDPOINTS) {
    if (found.size === wantedTopics.size) break;
    try {
      // A hash is only unique within one chain, and an RPC URL does not say which chain answers.
      await assertChainId(endpoint);
      let to = head;
      while (to >= floor) {
        const from = Math.max(floor, to - SWEEP_RANGE + 1);
        const logs = (await rpcCall(endpoint, "eth_getLogs", [
          {
            address: ERC20_FEE_PROXY,
            topics: [EVENT_TOPIC, [...wantedTopics.keys()]],
            fromBlock: hex(from),
            toBlock: hex(to),
          },
        ])) as Array<{ data: string; transactionHash: string; address?: string; topics?: string[] }>;

        for (const log of logs) {
          const reference = wantedTopics.get(String(log.topics?.[1] ?? "").toLowerCase());
          if (!reference) continue;
          const key = `${reference}:${log.transactionHash.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const bucket = found.get(reference) ?? [];
          bucket.push({ txHash: log.transactionHash, emitter: log.address ?? ERC20_FEE_PROXY, data: log.data });
          found.set(reference, bucket);
        }

        if (found.size === wantedTopics.size || from === floor) break;
        to = from - 1;
      }
    } catch {
      // An endpoint that will not answer is not a second opinion. Ask the next one.
    }
  }
  return found;
}

async function corroborate(rows: readonly Corroborand[]): Promise<Map<string, { status: Status; detail: string }>> {
  const out = new Map<string, { status: Status; detail: string }>();
  const readable: Corroborand[] = [];
  for (const row of rows) {
    if (!row.expect) out.set(row.label, { status: row.unstated.status, detail: row.unstated.detail });
    else if (!row.reference || !row.txHash) {
      out.set(row.label, { status: "BLOCKED", detail: "the row carries no payment reference or no transaction hash" });
    } else readable.push(row);
  }
  if (readable.length === 0) return out;

  let logs: Map<string, SweptLog[]>;
  try {
    logs = await sweepPayments([...new Set(readable.map((r) => r.reference as string))]);
  } catch (e) {
    for (const row of readable) {
      out.set(row.label, { status: "BLOCKED", detail: `RPC unavailable: ${(e as Error).message.slice(0, 70)}` });
    }
    return out;
  }

  for (const row of readable) {
    const sightings = logs.get((row.reference as string).toLowerCase()) ?? [];
    if (sightings.length === 0) {
      // Not "unpaid". Every endpoint was asked and none had it inside the window, which is
      // inconclusive — and inconclusive is never a pass.
      out.set(row.label, {
        status: "BLOCKED",
        detail: `no fee-proxy event carrying ${row.reference} in the last ${SWEEP_LOOKBACK} blocks on ${SWEEP_ENDPOINTS.length} endpoint(s) — inconclusive, not "unpaid"`,
      });
      continue;
    }
    if (sightings.length > 1) {
      out.set(row.label, {
        status: "FAIL",
        detail: `${sightings.length} transactions carry ${row.reference}: ${sightings.map((s) => s.txHash.slice(0, 12)).join(", ")}`,
      });
      continue;
    }
    const [log] = sightings;
    const fields = decodePaymentLogFields(log.data);
    if (!fields) {
      out.set(row.label, { status: "FAIL", detail: `${log.txHash.slice(0, 14)}… carries this reference but is not a payment event` });
      continue;
    }
    const verdict = matchPaymentLog({ ...fields, emitter: log.emitter }, row.expect as PaymentExpectation);
    if (!verdict.ok) {
      out.set(row.label, { status: "FAIL", detail: `${log.txHash.slice(0, 14)}… ${verdict.conflicts.join("; ")}` });
      continue;
    }
    if (log.txHash.toLowerCase() !== (row.txHash as string).toLowerCase()) {
      out.set(row.label, {
        status: "FAIL",
        detail: `the chain pays ${row.reference} in ${log.txHash.slice(0, 14)}…, the row claims ${(row.txHash as string).slice(0, 14)}…`,
      });
      continue;
    }
    out.set(row.label, { status: "ok", detail: `${log.txHash.slice(0, 20)}…` });
  }
  return out;
}

/**
 * The invoice is where token, payee and amount come from for the rows that do not state them.
 * `docs/refusals-live.json` records a case id, a reference and a hash and nothing about the
 * money, so without this join those 38 rows could only ever be matched on their reference.
 */
const invoiceByKey = new Map<string, InvoiceRow>();
for (const inv of invoiceRows) {
  if (inv.paymentReference) invoiceByKey.set(inv.paymentReference.toLowerCase(), inv);
  if (inv.requestId) invoiceByKey.set(inv.requestId.toLowerCase(), inv);
}
const invoiceExpectation = (...keys: Array<string | null | undefined>): PaymentExpectation | null => {
  const inv = keys.map((k) => (k ? invoiceByKey.get(k.toLowerCase()) : undefined)).find(Boolean);
  const to = inv?.payee ?? inv?.paymentAddress;
  if (!inv || !to || !inv.amountBaseUnits) return null;
  return {
    // The invoice file records no token. FAU is the only token this deployment settles in and
    // the only one `npm run fund` approves, so it is stated here from `src/plan.ts` rather than
    // read from the row — which is why this is named in the check's detail, not hidden in it.
    tokenAddress: FAU,
    to,
    amount: inv.amountBaseUnits,
    ...(inv.feeAmount !== undefined ? { feeAmount: inv.feeAmount } : {}),
    ...(inv.feeAddress !== undefined ? { feeAddress: inv.feeAddress } : {}),
  };
};

const NO_INVOICE = {
  status: "BLOCKED" as Status,
  detail: "docs/live-invoices.json has no invoice for this row, so token, payee and amount cannot be stated — uncorroborated, never a pass",
};

const mcpToCheck = (mcp?.rows ?? []).filter((r) => r.transport === "mcp");
const restToCheck = (live?.rows ?? []).filter((r) => r.tx_hash && r.payment_reference);
const raceRef = liveRace?.invoice?.reference ?? null;
const raceTx = (liveRace?.waves.flatMap((w) => w.workers) ?? []).map((w) => w.txHash).find(Boolean) ?? null;

const verdicts = await corroborate([
  ...mcpToCheck.map((r) => ({
    label: `mcp:${r.paymentReference}`,
    reference: r.paymentReference ?? null,
    txHash: r.txHash ?? null,
    // These rows DO state what they paid, so a missing field is the artifact's failure, not the
    // join's. The first version of this read `row.tokenAddress`, which is not what the artifact
    // calls the field, so the expectation came back undefined and the check quietly fell back to
    // the reference alone — green, and proving nothing.
    expect:
      r.token && r.payee && r.amountBaseUnits
        ? { tokenAddress: r.token, to: r.payee, amount: r.amountBaseUnits }
        : null,
    unstated: { status: "FAIL" as Status, detail: "the row does not state token, payee and amount, so nothing can corroborate it" },
  })),
  ...restToCheck.map((r) => ({
    label: `rest:${r.case_id}`,
    reference: r.payment_reference,
    txHash: r.tx_hash,
    expect: invoiceExpectation(r.payment_reference, (r as { request_id?: string }).request_id),
    unstated: NO_INVOICE,
  })),
  ...(raceRef && raceTx
    ? [
        {
          label: "race:live",
          reference: raceRef,
          txHash: raceTx,
          expect: invoiceExpectation(raceRef, liveRace?.invoice?.requestId),
          unstated: NO_INVOICE,
        },
      ]
    : []),
]);

for (const r of mcpToCheck) {
  const v = verdicts.get(`mcp:${r.paymentReference}`);
  if (v) record(`keeperhub.mcp.onchain.${r.paymentReference}`, `the MCP settlement for ${r.paymentReference} is on chain`, v.status, v.detail);
}

if (raceRef && raceTx) {
  const v = verdicts.get("race:live");
  if (v) record("race.live.onchain", "that live payment is on chain, exactly once", v.status, v.detail);
}

if (restToCheck.length === 0) {
  record("chain.reference", "every recorded payment is on chain, in the transaction its row names", "BLOCKED", "no recorded row carries both a hash and a reference");
} else {
  const results = restToCheck.map((r) => ({ id: r.case_id, ...(verdicts.get(`rest:${r.case_id}`) ?? { status: "BLOCKED" as Status, detail: "not checked" }) }));
  const failed = results.filter((r) => r.status === "FAIL");
  const blocked = results.filter((r) => r.status === "BLOCKED");
  const passed = results.filter((r) => r.status === "ok");
  const summarise = (rs: typeof results) => rs.slice(0, 3).map((r) => `${r.id}: ${r.detail}`).join(" · ") + (rs.length > 3 ? ` · +${rs.length - 3} more` : "");
  record(
    "chain.reference",
    "every recorded payment is on chain, in the transaction its row names",
    failed.length > 0 ? "FAIL" : blocked.length > 0 ? "BLOCKED" : "ok",
    failed.length > 0
      ? `${failed.length}/${results.length} row(s) disagree with the chain — ${summarise(failed)}`
      : blocked.length > 0
        ? `${blocked.length}/${results.length} row(s) could not be corroborated — ${summarise(blocked)}`
        : `${passed.length}/${results.length} recorded payments matched emitter, token, payee, amount and fee in the transaction the row names ` +
          `(payee, amount and fee joined from docs/live-invoices.json; token is FAU from src/plan.ts, the only token this deployment settles in)`,
  );
}

// ---- report ----------------------------------------------------------------

const failed = checks.filter((c) => c.status === "FAIL");
const blocked = checks.filter((c) => c.status === "BLOCKED");
const passed = checks.filter((c) => c.status === "ok");

const artifact = {
  generatedAt: new Date().toISOString(),
  chainId: 11155111,
  rpc: RPC,
  credentialsUsed: "none",
  totals: { checks: checks.length, ok: passed.length, failed: failed.length, blocked: blocked.length },
  checks,
};
mkdirSync("docs/evidence", { recursive: true });
writeFileSync("docs/evidence/verify.json", `${JSON.stringify(artifact, null, 2)}\n`);

// The truth ledger is GENERATED, so it cannot drift from the evidence it summarises.
const truth = [
  "# Truth ledger",
  "",
  "Generated by `npm run verify:all` from `docs/evidence/*.json` and from public Sepolia RPCs.",
  "Do not edit by hand: the next run overwrites it, and a claim that only lives here is a claim",
  "with no evidence behind it.",
  "",
  `Generated ${artifact.generatedAt} · chain 11155111 (Sepolia) · credentials used: none`,
  "",
  "| Claim | Status | Evidence | Reproduce |",
  "|---|---|---|---|",
  ...checks.map(
    (c) =>
      `| ${c.claim} | ${c.status === "ok" ? "PROVEN" : c.status === "BLOCKED" ? "UNPROVEN" : "**FAILED**"} | ${c.detail.replace(/\|/g, "\\|")} | \`npm run verify:all\` |`,
  ),
  "",
  "## What this does not claim",
  "",
  "- **Sepolia only.** No mainnet payment has ever been made, and mainnet chain ids are refused in code.",
  "- **Finality is depth, not proof.** Settlement requires an independently read receipt, the",
  "  fee-proxy event for the same transaction and amount, and a minimum confirmation depth",
  "  (`REQKEEPER_MIN_CONFIRMATIONS`, default 2). Nothing re-checks after settlement, so the honest",
  "  word is \"confirmed at a stated depth\", never \"final\" or \"irreversible\".",
  "- **The race runs against a fixture.** It proves the reservation and the compare-and-set across",
  "  real processes; it is not a live-money run. The fixture counts every call that reached it,",
  "  including ones its own idempotency cache would have absorbed, so the result cannot be",
  "  KeeperHub's cache taking the credit.",
  "- **The recorded live run predates several of the gates it is cited alongside.** Those 38",
  "  settlements are real payments with real receipts; they are not evidence that the receipt-log",
  "  check or the depth gate works.",
  "",
  "Open findings are listed in `hackathon/audit/STATUS.md`, including the ones still open.",
  "",
].join("\n");
writeFileSync("docs/TRUTH.md", truth);

if (JSON_ONLY) {
  console.log(JSON.stringify(artifact.totals));
} else {
  console.log("\n  verify:all — every public claim, no credentials\n");
  for (const c of checks) {
    const mark = c.status === "ok" ? "  ok  " : c.status === "FAIL" ? " FAIL " : "BLOCKED";
    console.log(`  ${mark} ${c.claim}`);
    console.log(`         ${c.detail}`);
  }
  console.log(
    `\n  ${passed.length} ok · ${failed.length} failed · ${blocked.length} blocked` +
      `\n  written to docs/evidence/verify.json and docs/TRUTH.md\n`,
  );
  if (blocked.length > 0) {
    console.log("  BLOCKED means an evidence file is missing or an endpoint would not answer.");
    console.log("  It is never counted as a pass.\n");
  }
}

// The documents are part of the claim surface. A figure in README.md or docs/SUBMISSION.md that
// no longer matches the evidence just written is the same failure as a check going red, and it is
// the failure nobody notices — docs/SUBMISSION.md claimed 239 unit tests for months after the
// suite passed 300. Run last, because it reads the verify.json this run just wrote.
let documentsAgree = true;
if (!JSON_ONLY) {
  try {
    execFileSync("node", ["--experimental-strip-types", "scripts/readme-numbers.ts", "--check"], {
      stdio: "inherit",
    });
  } catch {
    documentsAgree = false;
    console.error("  a documented number no longer matches the evidence (see above)\n");
  }
}

process.exit(failed.length === 0 && documentsAgree ? 0 : 1);
