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
import { ReplanError, assertTransition, canReplan, type State } from "./machine.ts";

export type JobKind = "DISPATCH_STEP" | "OBSERVE_EXECUTION" | "RECONCILE_SOURCE";

export interface Job {
  readonly id: number;
  readonly kind: JobKind;
  readonly obligationId: string;
  readonly attemptId: number | null;
  readonly attempts: number;
  readonly fencingGeneration: number;
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

const SCHEMA = `
PRAGMA journal_mode = WAL;
     -- Without this a second process contending for the same database fails instantly with
     -- SQLITE_BUSY. Two processes settling is the exact scenario this project is about.
     PRAGMA busy_timeout = 5000;
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
  const auditColumns = db.prepare("PRAGMA table_info(audit)").all() as Array<{ name: string }>;
  for (const col of ["prev_hash", "row_hash"]) {
    if (!auditColumns.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE audit ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    }
  }

  const columns = db.prepare("PRAGMA table_info(obligations)").all() as Array<{ name: string }>;
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

export class Store {
  #db: DatabaseSync;

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path);
    this.#db.exec(SCHEMA);
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
    const detailJson = JSON.stringify(detail ?? {});
    const tip = this.#db.prepare("SELECT row_hash AS h FROM audit ORDER BY id DESC LIMIT 1").get() as
      | { h: string }
      | undefined;
    const prev = tip?.h ?? "";
    const rowHash = auditHash(prev, obligationId, actor, action, detailJson, now);
    this.#db
      .prepare(
        "INSERT INTO audit (obligation_id, actor, action, detail_json, at, prev_hash, row_hash) VALUES (?,?,?,?,?,?,?)",
      )
      .run(obligationId, actor, action, detailJson, now, prev, rowHash);
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
    if (existing) return { created: false, state: existing.state };
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
  setState(obligationId: string, state: State, now = Date.now()): void {
    this.tx(() => {
      const row = this.#db
        .prepare("SELECT state FROM obligations WHERE obligation_id = ?")
        .get(obligationId) as { state: State } | undefined;
      if (!row) throw new Error(`unknown obligation ${obligationId}`);
      if (row.state === state) return;
      assertTransition(row.state, state);
      this.#db
        .prepare("UPDATE obligations SET state = ?, row_version = row_version + 1, updated_at = ? WHERE obligation_id = ?")
        .run(state, now, obligationId);
    });
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
      }
    | undefined {
    const row = this.#db
      .prepare(
        `SELECT obligation_id AS obligationId, request_id AS requestId, state,
                payment_reference AS paymentReference, source_facts_json AS factsJson
           FROM obligations WHERE obligation_id = ?`,
      )
      .get(obligationId) as
      | { obligationId: string; requestId: string; state: State; paymentReference: string | null; factsJson: string }
      | undefined;
    if (!row) return undefined;
    let invoiceBaseUnits: string | null = null;
    try {
      const parsed = JSON.parse(row.factsJson) as { invoiceBaseUnits?: string };
      invoiceBaseUnits = parsed.invoiceBaseUnits ?? null;
    } catch {
      invoiceBaseUnits = null;
    }
    return {
      obligationId: row.obligationId,
      requestId: row.requestId,
      state: row.state,
      paymentReference: row.paymentReference,
      invoiceBaseUnits,
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
        `INSERT OR IGNORE INTO plans
           (plan_hash, obligation_id, version, policy_hash, source_facts_hash, plan_json, total_debit_base, expires_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
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

  getApproval(planHash: string): { decision: string; approver: string; restatement: string } | undefined {
    return this.#db
      .prepare("SELECT decision, approver, restatement FROM approvals WHERE plan_hash = ? ORDER BY id DESC LIMIT 1")
      .get(planHash) as { decision: string; approver: string; restatement: string } | undefined;
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
  }): { attemptId: number; reused: boolean } {
    const now = a.now ?? Date.now();
    return this.tx(() => {
      const existing = this.#db
        .prepare("SELECT id FROM attempts WHERE plan_hash = ? AND step_index = ?")
        .get(a.planHash, a.stepIndex) as { id: number } | undefined;
      if (existing) return { attemptId: existing.id, reused: true };

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

      return { attemptId, reused: false };
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

  /** Stamp the moment we first handed this attempt to the provider. Never overwritten. */
  markSent(attemptId: number, now = Date.now()): void {
    this.#db
      .prepare("UPDATE attempts SET first_send_at = COALESCE(first_send_at, ?) WHERE id = ?")
      .run(now, attemptId);
  }

  recordOutcome(attemptId: number, o: { outcome: string; executionId?: string; txHash?: string }): void {
    this.#db
      .prepare("UPDATE attempts SET outcome = ?, execution_id = COALESCE(?, execution_id), tx_hash = COALESCE(?, tx_hash) WHERE id = ?")
      .run(o.outcome, o.executionId ?? null, o.txHash ?? null, attemptId);
  }

  // ---- jobs --------------------------------------------------------------

  enqueue(j: { kind: JobKind; dedupeKey: string; obligationId: string; attemptId?: number; dueAt: number; now?: number }): boolean {
    const info = this.#db
      .prepare(
        `INSERT OR IGNORE INTO jobs (kind, dedupe_key, obligation_id, attempt_id, due_at, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(j.kind, j.dedupeKey, j.obligationId, j.attemptId ?? null, j.dueAt, j.now ?? Date.now());
    return Number(info.changes) > 0;
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

  pendingJobCount(): number {
    return Number(
      (this.#db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'").get() as { n: number }).n,
    );
  }
}
