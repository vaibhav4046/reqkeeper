/**
 * Independent chain reads. Nothing here talks to the execution provider, deliberately:
 * these are the functions that get to contradict it.
 */

import { keccak256Hex } from "./keccak.ts";
import { ERC20_FEE_PROXY } from "./plan.ts";
import type { PayerReading } from "./exclusion.ts";

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

const rpcFallbacks = (): readonly string[] => (RPC_FALLBACKS.length > 0 ? RPC_FALLBACKS : DEFAULT_RPC_FALLBACKS);

/**
 * The endpoints a negative has to be put to before it counts, exported so that anything drawing a
 * conclusion from silence uses the same set this module does.
 *
 * A verification script that asks one endpoint and believes an empty `eth_getLogs` reproduces the
 * exact defect this module was built around — measured against this project's own payment, which
 * publicnode returns zero logs for and two other endpoints return in full.
 */
export const negativeCorroborationEndpoints = (): readonly string[] => rpcFallbacks();

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
  for (const alt of rpcFallbacks()) {
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
  /** The lowest block the scan reached. With `truncated: false` there is nothing below it to find. */
  readonly scannedFrom?: number;
  /**
   * The scan could not cover the window in which a payment for this obligation could
   * plausibly be, so `found: false` means "I could not tell", never "unpaid".
   *
   * This used to mean "the scan did not start at genesis", which on a live chain is every
   * scan there has ever been: head 11692278 with the standard 300k lookback puts the floor at
   * 11392278, so `truncated` was permanently true and every negative was inconclusive. The
   * floor that actually settles the question is the invoice's own anchor block — a payment
   * cannot predate the invoice it pays — which callers pass as `anchorBlock`.
   */
  readonly truncated?: boolean;
  /**
   * A second, independent endpoint returned the same transaction for this reference.
   * `found: true` without this is one endpoint's unverified word, and one endpoint has been
   * observed answering wrongly in both directions.
   */
  readonly corroborated?: boolean;
  /**
   * Set when a log carried this reference but disagreed about the payment itself.
   *
   * NOT automatically EVIDENCE_CONFLICT, which is what this comment used to say. The
   * ERC20FeeProxy is permissionless and payment references derive from data anchored openly on
   * Sepolia, so anyone can emit a log carrying this reference that pays somebody else. Treating
   * every such log as an integrity incident would move the obligation to a human-only terminal
   * state, which means one junk log could permanently suppress any invoice -- exactly the grief
   * `src/watch.ts` refuses for the same reason.
   *
   * For the dominant case, a third party's log, the invoice genuinely IS unpaid and paying it
   * once is correct. The case that deserves escalation is narrower: a log whose token and payee
   * match this invoice but whose amount or fee does not, because that is our own money moving
   * under this reference in a shape we did not plan. `amountOrFeeConflict` below is that test,
   * and it is what the worker branches on.
   */
  readonly conflicts?: readonly string[];
  /** The same disagreements as `conflicts`, classified, for callers that must branch on them. */
  readonly conflictKinds?: readonly ConflictKind[];
  /**
   * The highest block this scan covered.
   *
   * `eth_getLogs` does not see the mempool. A dry run that leaked (#1959) and is still pending is
   * invisible to a scan that honestly covered its whole window and honestly reports
   * `truncated: false` -- so "I looked everywhere and found nothing" is not the same statement as
   * "nothing was broadcast". The difference is AGE: absence only becomes evidence once enough
   * chain has passed since the send could have happened. A caller that knows when the send could
   * have happened compares it against this.
   */
  readonly scannedTo?: number;
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
export type ConflictKind = "emitter" | "token" | "to" | "amount" | "fee" | "feeAddress";

export function matchPaymentLog(
  log: PaymentLogFields & { readonly emitter?: string },
  expect: PaymentExpectation,
): { ok: boolean; conflicts: string[]; kinds: ConflictKind[] } {
  const conflicts: string[] = [];
  // The same disagreements, classified. Callers that have to BRANCH on which field disagreed get
  // this; the strings stay for the human who has to read the audit row. Parsing the strings was
  // the alternative, and a sentence is not an interface.
  const kinds: ConflictKind[] = [];
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
export function amountOrFeeConflict(sighting: { readonly conflictKinds?: readonly ConflictKind[] }): boolean {
  const kinds = sighting.conflictKinds;
  if (!kinds || kinds.length === 0) return false;
  const wrongCounterparty = kinds.includes("token") || kinds.includes("to") || kinds.includes("emitter");
  const wrongValue = kinds.includes("amount") || kinds.includes("fee") || kinds.includes("feeAddress");
  return wrongValue && !wrongCounterparty;
}

/**
 * What a chain read ESTABLISHED about a payment, as three mutually exclusive answers.
 *
 * `PaymentSighting` carries `found`, `truncated`, `corroborated` and `conflicts`, and five call
 * sites combined them five different ways. Every duplicate-payment finding in this project has
 * been one of those combinations getting it wrong, in one direction or the other:
 *
 *   - `found === true` alone → a forged log paying somebody else read as settlement
 *   - `found === false` alone → "I could not look" read as "not paid"
 *   - `truncated !== true` → an absent flag read as a conclusive scan
 *   - `found || truncated !== true` → the permissive inverse, on the hosted surface
 *   - conflicts discarded → a log paying the wrong amount read as no payment at all
 *
 * The dry-run path had exactly this shape and was fixed by giving it a union with an exhaustive
 * switch (`SimulateOutcome`). That fix was never carried across to the chain-read path, which is
 * where the remaining instances have all been found. This is the same repair, applied here.
 *
 * The three answers are deliberately NOT "paid / not paid / error". `UNKNOWN` is the normal
 * outcome of reading a distributed system through a public endpoint, and it is the one every
 * caller has to handle explicitly, because it is the one that has been silently collapsing into
 * "no".
 */
export type PaymentVerdict =
  /** A log corroborated against what this obligation actually owes. Safe to treat as settlement. */
  | { readonly kind: "PAID"; readonly txHash: string; readonly block?: number }
  /**
   * The scan covered the whole window in which a payment could exist and there was none. Only
   * ever returned when the caller supplied the floor that makes coverage provable.
   */
  | { readonly kind: "NOT_PAID"; readonly scannedFrom?: number; readonly scannedTo?: number }
  /**
   * Anything else, and there are more ways to land here than to land anywhere else: a scan that
   * ran out of window, a log that carries the reference but disagrees about the payment, a
   * positive no second endpoint would corroborate, or a read that could not be made at all.
   *
   * Never a licence to send, and never a licence to release an obligation either.
   */
  | {
      readonly kind: "UNKNOWN";
      readonly reason: "TRUNCATED" | "CONFLICTS" | "UNCORROBORATED" | "UNREADABLE";
      readonly detail: string;
      readonly conflicts?: readonly string[];
      readonly conflictKinds?: readonly ConflictKind[];
    };

/**
 * The single place a sighting becomes a decision.
 *
 * `requireCorroboration` is for callers deciding whether to treat a payment as THIS obligation's
 * settlement, where an uncorroborated positive must not count. A caller merely reporting what is
 * on chain passes false and gets the sighting's own word.
 */
export function verdictFor(
  sighting: PaymentSighting | null | undefined,
  opts: { readonly requireCorroboration?: boolean } = {},
): PaymentVerdict {
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
export async function findPaymentByReference(
  reference: string,
  opts: {
    rpcUrl?: string;
    fromBlock?: number;
    lookbackBlocks?: number;
    /**
     * The block the invoice itself is anchored at. A payment cannot predate the invoice it
     * pays, so this is the floor below which there is nothing to find — supply it and a
     * `found: false` is an answer rather than a shrug. The scan is extended down to it when
     * the requested window stops short, because a window that cannot reach the anchor cannot
     * settle the question, and its cost is bounded by the invoice's own age.
     */
    anchorBlock?: number;
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
  const requested =
    opts.fromBlock !== undefined
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
  for (const alt of rpcFallbacks()) {
    if (alt === rpcUrl) continue;
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
    } catch {
      // an unreachable endpoint is not a second opinion; keep asking
    }
  }
  // The window is reported with the negative, not separately: a caller that has to ask a second
  // question to find out whether the first answer meant anything will eventually stop asking.
  return { ...first, truncated, scannedFrom: floor };
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
  const conflictKinds: ConflictKind[] = [];

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
      conflictKinds.push(...verdict.kinds);
    }

    if (from === floor) break;
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
async function corroborate(
  reference: string,
  sighting: PaymentSighting,
  primaryUrl: string,
  expect?: PaymentExpectation,
): Promise<boolean> {
  if (sighting.block === undefined || sighting.txHash === undefined) return false;
  for (const alt of rpcFallbacks()) {
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
export async function readPayerNonce(payer: string, rpcUrl = DEFAULT_RPC): Promise<PayerReading> {
  const nonce = Number(BigInt((await rpcCall(rpcUrl, "eth_getTransactionCount", [payer, "latest"])) as string));
  // Both counts, because their DIFFERENCE is what says whether a new broadcast's slot is knowable.
  // Reading only the mined count was the defect: a queued transaction mining moves `latest` past
  // the baseline while the leak, which took a pending slot above it, is still mineable.
  const pending = Number(BigInt((await rpcCall(rpcUrl, "eth_getTransactionCount", [payer, "pending"])) as string));
  const head = await currentBlock(rpcUrl);
  return { payer, nonce, pending, head };
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
