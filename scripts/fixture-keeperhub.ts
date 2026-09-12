/**
 * A counting stand-in for KeeperHub, and for the chain behind it.
 *
 * The race and the crash matrix both need to answer one question honestly: how many times did
 * something that can move value actually get called? A provider stub inside the process cannot
 * answer it, because the thing under test is what happens across PROCESSES. So this is a real
 * HTTP server speaking KeeperHub's contract, and the workers talk to it through the real
 * `KeeperHubProvider` with `baseUrl` pointed here. Nothing is mocked below the transport.
 *
 * The counting is deliberately split three ways, because collapsing it would let this project
 * claim something it has not proved:
 *
 *   posts        every non-simulate POST that arrived. If exactly-once depended on KeeperHub's
 *                idempotency cache rather than on ReqKeeper's own reservation, this is the
 *                number that would be greater than one, and it would be visible.
 *   dedupedByKey those posts the server recognised as a replay of a key it had already seen,
 *                and answered from cache without executing.
 *   broadcasts   posts - dedupedByKey. The ones that would have moved money.
 *
 * The headline claim is `broadcasts: 1`. `posts: 1` is the stronger statement and the one this
 * design is actually going for: the second worker never reached the provider at all.
 *
 * It also serves a JSON-RPC endpoint, because settlement is not allowed to believe the provider
 * — it reads a receipt independently, checks the receipt's own fee-proxy log, and reconciles
 * against the payment reference. All of that has to work here or the run proves nothing.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { EVENT_TOPIC, referenceTopic } from "../src/chain.ts";
import { ERC20_FEE_PROXY, FAU } from "../src/plan.ts";

export interface FixtureCounters {
  /** Every non-simulate POST to the execute route. */
  readonly posts: number;
  /** Those answered from the idempotency cache without executing. */
  readonly dedupedByKey: number;
  /** Posts that would have moved money. */
  readonly broadcasts: number;
  readonly simulates: number;
  /** Distinct idempotency keys seen on the execute route. */
  readonly distinctKeys: number;
}

interface Executed {
  readonly executionId: string;
  readonly transactionHash: string;
  readonly blockNumber: number;
  readonly reference: string;
  readonly to: string;
  readonly amount: string;
}

const SEPOLIA_HEX = "0xaa36a7";
const HEAD_BLOCK = 1_000_000;
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/**
 * The 32-byte words a TransferWithReferenceAndFee log carries, in emission order:
 * tokenAddress, to, amount, feeAmount, feeAddress. The reference is an INDEXED bytes
 * parameter, so it is not in `data` at all — it is a topic, and an indexed dynamic parameter
 * is removed from the data rather than replaced by an offset.
 */
function paymentLogData(to: string, amount: string): string {
  return "0x" + word(FAU) + word(to) + word(BigInt(amount).toString(16)) + word("0") + word(`0x${"0".repeat(40)}`);
}

export class KeeperHubFixture {
  #server: Server | null = null;
  #port = 0;
  #seq = 0;
  #posts = 0;
  #deduped = 0;
  #simulates = 0;
  /** Keyed by Idempotency-Key, so a replay is answered rather than executed twice. */
  readonly #byKey = new Map<string, Executed>();
  /** Every execution, in order, so the race artifact can show what actually happened. */
  readonly #executions: Executed[] = [];

  get port(): number {
    return this.#port;
  }
  get baseUrl(): string {
    return `http://127.0.0.1:${this.#port}/api`;
  }
  get rpcUrl(): string {
    return `http://127.0.0.1:${this.#port}/rpc`;
  }
  get executions(): readonly Executed[] {
    return this.#executions;
  }

  counters(): FixtureCounters {
    return {
      posts: this.#posts,
      dedupedByKey: this.#deduped,
      broadcasts: this.#posts - this.#deduped,
      simulates: this.#simulates,
      distinctKeys: this.#byKey.size,
    };
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      void this.#route(req, res);
    });
    await new Promise<void>((resolve) => {
      this.#server?.listen(0, "127.0.0.1", () => {
        const addr = this.#server?.address();
        this.#port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const s = this.#server;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
    this.#server = null;
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const body = await readBody(req);

    if (url.startsWith("/counters")) return json(res, 200, this.counters());
    if (url.startsWith("/rpc")) return this.#rpc(res, body);
    if (url.startsWith("/api/execute/contract-call")) return this.#execute(req, res, body);
    // `paid` is how a worker asks "did THIS transaction pay THIS invoice" without a real chain.
    if (url.startsWith("/paid")) {
      const q = new URL(url, "http://x");
      const ref = (q.searchParams.get("reference") ?? "").toLowerCase();
      const hash = (q.searchParams.get("txHash") ?? "").toLowerCase();
      const hit = this.#executions.find(
        (e) => e.reference.toLowerCase() === ref && (hash === "" || e.transactionHash.toLowerCase() === hash),
      );
      return json(res, 200, { paid: hit !== undefined, txHash: hit?.transactionHash ?? null, amount: hit?.amount ?? null });
    }
    return json(res, 404, { error: `no route ${url}` });
  }

  #execute(req: IncomingMessage, res: ServerResponse, raw: string): void {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: "unparseable body" });
    }

    if (parsed.simulate === true) {
      this.#simulates++;
      return json(res, 200, { success: true, status: "simulated", gasEstimate: "74618", wouldRevert: false });
    }

    // Everything past this line is a call that can move value. Counted before anything else,
    // so a bug in the branches below cannot hide one.
    this.#posts++;

    const key = String(req.headers["idempotency-key"] ?? "");
    const cached = key === "" ? undefined : this.#byKey.get(key);
    if (cached) {
      this.#deduped++;
      return json(res, 202, {
        executionId: cached.executionId,
        status: "completed",
        transactionHash: cached.transactionHash,
        idempotentReplay: true,
      });
    }

    const args = parseArgs(parsed.functionArgs);
    this.#seq++;
    const executed: Executed = {
      executionId: `exec-fixture-${this.#seq}`,
      transactionHash: `0x${this.#seq.toString(16).padStart(4, "0")}${"ab".repeat(30)}`,
      blockNumber: HEAD_BLOCK - 6,
      reference: args.reference,
      to: args.to,
      amount: args.amount,
    };
    if (key !== "") this.#byKey.set(key, executed);
    this.#executions.push(executed);
    return json(res, 202, {
      executionId: executed.executionId,
      status: "completed",
      transactionHash: executed.transactionHash,
    });
  }

  /** Enough JSON-RPC for an independent receipt read, a depth check and a log scan. */
  #rpc(res: ServerResponse, raw: string): void {
    let call: { method?: string; params?: unknown[] } = {};
    try {
      call = JSON.parse(raw) as typeof call;
    } catch {
      return json(res, 200, { jsonrpc: "2.0", id: 1, error: { message: "unparseable" } });
    }
    const reply = (result: unknown) => json(res, 200, { jsonrpc: "2.0", id: 1, result });

    switch (call.method) {
      case "eth_chainId":
        return reply(SEPOLIA_HEX);
      case "eth_blockNumber":
        return reply(`0x${HEAD_BLOCK.toString(16)}`);
      case "eth_getLogs": {
        // Request's own detection, served from what this fixture actually executed. Filtered
        // the way the real scan filters — emitter, event topic, and the keccak of the reference
        // BYTES (it is an indexed dynamic parameter, so the topic is a hash, not the value).
        const f = (call.params?.[0] ?? {}) as { address?: string; topics?: string[] };
        const wantRef = f.topics?.[1];
        const hits = this.#executions
          .filter((e) => (!f.address || sameAddress(f.address, ERC20_FEE_PROXY)) && (!wantRef || referenceTopic(e.reference) === wantRef))
          .map((e) => ({
            address: ERC20_FEE_PROXY,
            topics: [EVENT_TOPIC, referenceTopic(e.reference)],
            data: paymentLogData(e.to, e.amount),
            transactionHash: e.transactionHash,
            blockNumber: `0x${e.blockNumber.toString(16)}`,
          }));
        return reply(hits);
      }
      case "eth_getTransactionReceipt": {
        const hash = String(call.params?.[0] ?? "").toLowerCase();
        const e = this.#executions.find((x) => x.transactionHash.toLowerCase() === hash);
        if (!e) return reply(null);
        return reply({
          status: "0x1",
          gasUsed: "0x123da",
          // A forwarder, exactly like the real thing: the fee proxy is a log emitter nested
          // inside somebody else's transaction, never the transaction's own target.
          to: "0x5af5194b4b0909eb978e3cf1e25333852277f07d",
          blockNumber: `0x${e.blockNumber.toString(16)}`,
          logs: [{ address: ERC20_FEE_PROXY, data: paymentLogData(e.to, e.amount), topics: [] }],
        });
      }
      default:
        return reply(null);
    }
  }
}

function parseArgs(functionArgs: unknown): { to: string; amount: string; reference: string } {
  // KeeperHub takes functionArgs as a JSON STRING, not an array. The provider serialises it
  // that way deliberately so a retry re-serialises byte-identically.
  let list: unknown[] = [];
  try {
    list = typeof functionArgs === "string" ? (JSON.parse(functionArgs) as unknown[]) : ((functionArgs as unknown[]) ?? []);
  } catch {
    list = [];
  }
  const at = (i: number) => String(list[i] ?? "");
  // transferFromWithReferenceAndFee(token, to, amount, reference, feeAmount, feeAddress)
  return { to: at(1) || `0x${"0".repeat(40)}`, amount: at(2) || "0", reference: at(3) || "0x" };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
