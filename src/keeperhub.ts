/**
 * The live KeeperHub execution provider.
 *
 * The awkward part of this integration, and the reason this file is not thin:
 *
 * Request Network gives you finished calldata. KeeperHub will not accept finished calldata —
 * probed on 2026-09-09, every write route rejects `data`/`callData` and there is no raw
 * transaction route (`/execute/{raw,transaction,send,write,tx}` all answer
 * `{"error":"Invalid action type"}`). The only write surface is
 * `(contractAddress, functionName, functionArgs)`, which KeeperHub re-encodes with an ABI it
 * resolves on its own side using ethers 6.17.0.
 *
 * So a decode/re-encode step sits between the bytes a human approved and the bytes a signer
 * signs, and it is performed by the platform. This provider refuses to be the place where
 * that goes wrong: it decodes the approved calldata, re-encodes it locally, and requires the
 * result to be byte-identical before anything is sent. It also refuses any selector that is
 * not on the allowlist, so a plan cannot be talked into calling something else entirely.
 *
 * What it cannot do is verify KeeperHub's own re-encoding, because the request that would
 * prove it is the one that spends the money. That is precisely why `receipt()` reads the
 * chain directly and never trusts a status field.
 */

import { type CallStep, decodeAllowedCall } from "./calldata-gate.ts";
import type { ExecuteResult, ExecutionProvider, Receipt, SimulateResult } from "./provider.ts";
import { ProviderError } from "./provider.ts";

export interface KeeperHubConfig {
  readonly apiKey: string;
  readonly chainId: number;
  /** Public RPC used for the independent receipt read. Never KeeperHub. */
  readonly rpcUrl: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

interface KeeperHubResponse {
  success?: boolean;
  status?: string;
  wouldRevert?: boolean;
  gasEstimate?: string;
  revertReason?: string;
  error?: string;
  transactionHash?: string;
  txHash?: string;
  hash?: string;
  executionId?: string;
  id?: string;
  idempotentReplay?: boolean;
  replayed?: boolean;
}

export class KeeperHubProvider implements ExecutionProvider {
  readonly #cfg: KeeperHubConfig;
  readonly #base: string;
  readonly #timeout: number;

  constructor(cfg: KeeperHubConfig) {
    if (!cfg.apiKey) throw new ProviderError("no_credential", "KEEPERHUB_API_KEY is required", false);
    this.#cfg = cfg;
    this.#base = cfg.baseUrl ?? "https://app.keeperhub.com/api";
    this.#timeout = cfg.timeoutMs ?? 60_000;
  }

  // --- the calldata integrity gate ----------------------------------------

  /**
   * Turn approved calldata into the arguments KeeperHub demands, proving along the way that
   * the arguments mean exactly the approved bytes. Any doubt refuses, non-retryably: a
   * malformed plan is not going to become well-formed on a retry.
   */
  #toArgs(step: CallStep): { functionName: string; functionArgs: string } {
    const call = decodeAllowedCall(step);
    return { functionName: call.functionName, functionArgs: JSON.stringify(call.args) };
  }

  #body(step: CallStep): Record<string, unknown> {
    const { functionName, functionArgs } = this.#toArgs(step);
    return {
      chainId: this.#cfg.chainId,
      contractAddress: step.to,
      functionName,
      // Not a typo and not an array: KeeperHub requires the arguments as a JSON *string*.
      functionArgs,
      value: step.value ?? "0",
    };
  }

  async #post(path: string, body: unknown, idempotencyKey?: string): Promise<KeeperHubResponse> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#cfg.apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    let res: Response;
    try {
      res = await fetch(`${this.#base}/${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch (e) {
      // The send may or may not have happened. Retryable at the transport level, but the
      // caller's state machine is what decides whether a retry is safe.
      throw new ProviderError("timeout", `no response from KeeperHub: ${String(e)}`, true);
    }

    const text = await res.text();
    let parsed: KeeperHubResponse = {};
    try {
      parsed = JSON.parse(text) as KeeperHubResponse;
    } catch {
      if (!res.ok) throw new ProviderError("bad_response", `HTTP ${res.status}: ${text.slice(0, 200)}`, res.status >= 500);
    }

    if (res.status === 409) {
      throw new ProviderError("idempotency_conflict", parsed.error ?? "409 from KeeperHub", false);
    }
    if (res.status === 429) {
      throw new ProviderError("rate_limited", "429 from KeeperHub", true);
    }
    if (res.status >= 500) {
      throw new ProviderError("provider_error", `HTTP ${res.status}: ${parsed.error ?? text.slice(0, 200)}`, true);
    }
    return parsed;
  }

  // --- ExecutionProvider ---------------------------------------------------

  async simulate(body: unknown): Promise<SimulateResult> {
    const res = await this.#post("execute/contract-call", { ...this.#body(body as CallStep), simulate: true });
    const hash = res.transactionHash ?? res.txHash ?? res.hash;
    return {
      status: "simulated",
      wouldRevert: res.wouldRevert === true || res.success === false,
      gasEstimate: res.gasEstimate ?? "0",
      // Passed through deliberately. A hash here means the dry run executed, and settle.ts
      // treats that as a real send rather than a simulation.
      ...(hash ? { transactionHash: hash } : {}),
    };
  }

  async execute(body: unknown, idempotencyKey: string): Promise<ExecuteResult> {
    if (!idempotencyKey) {
      throw new ProviderError("no_idempotency_key", "refusing to execute without an idempotency key", false);
    }
    const res = await this.#post("execute/contract-call", this.#body(body as CallStep), idempotencyKey);
    return this.#toExecuteResult(res);
  }

  async observe(executionId: string): Promise<ExecuteResult> {
    let res: Response;
    try {
      res = await fetch(`${this.#base}/execute/${encodeURIComponent(executionId)}`, {
        headers: { authorization: `Bearer ${this.#cfg.apiKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch (e) {
      throw new ProviderError("timeout", `observe failed: ${String(e)}`, true);
    }
    if (!res.ok) {
      // Not knowing is a legitimate answer here, and a safer one than guessing "failed".
      throw new ProviderError("observe_unavailable", `HTTP ${res.status}`, res.status >= 500);
    }
    return this.#toExecuteResult((await res.json()) as KeeperHubResponse);
  }

  /**
   * The independent read. Deliberately goes to a public RPC and not to KeeperHub, because a
   * provider reporting on its own success is not evidence of anything.
   */
  async receipt(hash: string): Promise<Receipt> {
    let body: { result?: { status?: string; gasUsed?: string } | null; error?: { message: string } };
    try {
      const res = await fetch(this.#cfg.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
        signal: AbortSignal.timeout(this.#timeout),
      });
      body = await res.json();
    } catch {
      return { hash, verified: false, receiptStatus: "timeout", gasUsed: "0" };
    }
    if (body.error) return { hash, verified: false, receiptStatus: "timeout", gasUsed: "0" };
    const r = body.result;
    if (!r) return { hash, verified: false, receiptStatus: "not_found", gasUsed: "0" };

    const gasUsed = r.gasUsed ? BigInt(r.gasUsed).toString(10) : "0";
    return r.status === "0x1"
      ? { hash, verified: true, receiptStatus: "success", gasUsed }
      : { hash, verified: true, receiptStatus: "reverted", gasUsed };
  }

  /**
   * Mapping of the executed-path response, observed against two real Sepolia executions
   * (`mint` and `approve`, 2026-09-09). KeeperHub answers HTTP 202 with:
   *
   *   {"executionId":"...","status":"completed","transactionHash":"0x...","transactionLink":"..."}
   *
   * Note the mismatch worth being careful about: the HTTP status is 202 Accepted while the
   * body claims "completed". The body is not taken as proof of anything — settle.ts still
   * requires an independent receipt read before it will call a payment settled.
   *
   * Unrecognised statuses become "pending", never "completed", so a shape this code has not
   * seen can never be mistaken for a finished payment.
   */
  #toExecuteResult(res: KeeperHubResponse): ExecuteResult {
    const hash = res.transactionHash ?? res.txHash ?? res.hash;
    const id = res.executionId ?? res.id ?? hash ?? "unknown";
    const replay = res.idempotentReplay === true || res.replayed === true;

    let status: ExecuteResult["status"];
    if (res.success === false || res.status === "failed" || res.status === "reverted") status = "failed";
    else if (res.status === "completed" || res.status === "success" || res.status === "confirmed") status = "completed";
    else status = "pending";

    return {
      executionId: id,
      status,
      ...(hash ? { transactionHash: hash } : {}),
      ...(replay ? { idempotentReplay: true } : {}),
    };
  }
}
