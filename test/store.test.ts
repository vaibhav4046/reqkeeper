import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { idempotencyKey, obligationId } from "../src/identity.ts";

const NS = "request-network:sepolia";
const REQ = "01e273ecc29d4b526df3a0f1f05ffc59aa";
const OID = obligationId(NS, REQ);
const PLAN = "b".repeat(64);
const PLAN_B = "c".repeat(64);

function seeded(): Store {
  const s = new Store();
  s.importObligation({
    obligationId: OID, namespace: NS, requestId: REQ,
    sourceFactsJson: "{}", sourceFactsHash: "a".repeat(64), now: 1000,
  });
  s.savePlan({
    planHash: PLAN, obligationId: OID, version: 1, policyHash: "d".repeat(64),
    sourceFactsHash: "a".repeat(64), planJson: "{}", totalDebitBaseUnits: "50", expiresAt: 9_000, now: 1000,
  });
  return s;
}

describe("obligation identity is unique and idempotent", () => {
  test("importing the same obligation twice does not create a rival identity", () => {
    const s = seeded();
    const again = s.importObligation({
      obligationId: OID, namespace: NS, requestId: REQ,
      sourceFactsJson: '{"changed":true}', sourceFactsHash: "z".repeat(64),
    });
    assert.equal(again.created, false);
    assert.equal(again.state, "IMPORTED");
    s.close();
  });

  test("the (namespace, request_id) index rejects a second row for one debt", () => {
    const s = seeded();
    // A different obligation_id for the same upstream pair must not be insertable.
    assert.throws(
      () =>
        s.importObligation({
          obligationId: "f".repeat(64), namespace: NS, requestId: REQ,
          sourceFactsJson: "{}", sourceFactsHash: "a".repeat(64),
        }),
      /UNIQUE|constraint/i,
    );
    s.close();
  });
});

describe("reservation grants exclusive settlement ownership", () => {
  test("the first plan wins and is re-entrant", () => {
    const s = seeded();
    assert.deepEqual(s.reserveObligation(OID, PLAN), { ok: true });
    assert.deepEqual(s.reserveObligation(OID, PLAN), { ok: true }, "same plan may re-reserve");
    s.close();
  });

  test("a rival plan is refused and cannot steal the reservation", () => {
    const s = seeded();
    s.reserveObligation(OID, PLAN);
    const r = s.reserveObligation(OID, PLAN_B);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.heldBy, PLAN);
    // and the winner still holds it
    assert.equal(s.getObligation(OID)?.reservedByPlan, PLAN);
    s.close();
  });

  test("concurrent double-propose yields exactly one winner", () => {
    const s = seeded();
    const results = [PLAN, PLAN_B, PLAN_B, PLAN].map((p) => s.reserveObligation(OID, p));
    assert.equal(results.filter((r) => r.ok).length, 2, "both PLAN calls succeed, both PLAN_B refused");
    assert.equal(results.filter((r) => !r.ok).length, 2);
    s.close();
  });
});

describe("the transactional outbox", () => {
  test("an attempt and its job are committed together", () => {
    const s = seeded();
    const key = idempotencyKey(OID, PLAN, 0);
    const { attemptId, reused } = s.openAttempt({
      obligationId: OID, planHash: PLAN, stepIndex: 0, idempotencyKey: key,
      endpoint: "/api/execute/contract-call", bodyJson: '{"x":1}', now: 2000,
    });
    assert.equal(reused, false);
    assert.equal(s.pendingJobCount(), 1, "the job exists because the attempt does");
    assert.equal(s.getAttempt(attemptId)?.idempotencyKey, key);
    s.close();
  });

  test("nothing is durable if the transaction throws — no orphan job, no orphan attempt", () => {
    const s = seeded();
    assert.throws(() =>
      s.tx(() => {
        s.openAttempt({
          obligationId: OID, planHash: PLAN, stepIndex: 0, idempotencyKey: idempotencyKey(OID, PLAN, 0),
          endpoint: "/e", bodyJson: "{}",
        });
        throw new Error("crash before commit");
      }),
    );
    assert.equal(s.pendingJobCount(), 0, "crash before commit leaves no outbound intent");
    s.close();
  });

  test("retrying a step reuses the row, and therefore the same idempotency key", () => {
    const s = seeded();
    const key = idempotencyKey(OID, PLAN, 0);
    const first = s.openAttempt({
      obligationId: OID, planHash: PLAN, stepIndex: 0, idempotencyKey: key, endpoint: "/e", bodyJson: "{}",
    });
    const second = s.openAttempt({
      obligationId: OID, planHash: PLAN, stepIndex: 0, idempotencyKey: key, endpoint: "/e", bodyJson: "{}",
    });
    assert.equal(second.reused, true);
    assert.equal(second.attemptId, first.attemptId);
    assert.equal(s.pendingJobCount(), 1, "no duplicate job");
    s.close();
  });

  test("a new plan gets a new attempt and a distinct key — the only legitimate new payment identity", () => {
    const s = seeded();
    s.savePlan({
      planHash: PLAN_B, obligationId: OID, version: 2, policyHash: "d".repeat(64),
      sourceFactsHash: "a".repeat(64), planJson: "{}", totalDebitBaseUnits: "50", expiresAt: 9_000,
    });
    const a = s.openAttempt({
      obligationId: OID, planHash: PLAN, stepIndex: 0, idempotencyKey: idempotencyKey(OID, PLAN, 0),
      endpoint: "/e", bodyJson: "{}",
    });
    const b = s.openAttempt({
      obligationId: OID, planHash: PLAN_B, stepIndex: 0, idempotencyKey: idempotencyKey(OID, PLAN_B, 0),
      endpoint: "/e", bodyJson: "{}",
    });
    assert.notEqual(a.attemptId, b.attemptId);
    assert.notEqual(s.getAttempt(a.attemptId)?.idempotencyKey, s.getAttempt(b.attemptId)?.idempotencyKey);
    s.close();
  });

  test("first_send_at is stamped once and never overwritten", () => {
    const s = seeded();
    const { attemptId } = s.openAttempt({
      obligationId: OID, planHash: PLAN, stepIndex: 0, idempotencyKey: idempotencyKey(OID, PLAN, 0),
      endpoint: "/e", bodyJson: "{}",
    });
    s.markSent(attemptId, 5000);
    s.markSent(attemptId, 9999);
    assert.equal(s.getAttempt(attemptId)?.firstSendAt, 5000);
    s.close();
  });

  test("markSent tells exactly one caller it may send", () => {
    // The column being right is not the same as the guard being right. The old form —
    // SET first_send_at = COALESCE(first_send_at, ?) — kept the first value and so passed the
    // test above, but it returned nothing and therefore decided nothing: the real gate was a
    // separate read of firstSendAt, and two processes could both read null and both pass it.
    // What must be true is that the SECOND caller is told no.
    const s = seeded();
    const { attemptId } = s.openAttempt({
      obligationId: OID, planHash: PLAN, stepIndex: 0, idempotencyKey: idempotencyKey(OID, PLAN, 0),
      endpoint: "/e", bodyJson: "{}",
    });

    assert.equal(s.markSent(attemptId, 5000), true, "the first caller claims the send");
    assert.equal(s.markSent(attemptId, 9999), false, "the second caller must be refused");
    assert.equal(s.markSent(attemptId, 9999), false, "and refused every time after that");
    assert.equal(s.getAttempt(attemptId)?.firstSendAt, 5000);
    s.close();
  });

  test("two callers that both read firstSendAt as null still produce only one send", () => {
    // The race shape from hackathon/audit/probes/p1-race.ts, Part A: "A read firstSendAt =
    // null -> A would send: true / B read firstSendAt = null -> B would send: true / both
    // callers passed the guard: true". Reading first must not entitle either of them to send.
    const s = seeded();
    const { attemptId } = s.openAttempt({
      obligationId: OID, planHash: PLAN, stepIndex: 0, idempotencyKey: idempotencyKey(OID, PLAN, 0),
      endpoint: "/e", bodyJson: "{}",
    });

    const aRead = s.getAttempt(attemptId)?.firstSendAt;
    const bRead = s.getAttempt(attemptId)?.firstSendAt;
    assert.equal(aRead, null);
    assert.equal(bRead, null, "both callers genuinely observe an unsent attempt");

    const winners = [s.markSent(attemptId, 100), s.markSent(attemptId, 200)].filter(Boolean);
    assert.equal(winners.length, 1, "exactly one caller may proceed to the provider");
    s.close();
  });

  test("recording a send enqueues the observation that closes the loop", () => {
    // The settle path used to enqueue OBSERVE_EXECUTION on its failure branches only, so a
    // crash after the provider answered left a real payment with an empty outbox: the dispatch
    // job completes as soon as an outcome exists, and nothing else was ever queued. The
    // enqueue belongs in the same transaction as the write that records the send.
    const s = seeded();
    const { attemptId } = s.openAttempt({
      obligationId: OID, planHash: PLAN, stepIndex: 0, idempotencyKey: idempotencyKey(OID, PLAN, 0),
      endpoint: "/e", bodyJson: "{}",
    });
    const before = s.pendingJobCount();

    s.recordOutcome(attemptId, { outcome: "SENT", txHash: `0x${"1".repeat(64)}`, now: 1000 });

    assert.equal(s.pendingJobCount(), before + 1, "a recorded send must leave something looking");
    s.close();
  });

  test("a failure carrying a transaction hash is also observed, not just believed", () => {
    // KeeperHub returns a hash on `failed` whenever the transaction reached the chain. A
    // status string is not evidence; the receipt is.
    const s = seeded();
    const { attemptId } = s.openAttempt({
      obligationId: OID, planHash: PLAN, stepIndex: 0, idempotencyKey: idempotencyKey(OID, PLAN, 0),
      endpoint: "/e", bodyJson: "{}",
    });
    const before = s.pendingJobCount();

    s.recordOutcome(attemptId, { outcome: "FAILED", txHash: `0x${"2".repeat(64)}`, now: 1000 });

    assert.equal(s.pendingJobCount(), before + 1);
    s.close();
  });

  test("an outcome with no hash and no send queues nothing", () => {
    // The control for the two above: the enqueue is triggered by evidence that a transaction
    // may exist, not by every write.
    const s = seeded();
    const { attemptId } = s.openAttempt({
      obligationId: OID, planHash: PLAN, stepIndex: 0, idempotencyKey: idempotencyKey(OID, PLAN, 0),
      endpoint: "/e", bodyJson: "{}",
    });
    const before = s.pendingJobCount();

    s.recordOutcome(attemptId, { outcome: "INTEGRITY_CONFLICT", now: 1000 });

    assert.equal(s.pendingJobCount(), before);
    s.close();
  });

  test("the recorded transaction is evidence, so a second, different hash cannot replace it", () => {
    // The outcome may be refined as the chain answers, but the identifiers it points at
    // must not move. A writer that can overwrite tx_hash can make a settled obligation
    // cite a transaction it never sent, which is the audit trail rewriting itself.
    const s = seeded();
    const { attemptId } = s.openAttempt({
      obligationId: OID, planHash: PLAN, stepIndex: 0, idempotencyKey: idempotencyKey(OID, PLAN, 0),
      endpoint: "/e", bodyJson: "{}",
    });

    s.recordOutcome(attemptId, { outcome: "SENT", executionId: "exec-real", txHash: `0x${"1".repeat(64)}` });
    s.recordOutcome(attemptId, { outcome: "CONFIRMED", executionId: "exec-EVIL", txHash: `0x${"f".repeat(64)}` });

    const a = s.getAttempt(attemptId);
    assert.equal(a?.txHash, `0x${"1".repeat(64)}`, "the first recorded hash must stand");
    assert.equal(a?.executionId, "exec-real", "the first recorded execution id must stand");
    assert.equal(a?.outcome, "CONFIRMED", "the outcome itself is still allowed to advance");
    s.close();
  });

  test("a hash still lands when none was recorded yet", () => {
    // Write-once must not mean write-never: the recovery path records a hash it found later.
    const s = seeded();
    const { attemptId } = s.openAttempt({
      obligationId: OID, planHash: PLAN, stepIndex: 0, idempotencyKey: idempotencyKey(OID, PLAN, 0),
      endpoint: "/e", bodyJson: "{}",
    });
    s.recordOutcome(attemptId, { outcome: "SENT" });
    s.recordOutcome(attemptId, { outcome: "CONFIRMED", txHash: `0x${"a".repeat(64)}` });
    assert.equal(s.getAttempt(attemptId)?.txHash, `0x${"a".repeat(64)}`);
    s.close();
  });
});

describe("job leasing and fencing", () => {
  function withJob(): { s: Store; jobId: number; gen: number } {
    const s = seeded();
    s.openAttempt({
      obligationId: OID, planHash: PLAN, stepIndex: 0, idempotencyKey: idempotencyKey(OID, PLAN, 0),
      endpoint: "/e", bodyJson: "{}", now: 1000,
    });
    const [job] = s.claimJobs({ limit: 10, now: 2000, leaseMs: 30_000 });
    return { s, jobId: job.id, gen: job.fencingGeneration };
  }

  test("a claimed job is not handed to a second worker while leased", () => {
    const { s } = withJob();
    assert.deepEqual(s.claimJobs({ limit: 10, now: 2001, leaseMs: 30_000 }), []);
    s.close();
  });

  test("an expired lease is reclaimable, with a higher generation", () => {
    const { s, gen } = withJob();
    const [again] = s.claimJobs({ limit: 10, now: 999_999, leaseMs: 30_000 });
    assert.ok(again, "expired lease should be reclaimable");
    assert.ok(again.fencingGeneration > gen, "generation must advance");
    s.close();
  });

  test("the worker that lost its lease cannot write — its generation is stale", () => {
    const { s, jobId, gen } = withJob();
    s.assertFencing(jobId, gen); // still valid
    s.claimJobs({ limit: 10, now: 999_999, leaseMs: 30_000 }); // someone else takes over
    assert.throws(() => s.assertFencing(jobId, gen), /stale fencing/);
    s.close();
  });

  test("a stale worker's write is rejected but no new payment identity appears", () => {
    const { s, jobId, gen } = withJob();
    s.claimJobs({ limit: 10, now: 999_999, leaseMs: 30_000 });
    // Asserted outside any catch. This used to be `try { assertFencing; assert.fail() } catch {}`,
    // which swallowed its own AssertionError: a fence that did nothing still went green.
    assert.throws(() => s.assertFencing(jobId, gen), /stale fencing/);
    // The attempt row and its idempotency key are unchanged, so the takeover worker
    // resumes the same provider operation rather than starting a second one.
    const a = s.getAttempt(1);
    assert.equal(a?.idempotencyKey, idempotencyKey(OID, PLAN, 0));
    assert.equal(a?.stepIndex, 0);
    // ...and no second payment identity was minted alongside it.
    assert.equal(s.getAttempt(2), undefined, "the rejected write must not create a second attempt");
    s.close();
  });

  test("a deferred job becomes due again and records why", () => {
    const { s, jobId, gen } = withJob();
    s.deferJob(jobId, 50_000, "PROVIDER_429", gen);
    assert.deepEqual(s.claimJobs({ limit: 10, now: 49_999, leaseMs: 1000 }), [], "not due yet");
    assert.equal(s.claimJobs({ limit: 10, now: 50_000, leaseMs: 1000 }).length, 1);
    s.close();
  });

  test("a completed job is never claimed again", () => {
    const { s, jobId, gen } = withJob();
    s.completeJob(jobId, gen);
    assert.deepEqual(s.claimJobs({ limit: 10, now: 999_999, leaseMs: 1000 }), []);
    assert.equal(s.pendingJobCount(), 0);
    s.close();
  });

  test("a worker that lost its lease cannot complete or defer the job", () => {
    const { s, jobId, gen: stale } = withJob();
    // The lease lapses and a second worker claims the same job.
    const live = s.claimJobs({ limit: 10, now: 40_000, leaseMs: 60_000 })[0].fencingGeneration;
    assert.notEqual(stale, live, "the second claim must bump the generation");

    // The old worker wakes up and tries to finish work it no longer owns.
    assert.throws(() => s.completeJob(jobId, stale), /stale fencing generation/);
    assert.throws(() => s.deferJob(jobId, 99_000, "LATE", stale), /stale fencing generation/);
    assert.equal(s.pendingJobCount(), 1, "the job still belongs to the live worker");

    s.completeJob(jobId, live);
    assert.equal(s.pendingJobCount(), 0);
    s.close();
  });

  test("duplicate observation jobs coalesce on the dedupe key", () => {
    const s = seeded();
    const j = { kind: "OBSERVE_EXECUTION" as const, dedupeKey: `observe:${PLAN}:0`, obligationId: OID, dueAt: 1 };
    assert.equal(s.enqueue(j), true);
    assert.equal(s.enqueue(j), false, "second enqueue is a no-op");
    assert.equal(s.pendingJobCount(), 1);
    s.close();
  });
});

describe("audit trail", () => {
  test("records actor and action in order", () => {
    const s = seeded();
    s.audit(OID, "agent:token-1", "PROPOSED", { reason: "invoice due" });
    s.audit(OID, "human:owner", "APPROVED", { planHash: PLAN });
    assert.deepEqual(s.auditTrail(OID).map((r) => r.action), ["PROPOSED", "APPROVED"]);
    assert.equal(s.auditTrail(OID)[0].actor, "agent:token-1");
    s.close();
  });
});

describe("an older database is migrated, not silently left without its defences", () => {
  test("a file created before payment_reference gains the column and the unique index", () => {
    const path = join(mkdtempSync(join(tmpdir(), "reqkeeper-")), "old.sqlite");

    // Exactly the obligations table as it was before the reference was the debt's identity.
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE obligations (
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
    )`);
    old.close();

    // Opening it used to throw: CREATE TABLE IF NOT EXISTS is a no-op on an existing table,
    // so the index over the missing column could not be created.
    const s = new Store(path);
    const shared = { namespace: "ns", sourceFactsJson: "{}", sourceFactsHash: "h" };
    assert.equal(
      s.importObligation({ obligationId: "o1", requestId: "inv-1", paymentReference: "0xdead", ...shared }).created,
      true,
    );

    // The defence must actually be live on the migrated file, not merely present in the DDL.
    assert.throws(
      () => s.importObligation({ obligationId: "o2", requestId: "INV-1", paymentReference: "0xdead", ...shared }),
      /UNIQUE/i,
      "one payment reference must still be one debt after a migration",
    );

    assert.equal(s.obligationForReference("0xdead")?.obligationId, "o1");
    s.close();
  });
});
