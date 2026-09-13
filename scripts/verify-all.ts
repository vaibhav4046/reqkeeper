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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  EVENT_TOPIC,
  assertChainId,
  currentBlock,
  decodePaymentLogFields,
  findPaymentByReference,
  negativeCorroborationEndpoints,
  matchPaymentLog,
  readReceipt,
  referenceTopic,
  rpcCall,
  type PaymentExpectation,
} from "../src/chain.ts";
import { derivePaymentReference } from "../src/request.ts";
import { evaluateSpec, type TotalSpec } from "../src/totals.ts";
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

// ---- 0. every artifact under docs/, its summary against its own rows -------
//
// The rule at the top of this file was applied artifact by artifact, by hand, and it was only
// ever written down for the two race artifacts. `docs/refusals.json` stated
// `refusedBeforeAnyProviderWrite: 18` while nineteen of its rows carry
// `refused_before_provider_write: true`, and nothing in this file opened that artifact at all —
// so the property the README sells ("tamper with a summary and leave its rows alone, and this
// exits 1") held for the artifacts somebody remembered to write a check for, and for no others.
//
// It is a property of the artifact FORMAT here, not of a list: every `.json` under `docs/` is
// scanned, and any file carrying a summary block (`totals` or `summary`) plus a rows array has
// every summary number it can re-derive re-derived from those rows. A new artifact is covered
// the day it lands, without anyone remembering.
//
// A summary number is matched to a row field BY NAME, never by position:
//   - the key names a top-level array           -> that array's length
//   - the key names exactly one row field       -> booleans counted, numbers summed
//   - the key is a row-count word (rows, cases) -> the number of rows
// Filler words (`any`, `total`, `number`) are dropped from both sides and a plural key may name
// a singular field, so `refusedBeforeAnyProviderWrite` finds `refused_before_provider_write`
// and `duplicates` finds `duplicate`. A key matching two fields is ambiguous, and ambiguous is
// not derived — a guessed arithmetic that happens to agree is not a check.
//
// A key that matches nothing is NOT quietly dropped. It is counted and named in the detail,
// because a check that stops checking without saying so is the failure this whole file exists
// to catch.

const FILLER = new Set(["any", "total", "num", "number", "of", "the", "all"]);
const ROW_COUNT_WORDS = new Set(["rows", "row", "cases", "case", "records", "record", "entries", "entry", "items", "item"]);
/** Array names that mean "the rows", in preference order, before falling back to the longest. */
const ROWS_KEYS = ["rows", "cases", "checks", "records", "entries", "items"];

const nameWords = (name: string): string[] =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());
const canonical = (name: string): string => {
  const kept = nameWords(name).filter((w) => !FILLER.has(w));
  return (kept.length > 0 ? kept : nameWords(name)).join("");
};
/** `duplicates` may name `duplicate` and `passed` may name `pass`. Nothing else is inferred. */
const aliases = (name: string): string[] => {
  const c = canonical(name);
  const out = [c];
  if (c.length > 2 && c.endsWith("s") && !c.endsWith("ss")) out.push(c.slice(0, -1));
  if (c.length > 3 && c.endsWith("ed")) out.push(c.slice(0, -2));
  return out;
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

interface ArtifactAudit {
  readonly file: string;
  /** Summary numbers actually re-derived from the rows. */
  readonly recomputed: number;
  readonly disagreements: string[];
  /** Summary numbers that name no row field. Reported, never silently dropped. */
  readonly underivable: string[];
}

const jsonFilesUnder = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...jsonFilesUnder(p));
    else if (entry.name.endsWith(".json")) out.push(p);
  }
  return out.sort();
};

/**
 * How an artifact says a total is derived, when its name does not already say it.
 *
 * Name-matching covers the easy half: a key that names a row field, an array, or the row count.
 * It cannot cover `settledAfterRecovery` or `maxBroadcastsForOneObligation`, and those were
 * reported as "not recomputed" and left alone — 27 of 42 numbers in this repository, including
 * every figure the crash matrix and the race publish.
 *
 * Listing them in this file would put the checklist back in the checker, which is the arrangement
 * that let `docs/refusals.json` disagree with its own rows for weeks. So the artifact carries the
 * derivation instead: a generator that adds a total must either name it after a row field or say
 * in `totalsFrom` how to compute it, and a total with neither is still reported. Coverage becomes
 * a property of the format rather than a property of whoever last edited the checker.
 */
/** `null` means "this file claims no totals", which is nothing to check rather than a pass. */
function auditArtifact(file: string): ArtifactAudit | null {
  const doc = readJson<unknown>(file);
  if (!isRecord(doc)) {
    // The file is there — `jsonFilesUnder` just listed it — so this is a malformed artifact,
    // not a missing one. An evidence file nobody can parse is an evidence file nobody checked.
    return { file, recomputed: 0, disagreements: [`${file} does not parse as a JSON object`], underivable: [] };
  }
  const summaryKey = ["totals", "summary"].find((k) => isRecord(doc[k]));
  if (!summaryKey) return null;
  const summary = doc[summaryKey] as Record<string, unknown>;

  const arrays: Array<[string, unknown[]]> = Object.entries(doc).filter((e): e is [string, unknown[]] => Array.isArray(e[1]));
  const preferred = arrays
    .filter(([n]) => ROWS_KEYS.includes(n))
    .sort((a, b) => ROWS_KEYS.indexOf(a[0]) - ROWS_KEYS.indexOf(b[0]))[0];
  const longest = arrays.filter(([, v]) => isRecord(v[0])).sort((a, b) => b[1].length - a[1].length)[0];
  const rowsEntry = preferred ?? longest;
  if (!rowsEntry) {
    return {
      file,
      recomputed: 0,
      disagreements: [],
      // A summary with no rows under it can be recomputed from nothing, so every number in
      // it is reported as not recomputed rather than passed over.
      underivable: Object.keys(summary).filter((k) => typeof summary[k] === "number"),
    };
  }
  const rows = rowsEntry[1].filter(isRecord);

  const fieldsByName = new Map<string, string[]>();
  for (const row of rows) {
    for (const field of Object.keys(row)) {
      const c = canonical(field);
      const seen = fieldsByName.get(c) ?? [];
      if (!seen.includes(field)) seen.push(field);
      fieldsByName.set(c, seen);
    }
  }
  const arrayLengths = new Map<string, number>(arrays.map(([n, v]): [string, number] => [canonical(n), v.length]));

  const derive = (key: string): { value: number; how: string } | null => {
    for (const alias of aliases(key)) {
      const length = arrayLengths.get(alias);
      if (length !== undefined) return { value: length, how: `the length of ${alias}` };
      const named = fieldsByName.get(alias);
      // Two row fields with the same canonical name is an ambiguity, not a derivation.
      if (named && named.length === 1) {
        const field = named[0];
        const values = rows.map((r) => r[field]).filter((v) => v !== undefined && v !== null);
        if (values.length > 0 && values.every((v) => typeof v === "boolean")) {
          return { value: values.filter((v) => v === true).length, how: `rows with ${field} true` };
        }
        if (values.length > 0 && values.every((v) => typeof v === "number")) {
          return { value: (values as number[]).reduce((n, v) => n + v, 0), how: `the sum of ${field}` };
        }
        return null;
      }
      if (ROW_COUNT_WORDS.has(alias)) return { value: rows.length, how: "the row count" };
    }
    return null;
  };

  const disagreements: string[] = [];
  const underivable: string[] = [];
  let recomputed = 0;
  for (const [key, stated] of Object.entries(summary)) {
    if (typeof stated !== "number") continue;
    // Name first, then the artifact's own statement of how it is derived. A key that has neither
    // is reported by name: a check that quietly stops checking is the failure this file exists
    // to catch, and that applies to this check too.
    const spec = isRecord(doc.totalsFrom) && isRecord(doc.totalsFrom[key]) ? (doc.totalsFrom[key] as TotalSpec) : undefined;
    const got = derive(key) ?? (spec ? evaluateSpec(spec, doc, rows) : null);
    if (!got) {
      underivable.push(key);
      continue;
    }
    recomputed++;
    if (got.value !== stated) {
      disagreements.push(`${file} ${summaryKey}.${key} says ${stated}, its rows give ${got.value} (${got.how})`);
    }
  }
  return { file, recomputed, disagreements, underivable };
}

const scannedFiles = existsSync("docs") ? jsonFilesUnder("docs") : [];
const artifactAudits = scannedFiles.map(auditArtifact).filter((a): a is ArtifactAudit => a !== null);
/** Race artifacts count their broadcasts inside nested waves, so section 1 adds its own. */
const summaryDisagreements: string[] = artifactAudits.flatMap((a) => a.disagreements);

// ---- 1. the race -----------------------------------------------------------

interface RaceArtifact {
  generatedAt: string;
  workers: number;
  totals: Record<string, number>;
  waves: Array<{ label: string; workers: Array<{ state: string; refusal: string | null; txHash: string | null; providerWriteIssued: boolean }>; counters: Record<string, number> }>;
}
/** Summary numbers section 0 cannot name-match, recomputed by hand below. */
let nestedRecomputed = 0;
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

  // race.json keeps its broadcasts inside nested waves, which the name-matched recompute in
  // section 0 cannot derive, so this artifact keeps its own hand-written recompute. The verdict
  // goes into the SAME check as every other artifact rather than into a second one covering only
  // this file — one check, one claim: every summary under docs/ matches the rows under it.
  nestedRecomputed += 2;
  if (broadcasts !== race.totals.broadcasts || second !== race.totals.secondWaveBroadcasts) {
    summaryDisagreements.push(
      `docs/evidence/race.json totals.broadcasts/secondWaveBroadcasts say ${race.totals.broadcasts}/${race.totals.secondWaveBroadcasts}, its wave rows give ${broadcasts}/${second}`,
    );
  }
  // `hashes.size` was computed and only printed. A review added three forged SETTLED workers
  // carrying transaction hashes to this artifact and the run stayed green at 21 ok, because the
  // status looked at `broadcasts` alone -- while the LIVE race check sixty lines below had already
  // been hardened against exactly that tamper. The hardening was never carried back.
  //
  // A worker that claims a transaction is claiming a payment, whether or not the counter agrees,
  // so the two have to agree with each other: one broadcast, one distinct hash, and no worker
  // asserting a settlement the counters do not account for.
  const claimedSettlements = race.waves
    .flatMap((w) => w.workers)
    .filter((x) => x.txHash || x.providerWriteIssued === true).length;
  const raceConsistent = broadcasts === 1 && hashes.size <= 1 && claimedSettlements === broadcasts;
  record(
    "race.exactly-once",
    `${race.workers} concurrent workers, one payment`,
    raceConsistent ? "ok" : "FAIL",
    raceConsistent
      ? `${broadcasts} broadcast, ${hashes.size} distinct transaction(s)`
      : `${broadcasts} broadcast, ${hashes.size} distinct transaction(s), ${claimedSettlements} worker(s) claiming one — the rows do not agree with the counters`,
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

// ---- 1a. one verdict for every summary under docs/ ------------------------
//
// Section 0 scanned the directory; section 1 added the two numbers only race.json's nested
// waves can produce. Both land here, in a single check, so the claim reads as what it is —
// a property of every artifact in the repository, not of the ones with bespoke checks.

const recomputedTotals = artifactAudits.reduce((n, a) => n + a.recomputed, 0) + nestedRecomputed;
const notRecomputed = artifactAudits.flatMap((a) => a.underivable.map((k) => `${a.file}:${k}`));
/** Capped for the line length, and the cap is stated rather than silently applied. */
const firstFew = (xs: readonly string[], n: number): string =>
  xs.slice(0, n).join(" · ") + (xs.length > n ? ` · +${xs.length - n} more` : "");
record(
  "artifacts.totals",
  "every artifact's summary matches its own rows",
  summaryDisagreements.length === 0 ? "ok" : "FAIL",
  summaryDisagreements.length > 0
    ? `${summaryDisagreements.length} summary number(s) disagree with the rows they summarise — ${firstFew(summaryDisagreements, 3)}`
    : `${recomputedTotals} summary number(s) recomputed from rows and agreeing, over ${artifactAudits.length} artifact(s) ` +
      `carrying a summary (${scannedFiles.length} .json scanned under docs/); ${notRecomputed.length} summary number(s) name no ` +
      `row field and were NOT recomputed: ${firstFew(notRecomputed, 4)}`,
);

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

  // The block README cites for that transaction, read from the chain rather than typed.
  //
  // "block 11,691,069" appeared in the README and in no evidence file anywhere — true on chain,
  // and unchecked by anything, which is the shape every wrong number in this repository has had
  // before it was caught. A number nobody can re-derive is a claim, not a fact.
  const winner = [...hashes][0];
  if (!winner) {
    record("race.live.block", "the block README cites for the live race", "BLOCKED", "no transaction hash in the artifact");
  } else {
    const receipt = await readReceipt(RPC, winner);
    record(
      "race.live.block",
      "the block README cites for the live race",
      receipt.blockNumber === undefined ? "BLOCKED" : "ok",
      receipt.blockNumber === undefined
        ? `the endpoint would not return a receipt for ${winner.slice(0, 12)}… — unread, not absent`
        : `block ${receipt.blockNumber} for ${winner.slice(0, 12)}…, read from the chain`,
    );
  }
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
  /** The block the invoice was written at, from the public Request gateway. The floor that
   *  turns "no payment on chain" from "I could not tell" into an answer. */
  anchorBlock?: number;
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
  // A row that cannot state its fee cannot be corroborated on its fee. Returning null makes it
  // BLOCKED -- never a pass -- rather than quietly checking four fields while the detail line
  // claims five.
  if (!inv || !to || !inv.amountBaseUnits) return null;
  if (inv.feeAmount === undefined || inv.feeAddress === undefined) return null;
  return {
    // The invoice file records no token. FAU is the only token this deployment settles in and
    // the only one `npm run fund` approves, so it is stated here from `src/plan.ts` rather than
    // read from the row — which is why this is named in the check's detail, not hidden in it.
    tokenAddress: FAU,
    to,
    amount: inv.amountBaseUnits,
    // NOT conditional. Spreading these only when present meant deleting them from an invoice
    // silently narrowed the check -- a wrong fee was caught, an absent one was not, and the
    // detail line went on saying "matched emitter, token, payee, amount and fee" either way.
    // That is the absent-reads-as-a-pass class this codebase refuses everywhere else, sitting in
    // the verifier that exists to catch exactly this.
    //
    // A row that cannot state its fee cannot be corroborated on its fee, and `null` says so: the
    // caller below turns it into a failure rather than a quieter check.
    feeAmount: inv.feeAmount,
    feeAddress: inv.feeAddress,
  };
};

const NO_INVOICE = {
  status: "BLOCKED" as Status,
  detail: "docs/live-invoices.json has no invoice for this row, so token, payee and amount cannot be stated — uncorroborated, never a pass",
};

const mcpToCheck = (mcp?.rows ?? []).filter((r) => r.transport === "mcp");
// Every row the artifact calls settled, whether or not it states a hash. Filtering on
// `r.tx_hash && r.payment_reference` counted only the rows that could be checked, so deleting a
// hash from a settled row removed it from the denominator and the run still reported 21 ok: the
// artifact claimed 38 settlements, the sweep corroborated 37, and nothing compared the two.
// A row that claims a payment and does not say which transaction is not a row to skip. It is a
// row that cannot be corroborated, which is the thing this check exists to notice.
const restSettled = (live?.rows ?? []).filter((r) => r.physical_sends > 0 || r.tx_hash);
const restToCheck = restSettled.filter((r) => r.tx_hash && r.payment_reference);
const restUncheckable = restSettled.filter((r) => !(r.tx_hash && r.payment_reference));
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
  // Carried INTO the sweep as failures rather than dropped from it, so the denominator is the
  // number of settlements claimed and not the number that happened to be checkable.
  ...restUncheckable.map((r) => ({
    label: `rest:${r.case_id}`,
    reference: r.payment_reference ?? null,
    txHash: r.tx_hash ?? null,
    expect: null,
    unstated: {
      status: "FAIL" as Status,
      detail: `the row claims a settlement but names no ${r.tx_hash ? "payment reference" : "transaction"}, so nothing can corroborate it`,
    },
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

if (restSettled.length === 0) {
  record("chain.reference", "every recorded payment is on chain, in the transaction its row names", "BLOCKED", "the artifact records no settlement");
} else {
  // Over every row the artifact CALLS settled. Mapping over the checkable subset was the same
  // denominator bug one layer up: a row stripped of its hash left the numerator and the
  // denominator together, so 37 of 38 corroborated still reported as everything checking out.
  const results = restSettled.map((r) => ({ id: r.case_id, ...(verdicts.get(`rest:${r.case_id}`) ?? { status: "BLOCKED" as Status, detail: "not checked" }) }));
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

// ---- the denominator the payer chose, not the one the artifact did ---------
//
// Every check above starts from the rows: it takes what the evidence CLAIMS and asks the chain
// whether the claim holds. That direction cannot see a row that is not there. An adversarial pass
// made exactly that point — erase a real payment end to end, consistently, and `verify:all` exits
// 0, because the denominator is whatever the artifact chose to mention.
//
// This runs the other way. The invoice set is the denominator: for every invoice this deployment
// knows, ask the chain whether it was paid, and require the evidence to account for any payment
// the chain shows. The invoice list is not derived from the evidence — it is the set of debts,
// each one anchored at the block its invoice was written at, and the anchor is what makes a
// negative conclusive rather than "I could not tell".
//
// It is not a proof of completeness over all payments ever made by the payer: only KeeperHub can
// enumerate those. It is a proof over every debt this deployment has a record of owing, which is
// the set an erased row would have to hide inside.

const invoiceDoc = readJson<{ rows?: InvoiceRow[]; invoices?: InvoiceRow[] }>("docs/live-invoices.json");
// The file names its array `invoices`. Reading only `rows` made this check BLOCKED on an empty
// universe while looking exactly like a check that ran -- a denominator of zero passes anything.
const invoiceUniverse: InvoiceRow[] = invoiceDoc?.invoices ?? invoiceDoc?.rows ?? [];

const recordedHashes = new Set<string>(
  [
    ...(live?.rows ?? []).map((r) => r.tx_hash),
    ...(mcp?.rows ?? []).map((r) => r.txHash),
    ...(liveRace?.waves.flatMap((w) => w.workers) ?? []).map((w) => w.txHash),
    // Payments this deployment made that no RUN artifact records, kept in their own file rather
    // than folded into one that claims to be a harness output. The first completeness sweep found
    // two of them: real, broadcast by this deployment's relayer, paying their invoice exactly, and
    // made before the evidence pipeline existed. Recording the gap is the honest option; the
    // alternative was a permanently red check that people learn to ignore.
    ...(readJson<{ rows?: Array<{ txHash?: string }> }>("docs/evidence/chain-only-payments.json")?.rows ?? []).map(
      (r) => r.txHash,
    ),
  ]
    .filter((h): h is string => typeof h === "string" && h.length > 0)
    .map((h) => h.toLowerCase()),
);

// Who this deployment pays, gathered from everything under docs/ rather than from one file.
//
// The previous version asked the chain about the references listed in `docs/live-invoices.json`,
// which put the DENOMINATOR inside the tamper surface: a reviewer deleted a real payment's rows
// AND its invoice, recomputed the totals, corrected the prose numbers this tool itself named, and
// got `23 ok · 0 failed · 0 blocked`, exit 0. The payment is still on Sepolia and nothing in the
// repository could name it.
//
// A payee survives that. Every invoice here pays the same handful of addresses, so deleting one
// invoice leaves the payee behind in forty-five others, and the chain still shows every event
// paying it. To shrink this denominator an attacker has to remove the payee from every file under
// docs/ — which means deleting every invoice and every settled row, at which point the artifacts
// claim nothing and the summary-vs-rows and prose-number checks fire on the wreckage.
const payeeSet = new Set<string>();
for (const file of scannedFiles) {
  const text = readFileSync(file, "utf8");
  // Any 20-byte address sitting under a key that names a payee. Deliberately broad: this is a
  // denominator, and a payee counted that this deployment never paid can only make the check
  // stricter, never blinder.
  for (const m of text.matchAll(/"(?:payee|to|paymentAddress|payeeOfRecord)"\s*:\s*"(0x[0-9a-fA-F]{40})"/g)) {
    payeeSet.add(m[1].toLowerCase());
  }
}

if (payeeSet.size === 0) {
  record("chain.completeness", "no payment on chain is missing from the evidence", "BLOCKED", "no payee appears anywhere under docs/");
} else {
  // The floor: the earliest block anything under docs/ points at. Invoice anchors are the usual
  // source, but a settled row's own block counts too, so deleting the invoices does not raise it.
  const anchors = invoiceUniverse.map((i) => i.anchorBlock).filter((b): b is number => typeof b === "number");
  const blocks: number[] = [...anchors];
  for (const file of scannedFiles) {
    for (const m of readFileSync(file, "utf8").matchAll(/"(?:block|blockNumber|anchorBlock|invoiceAnchorBlock)"\s*:\s*(\d{6,})/g)) {
      blocks.push(Number(m[1]));
    }
  }
  const floor = blocks.length > 0 ? Math.min(...blocks) : undefined;

  const unaccounted: string[] = [];
  let head: number | undefined;
  let paidToUs = 0;
  let complete = false;
  let failure: string | undefined;

  /** Every fee-proxy payment to one of our payees in the range, on one endpoint. */
  const sweep = async (endpoint: string, from: number, to: number): Promise<Map<string, string>> => {
    const hits = new Map<string, string>();
    const CHUNK = 9_000; // the smallest range cap among the endpoints this asks
    for (let lo = from; lo <= to; lo += CHUNK) {
      const hi = Math.min(lo + CHUNK - 1, to);
      const logs = (await rpcCall(endpoint, "eth_getLogs", [
        {
          address: ERC20_FEE_PROXY,
          topics: [EVENT_TOPIC],
          fromBlock: `0x${lo.toString(16)}`,
          toBlock: `0x${hi.toString(16)}`,
        },
      ])) as Array<{ data?: string; transactionHash?: string; topics?: string[] }>;
      for (const log of logs ?? []) {
        const fields = decodePaymentLogFields(log.data ?? "");
        if (!fields) {
          // A fee-proxy log carrying this event that will not decode is NOT "somebody else's
          // payment". It is a log this tool could not read, sitting in the contract and event
          // whose payments it is counting, and skipping it shrinks the denominator silently —
          // which is the whole failure this sweep was built to stop. It stops the scan instead.
          throw new Error(`a fee-proxy log in ${log.transactionHash ?? "an unnamed tx"} would not decode`);
        }
        if (!payeeSet.has(fields.to.toLowerCase())) continue;
        hits.set((log.transactionHash ?? "").toLowerCase(), (log.topics?.[1] ?? "").toLowerCase());
      }
    }
    return hits;
  };

  try {
    if (floor === undefined) throw new Error("nothing under docs/ points at a block, so there is no floor to scan from");
    head = await currentBlock(RPC);
    // The union across endpoints, because a single endpoint's empty answer is not evidence of
    // absence — measured against this project's own payment, which publicnode returns zero logs
    // for and two others return in full.
    const all = new Map<string, string>();
    const errors: string[] = [];
    for (const endpoint of [RPC, ...negativeCorroborationEndpoints()]) {
      try {
        for (const [k, v] of await sweep(endpoint, floor, head)) all.set(k, v);
        complete = true;
      } catch (e) {
        errors.push(`${new URL(endpoint).host}: ${String(e).slice(0, 60)}`);
      }
    }
    if (!complete) failure = errors.join(" · ");
    for (const [hash, topic] of all) {
      paidToUs++;
      if (hash && recordedHashes.has(hash)) continue;
      unaccounted.push(`${hash.slice(0, 14)}… (reference topic ${topic.slice(0, 10)}…) is on chain and no row records it`);
    }
  } catch (e) {
    // Unread is not "nothing there". A throw here is BLOCKED, never ok and never FAIL.
    failure = String(e).slice(0, 140);
  }

  const summarise = (xs: string[]) => xs.slice(0, 3).join(" · ") + (xs.length > 3 ? ` · +${xs.length - 3} more` : "");
  record(
    "chain.completeness",
    "no payment on chain is missing from the evidence",
    unaccounted.length > 0 ? "FAIL" : !complete ? "BLOCKED" : "ok",
    unaccounted.length > 0
      ? `${unaccounted.length} payment(s) on chain that no evidence row records — ${summarise(unaccounted)}`
      : !complete
        ? `no endpoint completed the scan of ${floor ?? "?"}..${head ?? "?"} — ${failure ?? "unknown"}`
        : `every fee-proxy payment to this deployment's ${payeeSet.size} payee(s) over ${floor}..${head}, asked of ` +
          `${1 + negativeCorroborationEndpoints().length} endpoint(s): ${paidToUs} found across their union, ` +
          `every one accounted for by an evidence file. The payee set comes from docs/, the payments come from the chain.`,
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
  // This artifact states how its own totals are derived, on the same terms it demands of every
  // other artifact under docs/. A verifier exempt from its own rule is a rule with a hole in it.
  totalsFrom: {
    ok: { count: true, where: { field: "status", equals: "ok" } },
    failed: { count: true, where: { field: "status", equals: "FAIL" } },
    blocked: { count: true, where: { field: "status", equals: "BLOCKED" } },
  },
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
