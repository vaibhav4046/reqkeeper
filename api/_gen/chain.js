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
const RPC_FALLBACKS = (process.env.REQKEEPER_RPC_ENDPOINTS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
/**
 * The endpoints a negative is corroborated against.
 *
 * Overridable because "which nodes do you trust" is an operator's decision, not a library's: a
 * deployment with its own endpoints should not be forced to consult three public ones, and a
 * harness running against a fixture chain should not silently reach the real Sepolia behind it.
 * That second case was a real failure -- an end-to-end run paired a fixture with a real invoice,
 * the fixture correctly said "not paid", the fallbacks asked the real chain where the invoice IS
 * paid, and the run refused on a contradiction between two different worlds.
 *
 * `REQKEEPER_RPC_ENDPOINTS` is a comma-separated list. Unset means these three.
 */
const DEFAULT_RPC_FALLBACKS = [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://sepolia.gateway.tenderly.co",
    "https://sepolia.drpc.org",
];
const rpcFallbacks = () => (RPC_FALLBACKS.length > 0 ? RPC_FALLBACKS : DEFAULT_RPC_FALLBACKS);
/**
 * The same endpoint, spelled differently. `alt === rpcUrl` let a trailing slash count the primary
 * as its own second opinion -- one physical host, `negativeCorroborations: 2` -- which is the
 * single-endpoint negative this module exists to reject.
 */
function sameEndpoint(a, b) {
    const norm = (u) => u.trim().toLowerCase().replace(/\/+$/, "");
    return norm(a) === norm(b);
}
/**
 * The endpoints a negative has to be put to before it counts, exported so that anything drawing a
 * conclusion from silence uses the same set this module does.
 *
 * A verification script that asks one endpoint and believes an empty `eth_getLogs` reproduces the
 * exact defect this module was built around — measured against this project's own payment, which
 * publicnode returns zero logs for and two other endpoints return in full.
 */
export const negativeCorroborationEndpoints = () => rpcFallbacks();
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
    for (const alt of rpcFallbacks()) {
        if (sameEndpoint(alt, rpcUrl))
            continue;
        try {
            // The chain first. This loop covers exactly the methods `assertChainId` exists for -- a
            // transaction hash is only unique WITHIN a chain -- and it was the one fallback path that
            // skipped the assertion, so a mainnet endpoint could answer a Sepolia receipt query about a
            // colliding hash and its answer would be returned as this chain's. Every other fallback
            // (`corroborate`, the negative re-scan) asserts; this one did not.
            await ensureChain(alt);
            const second = await rpcCallOnce(alt, method, params, timeoutMs);
            if (second !== null && second !== undefined)
                return second;
        }
        catch {
            // an unreachable fallback, or one on the wrong chain, tells us nothing; keep asking
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
export function conflictVerdict(sighting) {
    const logs = sighting.conflictingLogs;
    if (!logs)
        return "UNKNOWN";
    if (logs.length === 0)
        return "NOT_OURS";
    // A log under our reference that could not be decoded is not evidence either way, and ranks
    // above both other answers: it could be this payment in a shape this reader has never seen.
    if (logs.some((log) => log.kinds.includes("undecodable")))
        return "UNKNOWN";
    // ANY single log being ours-and-wrong is the answer. The kinds used to arrive as one flat list
    // accumulated across the whole scan, and a set cannot say which kind came from which log -- so
    // one junk transfer to a stranger contributed `to`, `wrongCounterparty` went true, and a log
    // that really had paid OUR payee in OUR token for the wrong amount was reclassified NOT_OURS.
    // That is the release answer. Payment references are public, so the masking log cost an
    // attacker one unit of a testnet token: two panels reproduced it independently.
    //
    // The repair is the shape, not the predicate. With one entry per log the question "was any log
    // ours and wrong" is answerable again, and a flattened list can no longer be handed in.
    return logs.some((log) => isOursAndWrong(log.kinds)) ? "OURS_AND_WRONG" : "NOT_OURS";
}
/** Our payee, our token, our reference -- and the wrong amount or fee. Nobody else's mistake. */
function isOursAndWrong(kinds) {
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
        // `!== true`, not `=== false`. The comment above states the rule -- absent means no second
        // endpoint ANSWERED, which is not the same as one disagreeing -- and the predicate used to
        // exempt exactly that third state, so an injected sighting with no `corroborated` field read
        // as PAID. Every documented seam (`WatchDeps.findPayment`, `WorkerDeps.sightPayment`,
        // `McpContext.findPayment`) returns a raw sighting, and on the watch path a false PAID
        // suppresses a real debt for ever.
        if (opts.requireCorroboration && sighting.corroborated !== true) {
            return {
                kind: "UNKNOWN",
                reason: "UNCORROBORATED",
                detail: `a log was seen${sighting.txHash ? ` in ${sighting.txHash}` : ""} but no second endpoint confirmed it`,
                ...(sighting.txHash === undefined ? {} : { txHash: sighting.txHash }),
            };
        }
        return {
            kind: "PAID",
            txHash: sighting.txHash ?? "",
            ...(sighting.block === undefined ? {} : { block: sighting.block }),
        };
    }
    // A negative that carries conflicts is not automatically a negative -- but WHICH conflicts
    // decides, and only three answers are honest. `conflictVerdict` is the same reading the worker
    // and the operator release already took, and it lives here now so there is only one of it.
    // There were three, and the copy in this function was the weakest: it returned NOT_PAID for a
    // scan that never said what conflicting logs it saw, and NOT_PAID for a negative no second
    // endpoint would corroborate. Both are "I could not tell" read as "no", in the gate that
    // decides whether to pay at all -- while the two release paths downstream refused on exactly
    // those sightings. One sighting, three readings, and the weakest one guarded the money.
    const conflict = conflictVerdict(sighting);
    const conflicts = sighting.conflicts ?? [];
    // Checked before the window, deliberately: a log that paid our payee our token for the wrong
    // amount was SEEN, and a short window does not unsee it. That one belongs in front of a human
    // whatever else the scan managed to cover.
    if (conflict === "OURS_AND_WRONG") {
        return {
            kind: "CONFLICT_OURS",
            detail: `a log pays this invoice's payee and token under its reference but disagrees: ${conflicts.join("; ")}`,
            conflicts,
            conflictingLogs: sighting.conflictingLogs ?? [],
            ...(sighting.txHash === undefined ? {} : { txHash: sighting.txHash }),
        };
    }
    // Only an explicit `false` is a covered window. Absent means the reader did not say. Ranked
    // above the two checks below because it is the one an operator can act on: a window that did
    // not reach the invoice's anchor explains everything else the scan failed to establish.
    if (sighting.truncated !== false) {
        return {
            kind: "UNKNOWN",
            reason: "TRUNCATED",
            detail: "the scan did not cover the window a payment for this obligation could be in",
        };
    }
    if (conflict === "UNKNOWN") {
        return {
            kind: "UNKNOWN",
            reason: "CONFLICTS_NOT_STATED",
            detail: "the scan never said what conflicting logs it saw, so it has not concluded",
        };
    }
    // How many OTHER endpoints answered this same negative. Deliberately NOT gated on
    // `requireCorroboration`: that option is about whether a POSITIVE counts as this obligation's
    // settlement, and there is no caller for whom one endpoint's silence about an absent log is an
    // answer. publicnode has been observed returning an empty `eth_getLogs` for a fee-proxy log
    // that demonstrably exists, with no error, which is the whole reason a negative is re-asked.
    if ((sighting.negativeCorroborations ?? 0) < 1) {
        return {
            kind: "UNKNOWN",
            reason: "UNCORROBORATED",
            detail: "no second endpoint confirmed this negative, and one endpoint's silence is not absence",
        };
    }
    return {
        kind: "NOT_PAID",
        ...(sighting.scannedFrom === undefined ? {} : { scannedFrom: sighting.scannedFrom }),
        ...(sighting.scannedTo === undefined ? {} : { scannedTo: sighting.scannedTo }),
        ...(conflicts.length === 0 ? {} : { conflicts }),
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
    // An anchor may only ever make this scan DEEPER. Never shallower, and never more confident.
    //
    // This is the whole defence, and it was not here. An anchor says "the invoice did not exist
    // before block N", so a scan that reached N has covered everywhere a payment could be. But the
    // anchor arrives from the gateway, in `meta`, which the channel id does not hash -- and a
    // reviewer demonstrated the consequence end to end: move the anchor forward past a payment that
    // really happened, and `truncated` goes false over a window the scan never reached, so a settled
    // invoice reads NOT_PAID and is paid a second time. Binding the anchor to the transaction that
    // stored the invoice raises the cost of that forgery; it does not remove it, because the same
    // `meta` supplies both halves of the binding.
    //
    // So the anchor's power is cut to the direction that cannot hurt. An anchor BELOW the requested
    // window extends the scan down to it and makes the answer conclusive -- that is the honest case,
    // and it is every real invoice this deployment has. An anchor ABOVE the requested window is
    // claiming the scan needed to cover less than it already did, and that claim is exactly the
    // attack: it is dropped, the scan keeps its own floor, and the answer stays inconclusive.
    //
    // The forged-anchor path now ends in "I could not tell", which refuses. The honest path is
    // unchanged: 46 of 46 real invoices anchor below the default lookback.
    const claimedAnchor = opts.anchorBlock === undefined ? undefined : Math.max(0, opts.anchorBlock);
    const anchorFloor = claimedAnchor !== undefined && claimedAnchor <= head ? claimedAnchor : undefined;
    // A BOUND anchor is the floor, not a hint to scan below.
    //
    // `min(requested, anchorFloor)` scanned 450,000 blocks under a floor the anchor had already
    // proven nothing could exist below -- the anchor is bound to the transaction that stored this
    // invoice's bytes in Request's storage contract AND to the create's own signed timestamp, so a
    // payment for this invoice cannot predate it. The extra window bought no safety and cost the
    // answer: every free Sepolia endpoint rate-limits a 450k-block log scan, so the second opinion
    // that `verdictFor` requires could not be obtained, and a live invoice was refused as
    // UNCORROBORATED on a chain where nothing was wrong. Measured on Sepolia, 2026-09-13.
    const floor = anchorFloor === undefined ? requested : anchorFloor;
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
    // With an honoured anchor the scan ran from it, so coverage is proven by construction and the
    // comparison below is trivially false -- deliberately, and now truthfully, because an anchor is
    // only honoured when it deepens the scan. Without one there is no floor short of genesis.
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
    // Counted, not assumed. An endpoint that threw told us nothing, and the difference between
    // "they agreed" and "they never answered" is the difference between evidence and silence.
    let negativeCorroborations = 0;
    /**
     * Every conflicting log ANY endpoint saw, unioned and de-duplicated by transaction.
     *
     * This used to keep the primary's conflicts and take a fallback's only when the primary had
     * none. So one pre-existing junk log paying a stranger kept the primary's list non-empty for
     * ever, and a fallback that later saw the log paying OUR payee in OUR token for the wrong
     * amount had it discarded: `conflictVerdict` read NOT_OURS, `verdictFor` read NOT_PAID, and
     * NOT_PAID is the answer that releases an obligation and lets a fresh proposal through -- over
     * our own money that had already moved. Endpoints genuinely see different log sets; that is the
     * entire reason this loop exists.
     */
    const byTransaction = new Map();
    /** The lowest head any endpoint that answered actually had. See the loop below. */
    let corroboratedTo = head;
    const conflictText = new Set(first.conflicts ?? []);
    for (const log of first.conflictingLogs ?? [])
        byTransaction.set(log.txHash ?? `unnamed:${byTransaction.size}`, log);
    for (const alt of rpcFallbacks()) {
        if (sameEndpoint(alt, rpcUrl))
            continue;
        try {
            await ensureChain(alt);
            // This endpoint's OWN head, not the primary's.
            //
            // The re-scan passed the primary's `head` to every fallback, so a primary reporting a stale
            // tip made all three endpoints answer about a window that excluded the payment -- and the
            // result was `negativeCorroborations: 2, truncated: false`, a confident NOT_PAID from three
            // endpoints that all hold the payment and none of which was asked about the blocks that
            // contain it. Ordinary RPC lag reproduces it; no attacker is needed. The re-scan exists
            // because one endpoint's answer cannot be trusted, and it was inheriting the primary's lie.
            const altHead = await currentBlock(alt);
            // And not asked about blocks it does not have. `Math.max` fixed the stale-primary case and
            // opened the mirror: a fallback BEHIND the primary was asked past its own tip, geth-family
            // nodes clamp that to their head and answer `[]` without an error, and the empty answer
            // was counted as a corroborating negative over a window it never saw. Ordinary RPC lag,
            // no attacker.
            //
            // Skipping a lagging endpoint outright was the mirror of that defect: public endpoints
            // normally sit a block or two apart, so "behind the primary" is the ordinary case, and
            // discarding those answers left a real negative with no corroboration at all -- a refusal
            // to propose, on a live invoice, for a two-block difference. Measured on Sepolia.
            //
            // So it answers about the window it can actually see, and the COVERAGE is reported honestly
            // instead: `scannedTo` is the lowest head any answering endpoint had, so a caller is told
            // what was really covered rather than what the fastest endpoint claimed.
            const second = await scanForReference(reference, alt, Math.min(altHead, head), floor, opts.expect);
            if (second.found) {
                // The primary said no and this endpoint says yes. The primary IS the second opinion
                // here — it has already disagreed — so the sighting is reported uncorroborated and the
                // caller decides. It is enough to refuse a payment, not enough to declare one settled.
                return { ...second, corroborated: false };
            }
            // This endpoint answered, and answered no, over the window it could see.
            negativeCorroborations++;
            corroboratedTo = Math.min(corroboratedTo, altHead);
            for (const line of second.conflicts ?? [])
                conflictText.add(line);
            for (const log of second.conflictingLogs ?? []) {
                byTransaction.set(log.txHash ?? `unnamed:${byTransaction.size}`, log);
            }
        }
        catch {
            // an unreachable endpoint, or one on the wrong chain, is not a second opinion; keep asking
        }
    }
    // The window is reported with the negative, not separately: a caller that has to ask a second
    // question to find out whether the first answer meant anything will eventually stop asking.
    //
    // `conflictingLogs` is stated even when empty, because absent means "nobody looked" and that is
    // a different answer from "we looked and there were none".
    return {
        ...first,
        truncated,
        // What EVERY answering endpoint covered, not what the fastest one did.
        scannedTo: corroboratedTo,
        scannedFrom: floor,
        negativeCorroborations,
        ...(conflictText.size > 0 ? { conflicts: [...conflictText] } : {}),
        conflictingLogs: [...byTransaction.values()],
    };
}
async function scanForReference(reference, rpcUrl, head, floor, expect) {
    const topics = [EVENT_TOPIC, referenceTopic(reference)];
    let to = head;
    const conflicts = [];
    const conflictingLogs = [];
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
                // Structured, not only narrated. The sentence above went into `conflicts`, which nothing
                // branches on, while `conflictingLogs` -- which everything branches on -- stayed empty and
                // therefore said "we looked and there was nothing of ours". A log under our own reference
                // that this reader cannot decode is the one thing it must not call absence.
                conflictingLogs.push({ ...(log.transactionHash === undefined ? {} : { txHash: log.transactionHash }), kinds: ["undecodable"] });
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
            // One entry per log, never a union across the scan. See `conflictVerdict`.
            conflictingLogs.push({ txHash: log.transactionHash, kinds: verdict.kinds });
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
        // Always stated, including as an empty list.
        //
        // Omitting it when there were none makes absence mean two different things — "this reader
        // looked and saw no conflicting log" and "this reader never looked" — and
        // a boolean reads both as "no conflict", which releases. That is the exact shape
        // that cost this project three separate duplicate-payment findings under `truncated` and
        // `confirmations`. A reader that concluded says what it saw; a reader that did not conclude
        // leaves the field off, and the callers treat that as unknown.
        conflictingLogs,
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
    for (const alt of rpcFallbacks()) {
        if (sameEndpoint(alt, primaryUrl))
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
 * The payer's mined nonce, and the head it was true at.
 *
 * `"latest"` and never `"pending"`. A pending count includes the very transaction we are trying
 * to exclude, so it would move on the strength of the leak itself and read as proof that the leak
 * cannot happen -- the exact inversion this exists to prevent. Only mined transactions spend a
 * nonce irreversibly.
 *
 * Nonce first, head second. The transactions that advanced the nonce to this value were mined at
 * or below the head read immediately afterwards, so `head` is a sound upper bound on "the block
 * by which this was true" -- which is what the log scan then has to cover. See src/exclusion.ts.
 */
export async function readPayerNonce(payer, rpcUrl = DEFAULT_RPC) {
    const nonce = Number(BigInt((await rpcCall(rpcUrl, "eth_getTransactionCount", [payer, "latest"]))));
    // Both counts, because their DIFFERENCE is what says whether a new broadcast's slot is knowable.
    // Reading only the mined count was the defect: a queued transaction mining moves `latest` past
    // the baseline while the leak, which took a pending slot above it, is still mineable.
    const pending = Number(BigInt((await rpcCall(rpcUrl, "eth_getTransactionCount", [payer, "pending"]))));
    const head = await currentBlock(rpcUrl);
    return { payer, nonce, pending, head };
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
        return { hash, verified: false, receiptStatus: "timeout", gasUsed: "0", source: "chain" };
    }
    let r;
    try {
        r = (await rpcCall(rpcUrl, "eth_getTransactionReceipt", [hash], timeoutMs));
    }
    catch {
        return { hash, verified: false, receiptStatus: "timeout", gasUsed: "0", source: "chain" };
    }
    if (!r)
        return { hash, verified: false, receiptStatus: "not_found", gasUsed: "0", source: "chain" };
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
    // `source: "chain"` says this really is a receipt an endpoint answered with, so a missing
    // `logs` here is a gap in the answer rather than the absence of a chain. See `Receipt.source`.
    // The block's own timestamp, for the anchor binding: a create carries a signed timestamp, and
    // its anchoring transaction cannot sit in a block mined long after it. Unknown is left unknown.
    let blockTimestamp;
    if (r.blockNumber !== undefined) {
        try {
            const block = (await rpcCall(rpcUrl, "eth_getBlockByNumber", [r.blockNumber, false], timeoutMs));
            if (block?.timestamp)
                blockTimestamp = Number(BigInt(block.timestamp));
        }
        catch {
            // unknown, not zero
        }
    }
    const common = { hash, gasUsed, to: r.to, logs: r.logs, blockNumber, blockTimestamp, confirmations, source: "chain" };
    // Three outcomes, not two. Only 0x0 means the chain said no; a missing or malformed status
    // means this read did not answer, and EXECUTION_REVERTED is terminal.
    if (r.status === "0x1")
        return { ...common, verified: true, receiptStatus: "success" };
    if (r.status === "0x0")
        return { ...common, verified: true, receiptStatus: "reverted" };
    return { ...common, verified: false, receiptStatus: "not_found" };
}
