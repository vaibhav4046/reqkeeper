/**
 * Independent chain reads. Nothing here talks to the execution provider, deliberately:
 * these are the functions that get to contradict it.
 */
import { keccak256Hex } from "./keccak.js";
import { ERC20_FEE_PROXY } from "./plan.js";
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
export const EVENT_TOPIC = keccak256Hex("TransferWithReferenceAndFee(address,address,uint256,bytes,uint256,address)");
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
const chainChecks = new Map();
export async function assertChainId(rpcUrl, expected = EXPECTED_CHAIN_ID) {
    const raw = (await rpcCallOnce(rpcUrl, "eth_chainId", [], 15_000));
    if (raw === null || raw === undefined)
        throw new Error(`${rpcUrl} did not answer eth_chainId`);
    const actual = Number(BigInt(raw));
    if (actual !== expected) {
        throw new Error(`refusing to read chain ${actual} from ${rpcUrl}: this settlement is on chain ${expected}. ` +
            "A transaction hash is only unique within one chain.");
    }
}
function ensureChain(rpcUrl) {
    const existing = chainChecks.get(rpcUrl);
    if (existing)
        return existing;
    const check = assertChainId(rpcUrl);
    chainChecks.set(rpcUrl, check);
    // An unreachable endpoint should be retried; a wrong-chain endpoint should not.
    check.catch((e) => {
        if (!/refusing to read chain/.test(e.message))
            chainChecks.delete(rpcUrl);
    });
    return check;
}
export function referenceTopic(reference) {
    let hex = reference.replace(/^0x/, "");
    if (hex.length % 2 !== 0)
        hex = "0" + hex;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return keccak256Hex(bytes);
}
async function rpcCallOnce(rpcUrl, method, params, timeoutMs) {
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
export async function rpcCall(rpcUrl, method, params, timeoutMs = 30_000) {
    const result = await rpcCallOnce(rpcUrl, method, params, timeoutMs);
    if (result !== null && result !== undefined)
        return result;
    if (!NULLABLE_IS_UNKNOWN.has(method))
        return result;
    // The endpoint disclaimed knowledge of a transaction. Ask the others before
    // concluding it does not exist; only agreement across endpoints is evidence.
    for (const alt of RPC_FALLBACKS) {
        if (alt === rpcUrl)
            continue;
        try {
            const second = await rpcCallOnce(alt, method, params, timeoutMs);
            if (second !== null && second !== undefined)
                return second;
        }
        catch {
            // an unreachable fallback tells us nothing; keep asking
        }
    }
    return result;
}
const sameAddress = (a, b) => a.toLowerCase() === b.toLowerCase();
export function matchPaymentLog(log, expect) {
    const conflicts = [];
    // The same disagreements, classified. Callers that have to BRANCH on which field disagreed get
    // this; the strings stay for the human who has to read the audit row. Parsing the strings was
    // the alternative, and a sentence is not an interface.
    const kinds = [];
    if (log.emitter !== undefined && !sameAddress(log.emitter, ERC20_FEE_PROXY)) {
        conflicts.push(`emitted by ${log.emitter}, not the ERC20FeeProxy ${ERC20_FEE_PROXY}`);
        kinds.push("emitter");
    }
    if (!sameAddress(log.tokenAddress, expect.tokenAddress)) {
        conflicts.push(`pays in token ${log.tokenAddress}, the invoice is in ${expect.tokenAddress}`);
        kinds.push("token");
    }
    if (!sameAddress(log.to, expect.to)) {
        conflicts.push(`pays ${log.to}, the invoice is owed to ${expect.to}`);
        kinds.push("to");
    }
    if (log.amount !== expect.amount) {
        conflicts.push(`moves ${log.amount}, the invoice is ${expect.amount}`);
        kinds.push("amount");
    }
    if (expect.feeAmount !== undefined && log.feeAmount !== expect.feeAmount) {
        conflicts.push(`pays a fee of ${log.feeAmount}, the plan fee is ${expect.feeAmount}`);
        kinds.push("fee");
    }
    if (expect.feeAddress !== undefined && !sameAddress(log.feeAddress, expect.feeAddress)) {
        conflicts.push(`sends the fee to ${log.feeAddress}, not ${expect.feeAddress}`);
        kinds.push("feeAddress");
    }
    return { ok: conflicts.length === 0, conflicts, kinds };
}
/**
 * Is this a log that paid OUR payee in OUR token under our reference, but for the wrong amount or
 * fee?
 *
 * The distinction decides whether an obligation is released or escalated, and getting it wrong is
 * costly in both directions. Escalate on every conflicting log and anyone who can read a public
 * payment reference can wedge any invoice for ever with one junk log. Release on every conflicting
 * log and a dry run that leaked (#1959) with different fields gets paid a second time, out of our
 * own funds.
 *
 * Nobody else has a reason to pay our payee, in our token, under our reference. That shape is our
 * money moving in a plan we did not make, and it is the one that belongs in front of a human.
 */
export function amountOrFeeConflict(sighting) {
    const kinds = sighting.conflictKinds;
    if (!kinds || kinds.length === 0)
        return false;
    const wrongCounterparty = kinds.includes("token") || kinds.includes("to") || kinds.includes("emitter");
    const wrongValue = kinds.includes("amount") || kinds.includes("fee") || kinds.includes("feeAddress");
    return wrongValue && !wrongCounterparty;
}
/**
 * The single place a sighting becomes a decision.
 *
 * `requireCorroboration` is for callers deciding whether to treat a payment as THIS obligation's
 * settlement, where an uncorroborated positive must not count. A caller merely reporting what is
 * on chain passes false and gets the sighting's own word.
 */
export function verdictFor(sighting, opts = {}) {
    if (!sighting) {
        return { kind: "UNKNOWN", reason: "UNREADABLE", detail: "the chain could not be read" };
    }
    if (sighting.found === true) {
        // A positive only one endpoint can see is not a positive. `corroborated: null` means no
        // second endpoint answered at all, which is different from one disagreeing.
        if (opts.requireCorroboration && sighting.corroborated === false) {
            return {
                kind: "UNKNOWN",
                reason: "UNCORROBORATED",
                detail: "a log was seen but no second endpoint confirmed it",
            };
        }
        return {
            kind: "PAID",
            txHash: sighting.txHash ?? "",
            ...(sighting.block === undefined ? {} : { block: sighting.block }),
        };
    }
    // A negative that carries conflicts is not a negative. A log DID carry this reference and
    // disagreed about the payment; discarding that is how an invoice already paid for a different
    // fee got paid a second time.
    if (sighting.conflicts && sighting.conflicts.length > 0) {
        return {
            kind: "UNKNOWN",
            reason: "CONFLICTS",
            detail: `a log carries this reference but disagrees: ${sighting.conflicts.join("; ")}`,
            conflicts: sighting.conflicts,
            ...(sighting.conflictKinds ? { conflictKinds: sighting.conflictKinds } : {}),
        };
    }
    // Only an explicit `false` is a covered window. Absent means the reader did not say.
    if (sighting.truncated !== false) {
        return {
            kind: "UNKNOWN",
            reason: "TRUNCATED",
            detail: "the scan did not cover the window a payment for this obligation could be in",
        };
    }
    return {
        kind: "NOT_PAID",
        ...(sighting.scannedFrom === undefined ? {} : { scannedFrom: sighting.scannedFrom }),
        ...(sighting.scannedTo === undefined ? {} : { scannedTo: sighting.scannedTo }),
    };
}
/**
 * The five non-indexed words: tokenAddress, to, amount, feeAmount, feeAddress.
 *
 * There is no offset placeholder among them. An indexed dynamic parameter is removed from
 * `data` entirely rather than replaced, which is why `amount` is word 2 and not word 3 — a
 * detail worth stating, because a comment in this file used to claim otherwise and the next
 * person to "fix" the correct offset would have broken every amount check at once.
 */
export function decodePaymentLogFields(data) {
    const d = data.replace(/^0x/, "");
    if (d.length < 320)
        return null;
    const word = (i) => d.slice(i * 64, i * 64 + 64);
    const addr = (i) => `0x${word(i).slice(24)}`;
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
export const DEFAULT_LOOKBACK = 450_000;
/**
 * Request Network's payment detection, as a direct chain read: find the ERC20FeeProxy event
 * carrying this payment reference. This is the same evidence Request's own indexer uses, so
 * agreeing with it does not depend on Request's API being up.
 *
 * Scans backwards from head in permitted chunks and stops at the first hit, because a payment
 * we care about is almost always recent. `truncated` says whether the window ran out before it
 * reached the block below which there is nothing to find — a `found: false` with
 * `truncated: true` means "not seen", never "unpaid".
 */
export async function findPaymentByReference(reference, opts = {}) {
    const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC;
    await ensureChain(rpcUrl);
    const head = await currentBlock(rpcUrl);
    const requested = opts.fromBlock !== undefined
        ? Math.max(0, opts.fromBlock)
        : Math.max(0, head - (opts.lookbackBlocks ?? DEFAULT_LOOKBACK));
    // An anchor above the head is not an anchor. It cannot be a real create block, and honouring
    // it would let a wrong number assert coverage of a window that does not exist yet.
    const claimedAnchor = opts.anchorBlock === undefined ? undefined : Math.max(0, opts.anchorBlock);
    const anchorFloor = claimedAnchor !== undefined && claimedAnchor <= head ? claimedAnchor : undefined;
    const floor = anchorFloor === undefined ? requested : Math.min(requested, anchorFloor);
    /**
     * Genesis is not the bar. Requiring `floor === 0` made every real scan inconclusive, which
     * made `PREFLIGHT_UNAVAILABLE` — the only way back for an obligation whose preflight failed —
     * unreachable against the live chain, and wedged those obligations permanently.
     *
     * A caller that names the anchor gets a conclusive answer. A caller that names nothing has
     * given this function no floor to prove coverage against, so it stays inconclusive: "I could
     * not tell" must never quietly become "go ahead", which is the whole point of the flag.
     */
    // Measured, not asserted. The previous form was `floor > (anchorFloor ?? 0)` with
    // `floor = min(requested, anchorFloor)`, which is unsatisfiable: supplying ANY anchor made
    // `truncated` false unconditionally, so the flag stopped being a statement about what was
    // scanned and became a restatement of what the caller claimed. An anchor above the true create
    // block -- which `storageAnchor` could produce from a multi-action channel with no forgery
    // involved -- then asserted coverage of a window the scan never reached, and an invoice paid
    // before that window read as unpaid at the one gate that guards against paying it twice.
    //
    // The question is only ever: did the scan reach the floor below which no payment for this
    // obligation can exist? With an anchor that floor is the anchor. Without one there is no such
    // floor short of genesis, and the answer stays inconclusive.
    const truncated = anchorFloor === undefined ? floor > 0 : floor > anchorFloor;
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
        if (alt === rpcUrl)
            continue;
        try {
            await ensureChain(alt);
            // Conflicts from the FIRST scan survive the fallback. The re-scan exists because a public
            // endpoint can return zero logs for a log that plainly exists -- measured against this
            // project's own payment -- but rescuing `found` while dropping `conflicts` throws away the
            // one field that says "a log carried this reference and paid something else".
            const second = await scanForReference(reference, alt, head, floor, opts.expect);
            if (second.found) {
                // The primary said no and this endpoint says yes. The primary IS the second opinion
                // here — it has already disagreed — so the sighting is reported uncorroborated and the
                // caller decides. It is enough to refuse a payment, not enough to declare one settled.
                return { ...second, corroborated: false };
            }
            // A negative from the fallback can still carry conflicts the primary never saw, and those
            // outrank a bare negative: a log that carries this reference and pays the wrong amount is
            // not "no payment", it is a question. Merged rather than dropped.
            if (second.conflicts && second.conflicts.length > 0 && !(first.conflicts && first.conflicts.length > 0)) {
                return {
                    ...first,
                    conflicts: second.conflicts,
                    ...(second.conflictKinds ? { conflictKinds: second.conflictKinds } : {}),
                    truncated,
                    scannedFrom: floor,
                };
            }
        }
        catch {
            // an unreachable endpoint is not a second opinion; keep asking
        }
    }
    // The window is reported with the negative, not separately: a caller that has to ask a second
    // question to find out whether the first answer meant anything will eventually stop asking.
    return { ...first, truncated, scannedFrom: floor };
}
async function scanForReference(reference, rpcUrl, head, floor, expect) {
    const topics = [EVENT_TOPIC, referenceTopic(reference)];
    let to = head;
    const conflicts = [];
    const conflictKinds = [];
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
        for (const log of logs) {
            const fields = decodePaymentLogFields(log.data);
            if (!fields) {
                conflicts.push(`log in ${log.transactionHash} carries this reference but is not a payment event`);
                continue;
            }
            const sighting = {
                found: true,
                txHash: log.transactionHash,
                block: log.blockNumber === undefined ? undefined : Number(BigInt(log.blockNumber)),
                scannedBlocks: head - from + 1,
                ...fields,
            };
            if (!expect)
                return sighting;
            const verdict = matchPaymentLog({ ...fields, emitter: log.address }, expect);
            if (verdict.ok)
                return sighting;
            // Carries our reference, pays something else. Do not settle on it, and do not
            // pretend it was never there: the caller has to hear about it.
            conflicts.push(`${log.transactionHash}: ${verdict.conflicts.join("; ")}`);
            conflictKinds.push(...verdict.kinds);
        }
        if (from === floor)
            break;
        to = from - 1;
    }
    // No `truncated` here: whether this window was wide enough depends on the floor the CALLER
    // could name, which this function is not told. `findPaymentByReference` decides it.
    return {
        found: false,
        scannedBlocks: head - floor + 1,
        // The CEILING, not just the depth. A scan's floor says how far back it looked; its ceiling
        // says how recently. `eth_getLogs` cannot see the mempool, so a transaction broadcast a
        // moment ago is absent from a scan that covered everything and is being honest about it.
        // Only the ceiling can tell a caller whether enough chain has passed for that to matter.
        scannedTo: head,
        ...(conflicts.length > 0 ? { conflicts } : {}),
        ...(conflictKinds.length > 0 ? { conflictKinds } : {}),
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
async function corroborate(reference, sighting, primaryUrl, expect) {
    if (sighting.block === undefined || sighting.txHash === undefined)
        return false;
    for (const alt of RPC_FALLBACKS) {
        if (alt === primaryUrl)
            continue;
        try {
            await ensureChain(alt);
            const second = await scanForReference(reference, alt, sighting.block, sighting.block, expect);
            if (second.found && second.txHash?.toLowerCase() === sighting.txHash.toLowerCase())
                return true;
        }
        catch {
            // An unreachable endpoint is not a second opinion. Keep asking.
        }
    }
    return false;
}
export async function currentBlock(rpcUrl = DEFAULT_RPC) {
    return Number(BigInt((await rpcCall(rpcUrl, "eth_blockNumber", []))));
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
export async function readReceipt(rpcUrl, hash, timeoutMs = 30_000) {
    try {
        await ensureChain(rpcUrl);
    }
    catch (e) {
        // An endpoint that will not answer is "I could not read", the same as any other transport
        // failure. An endpoint on the WRONG CHAIN is different in kind: it is answering, and its
        // answer would be about a different chain's transaction with a colliding hash. That is a
        // refusal, and it propagates.
        if (/refusing to read chain/.test(e instanceof Error ? e.message : String(e)))
            throw e;
        return { hash, verified: false, receiptStatus: "timeout", gasUsed: "0" };
    }
    let r;
    try {
        r = (await rpcCall(rpcUrl, "eth_getTransactionReceipt", [hash], timeoutMs));
    }
    catch {
        return { hash, verified: false, receiptStatus: "timeout", gasUsed: "0" };
    }
    if (!r)
        return { hash, verified: false, receiptStatus: "not_found", gasUsed: "0" };
    const gasUsed = r.gasUsed ? BigInt(r.gasUsed).toString(10) : "0";
    const blockNumber = r.blockNumber === undefined ? undefined : Number(BigInt(r.blockNumber));
    let confirmations;
    if (blockNumber !== undefined) {
        try {
            confirmations = Math.max(0, (await currentBlock(rpcUrl)) - blockNumber + 1);
        }
        catch {
            // Depth unknown is not depth zero. Left undefined so a caller can tell the difference.
        }
    }
    const common = { hash, gasUsed, to: r.to, logs: r.logs, blockNumber, confirmations };
    // Three outcomes, not two. Only 0x0 means the chain said no; a missing or malformed status
    // means this read did not answer, and EXECUTION_REVERTED is terminal.
    if (r.status === "0x1")
        return { ...common, verified: true, receiptStatus: "success" };
    if (r.status === "0x0")
        return { ...common, verified: true, receiptStatus: "reverted" };
    return { ...common, verified: false, receiptStatus: "not_found" };
}
