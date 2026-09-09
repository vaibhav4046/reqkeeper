/**
 * The KeeperHub execution boundary, behind one interface so the harness can inject the
 * faults that matter without touching a real chain.
 *
 * Three platform behaviours are modelled explicitly because each one is a documented,
 * money-critical hazard rather than a hypothetical:
 *
 *   REPLAY_EXPIRED  docs/api/direct-execution: "Replay lasts 24 hours ... Past that the
 *                   stored response is gone and the same key executes again, silently."
 *   CACHED_FAILURE  issue #1840: a reused key replays a cached FAILURE, so a retry can
 *                   never succeed. Rotating the key would "fix" it by paying twice.
 *   SIMULATE_IGNORED  issues #1959 / #1929: `?simulate=true` is ignored on the transfer and
 *                   protocol-action routes and the transaction really executes. So a dry run
 *                   is not a safety boundary, and a tx hash coming back from one is evidence
 *                   of a real send.
 */

export type Fault =
  | "NONE"
  | "TIMEOUT_NO_RESPONSE"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "REPLAY_EXPIRED"
  | "CACHED_FAILURE"
  | "SIMULATE_IGNORED"
  | "RECEIPT_REVERTED"
  | "COMPLETE_BUT_RECEIPT_MISSING"
  | "RATE_LIMITED";

export interface SimulateResult {
  readonly status: "simulated";
  readonly wouldRevert: boolean;
  readonly gasEstimate: string;
  /** Must always be absent. A hash from a dry run means it really executed (#1959). */
  readonly transactionHash?: string;
}

export interface ExecuteResult {
  readonly executionId: string;
  readonly status: "pending" | "completed" | "failed";
  readonly transactionHash?: string;
  readonly idempotentReplay?: boolean;
}

export interface Receipt {
  readonly hash: string;
  readonly verified: boolean;
  readonly receiptStatus: "success" | "reverted" | "not_found" | "timeout";
  readonly gasUsed: string;
}

export class ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ExecutionProvider {
  simulate(body: unknown): Promise<SimulateResult>;
  /** `idempotencyKey` must come from the persisted attempt, never minted at call time. */
  execute(body: unknown, idempotencyKey: string): Promise<ExecuteResult>;
  observe(executionId: string): Promise<ExecuteResult>;
  /** Independent chain read. A provider's own status is not evidence. */
  receipt(hash: string): Promise<Receipt>;
}

interface Sent {
  readonly bodyJson: string;
  readonly executionId: string;
  readonly txHash: string;
  outcome: "pending" | "completed" | "failed";
  sends: number;
}

/**
 * Deterministic in-memory provider. Counts how many times each key was really executed, so
 * the harness can assert "no second payment" rather than trusting a status string.
 */
export class FixtureProvider implements ExecutionProvider {
  #fault: Fault;
  #sent = new Map<string, Sent>();
  #seq = 0;
  /** Every physical send, keyed by idempotency key. >1 means the money moved twice. */
  readonly sendCounts = new Map<string, number>();

  constructor(fault: Fault = "NONE") {
    this.#fault = fault;
  }

  setFault(f: Fault): void {
    this.#fault = f;
  }

  totalSends(): number {
    let n = 0;
    for (const c of this.sendCounts.values()) n += c;
    return n;
  }

  async simulate(body: unknown): Promise<SimulateResult> {
    if (this.#fault === "SIMULATE_IGNORED") {
      // The bug: the dry run actually executed. It even hands back a hash.
      this.#seq++;
      const key = `simulate-leak-${this.#seq}`;
      this.sendCounts.set(key, (this.sendCounts.get(key) ?? 0) + 1);
      return {
        status: "simulated",
        wouldRevert: false,
        gasEstimate: "21000",
        transactionHash: `0x${"5i".repeat(32).slice(0, 64)}`,
      };
    }
    if (this.#fault === "RATE_LIMITED") {
      throw new ProviderError("rate_limited", "429 from provider", true);
    }
    return { status: "simulated", wouldRevert: false, gasEstimate: "21000" };
  }

  async execute(body: unknown, idempotencyKey: string): Promise<ExecuteResult> {
    const bodyJson = JSON.stringify(body);
    const prior = this.#sent.get(idempotencyKey);

    switch (this.#fault) {
      case "TIMEOUT_NO_RESPONSE": {
        // The provider may still have executed. Caller learns nothing.
        this.#record(idempotencyKey, bodyJson);
        throw new ProviderError("timeout", "no response from provider", true);
      }
      case "IDEMPOTENCY_IN_PROGRESS":
        throw new ProviderError("idempotency_in_progress", "409 in progress", true);
      case "RATE_LIMITED":
        throw new ProviderError("rate_limited", "429 from provider", true);
      case "CACHED_FAILURE":
        // #1840: the key is stuck replaying a failure. Retrying forever cannot help.
        return { executionId: "exec-cached-failure", status: "failed", idempotentReplay: true };
      case "REPLAY_EXPIRED": {
        // The 24h window lapsed. The provider has forgotten, so this executes AGAIN.
        const sent = this.#record(idempotencyKey, bodyJson);
        return { executionId: sent.executionId, status: "completed", transactionHash: sent.txHash };
      }
      default:
        break;
    }

    if (prior) {
      if (prior.bodyJson !== bodyJson) {
        throw new ProviderError("idempotency_conflict", "409 same key, different body", false);
      }
      // Inside the window: a genuine replay, no second send.
      return {
        executionId: prior.executionId,
        status: prior.outcome,
        transactionHash: prior.txHash,
        idempotentReplay: true,
      };
    }

    if (this.#fault === "IDEMPOTENCY_CONFLICT") {
      throw new ProviderError("idempotency_conflict", "409 same key, different body", false);
    }

    const sent = this.#record(idempotencyKey, bodyJson);
    return { executionId: sent.executionId, status: "completed", transactionHash: sent.txHash };
  }

  async observe(executionId: string): Promise<ExecuteResult> {
    for (const s of this.#sent.values()) {
      if (s.executionId === executionId) {
        return { executionId, status: s.outcome, transactionHash: s.txHash };
      }
    }
    if (this.#fault === "COMPLETE_BUT_RECEIPT_MISSING") {
      return { executionId, status: "completed", transactionHash: `0x${"ab".repeat(32)}` };
    }
    return { executionId, status: "failed" };
  }

  async receipt(hash: string): Promise<Receipt> {
    if (this.#fault === "RECEIPT_REVERTED") {
      return { hash, verified: true, receiptStatus: "reverted", gasUsed: "21000" };
    }
    if (this.#fault === "COMPLETE_BUT_RECEIPT_MISSING") {
      return { hash, verified: false, receiptStatus: "not_found", gasUsed: "0" };
    }
    const known = [...this.#sent.values()].some((s) => s.txHash === hash);
    return known
      ? { hash, verified: true, receiptStatus: "success", gasUsed: "52000" }
      : { hash, verified: false, receiptStatus: "not_found", gasUsed: "0" };
  }

  #record(key: string, bodyJson: string): Sent {
    this.sendCounts.set(key, (this.sendCounts.get(key) ?? 0) + 1);
    const existing = this.#sent.get(key);
    if (existing) {
      existing.sends++;
      return existing;
    }
    this.#seq++;
    const sent: Sent = {
      bodyJson,
      executionId: `exec-${this.#seq}`,
      txHash: `0x${this.#seq.toString(16).padStart(64, "0")}`,
      outcome: "completed",
      sends: 1,
    };
    this.#sent.set(key, sent);
    return sent;
  }
}
