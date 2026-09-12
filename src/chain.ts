/**
 * Independent chain reads. Nothing here talks to the execution provider, deliberately:
 * these are the functions that get to contradict it.
 */

import { keccak256Hex } from "./keccak.ts";
import { ERC20_FEE_PROXY } from "./plan.ts";

export const DEFAULT_RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";

/**
 * Public Sepolia endpoints prune receipts. publicnode answers `eth_getTransactionReceipt`
 * with `result: null` for transactions it still returns in full from `eth_getTransactionByHash`,
 * which reads downstream exactly like "this payment never landed" — the one conclusion this
 * module exists to get right. A null here is therefore treated as "this endpoint does not know",
 * not as an answer, and the question is put to another endpoint before we believe it.
 *
 * Order matters: publicnode stays first because its `eth_getLogs` range cap is what MAX_RANGE
 * below is tuned against.
 */
const RPC_FALLBACKS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.gateway.tenderly.co",
  "https://sepolia.drpc.org",
];

/** Methods where a null result may mean "pruned" rather than "absent". */
const NULLABLE_IS_UNKNOWN = new Set([
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
]);

/**
 * `TransferWithReferenceAndFee`'s `paymentReference` is an INDEXED bytes parameter, so the
 * topic is the keccak hash of the reference bytes, not the bytes themselves. Getting this
 * wrong returns zero logs and looks exactly like "not paid yet".
 */
export const EVENT_TOPIC = keccak256Hex(
  "TransferWithReferenceAndFee(address,address,uint256,bytes,uint256,address)",
);

/**
 * Sepolia. Hardcoded rather than configurable, because every address, selector and piece of
 * recorded evidence in this repository is Sepolia's, and "it read the wrong chain" is not a
 * failure mode worth leaving open for a convenience nobody asked for.
 */
export const EXPECTED_CHAIN_ID = 11155111;

/**
 * An RPC URL is a string. Nothing about it says which chain answers.
 *
 * `grep -rn "eth_chainId" src/` used to return nothing: the settle path read receipts and logs
 * from whatever `SEPOLIA_RPC` pointed at and believed the answer. A transaction hash is only
 * unique within a chain, so a receipt fetched from the wrong chain for a colliding hash was
 * accepted as this chain's receipt. The assertions that did exist lived in scripts the
 * settlement path never calls.
 *
 * Asked once per endpoint per process and memoised, including the rejection: an endpoint that
 * answered with the wrong chain is not asked again, it is refused again.
 */
const chainChecks = new Map<string, Promise<void>>();

export async function assertChainId(rpcUrl: string, expected = EXPECTED_CHAIN_ID): Promise<void> {
  const raw = (await rpcCallOnce(rpcUrl, "eth_chainId", [], 15_000)) as string | null;
  if (raw === null || raw === undefined) throw new Error(`${rpcUrl} did not answer eth_chainId`);
  const actual = Number(BigInt(raw));
  if (actual !== expected) {
    throw new Error(
      `refusing to read chain ${actual} from ${rpcUrl}: this settlement is on chain ${expected}. ` +
        "A transaction hash is only unique within one chain.",
    );
  }
}

function ensureChain(rpcUrl: string): Promise<void> {
  const existing = chainChecks.get(rpcUrl);
  if (existing) return existing;
  const check = assertChainId(rpcUrl);
  chainChecks.set(rpcUrl, check);
  // An unreachable endpoint should be retried; a wrong-chain endpoint should not.
  check.catch((e: Error) => {
    if (!/refusing to read chain/.test(e.message)) chainChecks.delete(rpcUrl);
  });
  return check;
}

export function referenceTopic(reference: string): string {
  let hex = reference.replace(/^0x/, "");
  if (hex.length % 2 !== 0) hex = "0" + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return keccak256Hex(bytes);
}

async function rpcCallOnce(
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs = 30_000,
): Promise<unknown> {
  const result = await rpcCallOnce(rpcUrl, method, params, timeoutMs);
  if (result !== null && result !== undefined) return result;
  if (!NULLABLE_IS_UNKNOWN.has(method)) return result;

  // The endpoint disclaimed knowledge of a transaction. Ask the others before
  // concluding it does not exist; only agreement across endpoints is evidence.
  for (const alt of RPC_FALLBACKS) {
    if (alt === rpcUrl) continue;
    try {
      const second = await rpcCallOnce(alt, method, params, timeoutMs);
      if (second !== null && second !== undefined) return second;
    } catch {
      // an unreachable fallback tells us nothing; keep asking
    }
  }
  return result;
}

/**
 * Every non-indexed field of `TransferWithReferenceAndFee`.
 *
 * The reference alone was the only thing ever compared, and the reference is public: it is
 * derived from data anchored openly on Sepolia, so anyone can read one off-chain and emit a
 * fee-proxy event carrying it. Reconciling on the reference means accepting that event as
 * proof this invoice was paid.
 */
export interface PaymentLogFields {
  readonly tokenAddress: string;
  readonly to: string;
  readonly amount: string;
  readonly feeAmount: string;
  readonly feeAddress: string;
}

export interface PaymentSighting extends Partial<PaymentLogFields> {
  readonly found: boolean;
  readonly txHash?: string;
  readonly block?: number;
  /** How far back the scan actually looked. A false with a small window is not "unpaid". */
  readonly scannedBlocks?: number;
  readonly truncated?: boolean;
  /**
   * A second, independent endpoint returned the same transaction for this reference.
   * `found: true` without this is one endpoint's unverified word, and one endpoint has been
   * observed answering wrongly in both directions.
   */
  readonly corroborated?: boolean;
  /**
   * Set when a log carried this reference but disagreed about the payment itself. This is
   * EVIDENCE_CONFLICT, not "unpaid" and certainly not "paid".
   */
  readonly conflicts?: readonly string[];
}

/** What a log has to say before it counts as paying THIS obligation. */
export interface PaymentExpectation {
  readonly tokenAddress: string;
  readonly to: string;
  readonly amount: string;
  readonly feeAmount?: string;
  readonly feeAddress?: string;
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Does this log actually pay this obligation?
 *
 * Emitter, token, payee, amount and fee — not the reference alone. A log that matches the
 * reference but not the fields is somebody else's transaction, and reporting it as settlement
 * is how an obligation ends up citing a payment it never made. Returns the disagreements
 * rather than a bare false, because "which field" is the difference between an attack, a
 * misconfiguration and a rounding bug.
 */
export function matchPaymentLog(
  log: PaymentLogFields & { readonly emitter?: string },
  expect: PaymentExpectation,
): { ok: boolean; conflicts: string[] } {
  const conflicts: string[] = [];
  if (log.emitter !== undefined && !sameAddress(log.emitter, ERC20_FEE_PROXY)) {
    conflicts.push(`emitted by ${log.emitter}, not the ERC20FeeProxy ${ERC20_FEE_PROXY}`);
  }
  if (!sameAddress(log.tokenAddress, expect.tokenAddress)) {
    conflicts.push(`pays in token ${log.tokenAddress}, the invoice is in ${expect.tokenAddress}`);
  }
  if (!sameAddress(log.to, expect.to)) {
    conflicts.push(`pays ${log.to}, the invoice is owed to ${expect.to}`);
  }
  if (log.amount !== expect.amount) {
    conflicts.push(`moves ${log.amount}, the invoice is ${expect.amount}`);
  }
  if (expect.feeAmount !== undefined && log.feeAmount !== expect.feeAmount) {
    conflicts.push(`pays a fee of ${log.feeAmount}, the plan fee is ${expect.feeAmount}`);
  }
  if (expect.feeAddress !== undefined && !sameAddress(log.feeAddress, expect.feeAddress)) {
    conflicts.push(`sends the fee to ${log.feeAddress}, not ${expect.feeAddress}`);
  }
  return { ok: conflicts.length === 0, conflicts };
}

/**
 * The five non-indexed words: tokenAddress, to, amount, feeAmount, feeAddress.
 *
 * There is no offset placeholder among them. An indexed dynamic parameter is removed from
 * `data` entirely rather than replaced, which is why `amount` is word 2 and not word 3 — a
 * detail worth stating, because a comment in this file used to claim otherwise and the next
 * person to "fix" the correct offset would have broken every amount check at once.
 */
export function decodePaymentLogFields(data: string): PaymentLogFields | null {
  const d = data.replace(/^0x/, "");
  if (d.length < 320) return null;
  const word = (i: number) => d.slice(i * 64, i * 64 + 64);
  const addr = (i: number) => `0x${word(i).slice(24)}`;
  return {
    tokenAddress: addr(0),
    to: addr(1),
    amount: BigInt(`0x${word(2)}`).toString(10),
    feeAmount: BigInt(`0x${word(3)}`).toString(10),
    feeAddress: addr(4),
  };
}

/**
 * Public RPCs cap `eth_getLogs` ranges. publicnode's Sepolia endpoint answers
 * `exceed maximum block range: 50000`, so a single `fromBlock: "earliest"` query — the
 * obvious way to write this — fails for every caller rather than returning nothing.
 */
const MAX_RANGE = 45_000;
const DEFAULT_LOOKBACK = 450_000;

/**
 * Request Network's payment detection, as a direct chain read: find the ERC20FeeProxy event
 * carrying this payment reference. This is the same evidence Request's own indexer uses, so
 * agreeing with it does not depend on Request's API being up.
 *
 * Scans backwards from head in permitted chunks and stops at the first hit, because a payment
 * we care about is almost always recent. `truncated` says whether the window ran out before
 * genesis — a `found: false` with `truncated: true` means "not seen recently", never "unpaid".
 */
export async function findPaymentByReference(
  reference: string,
  opts: {
    rpcUrl?: string;
    fromBlock?: number;
    lookbackBlocks?: number;
    /**
     * The payment this obligation is owed. Supplied by every caller that can decide money;
     * without it a log is matched on its reference alone, which is what made a foreign
     * transaction look like settlement.
     */
    expect?: PaymentExpectation;
  } = {},
): Promise<PaymentSighting> {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC;
  await ensureChain(rpcUrl);
  const head = await currentBlock(rpcUrl);
  const floor =
    opts.fromBlock !== undefined
      ? Math.max(0, opts.fromBlock)
      : Math.max(0, head - (opts.lookbackBlocks ?? DEFAULT_LOOKBACK));

  const first = await scanForReference(reference, rpcUrl, head, floor, opts.expect);
  if (first.found) {
    return { ...first, corroborated: await corroborate(reference, first, rpcUrl, opts.expect) };
  }

  /**
   * A negative is the dangerous answer: it is the one that reads as "this invoice is
   * unpaid, go ahead and pay it". publicnode has been observed returning an empty
   * `eth_getLogs` for a fee-proxy log that demonstrably exists and that other endpoints
   * return, with no error — so a single endpoint's silence is not evidence of absence.
   * Only re-scan on a negative, so the common path still costs one pass.
   */
  for (const alt of RPC_FALLBACKS) {
    if (alt === rpcUrl) continue;
    try {
      await ensureChain(alt);
      const second = await scanForReference(reference, alt, head, floor, opts.expect);
      if (second.found) {
        // The primary said no and this endpoint says yes. The primary IS the second opinion
        // here — it has already disagreed — so the sighting is reported uncorroborated and the
        // caller decides. It is enough to refuse a payment, not enough to declare one settled.
        return { ...second, corroborated: false };
      }
    } catch {
      // an unreachable endpoint is not a second opinion; keep asking
    }
  }
  return first;
}

interface RawLog {
  readonly data: string;
  readonly transactionHash: string;
  readonly address?: string;
  readonly blockNumber?: string;
}

async function scanForReference(
  reference: string,
  rpcUrl: string,
  head: number,
  floor: number,
  expect?: PaymentExpectation,
): Promise<PaymentSighting> {
  const topics = [EVENT_TOPIC, referenceTopic(reference)];
  let to = head;
  const conflicts: string[] = [];

  while (to >= floor) {
    const from = Math.max(floor, to - MAX_RANGE + 1);
    const logs = (await rpcCall(rpcUrl, "eth_getLogs", [
      {
        address: ERC20_FEE_PROXY,
        topics,
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
      },
    ])) as RawLog[];

    for (const log of logs) {
      const fields = decodePaymentLogFields(log.data);
      if (!fields) {
        conflicts.push(`log in ${log.transactionHash} carries this reference but is not a payment event`);
        continue;
      }
      const sighting: PaymentSighting = {
        found: true,
        txHash: log.transactionHash,
        block: log.blockNumber === undefined ? undefined : Number(BigInt(log.blockNumber)),
        scannedBlocks: head - from + 1,
        ...fields,
      };
      if (!expect) return sighting;

      const verdict = matchPaymentLog({ ...fields, emitter: log.address }, expect);
      if (verdict.ok) return sighting;
      // Carries our reference, pays something else. Do not settle on it, and do not
      // pretend it was never there: the caller has to hear about it.
      conflicts.push(`${log.transactionHash}: ${verdict.conflicts.join("; ")}`);
    }

    if (from === floor) break;
    to = from - 1;
  }

  return {
    found: false,
    scannedBlocks: head - floor + 1,
    truncated: floor > 0,
    ...(conflicts.length > 0 ? { conflicts } : {}),
  };
}

/**
 * Ask a second endpoint whether it sees the same transaction for this reference.
 *
 * A one-block range, so it costs one cheap query. `found: true` is as dangerous as `found:
 * false` once it can mark an obligation SETTLED, and publicnode has been observed answering
 * wrongly in the other direction for this exact query — so a positive from one endpoint is a
 * claim, not evidence.
 */
async function corroborate(
  reference: string,
  sighting: PaymentSighting,
  primaryUrl: string,
  expect?: PaymentExpectation,
): Promise<boolean> {
  if (sighting.block === undefined || sighting.txHash === undefined) return false;
  for (const alt of RPC_FALLBACKS) {
    if (alt === primaryUrl) continue;
    try {
      await ensureChain(alt);
      const second = await scanForReference(reference, alt, sighting.block, sighting.block, expect);
      if (second.found && second.txHash?.toLowerCase() === sighting.txHash.toLowerCase()) return true;
    } catch {
      // An unreachable endpoint is not a second opinion. Keep asking.
    }
  }
  return false;
}

export async function currentBlock(rpcUrl = DEFAULT_RPC): Promise<number> {
  return Number(BigInt((await rpcCall(rpcUrl, "eth_blockNumber", [])) as string));
}


/** The raw JSON-RPC receipt, as the node returns it. */
export interface RawReceipt {
  status?: string;
  gasUsed?: string;
  to?: string;
  blockNumber?: string;
  logs?: Array<{ address?: string; data?: string; topics?: string[] }>;
}

/**
 * The one receipt reader, for every transport.
 *
 * There were four private copies of this, and each one had to learn separately that publicnode
 * answers `result: null` for receipts it still holds. The MCP provider was the last to keep its
 * own `fetch`, so on that transport a pruned null still became `not_found`, which settle reads
 * as EVIDENCE_CONFLICT — a real settlement reported as missing, for the wrong reason, on the
 * path that had just moved money.
 *
 * Reads more than `{status, gasUsed}`: the transaction's own target, its own logs, and how far
 * behind head its block is. The real execution shape is a meta-transaction, so the fee proxy
 * appears only as a log emitter nested inside a forwarder's transaction — and a forwarder that
 * does not bubble an inner revert returns status 0x1 regardless. Without the logs, "the
 * transaction succeeded" and "the payment happened" are indistinguishable here.
 */
export async function readReceipt(
  rpcUrl: string,
  hash: string,
  timeoutMs = 30_000,
): Promise<{
  hash: string;
  verified: boolean;
  receiptStatus: "success" | "reverted" | "not_found" | "timeout";
  gasUsed: string;
  to?: string;
  logs?: Array<{ address?: string; data?: string; topics?: string[] }>;
  blockNumber?: number;
  confirmations?: number;
}> {
  try {
    await ensureChain(rpcUrl);
  } catch (e) {
    // An endpoint that will not answer is "I could not read", the same as any other transport
    // failure. An endpoint on the WRONG CHAIN is different in kind: it is answering, and its
    // answer would be about a different chain's transaction with a colliding hash. That is a
    // refusal, and it propagates.
    if (/refusing to read chain/.test(e instanceof Error ? e.message : String(e))) throw e;
    return { hash, verified: false, receiptStatus: "timeout", gasUsed: "0" };
  }
  let r: RawReceipt | null | undefined;
  try {
    r = (await rpcCall(rpcUrl, "eth_getTransactionReceipt", [hash], timeoutMs)) as RawReceipt | null;
  } catch {
    return { hash, verified: false, receiptStatus: "timeout", gasUsed: "0" };
  }
  if (!r) return { hash, verified: false, receiptStatus: "not_found", gasUsed: "0" };

  const gasUsed = r.gasUsed ? BigInt(r.gasUsed).toString(10) : "0";
  const blockNumber = r.blockNumber === undefined ? undefined : Number(BigInt(r.blockNumber));

  let confirmations: number | undefined;
  if (blockNumber !== undefined) {
    try {
      confirmations = Math.max(0, (await currentBlock(rpcUrl)) - blockNumber + 1);
    } catch {
      // Depth unknown is not depth zero. Left undefined so a caller can tell the difference.
    }
  }

  const common = { hash, gasUsed, to: r.to, logs: r.logs, blockNumber, confirmations };

  // Three outcomes, not two. Only 0x0 means the chain said no; a missing or malformed status
  // means this read did not answer, and EXECUTION_REVERTED is terminal.
  if (r.status === "0x1") return { ...common, verified: true, receiptStatus: "success" };
  if (r.status === "0x0") return { ...common, verified: true, receiptStatus: "reverted" };
  return { ...common, verified: false, receiptStatus: "not_found" };
}
