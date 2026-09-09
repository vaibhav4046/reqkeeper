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
  at            INTEGER NOT NULL
);
`;

export class Store {
  #db: DatabaseSync;

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path);
    this.#db.exec(SCHEMA);
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
    this.#db
      .prepare("INSERT INTO audit (obligation_id, actor, action, detail_json, at) VALUES (?,?,?,?,?)")
      .run(obligationId, actor, action, JSON.stringify(detail ?? {}), now);
  }

  auditTrail(obligationId: string): Array<{ action: string; actor: string }> {
    return this.#db
      .prepare("SELECT actor, action FROM audit WHERE obligation_id = ? ORDER BY id")
      .all(obligationId) as Array<{ action: string; actor: string }>;
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
    now?: number;
  }): { created: boolean; state: string } {
    const now = o.now ?? Date.now();
    const existing = this.getObligation(o.obligationId);
    if (existing) return { created: false, state: existing.state };
    this.#db
      .prepare(
        `INSERT INTO obligations
           (obligation_id, namespace, request_id, state, source_facts_json, source_facts_hash, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(o.obligationId, o.namespace, o.requestId, "IMPORTED", o.sourceFactsJson, o.sourceFactsHash, now, now);
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

  setState(obligationId: string, state: string, now = Date.now()): void {
    this.#db
      .prepare("UPDATE obligations SET state = ?, row_version = row_version + 1, updated_at = ? WHERE obligation_id = ?")
      .run(state, now, obligationId);
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
    this.#db
      .prepare(
        `INSERT INTO approvals (plan_hash, obligation_id, approver, decision, restatement, reason, decided_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(a.planHash, a.obligationId, a.approver, a.decision, a.restatement, a.reason ?? null, a.now ?? Date.now());
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
  claimJobs(opts: { limit: number; now: number; leaseMs: number }): Job[] {
    return this.tx(() => {
      const rows = this.#db
        .prepare(
          `SELECT id FROM jobs
            WHERE status = 'pending' AND due_at <= ? AND lease_expires_at <= ?
            ORDER BY due_at LIMIT ?`,
        )
        .all(opts.now, opts.now, opts.limit) as Array<{ id: number }>;

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
            .get(id) as Job,
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

  completeJob(jobId: number): void {
    this.#db.prepare("UPDATE jobs SET status = 'done', lease_expires_at = 0 WHERE id = ?").run(jobId);
  }

  deferJob(jobId: number, dueAt: number, errorCode: string): void {
    this.#db
      .prepare("UPDATE jobs SET due_at = ?, lease_expires_at = 0, last_error_code = ? WHERE id = ?")
      .run(dueAt, errorCode, jobId);
  }

  pendingJobCount(): number {
    return Number(
      (this.#db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'").get() as { n: number }).n,
    );
  }
}
