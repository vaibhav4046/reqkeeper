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
const EVENT_TOPIC = keccak256Hex(
  "TransferWithReferenceAndFee(address,address,uint256,bytes,uint256,address)",
);

function referenceTopic(reference: string): string {
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

export interface PaymentSighting {
  readonly found: boolean;
  readonly txHash?: string;
  readonly amount?: string;
  /** How far back the scan actually looked. A false with a small window is not "unpaid". */
  readonly scannedBlocks?: number;
  readonly truncated?: boolean;
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
  } = {},
): Promise<PaymentSighting> {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC;
  const head = await currentBlock(rpcUrl);
  const floor =
    opts.fromBlock !== undefined
      ? Math.max(0, opts.fromBlock)
      : Math.max(0, head - (opts.lookbackBlocks ?? DEFAULT_LOOKBACK));

  const first = await scanForReference(reference, rpcUrl, head, floor);
  if (first.found) return first;

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
      const second = await scanForReference(reference, alt, head, floor);
      if (second.found) return second;
    } catch {
      // an unreachable endpoint is not a second opinion; keep asking
    }
  }
  return first;
}

async function scanForReference(
  reference: string,
  rpcUrl: string,
  head: number,
  floor: number,
): Promise<PaymentSighting> {
  const topics = [EVENT_TOPIC, referenceTopic(reference)];
  let to = head;
  while (to >= floor) {
    const from = Math.max(floor, to - MAX_RANGE + 1);
    const logs = (await rpcCall(rpcUrl, "eth_getLogs", [
      {
        address: ERC20_FEE_PROXY,
        topics,
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
      },
    ])) as Array<{ data: string; transactionHash: string }>;

    if (logs.length > 0) {
      // non-indexed words: tokenAddress, to, amount, <bytes offset>, feeAmount, feeAddress
      const d = logs[0].data.slice(2);
      return {
        found: true,
        txHash: logs[0].transactionHash,
        amount: BigInt(`0x${d.slice(128, 192)}`).toString(10),
        scannedBlocks: head - from + 1,
      };
    }
    if (from === floor) break;
    to = from - 1;
  }

  return { found: false, scannedBlocks: head - floor + 1, truncated: floor > 0 };
}

export async function currentBlock(rpcUrl = DEFAULT_RPC): Promise<number> {
  return Number(BigInt((await rpcCall(rpcUrl, "eth_blockNumber", [])) as string));
}
