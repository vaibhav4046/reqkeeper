/**
 * Independent chain reads. Nothing here talks to the execution provider, deliberately:
 * these are the functions that get to contradict it.
 */
import { keccak256Hex } from "./keccak.js";
import { ERC20_FEE_PROXY } from "./plan.js";
export const DEFAULT_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
/**
 * `TransferWithReferenceAndFee`'s `paymentReference` is an INDEXED bytes parameter, so the
 * topic is the keccak hash of the reference bytes, not the bytes themselves. Getting this
 * wrong returns zero logs and looks exactly like "not paid yet".
 */
const EVENT_TOPIC = keccak256Hex("TransferWithReferenceAndFee(address,address,uint256,bytes,uint256,address)");
function referenceTopic(reference) {
    let hex = reference.replace(/^0x/, "");
    if (hex.length % 2 !== 0)
        hex = "0" + hex;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return keccak256Hex(bytes);
}
export async function rpcCall(rpcUrl, method, params, timeoutMs = 30_000) {
    const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json());
    if (body.error)
        throw new Error(`${method}: ${body.error.message}`);
    return body.result;
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
export async function findPaymentByReference(reference, opts = {}) {
    const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC;
    const topics = [EVENT_TOPIC, referenceTopic(reference)];
    const head = await currentBlock(rpcUrl);
    const floor = opts.fromBlock !== undefined
        ? Math.max(0, opts.fromBlock)
        : Math.max(0, head - (opts.lookbackBlocks ?? DEFAULT_LOOKBACK));
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
        ]));
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
        if (from === floor)
            break;
        to = from - 1;
    }
    return { found: false, scannedBlocks: head - floor + 1, truncated: floor > 0 };
}
export async function currentBlock(rpcUrl = DEFAULT_RPC) {
    return Number(BigInt((await rpcCall(rpcUrl, "eth_blockNumber", []))));
}
