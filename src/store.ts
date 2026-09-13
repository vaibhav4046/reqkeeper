/**
 * Durable state. Six tables, one file, zero dependencies (node:sqlite).
 *
 * Two invariants live here and nowhere else:
 *
 *   1. UNIQUE(obligation_id) is the entire duplicate defence. It outlives KeeperHub's 24h
 *      idempotency replay window, after which the same provider key silently executes again.
 *   2. An attempt row is committed BEFORE any outbound call, in the same transaction as its
 *      job (transactional outbox). A crash after commit resumes the recorded attempt; a crash
 *      before commit leaves no outbound effect at all.
 *
 * ponytail: SQLite is single-writer, so job claiming uses BEGIN IMMEDIATE + a lease column
 * rather than SELECT ... FOR UPDATE SKIP LOCKED. Fencing generations make a lost lease safe
 * regardless. Move to Postgres and swap claimJobs' body if more than one process ever writes.
 */

import { DatabaseSync } from "node:sqlite";
import { canonicalReference } from "./identity.ts";
import { keccak256Hex } from "./keccak.ts";
import type { PaymentExpectation } from "./chain.ts";
import { ReplanError, assertTransition, canReplan, type State } from "./machine.ts";

export type JobKind = "DISPATCH_STEP" | "OBSERVE_PREFLIGHT" | "OBSERVE_EXECUTION" | "RECONCILE_SOURCE";

/**
 * How long the preflight observation waits before it is due.
 *
 * Long enough that an uninterrupted settle has finished and cancelled it, short enough that a
 * process killed inside `simulate` is picked up by the next drain rather than next week.
 */
const PREFLIGHT_OBSERVE_DELAY_MS = 30_000;

export interface Job {
  readonly id: number;
  readonly kind: JobKind;
  readonly obligationId: string;
  readonly attemptId: number | null;
  readonly attempts: number;
  readonly fencingGeneration: number;
}

/**
 * Proof that a caller still owns the job it is writing on behalf of.
 *
 * `completeJob` and `deferJob` already put the generation in their WHERE clause, and that half
 * held under probing. The domain writes did not: `setState`, `enqueue` and `recordOutcome`
 * carried no generation at all, so a worker whose lease expired thirty seconds ago could still
 * rewrite an obligation's state and an attempt's recorded evidence while the live worker owned
 * the job (`hackathon/audit/probes/p2-fencing.ts`: "writes that LANDED despite the stale fence:
 * recordOutcome, enqueue, setState"). Passing a fence makes the ownership check part of the
 * same immediate transaction as the write, so losing the lease means writing nothing.
 *
 * Optional on every method that takes it: the settle path holds no job lease and is correct
 * without one.
 */
export interface Fence {
  readonly jobId: number;
  readonly generation: number;
}

export interface AttemptRow {
  readonly id: number;
  readonly obligationId: string;
  readonly planHash: string;
  readonly stepIndex: number;
  readonly idempotencyKey: string;
  readonly endpoint: string;
  readonly bodyJson: string;
  readonly firstSendAt: number | null;
  readonly outcome: string | null;
  readonly executionId: string | null;
  readonly txHash: string | null;
}

/**
 * Armed on its own, before anything else touches the file.
 *
 * This used to sit in the middle of SCHEMA, after `PRAGMA journal_mode = WAL`. Switching the
 * journal mode takes a brief exclusive lock, so the one statement most likely to collide ran
 * before the timeout that exists to survive a collision. Measured over 50 concurrent opens of
 * a fresh database: 22-29 failures as shipped, 13-16 with the timeout armed first.
 */
const BUSY_TIMEOUT_MS = 5000;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS obligations (
  obligation_id     TEXT PRIMARY KEY,
  namespace         TEXT NOT NULL,
  request_id        TEXT NOT NULL,
  state             TEXT NOT NULL,
  source_facts_json TEXT NOT NULL,
  source_facts_hash TEXT NOT NULL,
  reserved_by_plan  TEXT,
  row_version       INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
-- Belt and braces: PRIMARY KEY already enforces this, but the intent is load-bearing
-- enough to state twice. One canonical Request obligation, one row, forever.
CREATE UNIQUE INDEX IF NOT EXISTS obligations_identity ON obligations (namespace, request_id);

CREATE TABLE IF NOT EXISTS plans (
  plan_hash          TEXT PRIMARY KEY,
  obligation_id      TEXT NOT NULL REFERENCES obligations(obligation_id),
  version            INTEGER NOT NULL,
  policy_hash        TEXT NOT NULL,
  source_facts_hash  TEXT NOT NULL,
  plan_json          TEXT NOT NULL,
  total_debit_base   TEXT NOT NULL,
  expires_at         INTEGER NOT NULL,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_hash     TEXT NOT NULL REFERENCES plans(plan_hash),
  obligation_id TEXT NOT NULL,
  approver      TEXT NOT NULL,
  decision      TEXT NOT NULL,
  restatement   TEXT NOT NULL,
  reason        TEXT,
  decided_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  obligation_id   TEXT NOT NULL REFERENCES obligations(obligation_id),
  plan_hash       TEXT NOT NULL,
  step_index      INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  body_json       TEXT NOT NULL,
  first_send_at   INTEGER,
  outcome         TEXT,
  execution_id    TEXT,
  tx_hash         TEXT,
  created_at      INTEGER NOT NULL
);
-- One attempt per (plan, step). A retry reuses this row and therefore the same key.
CREATE UNIQUE INDEX IF NOT EXISTS attempts_step ON attempts (plan_hash, step_index);

CREATE TABLE IF NOT EXISTS jobs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  kind               TEXT NOT NULL,
  dedupe_key         TEXT NOT NULL UNIQUE,
  obligation_id      TEXT NOT NULL,
  attempt_id         INTEGER,
  status             TEXT NOT NULL DEFAULT 'pending',
  due_at             INTEGER NOT NULL,
  attempts           INTEGER NOT NULL DEFAULT 0,
  lease_expires_at   INTEGER NOT NULL DEFAULT 0,
  fencing_generation INTEGER NOT NULL DEFAULT 0,
  last_error_code    TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (status, due_at);

CREATE TABLE IF NOT EXISTS audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  obligation_id TEXT,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  detail_json   TEXT NOT NULL,
  at            INTEGER NOT NULL,
  -- Each row commits to the one before it. Editing or deleting a row breaks every hash after
  -- it, so a rewritten trail is detectable rather than merely discouraged. This does not make
  -- the trail tamper-PROOF — the same administrator can recompute the whole chain — but it
  -- turns silent edits into loud ones, which is the difference between "trust me" and
  -- "check it".
  prev_hash     TEXT NOT NULL DEFAULT '',
  row_hash      TEXT NOT NULL DEFAULT ''
);
`;

/**
 * Bring an existing database up to the current shape.
 *
 * `CREATE TABLE IF NOT EXISTS` is not a migration: it is a no-op on a table that already
 * exists, whatever columns that table has. The payment reference was added to the schema
 * long after the first live database was created, so on that file the column was never
 * added and the UNIQUE index over it — the entire defence against paying one debt twice
 * under two spellings — was never created either. It failed loudly, which is the lucky
 * case; a slightly different ordering would have left the index quietly absent.
 *
 * Additive only, and idempotent: SQLite cannot drop or retype a column without rebuilding
 * the table, and rebuilding a table that holds payment history is not something to do on
 * process start.
 */
function migrate(db: DatabaseSync): void {
  // The audit chain links each row to the one before it, which catches an edited row and a
  // removed row in the middle. It cannot catch TRUNCATION: delete the last three rows and what
  // remains is a perfectly consistent chain, so the check returned ok. A chain of hashes proves
  // nothing about its own length unless something outside it remembers where the end was.
  db.exec("CREATE TABLE IF NOT EXISTS audit_head (id INTEGER PRIMARY KEY CHECK (id = 1), row_hash TEXT NOT NULL, rows INTEGER NOT NULL)");
  // Backfill the tip for a database whose audit rows predate this table.
  //
  // Without it there is a legitimate state -- rows present, no head -- and `verifyAuditChain` had
  // to tolerate a missing head to avoid failing those databases. Tolerating it is the hole: an
  // attacker who can DELETE audit rows can DELETE FROM audit_head in the same breath, at the same
  // privilege, and the chain then verifies clean over whatever is left. Absence read as "nothing
  // to check" -- the same defect as the duplicate-payment class, pointed at the audit trail.
  //
  // Backfilling removes the legitimate case, so after this a missing head with rows present can
  // only be tampering, and the verifier says so.
  {
    const head = db.prepare("SELECT rows FROM audit_head WHERE id = 1").get() as { rows: number } | undefined;
    if (!head) {
      const tip = db.prepare("SELECT row_hash AS rowHash FROM audit ORDER BY id DESC LIMIT 1").get() as
        | { rowHash: string }
        | undefined;
      const count = (db.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n;
      if (count > 0 && tip) {
        db.prepare("INSERT INTO audit_head (id, row_hash, rows) VALUES (1, ?, ?)").run(tip.rowHash, count);
      }
    }
  }
  const auditColumns = db.prepare("PRAGMA table_info(audit)").all() as Array<{ name: string }>;
  for (const col of ["prev_hash", "row_hash"]) {
    if (!auditColumns.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE audit ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    }
  }

  const columns = db.prepare("PRAGMA table_info(obligations)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "preflight_block")) {
    // The chain head as the dry run was about to be made. A log scan cannot see the mempool, so
    // "no payment anywhere" only means "nothing was broadcast" once the chain has moved past the
    // moment a broadcast could have happened. Rows written before this column existed carry NULL,
    // which reads as "unknown" and keeps the observer inconclusive -- the fail-safe direction.
    db.exec("ALTER TABLE obligations ADD COLUMN preflight_block INTEGER");
  }
  if (!columns.some((c) => c.name === "anchor_block")) {
    // The invoice's storage block, which is the floor that makes a negative conclusive: a payment
    // cannot predate the invoice it pays, so a scan that reaches the anchor has seen every block
    // a payment could be in.
    //
    // It used to live only inside `source_facts_json`, so it could only ever arrive at import.
    // An obligation fed by the watcher from `docs/live-invoices.json` — which carries no anchors —
    // therefore had no floor for ever: every scan came back truncated, the worker correctly
    // refused to conclude from a truncated scan, and the obligation could never be released.
    // Permanently wedged, at zero sends. Learning it later could not help, because the facts are
    // hashed and rewriting them would read as PLAN_CHANGED.
    //
    // Its own column, immutable once set, so it can be learned whenever the gateway is next
    // reachable without touching the approved bytes.
    db.exec("ALTER TABLE obligations ADD COLUMN anchor_block INTEGER");
  }
  if (!columns.some((c) => c.name === "preflight_nonce")) {
    // The payer's mined nonce as the dry run was about to be made. The block above bounds how
    // far the chain has moved; this bounds whether the leak can still be mined at all, which is
    // the question that actually decides whether a second payment is safe. See src/exclusion.ts.
    db.exec("ALTER TABLE obligations ADD COLUMN preflight_nonce INTEGER");
  }
  if (!columns.some((c) => c.name === "payment_reference")) {
    // The debt's real identity. A request id is free text supplied by the caller, so two
    // spellings of one invoice used to mint two obligations and pay it twice. The reference
    // is derived from the invoice by Request and is what the chain actually carries.
    db.exec("ALTER TABLE obligations ADD COLUMN payment_reference TEXT");
  }
  // Existing rows predate canonicalisation, so fold them to one spelling before the unique
  // index is asked to hold. Rows that are not hex are left alone rather than mangled.
  db.exec(
    "UPDATE obligations SET payment_reference = lower(payment_reference) " +
      "WHERE payment_reference IS NOT NULL AND payment_reference GLOB '0x*'",
  );

  // One payment reference is one debt, whatever the caller called it.
  try {
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS obligations_reference ON obligations (payment_reference) " +
        "WHERE payment_reference IS NOT NULL",
    );
  } catch (e) {
    // The index cannot be built because rows already violate it — which means this database
    // already holds two obligations for one debt. That is the exact condition this project
    // exists to prevent, so it is reported as what it is instead of as a SQL error.
    const dupes = db
      .prepare(
        "SELECT payment_reference AS ref, COUNT(*) AS n FROM obligations " +
          "WHERE payment_reference IS NOT NULL GROUP BY payment_reference HAVING n > 1",
      )
      .all() as Array<{ ref: string; n: number }>;
    throw new Error(
      "this database already contains more than one obligation for the same payment reference, " +
        "so the uniqueness constraint cannot be applied: " +
        dupes.map((d) => `${d.ref} x${d.n}`).join(", ") +
        ` (${(e as Error).message})`,
    );
  }
}

/** One row's commitment to every row before it. Order and contents are both covered. */
function auditHash(
  prev: string,
  obligationId: string | null,
  actor: string,
  action: string,
  detailJson: string,
  at: number,
): string {
  return keccak256Hex([prev, obligationId ?? "", actor, action, detailJson, String(at)].join("\u0000"));
}

function staleFence(jobId: number, generation: number): Error {
  const e = new Error(`stale fencing generation for job ${jobId}: held ${generation}`);
  (e as Error & { code?: string }).code = "STALE_FENCE";
  return e;
}

/** Block this thread. A constructor cannot await, and there is nothing else to do meanwhile. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Sized against the race, not against a guess.
 *
 * Six attempts with a 40ms step survived two processes and lost six of ten workers at the
 * concurrency this project actually demonstrates. The backoff is jittered because the failure
 * mode is a thundering herd: every loser waking on the same schedule re-collides with every
 * other loser, so a fixed step converts one collision into a queue of them.
 *
 * Worst case is a little over three seconds of waiting before giving up, which is the right
 * trade for a process whose alternative is dying before it has done anything.
 */
const OPEN_ATTEMPTS = 14;
const OPEN_BACKOFF_MS = 25;

/**
 * Open the database, retrying while another process is mid-open.
 *
 * `PRAGMA busy_timeout` covers a busy database. It does not cover the window that CREATES one:
 * two processes opening the same fresh file race on the schema, and roughly half the time one
 * of them dies on `database is locked` before doing any work. Measured, 25 trials x 2 processes,
 * three runs: 29/50, 23/50, 22/50 failures on a fresh file, still 3-4/50 against an existing
 * one (`hackathon/audit/probes/p6-open-race.ts`). Arming the timeout before the schema roughly
 * halves it and does not remove it, so the underlying cause is NOT just pragma ordering and is
 * recorded as unproven rather than guessed at — a node:sqlite-level trace is what would settle
 * it. What is proven is the symptom and its blast radius: `settle` and `resolve` started
 * together, or two `resolve` runs, sometimes die in the constructor.
 *
 * It fails closed -- the crash is before any work -- but "the exact contention this project is
 * about kills the process" is not a defensible answer, so the open is retried. Only the lock
 * error is retried; a corrupt file or a bad path still throws on the first attempt.
 *
 * Measured on the real constructor, two processes released from one barrier onto a fresh file,
 * 25 trials (hackathon/audit/probes/p7-store-open-race.ts), three runs:
 *
 *   retry disabled   12/50, 15/50, 10/50 failed with "database is locked"
 *   as shipped        0/50,  0/50,  0/50
 */function openWithRetry(path: string): DatabaseSync {
  // The audit probe sets this to measure the unprotected path, so the retry's effect is a
  // measured difference rather than an unfalsifiable claim. Never set in normal operation.
  const attempts = process.env.REQKEEPER_NO_OPEN_RETRY === "1" ? 1 : OPEN_ATTEMPTS;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      // Armed first, on its own, so the statement most likely to collide is already covered.
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
      db.exec(SCHEMA);
      return db;
    } catch (e) {
      try {
        db?.close();
      } catch {
        // Already unusable; the retry opens a fresh handle.
      }
      const message = e instanceof Error ? e.message : String(e);
      if (!/database is locked|SQLITE_BUSY/i.test(message)) throw e;
      lastError = e;
      // Jittered: a fixed step makes every loser wake together and collide again.
      sleepSync(OPEN_BACKOFF_MS * (attempt + 1) + Math.floor(Math.random() * OPEN_BACKOFF_MS * (attempt + 1)));
    }
  }
  throw lastError;
}

export class Store {
  #db: DatabaseSync;

  constructor(path = ":memory:") {
    this.#db = openWithRetry(path);
    migrate(this.#db);
    // The duplicate defence is a UNIQUE index in this file. A corrupted index silently stops
    // being a constraint, so the file is checked at open rather than trusted.
    const integrity = this.#db.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: string }
      | undefined;
    const verdict = integrity?.integrity_check ?? "unknown";
    if (verdict !== "ok") {
      throw new Error(
        `refusing to open a corrupt settlement database (${path}): integrity_check said "${verdict}". ` +
          "The uniqueness constraints that stop a double payment cannot be trusted here.",
      );
    }
  }

  /**
   * Raw SQL, for tests that need to simulate someone with write access to the file.
   * Nothing in src/ calls this; it exists so the tamper-detection test can actually tamper.
   */
  rawExecForTests(sql: string): void {
    this.#db.exec(sql);
  }

  close(): void {
    this.#db.close();
  }

  /** Run fn inside an immediate transaction. Rolls back on throw. */
  tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  audit(obligationId: string | null, actor: string, action: string, detail: unknown, now = Date.now()): void {
    const doAudit = () => {
      const detailJson = JSON.stringify(detail ?? {});
      const tip = this.#db.prepare("SELECT row_hash AS h FROM audit ORDER BY id DESC LIMIT 1").get() as
        | { h: string }
        | undefined;
      const prev = tip?.h ?? "";
      const rowHash = auditHash(prev, obligationId, actor, action, detailJson, now);
      // Written in the same transaction as the row, so the tip cannot disagree with the chain
      // unless somebody edits the database behind the process -- which is exactly the case this
      // is here to catch.
      this.#db
        .prepare(
          "INSERT INTO audit (obligation_id, actor, action, detail_json, at, prev_hash, row_hash) VALUES (?,?,?,?,?,?,?)",
        )
        .run(obligationId, actor, action, detailJson, now, prev, rowHash);
      const count = (this.#db.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n;
      this.#db
        .prepare("INSERT INTO audit_head (id, row_hash, rows) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET row_hash = excluded.row_hash, rows = excluded.rows")
        .run(rowHash, count);
    };

    try {
      this.tx(doAudit);
    } catch (e: unknown) {
      if (e instanceof Error && /cannot start a transaction within a transaction/.test(e.message)) {
        doAudit();
      } else {
        throw e;
      }
    }
  }

  /**
   * The trail as an auditor needs it: who, what, when, and the detail.
   *
   * It used to return only actor and action, so the first question anyone asks of an approval
   * record — who approved this, and when — could not be answered from the surface that shows
   * the trail, even though the approvals table had both.
   */
  auditTrail(obligationId: string): Array<{
    action: string;
    actor: string;
    at: number;
    detail: unknown;
  }> {
    const rows = this.#db
      .prepare(
        "SELECT actor, action, at, detail_json AS detailJson FROM audit WHERE obligation_id = ? ORDER BY id",
      )
      .all(obligationId) as Array<{ actor: string; action: string; at: number; detailJson: string }>;
    return rows.map((r) => {
      let detail: unknown = {};
      try {
        detail = JSON.parse(r.detailJson);
      } catch {
        detail = { unparseable: r.detailJson };
      }
      return { actor: r.actor, action: r.action, at: r.at, detail };
    });
  }

  /**
   * Walk the audit chain and report the first row whose hash does not follow from the one
   * before it. `ok: true` means nothing has been edited or removed since it was written.
   */
  verifyAuditChain(): { ok: boolean; rows: number; brokenAtId?: number; reason?: string } {
    const rows = this.#db
      .prepare(
        "SELECT id, obligation_id AS obligationId, actor, action, detail_json AS detailJson, at, prev_hash AS prevHash, row_hash AS rowHash FROM audit ORDER BY id",
      )
      .all() as Array<{
      id: number;
      obligationId: string | null;
      actor: string;
      action: string;
      detailJson: string;
      at: number;
      prevHash: string;
      rowHash: string;
    }>;

    let expectedPrev = "";
    for (const r of rows) {
      if (r.prevHash !== expectedPrev) {
        return { ok: false, rows: rows.length, brokenAtId: r.id, reason: "a row is missing or was reordered" };
      }
      const recomputed = auditHash(r.prevHash, r.obligationId, r.actor, r.action, r.detailJson, r.at);
      if (recomputed !== r.rowHash) {
        return { ok: false, rows: rows.length, brokenAtId: r.id, reason: "a row's contents were edited" };
      }
      expectedPrev = r.rowHash;
    }

    // The end of the chain, checked against the tip recorded when the last row was written. A
    // hash chain is only evidence of what it still contains: an adversarial pass deleted the last
    // three rows and this returned ok, because every remaining link was intact. Now a truncated
    // log fails on its length and its last hash, and an empty log with a recorded tip fails too.
    const head = this.#db.prepare("SELECT row_hash AS rowHash, rows FROM audit_head WHERE id = 1").get() as
      | { rowHash: string; rows: number }
      | undefined;
    // A missing head with rows present is tampering, not an old database: the migration above
    // backfills the tip, so there is no honest way to have one without the other.
    // Total erasure — every audit row AND the tip — leaves a state that is, inside the audit
    // tables alone, identical to a database that has never been used. There is no link left to
    // break. What gives it away is the rest of the file: an obligation exists only because it was
    // proposed, and proposing writes an audit row, so obligations with an empty log is a
    // contradiction no honest sequence produces.
    //
    // This is a cross-check, not a hash chain, and it is worth being plain about the limit: an
    // attacker with write access who erases both tables and the obligations too leaves nothing to
    // detect in-band. Detecting that needs append-only storage or an external anchor, neither of
    // which this deployment has.
    if (rows.length === 0) {
      const obligations = (this.#db.prepare("SELECT COUNT(*) AS n FROM obligations").get() as { n: number }).n;
      if (obligations > 0) {
        return {
          ok: false,
          rows: 0,
          reason: `the audit log is empty while ${obligations} obligation(s) exist — the log was erased`,
        };
      }
    }
    if (!head && rows.length > 0) {
      return {
        ok: false,
        rows: rows.length,
        reason: "the audit head is missing while rows are present — the tip record was deleted",
      };
    }
    if (head && (head.rowHash !== expectedPrev || head.rows !== rows.length)) {
      return {
        ok: false,
        rows: rows.length,
        reason:
          head.rows !== rows.length
            ? `the log holds ${rows.length} rows and the recorded tip was written at ${head.rows}: rows were removed from the end`
            : "the last row does not match the recorded tip: the end of the log was rewritten",
      };
    }
    return { ok: true, rows: rows.length };
  }

  // ---- obligations -------------------------------------------------------

  /**
   * Idempotent import. A second import of the same canonical obligation returns the existing
   * row rather than creating a rival identity — re-importing is not a way to pay twice.
   */
  importObligation(o: {
    obligationId: string;
    namespace: string;
    requestId: string;
    sourceFactsJson: string;
    sourceFactsHash: string;
    paymentReference?: string | null;
    now?: number;
  }): { created: boolean; state: string } {
    const now = o.now ?? Date.now();
    const existing = this.getObligation(o.obligationId);
    if (existing) {
      // An early return here used to mean a row imported once WITHOUT a reference kept that NULL
      // for life. The global uniqueness index is partial -- `WHERE payment_reference IS NOT NULL`
      // -- and the cross-namespace lookup matches on equality, so a NULL row is invisible to both:
      // the same debt could be imported again under a second obligation id and paid twice, with
      // the one index built to stop it looking straight through the row. Back-filling is safe in
      // the only direction that matters, NULL to a value, and the UNIQUE index still refuses a
      // value that belongs to another obligation.
      const storedReference = this.#db
        .prepare("SELECT payment_reference AS ref FROM obligations WHERE obligation_id = ?")
        .get(o.obligationId) as { ref: string | null } | undefined;
      if (storedReference?.ref == null && o.paymentReference != null) {
        this.#db
          .prepare("UPDATE obligations SET payment_reference = ?, updated_at = ? WHERE obligation_id = ? AND payment_reference IS NULL")
          .run(canonicalReference(o.paymentReference), now, o.obligationId);
      }
      // The anchor is back-filled on re-import for the same reason the reference is: a row that
      // was first created without one would otherwise never get a floor, and every scan for it
      // stays truncated for ever.
      this.#seedAnchorFromFacts(o.obligationId, o.sourceFactsJson, now);
      return { created: false, state: existing.state };
    }
    this.#db
      .prepare(
        `INSERT INTO obligations
           (obligation_id, namespace, request_id, state, source_facts_json, source_facts_hash, payment_reference, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        o.obligationId,
        o.namespace,
        o.requestId,
        "IMPORTED",
        o.sourceFactsJson,
        o.sourceFactsHash,
        o.paymentReference === undefined || o.paymentReference === null
          ? null
          : canonicalReference(o.paymentReference),
        now,
        now,
      );
    this.#seedAnchorFromFacts(o.obligationId, o.sourceFactsJson, now);
    return { created: true, state: "IMPORTED" };
  }

  getObligation(obligationId: string):
    | { obligationId: string; state: string; reservedByPlan: string | null; rowVersion: number; sourceFactsHash: string }
    | undefined {
    const r = this.#db
      .prepare(
        `SELECT obligation_id AS obligationId, state, reserved_by_plan AS reservedByPlan,
                row_version AS rowVersion, source_facts_hash AS sourceFactsHash
           FROM obligations WHERE obligation_id = ?`,
      )
      .get(obligationId) as
      | { obligationId: string; state: string; reservedByPlan: string | null; rowVersion: number; sourceFactsHash: string }
      | undefined;
    return r;
  }

  /**
   * The obligation already holding this payment reference, if any.
   *
   * The duplicate defence used to key on the request id, which the caller supplies as free
   * text. Two spellings of one invoice were two obligations and two payments of the same
   * debt. The reference is derived from the invoice, so this is the question worth asking.
   */
  obligationForReference(paymentReference: string): { obligationId: string; state: string } | undefined {
    return this.#db
      .prepare(
        "SELECT obligation_id AS obligationId, state FROM obligations WHERE payment_reference = ?",
      )
      .get(canonicalReference(paymentReference)) as { obligationId: string; state: string } | undefined;
  }

  /**
   * The ONLY way a state is written, and the only place the machine is enforced.
   *
   * It used to be an unchecked UPDATE, with `assertTransition` called once, by hand, at a
   * single call site — so the table in machine.ts documented a machine that nothing ran.
   * Reading the current state and checking the edge inside one transaction is what makes it
   * real: an impossible move now throws instead of quietly overwriting a row that says money
   * moved. Writing the same state twice is a no-op, so a retry is not an illegal move.
   */
  setState(obligationId: string, state: State, now = Date.now(), fence?: Fence): void {
    this.tx(() => {
      if (fence) this.#assertFencingInTx(fence);
      this.#setStateInTx(obligationId, state, now);
    });
  }

  /** The body of setState, for callers that are already inside a transaction. */
  #setStateInTx(obligationId: string, state: State, now: number): void {
    const row = this.#db
      .prepare("SELECT state FROM obligations WHERE obligation_id = ?")
      .get(obligationId) as { state: State } | undefined;
    if (!row) throw new Error(`unknown obligation ${obligationId}`);
    if (row.state === state) return;
    assertTransition(row.state, state);
    this.#db
      .prepare("UPDATE obligations SET state = ?, row_version = row_version + 1, updated_at = ? WHERE obligation_id = ?")
      .run(state, now, obligationId);
  }

  /**
   * Enter PAYMENT_PREFLIGHT and, in the same transaction, leave something behind that will come
   * looking if this process never comes back.
   *
   * The attempt row — the outbox entry that makes every other risky step recoverable — is not
   * written until AFTER the simulation, because the attempt means "intent to send" and nothing
   * is being sent yet. That left one uncovered window, and a crash inside `simulate` fell into
   * it: state PAYMENT_PREFLIGHT, no attempt, no job, and PAYMENT_PREFLIGHT is deliberately not
   * replannable, so the invoice could never be paid by this system again. Zero sends and zero
   * ways forward.
   *
   * The fix is not to make PAYMENT_PREFLIGHT replannable — a simulate can time out, and a
   * timed-out dry run may have executed for real (#1959), so assuming nothing happened is
   * exactly the assumption this project exists to refuse. The fix is to resolve the uncertainty
   * the way every other uncertainty here is resolved: by looking at the chain. This job is that
   * look, and it is committed before the risky call, which is the same discipline `openAttempt`
   * applies one step later.
   */
  beginPreflight(
    obligationId: string,
    planHash: string,
    now = Date.now(),
    preflightBlock?: number,
    preflightNonce?: number,
  ): void {
    this.tx(() => {
      // The chain head as the risky call was about to be made. `eth_getLogs` cannot see the
      // mempool, so a scan that covers every block and finds nothing is NOT evidence that
      // nothing was broadcast -- a transaction sent a moment ago is simply not in a block yet.
      // Absence becomes evidence only once enough chain has passed since the send could have
      // happened, and this is the block that "since" is measured from. Stored here because it
      // has to be captured before the call, in the same transaction as the state and the job.
      //
      // Written UNCONDITIONALLY, including as NULL. Guarding this on `!== undefined` was a
      // duplicate-payment path: an obligation that preflighted once at a high block and later
      // preflighted again when the head read failed kept the FIRST preflight's block. A stale
      // block is always low enough that the age gate opens immediately, so "we could not read
      // the head, so the observer stays inconclusive" was true only for an obligation's very
      // first preflight. Every retry after a failed head read released on a number that
      // described a different attempt.
      //
      // `preflight_nonce` is written on the same terms and for the same reason. It is the payer's
      // mined nonce before the risky call: a transaction the dry run broadcasts is bound to that
      // nonce, and once some other transaction is mined at it the leak can never be included by
      // any node. That is what makes a negative conclusive, rather than the passage of time.
      this.#db
        .prepare("UPDATE obligations SET preflight_block = ?, preflight_nonce = ? WHERE obligation_id = ?")
        .run(preflightBlock ?? null, preflightNonce ?? null, obligationId);
      this.#setStateInTx(obligationId, "PAYMENT_PREFLIGHT", now);
      // The dedupe key carries `now` as well as the plan hash. Keyed on the plan hash alone, a
      // SECOND preflight of the same plan -- which is what a retry after a failed dry run is --
      // collided with the first job's key and `INSERT OR IGNORE` silently dropped it. The
      // obligation then sat in PAYMENT_PREFLIGHT with nothing queued to ever look at the chain,
      // and nothing to release it: wedged permanently at zero sends. The first job is long since
      // done; what has to be deduped is two observations of the SAME attempt, not two attempts.
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO jobs (kind, dedupe_key, obligation_id, attempt_id, due_at, created_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run("OBSERVE_PREFLIGHT", `preflight:${planHash}:${now}`, obligationId, null, now + PREFLIGHT_OBSERVE_DELAY_MS, now);
    });
  }

  /**
   * Cancel the preflight observation: the question it exists to answer has been answered.
   *
   * Called when the settlement got past the simulation under its own power — either it opened
   * an attempt, or it refused conclusively. Only the crash leaves the job behind, which is the
   * point: on an uninterrupted run the outbox does not accumulate work nobody needs.
   */
  endPreflight(planHash: string): void {
    // Matched on the plan-hash PREFIX, because the key now also carries the timestamp of the
    // preflight it belongs to -- two preflights of the same plan are two attempts and each needs
    // its own observation. Closing by prefix retires every observation for this plan, which is
    // what "the dry run answered, stop looking" means.
    this.#db
      .prepare("UPDATE jobs SET status = 'done', lease_expires_at = 0 WHERE dedupe_key LIKE ? AND status = 'pending'")
      .run(`preflight:${planHash}%`);
  }

  /**
   * Start a fresh settlement over an existing debt.
   *
   * Deliberately not a transition: a refusal stays closed, and this opens a new attempt
   * beside it. Refused for anything past the point of no return, which is what stops a
   * re-proposal from dragging a live or finished payment back to the start.
   */
  replan(obligationId: string, now = Date.now()): void {
    this.tx(() => {
      const row = this.#db
        .prepare("SELECT state FROM obligations WHERE obligation_id = ?")
        .get(obligationId) as { state: State } | undefined;
      if (!row) throw new Error(`unknown obligation ${obligationId}`);
      if (!canReplan(row.state)) throw new ReplanError(row.state);
      if (row.state === "VALIDATING") return;
      this.#db
        .prepare(
          "UPDATE obligations SET state = 'VALIDATING', row_version = row_version + 1, updated_at = ? WHERE obligation_id = ?",
        )
        .run(now, obligationId);
    });
  }

  /**
   * Everything a resolver needs to finish a settlement it did not start.
   *
   * The invoice amount comes along because reconciliation has to check it. A resolver that
   * only matches the reference and the transaction hash will accept a payment of the wrong
   * size as proof, which is the same class of mistake as accepting another transaction.
   */
  obligationForRecovery(obligationId: string):
    | {
        obligationId: string;
        requestId: string;
        state: State;
        paymentReference: string | null;
        invoiceBaseUnits: string | null;
        /**
         * What paying this obligation looks like on chain, recovered from the facts that were
         * stored when it was imported. The recovery path needs this: matching a fee-proxy log
         * on its reference alone accepts a stranger's transaction as settlement, and the
         * recovery path is exactly where nobody is watching.
         */
        expectation: PaymentExpectation | null;
        /** The invoice's anchor block, when it was known at import. See SourceFacts.anchorBlock. */
        anchorBlock: number | null;
        /** The chain head as the dry run was about to run. See beginPreflight. */
        preflightBlock: number | null;
        /** The payer's mined nonce at the same moment. See src/exclusion.ts. */
        preflightNonce: number | null;
      }
    | undefined {
    const row = this.#db
      .prepare(
        `SELECT obligation_id AS obligationId, request_id AS requestId, state,
                payment_reference AS paymentReference, source_facts_json AS factsJson,
                preflight_block AS preflightBlock,
                preflight_nonce AS preflightNonce,
                anchor_block AS anchorBlockColumn
           FROM obligations WHERE obligation_id = ?`,
      )
      .get(obligationId) as
      | {
          obligationId: string;
          requestId: string;
          state: State;
          paymentReference: string | null;
          factsJson: string;
          preflightBlock: number | null;
          preflightNonce: number | null;
          anchorBlockColumn: number | null;
        }
      | undefined;
    if (!row) return undefined;
    let invoiceBaseUnits: string | null = null;
    let expectation: PaymentExpectation | null = null;
    let anchorBlock: number | null = null;
    try {
      const parsed = JSON.parse(row.factsJson) as {
        invoiceBaseUnits?: string;
        payee?: string;
        tokenAddress?: string;
        feeBaseUnits?: string;
        feeRecipient?: string;
        anchorBlock?: number;
      };
      invoiceBaseUnits = parsed.invoiceBaseUnits ?? null;
      anchorBlock = typeof parsed.anchorBlock === "number" ? parsed.anchorBlock : null;
      // The column wins when it is set: it is the one that can be learned after import.
      // Only when every load-bearing field is present. A partial expectation is worse than
      // none: it reads as a full check while silently skipping the field that was missing.
      if (parsed.invoiceBaseUnits && parsed.payee && parsed.tokenAddress) {
        expectation = {
          tokenAddress: parsed.tokenAddress,
          to: parsed.payee,
          amount: parsed.invoiceBaseUnits,
          feeAmount: parsed.feeBaseUnits,
          feeAddress: parsed.feeRecipient,
        };
      }
    } catch {
      invoiceBaseUnits = null;
    }
    return {
      obligationId: row.obligationId,
      requestId: row.requestId,
      state: row.state,
      paymentReference: row.paymentReference,
      invoiceBaseUnits,
      expectation,
      // The column wins when set: it is the one that can be learned after import, and facts
      // can only ever carry what was known when the obligation was created.
      anchorBlock: typeof row.anchorBlockColumn === "number" ? row.anchorBlockColumn : anchorBlock,
      preflightBlock: typeof row.preflightBlock === "number" ? row.preflightBlock : null,
      preflightNonce: typeof row.preflightNonce === "number" ? row.preflightNonce : null,
    };
  }

  /**
   * Claim exclusive settlement ownership for one plan.
   *
   * The first caller wins. A second caller gets `conflict` and the winning plan hash — never
   * the ability to steal it, and never another workspace's invoice data.
   */
  reserveObligation(obligationId: string, planHash: string): { ok: true } | { ok: false; heldBy: string } {
    return this.tx(() => {
      const row = this.#db
        .prepare("SELECT reserved_by_plan AS held FROM obligations WHERE obligation_id = ?")
        .get(obligationId) as { held: string | null } | undefined;
      if (!row) throw new Error(`unknown obligation ${obligationId}`);
      if (row.held !== null && row.held !== planHash) return { ok: false as const, heldBy: row.held };
      if (row.held === planHash) return { ok: true as const };
      this.#db
        .prepare("UPDATE obligations SET reserved_by_plan = ?, row_version = row_version + 1 WHERE obligation_id = ?")
        .run(planHash, obligationId);
      return { ok: true as const };
    });
  }

  /**
   * Give the reservation back.
   *
   * Without this one bad proposal bricks an invoice forever: the plan is refused, the debt is
   * still owed, and no other plan can ever claim it. Only the holder may release, and only
   * while nothing has been dispatched — releasing a live payment's claim would re-open the
   * door this whole project exists to shut.
   */
  releaseObligation(obligationId: string, planHash: string): { released: boolean; reason?: string } {
    return this.tx(() => {
      const row = this.#db
        .prepare("SELECT reserved_by_plan AS held, state FROM obligations WHERE obligation_id = ?")
        .get(obligationId) as { held: string | null; state: State } | undefined;
      if (!row) throw new Error(`unknown obligation ${obligationId}`);
      if (row.held === null) return { released: false, reason: "not reserved" };
      if (row.held !== planHash) return { released: false, reason: "held by another plan" };
      if (!canReplan(row.state)) return { released: false, reason: `already dispatched (${row.state})` };
      const dispatched = this.#db
        .prepare("SELECT COUNT(*) AS n FROM attempts WHERE plan_hash = ? AND first_send_at IS NOT NULL")
        .get(planHash) as { n: number };
      if (Number(dispatched.n) > 0) return { released: false, reason: "plan has a dispatched attempt" };
      this.#db
        .prepare("UPDATE obligations SET reserved_by_plan = NULL, row_version = row_version + 1 WHERE obligation_id = ?")
        .run(obligationId);
      return { released: true };
    });
  }

  // ---- plans and approvals ----------------------------------------------

  /**
   * Record the invoice's anchor block, once.
   *
   * First non-null wins. An anchor is a fact about an invoice that was written to a chain, so it
   * does not change; a later read that disagrees is evidence that this is a different invoice, and
   * silently overwriting it would move the floor a conclusion was already drawn against. The
   * disagreement is audited and the stored value kept.
   */
  /** Seed the anchor column from the facts an obligation was created with, when they carry one. */
  #seedAnchorFromFacts(obligationId: string, sourceFactsJson: string, now: number): void {
    try {
      const parsed = JSON.parse(sourceFactsJson) as { anchorBlock?: number };
      if (typeof parsed.anchorBlock === "number") this.learnAnchor(obligationId, parsed.anchorBlock, now);
    } catch {
      // Facts that will not parse are somebody else's problem; there is simply no anchor here.
    }
  }

  learnAnchor(obligationId: string, anchorBlock: number, now = Date.now()): void {
    if (!Number.isInteger(anchorBlock) || anchorBlock <= 0) return;
    const row = this.#db
      .prepare("SELECT anchor_block AS anchorBlock FROM obligations WHERE obligation_id = ?")
      .get(obligationId) as { anchorBlock: number | null } | undefined;
    if (!row) return;
    if (row.anchorBlock === null) {
      this.#db
        .prepare("UPDATE obligations SET anchor_block = ? WHERE obligation_id = ? AND anchor_block IS NULL")
        .run(anchorBlock, obligationId);
      return;
    }
    if (row.anchorBlock !== anchorBlock) {
      this.audit(obligationId, "system", "ANCHOR_DISAGREES", { stored: row.anchorBlock, offered: anchorBlock }, now);
    }
  }

  savePlan(p: {
    planHash: string;
    obligationId: string;
    version: number;
    policyHash: string;
    sourceFactsHash: string;
    planJson: string;
    totalDebitBaseUnits: string;
    expiresAt: number;
    now?: number;
  }): void {
    this.#db
      .prepare(
        // The plan's BYTES are immutable and keyed by their own hash, so re-proposing an
        // identical plan must not rewrite them. Its expiry is not part of the bytes: it is how
        // long *this proposal* stays dispatchable, and `INSERT OR IGNORE` froze it at the first
        // proposal's value. A plan hash is deterministic, so a debt proposed again after its TTL
        // got the same row back with the same expired timestamp and refused as PLAN_EXPIRED for
        // ever — permanently unpayable, with no way out short of changing the invoice.
        //
        // Refreshing the window is only safe because the authority to spend does not live here.
        // It lives on the approval's `decided_at`, which settle checks separately, so a restarted
        // proposal window cannot resurrect a stale human decision.
        `INSERT INTO plans
           (plan_hash, obligation_id, version, policy_hash, source_facts_hash, plan_json, total_debit_base, expires_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(plan_hash) DO UPDATE SET expires_at = excluded.expires_at`,
      )
      .run(
        p.planHash, p.obligationId, p.version, p.policyHash, p.sourceFactsHash,
        p.planJson, p.totalDebitBaseUnits, p.expiresAt, p.now ?? Date.now(),
      );
  }

  getPlan(planHash: string): { planHash: string; obligationId: string; expiresAt: number; sourceFactsHash: string } | undefined {
    return this.#db
      .prepare(
        `SELECT plan_hash AS planHash, obligation_id AS obligationId, expires_at AS expiresAt,
                source_facts_hash AS sourceFactsHash FROM plans WHERE plan_hash = ?`,
      )
      .get(planHash) as { planHash: string; obligationId: string; expiresAt: number; sourceFactsHash: string } | undefined;
  }

  recordApproval(a: {
    planHash: string;
    obligationId: string;
    approver: string;
    decision: "APPROVED" | "REJECTED";
    restatement: string;
    reason?: string;
    /** When the human decided. A replay passes the original, never the current time. */
    now?: number;
  }): void {
    const at = a.now ?? Date.now();
    this.#db
      .prepare(
        `INSERT INTO approvals (plan_hash, obligation_id, approver, decision, restatement, reason, decided_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(a.planHash, a.obligationId, a.approver, a.decision, a.restatement, a.reason ?? null, at);
    // The decision belongs in the trail too. It used to be written only by the CLI, so an
    // approval recorded any other way left no "who approved this" row at all.
    this.audit(
      a.obligationId,
      a.approver,
      a.decision === "APPROVED" ? "HUMAN_APPROVED" : "HUMAN_REJECTED",
      { planHash: a.planHash, reason: a.reason ?? null },
      at,
    );
  }

  /**
   * Distinct humans who have approved this exact plan.
   *
   * One approver is the default, and for a single operator that is the honest arrangement.
   * Where a workspace wants two pairs of eyes, the count is what a quorum is checked against
   * — and it counts DISTINCT approvers, so one person approving twice is still one person.
   */
  approversFor(planHash: string): string[] {
    const rows = this.#db
      .prepare(
        "SELECT DISTINCT lower(approver) AS approver FROM approvals WHERE plan_hash = ? AND decision = 'APPROVED' ORDER BY approver",
      )
      .all(planHash) as Array<{ approver: string }>;
    return rows.map((r) => r.approver);
  }

  getApproval(
    planHash: string,
  ): { decision: string; approver: string; restatement: string; decidedAt: number } | undefined {
    // `decidedAt` travels with the decision because the decision is the thing that goes stale.
    // A human approved these bytes at a moment; how long that authorises a payment is a property
    // of the decision, not of the bytes, which are the same bytes for ever.
    return this.#db
      .prepare(
        "SELECT decision, approver, restatement, decided_at AS decidedAt FROM approvals WHERE plan_hash = ? ORDER BY id DESC LIMIT 1",
      )
      .get(planHash) as
      | { decision: string; approver: string; restatement: string; decidedAt: number }
      | undefined;
  }

  // ---- attempts and the outbox ------------------------------------------

  /**
   * Persist an attempt and its job in ONE transaction, before anything is sent.
   *
   * This commit is the local authority boundary. Returning here means the intent to send is
   * durable; a crash now is recoverable by observation. Returning the same attempt id for a
   * (plan, step) already present is deliberate: a retry must reuse the row, and therefore the
   * same idempotency key.
   */
  openAttempt(a: {
    obligationId: string;
    planHash: string;
    stepIndex: number;
    idempotencyKey: string;
    endpoint: string;
    bodyJson: string;
    now?: number;
  }): { attemptId: number; reused: boolean; idempotencyKey: string } {
    const now = a.now ?? Date.now();
    return this.tx(() => {
      const existing = this.#db
        .prepare("SELECT id FROM attempts WHERE plan_hash = ? AND step_index = ?")
        .get(a.planHash, a.stepIndex) as { id: number } | undefined;
      if (existing) {
        // The key the row was OPENED with, not the one this call minted. They are equal today
        // because the derivation is a function of (plan_hash, step_index) — but `provider.ts`
        // states the contract as "must come from the persisted attempt, never minted at call
        // time", and the day the key's version string changes, a reused row would be sent under a
        // new key while recording the old one. Two keys, one attempt, and the provider's
        // idempotency cache indexed under neither.
        const stored = this.#db
          .prepare("SELECT idempotency_key AS k FROM attempts WHERE id = ?")
          .get(existing.id) as { k: string } | undefined;
        return { attemptId: existing.id, reused: true, idempotencyKey: stored?.k ?? a.idempotencyKey };
      }

      this.#db
        .prepare(
          `INSERT INTO attempts
             (obligation_id, plan_hash, step_index, idempotency_key, endpoint, body_json, created_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(a.obligationId, a.planHash, a.stepIndex, a.idempotencyKey, a.endpoint, a.bodyJson, now);
      const attemptId = Number(
        (this.#db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id,
      );

      // Transactional outbox: the job cannot be lost relative to the attempt.
      this.#db
        .prepare(
          `INSERT INTO jobs (kind, dedupe_key, obligation_id, attempt_id, due_at, created_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run("DISPATCH_STEP", `dispatch:${a.planHash}:${a.stepIndex}`, a.obligationId, attemptId, now, now);

      // The attempt supersedes the preflight observation: from here the dispatch job is the
      // thing that comes looking. Same transaction, so the hand-off cannot be interrupted.
      this.#db
        .prepare("UPDATE jobs SET status = 'done', lease_expires_at = 0 WHERE dedupe_key LIKE ? AND status = 'pending'")
        .run(`preflight:${a.planHash}%`);

      return { attemptId, reused: false, idempotencyKey: a.idempotencyKey };
    });
  }

  getAttempt(attemptId: number): AttemptRow | undefined {
    return this.#db
      .prepare(
        `SELECT id, obligation_id AS obligationId, plan_hash AS planHash, step_index AS stepIndex,
                idempotency_key AS idempotencyKey, endpoint, body_json AS bodyJson,
                first_send_at AS firstSendAt, outcome, execution_id AS executionId, tx_hash AS txHash
           FROM attempts WHERE id = ?`,
      )
      .get(attemptId) as AttemptRow | undefined;
  }

  /**
   * Claim the right to send this attempt, exactly once. Returns true only to the caller that
   * actually stamped it.
   *
   * This is a compare-and-set, not a stamp. The previous form —
   * `SET first_send_at = COALESCE(first_send_at, ?)` — kept the first value, so the column was
   * right, but it always reported success and so decided nothing. The caller's real gate was
   * `getAttempt(...).firstSendAt === null` followed, in a separate statement, by this write.
   * Two processes both read null, both passed, and what stopped the second send was that Node
   * runs the read and the write with no `await` between them while SQLite serialises writers —
   * an accident of the runtime, not a property of the schema. A red-team probe drove both
   * callers past that guard (`hackathon/audit/probes/p1-race.ts`, "both callers passed the
   * guard: true"). Put the condition in the WHERE clause and losing the race means writing
   * nothing and being told so.
   */
  markSent(attemptId: number, now = Date.now()): boolean {
    const info = this.#db
      .prepare("UPDATE attempts SET first_send_at = ? WHERE id = ? AND first_send_at IS NULL")
      .run(now, attemptId);
    return Number(info.changes) === 1;
  }

  /**
   * The outcome of an attempt may be refined — SENT becomes CONFIRMED — but the identifiers
   * that make it evidence may not.
   *
   * `COALESCE(?, tx_hash)` was the wrong way round: it only declined to write NULL over a
   * value, so any non-null hash overwrote the recorded one. A late or stale writer could
   * therefore replace the transaction a settled obligation points at, which turns the audit
   * trail into something last-write-wins. `COALESCE(tx_hash, ?)` is write-once: the first
   * hash recorded is the one that stands, and a second, different hash is ignored rather
   * than believed.
   *
   * Recording a SENT outcome also enqueues the observation that closes the loop, in the same
   * transaction. That is here rather than at the call sites because leaving it to callers is
   * what stranded real payments: the settle path enqueued OBSERVE_EXECUTION on its failure
   * branches only, so a crash after the provider answered — between the receipt read and
   * reconciliation — left the obligation at CHAIN_PENDING with the dispatch job already
   * complete and an EMPTY outbox. Money moved, nothing was looking, and `resolve` only drains
   * jobs that exist. Two of the six crash checkpoints ended that way. One enqueue beside the
   * write that records the send closes all of them, for every caller, including future ones.
   *
   * The trigger is "a transaction may exist on chain", not the literal outcome SENT: a
   * provider `failed` carries a transaction hash whenever the transaction reached the chain,
   * and a reverted payment still needs a receipt read before anyone says what happened.
   */
  recordOutcome(
    attemptId: number,
    o: { outcome: string; executionId?: string; txHash?: string; now?: number; fence?: Fence },
  ): void {
    const now = o.now ?? Date.now();
    this.tx(() => {
      if (o.fence) this.#assertFencingInTx(o.fence);
      this.#db
        .prepare("UPDATE attempts SET outcome = ?, execution_id = COALESCE(execution_id, ?), tx_hash = COALESCE(tx_hash, ?) WHERE id = ?")
        .run(o.outcome, o.executionId ?? null, o.txHash ?? null, attemptId);
      const a = this.#db
        .prepare(
          "SELECT obligation_id AS obligationId, plan_hash AS planHash, step_index AS stepIndex, first_send_at AS firstSendAt FROM attempts WHERE id = ?",
        )
        .get(attemptId) as
        | { obligationId: string; planHash: string; stepIndex: number; firstSendAt: number | null }
        | undefined;
      if (!a) return;

      // What decides whether anything has to be observed is whether a WRITE WAS ISSUED, not
      // whether the provider handed back a hash.
      //
      // This read `if (o.outcome !== "SENT" && !o.txHash) return;`, so a `{"success": false}`
      // reply carrying no hash queued nothing at all — while `markSent` had already stamped
      // `first_send_at` before the call, because the money may well have moved. The obligation
      // was left in EXECUTION_OUTCOME_UNKNOWN with an empty outbox: no job, no observation,
      // nothing that would ever look at the chain. Safe, and never recovered, which is the
      // liveness half of the same defect the send path keeps producing.
      //
      // A provider's "failed" is not evidence either. It is the provider reporting on itself,
      // and the chain is the only thing that knows. An attempt with no hash is still findable —
      // the worker looks it up by payment reference, which is exactly the identifier that
      // survives a lost reply.
      if (o.outcome !== "SENT" && !o.txHash && a.firstSendAt === null) return;
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO jobs (kind, dedupe_key, obligation_id, attempt_id, due_at, created_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run("OBSERVE_EXECUTION", `observe:${a.planHash}:${a.stepIndex}`, a.obligationId, attemptId, now, now);
    });
  }

  // ---- jobs --------------------------------------------------------------

  enqueue(j: {
    kind: JobKind;
    dedupeKey: string;
    obligationId: string;
    attemptId?: number;
    dueAt: number;
    now?: number;
    fence?: Fence;
  }): boolean {
    return this.tx(() => {
      if (j.fence) this.#assertFencingInTx(j.fence);
      const info = this.#db
        .prepare(
          `INSERT OR IGNORE INTO jobs (kind, dedupe_key, obligation_id, attempt_id, due_at, created_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(j.kind, j.dedupeKey, j.obligationId, j.attemptId ?? null, j.dueAt, j.now ?? Date.now());
      return Number(info.changes) > 0;
    });
  }

  /**
   * Claim due jobs and bump their fencing generation.
   *
   * A worker that loses its lease is still safe: the generation it holds is stale, so its
   * writes are rejected by assertFencing. Fencing protects local state. It cannot cancel an
   * HTTP request already in flight — that is what the immutable attempt row and the
   * provider's idempotency key are for.
   */
  claimJobs(opts: { limit: number; now: number; leaseMs: number; dueBy?: number }): Job[] {
    // `dueBy` separates "what is ready" from "what time it is". The retry backoff exists to
    // stop a timer hammering an RPC; it is not a safety property, so an operator asking
    // explicitly may look ahead of it. Leases and deferrals still run on the real clock.
    const dueBy = opts.dueBy ?? opts.now;
    return this.tx(() => {
      const rows = this.#db
        .prepare(
          `SELECT id FROM jobs
            WHERE status = 'pending' AND due_at <= ? AND lease_expires_at <= ?
            ORDER BY due_at LIMIT ?`,
        )
        .all(dueBy, opts.now, opts.limit) as Array<{ id: number }>;

      const claimed: Job[] = [];
      for (const { id } of rows) {
        this.#db
          .prepare(
            `UPDATE jobs
                SET lease_expires_at = ?, fencing_generation = fencing_generation + 1, attempts = attempts + 1
              WHERE id = ?`,
          )
          .run(opts.now + opts.leaseMs, id);
        claimed.push(
          this.#db
            .prepare(
              `SELECT id, kind, obligation_id AS obligationId, attempt_id AS attemptId,
                      attempts, fencing_generation AS fencingGeneration
                 FROM jobs WHERE id = ?`,
            )
            .get(id) as unknown as Job,
        );
      }
      return claimed;
    });
  }

  /**
   * The same check as `assertFencing`, for use INSIDE an already-open immediate transaction.
   *
   * `assertFencing` followed by a write is two statements and therefore a race. Called from
   * inside `tx()` the read and the write share one BEGIN IMMEDIATE, so a generation bumped by
   * another claimer between them is impossible.
   */
  #assertFencingInTx(fence: Fence): void {
    const row = this.#db
      .prepare("SELECT fencing_generation AS g FROM jobs WHERE id = ?")
      .get(fence.jobId) as { g: number } | undefined;
    if (!row) throw new Error(`unknown job ${fence.jobId}`);
    if (row.g !== fence.generation) throw staleFence(fence.jobId, fence.generation);
  }

  /** Throws if the caller's fencing generation is stale — it lost the lease mid-flight. */
  assertFencing(jobId: number, generation: number): void {
    const row = this.#db
      .prepare("SELECT fencing_generation AS g FROM jobs WHERE id = ?")
      .get(jobId) as { g: number } | undefined;
    if (!row) throw new Error(`unknown job ${jobId}`);
    if (row.g !== generation) {
      const e = new Error(`stale fencing generation for job ${jobId}: held ${generation}, current ${row.g}`);
      (e as Error & { code?: string }).code = "STALE_FENCE";
      throw e;
    }
  }

  /**
   * Fencing is a condition of the write, not a check beside it.
   *
   * `assertFencing` then `completeJob` is two statements: a worker can pass the check, lose
   * its lease, and still complete a job another worker now owns. Putting the generation in
   * the WHERE clause makes losing the race mean writing nothing at all.
   */
  completeJob(jobId: number, generation: number): void {
    const info = this.#db
      .prepare("UPDATE jobs SET status = 'done', lease_expires_at = 0 WHERE id = ? AND fencing_generation = ?")
      .run(jobId, generation);
    if (Number(info.changes) === 0) throw staleFence(jobId, generation);
  }

  deferJob(jobId: number, dueAt: number, errorCode: string, generation: number): void {
    const info = this.#db
      .prepare(
        "UPDATE jobs SET due_at = ?, lease_expires_at = 0, last_error_code = ? WHERE id = ? AND fencing_generation = ?",
      )
      .run(dueAt, errorCode, jobId, generation);
    if (Number(info.changes) === 0) throw staleFence(jobId, generation);
  }

  /** The attempt that actually went out for an obligation, if one did. */
  sentAttemptFor(obligationId: string): AttemptRow | undefined {
    return this.#db
      .prepare(
        `SELECT id, obligation_id AS obligationId, plan_hash AS planHash, step_index AS stepIndex,
                idempotency_key AS idempotencyKey, endpoint, body_json AS bodyJson,
                first_send_at AS firstSendAt, outcome, execution_id AS executionId, tx_hash AS txHash
           FROM attempts WHERE obligation_id = ? AND first_send_at IS NOT NULL
           ORDER BY id DESC LIMIT 1`,
      )
      .get(obligationId) as AttemptRow | undefined;
  }

  /** What kinds of work are still owed. Useful for diagnostics and for asserting on an outbox. */
  pendingJobKinds(): JobKind[] {
    return (
      this.#db.prepare("SELECT kind FROM jobs WHERE status = 'pending' ORDER BY id").all() as Array<{ kind: JobKind }>
    ).map((r) => r.kind);
  }

  pendingJobCount(): number {
    return Number(
      (this.#db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'").get() as { n: number }).n,
    );
  }
}
