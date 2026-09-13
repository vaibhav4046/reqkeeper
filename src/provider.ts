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

/**
 * What a dry run ESTABLISHED, as four mutually exclusive outcomes.
 *
 * This was booleans, and it cost four duplicate-payment findings in three adversarial rounds --
 * each one a different caller reading a flag that could mean "I do not know" as if it meant "no":
 *
 *   1. `retryable` read as "nothing executed"
 *   2. `!retryable` read as "nothing executed"
 *   3. `wouldRevert` read as a verdict, when both transports also raise it for an unreadable
 *      reply, deliberately, so that an unknown can never authorise a send
 *   4. and the same conflation again on the success path
 *
 * Each was fixed where it was found, and the next round found the next one, because the shape of
 * the data let any caller collapse "unknown" into "no" by accident. A boolean cannot carry three
 * states, so the code carried the third one in a comment and hoped.
 *
 * The distinction that actually matters is not revert-versus-success. It is whether the provider
 * TOLD US ANYTHING. A timeout, a malformed body, a 409, an HTML error page and `{"success":false}`
 * are all the same thing to this system: the dry run may or may not have broadcast, and only the
 * chain can say. That is `UNKNOWN`, and it is not a failure mode -- it is the normal state of a
 * distributed call, and the one this project exists to handle.
 *
 * Callers must switch exhaustively. `settleOrRefuse` ends its switch with a `never` assignment,
 * so adding a fifth outcome without handling it is a compile error rather than a payment.
 */
export type SimulateOutcome =
  /** The provider simulated, and the payment would go through. */
  | { readonly kind: "WOULD_SUCCEED"; readonly gasEstimate: string }
  /** The provider simulated, and the payment would revert. Conclusive: nothing was broadcast. */
  | { readonly kind: "WOULD_REVERT"; readonly detail: string }
  /**
   * The dry run really executed (#1959). The hash proves a send happened with no attempt row
   * behind it, which is an integrity incident, never a settlement.
   */
  | { readonly kind: "EXECUTED"; readonly transactionHash: string }
  /**
   * No verdict. The call may or may not have broadcast, and nothing reachable from the provider
   * can distinguish the two. Never a licence to release the obligation or to send again.
   */
  | { readonly kind: "UNKNOWN"; readonly code: string; readonly detail: string };

/**
 * What a dry-run reply established, for either transport.
 *
 * Order matters and is the whole point. A hash comes first, because a dry run that hands back a
 * transaction really executed (#1959) and nothing else about the reply can matter after that.
 * `error` and `success === false` come next, and they are UNKNOWN rather than a revert: the
 * provider is telling us it did not complete a simulation, not that it completed one and the
 * payment fails. Only an explicit `wouldRevert` from a reply that carries no error is a verdict.
 *
 * The previous shape folded rows two and three together into one boolean and left a comment
 * warning the reader not to read it as a verdict. Three adversarial rounds read it as a verdict.
 */
export function classifySimulateReply(reply: {
  transactionHash?: string;
  txHash?: string;
  hash?: string;
  wouldRevert?: boolean;
  success?: boolean;
  error?: unknown;
  gasEstimate?: string;
}): SimulateOutcome {
  const hash = reply.transactionHash ?? reply.txHash ?? reply.hash;
  if (hash) return { kind: "EXECUTED", transactionHash: hash };
  if (reply.error !== undefined) {
    return { kind: "UNKNOWN", code: "simulate_error", detail: String(reply.error).slice(0, 200) };
  }
  if (reply.success === false) {
    return { kind: "UNKNOWN", code: "simulate_unsuccessful", detail: "the reply reported success: false with no revert verdict" };
  }
  if (reply.wouldRevert === true) {
    return { kind: "WOULD_REVERT", detail: "the provider simulated the call and it reverts" };
  }
  if (reply.wouldRevert === false) {
    return { kind: "WOULD_SUCCEED", gasEstimate: reply.gasEstimate ?? "0" };
  }
  // No hash, no error, no success flag, no verdict: a reply that said nothing about the dry run.
  // This used to read as `wouldRevert: false` -- a clean simulation -- and let a payment through.
  return { kind: "UNKNOWN", code: "no_verdict", detail: "the reply carried no simulation verdict" };
}

export interface ExecuteResult {
  /**
   * Null when the provider gave none.
   *
   * This used to default to the literal string "unknown", which was persisted into
   * attempts.execution_id and would have been sent as a path segment by observe(). Two
   * different stranded attempts recorded the same identifier. An absent id is absent.
   */
  readonly executionId: string | null;
  readonly status: "pending" | "completed" | "failed";
  readonly transactionHash?: string;
  readonly idempotentReplay?: boolean;
}

export interface Receipt {
  readonly hash: string;
  readonly verified: boolean;
  readonly receiptStatus: "success" | "reverted" | "not_found" | "timeout";
  readonly gasUsed: string;
  /**
   * The transaction's own target, and its own logs.
   *
   * The receipt used to be parsed as `{status, gasUsed}` and nothing else, so nothing
   * post-dispatch checked that the transaction had touched the fee proxy, paid the right payee
   * or moved the right amount — those were bound before dispatch only. That matters here more
   * than it would elsewhere, because the real execution shape is a meta-transaction: `to` is a
   * forwarder, `from` is a relayer, and the fee proxy appears only as a log emitter nested
   * inside someone else's transaction. A forwarder that does not bubble an inner revert
   * returns status 0x1 regardless, which is exactly the shape in which "the transaction
   * succeeded" and "the payment happened" come apart.
   *
   * Optional because a fixture provider has no chain behind it. Where the transport supplies
   * them, settle requires them to contain the payment.
   */
  readonly to?: string;
  readonly logs?: ReadonlyArray<{ address?: string; data?: string; topics?: string[] }>;
  /** Height of the block the receipt is in, and how far behind head that is. */
  readonly blockNumber?: number;
  readonly confirmations?: number;
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
  simulate(body: unknown): Promise<SimulateOutcome>;
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

  async simulate(body: unknown): Promise<SimulateOutcome> {
    if (this.#fault === "SIMULATE_IGNORED") {
      // The bug: the dry run actually executed. It even hands back a hash.
      this.#seq++;
      const key = `simulate-leak-${this.#seq}`;
      this.sendCounts.set(key, (this.sendCounts.get(key) ?? 0) + 1);
      return { kind: "EXECUTED", transactionHash: `0x${"5i".repeat(32).slice(0, 64)}` };
    }
    if (this.#fault === "RATE_LIMITED") {
      throw new ProviderError("rate_limited", "429 from provider", true);
    }
    return { kind: "WOULD_SUCCEED", gasEstimate: "21000" };
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
