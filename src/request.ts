/**
 * The facts, read from Request itself.
 *
 * Everything downstream of settlement is a guard over the payment reference: the canonical
 * obligation id, the policy gate, the calldata seam, the approval sentence a human reads, the
 * exactly-once compare-and-set. None of them re-derives that reference — they protect,
 * faithfully, whatever they are handed. So a single wrong `paymentReference` in a local file
 * does not break the machine; it aims it. Every gate passes, and the money moves against the
 * wrong debt. The payee check does not save you either, because in that file the payee sits
 * next to the reference and a hand that can edit one can edit both.
 *
 * This module is where that stops being possible. It reads the invoice from the public
 * Sepolia gateway (no credential) and derives the reference from the invoice's own salt and
 * payment address, so the reference is a CONSEQUENCE of the obligation rather than an input
 * to it. `assertReferenceMatches` is the refusal the settle path uses when a caller supplies
 * one anyway.
 *
 * Verified against the live gateway: every one of the 46 references recorded in
 * `docs/live-invoices.json` is reproduced by `derivePaymentReference` from its own
 * requestId/salt/paymentAddress.
 */

import { keccak256Hex } from "./keccak.ts";

/** Sepolia. Mainnet ids are refused in code; this repository is testnet-only by policy. */
export const SEPOLIA_CHAIN_ID = 11155111;

/** The one Request payment network this project can settle: ERC20FeeProxy, with a fee field. */
const FEE_PROXY_EXTENSION_ID = "pn-erc20-fee-proxy-contract";

const DEFAULT_GATEWAY = process.env.REQUEST_GATEWAY_URL ?? "https://sepolia.gateway.request.network/";

export type RequestErrorCode =
  | "BAD_IDENTIFIER"
  | "GATEWAY_UNAVAILABLE"
  | "CHANNEL_EMPTY"
  | "MALFORMED_TRANSACTION"
  | "NO_CREATE_ACTION"
  | "NO_FEE_PROXY_EXTENSION"
  | "WRONG_NETWORK"
  | "REFERENCE_MISMATCH"
  | "FACT_MISMATCH"
  | "INVOICE_CANCELLED";

export class RequestError extends Error {
  // See MoneyError: Node's strip-only TypeScript mode rejects constructor parameter
  // properties, since those emit code rather than erase types.
  readonly code: RequestErrorCode;

  constructor(code: RequestErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "RequestError";
  }
}

/**
 * One invoice, as Request states it. Read, never inferred, never supplied by an agent.
 *
 * Nothing here is optional except the storage anchor, and that is absent only while the
 * create action is still unconfirmed. A half-read invoice is worse than no invoice: the
 * guards downstream would protect the half they were given.
 */
export interface InvoiceFactsFromRequest {
  readonly requestId: string;
  readonly chainId: number;
  /** `currency.value` — the ERC20 the debt is denominated in. */
  readonly tokenAddress: string;
  /**
   * The extension's `paymentAddress`, which is what the fee proxy actually pays and what the
   * reference is derived from — NOT `parameters.payee`. They are usually the same address and
   * are allowed to differ, so reading the wrong one yields a plausible wrong answer.
   */
  readonly payee: string;
  /**
   * `parameters.payee`: who the invoice names as creditor. Recorded for diagnosis only —
   * paying this address rather than `payee` above would produce a transfer the reconciler
   * cannot match. If the two disagree, a human should look before anything is settled.
   */
  readonly payeeOfRecord: string;
  readonly invoiceBaseUnits: string;
  readonly feeBaseUnits: string;
  readonly feeRecipient: string;
  readonly salt: string;
  /** Derived here from requestId + salt + paymentAddress. Never taken from a caller. */
  readonly paymentReference: string;
  /** Set when later channel actions changed the amount the create stated. See policy.ts. */
  readonly amountChangedBy?: { readonly actions: number; readonly fromBaseUnits: string };
  /** Where the create action is anchored on Sepolia. Absent while it is unconfirmed. */
  readonly anchor?: { readonly blockNumber: number; readonly transactionHash: string };
}

export interface FetchInvoiceOptions {
  readonly gatewayUrl?: string;
  readonly timeoutMs?: number;
}

/**
 * `last8Bytes(keccak256(utf8(lowercase(requestId + salt + paymentAddress))))`.
 *
 * Two subtleties, both of which fail silently into a wrong-but-plausible 8-byte answer:
 *
 *   1. The hash is over the UTF-8 TEXT of the concatenated hex strings, not over the bytes
 *      those strings decode to. `keccak256Hex` encodes a string argument as UTF-8, which is
 *      exactly what is wanted; handing it a decoded `Uint8Array` would not be.
 *   2. The whole preimage is lowercased, and the pieces are concatenated in their recorded
 *      spelling — the requestId and salt WITHOUT a `0x`, the payment address WITH one. A
 *      `0x`-prefixed requestId therefore hashes to a different reference, which is why the
 *      identifier checks below refuse one instead of quietly stripping it.
 */
export function derivePaymentReference(requestId: string, salt: string, paymentAddress: string): string {
  const id = assertBareHex("requestId", requestId);
  const s = assertBareHex("salt", salt);
  const addr = assertAddress("paymentAddress", paymentAddress);
  const preimage = (id + s + addr).toLowerCase();
  return `0x${keccak256Hex(preimage).slice(-16)}`;
}

/**
 * The refusal. A caller-supplied reference that is not the derived one names a different
 * debt, and every guard downstream would have protected that one instead.
 *
 * Compared case-insensitively: references are hex, so `0xDEADBEEF` and `0xdeadbeef` are one
 * debt and refusing there would be theatre, not safety.
 */
export function assertReferenceMatches(supplied: string, derived: string): void {
  // Compared in the canonical spelling, because Request's own PaymentReferenceCalculator returns
  // the bare 16 hex characters while this project stores the 0x form. Comparing the raw strings
  // answered REFERENCE_MISMATCH -- "these are different debts" -- for two spellings of one debt.
  const canon = (r: string) => (/^[0-9a-fA-F]{16}$/.test(r) ? `0x${r}` : r).toLowerCase();
  if (canon(supplied) === canon(derived)) return;
  throw new RequestError(
    "REFERENCE_MISMATCH",
    `supplied payment reference ${supplied} is not the one this invoice derives (${derived}); ` +
      "these are different debts, and nothing downstream re-derives the reference",
  );
}

/**
 * What a caller already believes about an invoice — from `.env`, from a local JSON file, from
 * an agent. Every field is a CLAIM to be checked against Request, never a fact to be used.
 */
export interface ClaimedFacts {
  readonly paymentReference?: string;
  readonly payee?: string;
  readonly amountBaseUnits?: string;
  readonly feeAmount?: string;
  readonly feeAddress?: string;
  readonly tokenAddress?: string;
}

/**
 * The only way a settlement path should learn what an invoice says.
 *
 * `fetchInvoice` alone is not enough in practice, because the scripts that move money already
 * hold a local copy of these fields and the tempting thing is to keep using it. So this is the
 * one call that does both halves: read the invoice, then REFUSE — not warn, not prefer one
 * side — if anything the caller brought disagrees with what Request states. The identifier is
 * the only thing a caller is allowed to supply and have used.
 *
 * Amounts are compared as exact strings. A claimed amount is supposed to be a verbatim copy of
 * the invoice's, so "1000000000000000000" and "01000000000000000000" being refused as
 * different is the point: one of them was typed by something other than Request.
 */
export async function fetchInvoiceChecked(
  requestId: string,
  claimed: ClaimedFacts = {},
  opts: FetchInvoiceOptions = {},
): Promise<InvoiceFactsFromRequest> {
  const invoice = await fetchInvoice(requestId, opts);
  if (claimed.paymentReference !== undefined) {
    assertReferenceMatches(claimed.paymentReference, invoice.paymentReference);
  }
  // Addresses compare case-insensitively (checksum capitalisation is a rendering choice);
  // amounts do not.
  const check = (field: string, c: string | undefined, stated: string, addressLike = false): void => {
    if (c === undefined) return;
    if (addressLike ? c.toLowerCase() === stated.toLowerCase() : c === stated) return;
    throw new RequestError(
      "FACT_MISMATCH",
      `${field} was supplied as ${JSON.stringify(c)}, but invoice ${invoice.requestId} states ` +
        `${JSON.stringify(stated)}; the facts come from Request, so this settlement is refused ` +
        "rather than run against the caller's version",
    );
  };
  check("payee", claimed.payee, invoice.payee, true);
  check("tokenAddress", claimed.tokenAddress, invoice.tokenAddress, true);
  check("feeAddress", claimed.feeAddress, invoice.feeRecipient, true);
  check("amountBaseUnits", claimed.amountBaseUnits, invoice.invoiceBaseUnits);
  check("feeAmount", claimed.feeAmount, invoice.feeBaseUnits);
  return invoice;
}

/**
 * Read one invoice from the public Request gateway. No credential, no agent-supplied facts.
 *
 * Throws — never returns a partial record — on an HTTP failure, an empty or unparseable
 * channel, a missing `create` action, a missing fee-proxy extension, or any network that is
 * not Sepolia.
 */
export async function fetchInvoice(
  requestId: string,
  opts: FetchInvoiceOptions = {},
): Promise<InvoiceFactsFromRequest> {
  const id = assertBareHex("requestId", requestId);
  const base = (opts.gatewayUrl ?? DEFAULT_GATEWAY).replace(/\/+$/, "");
  const url = `${base}/getTransactionsByChannelId?channelId=${encodeURIComponent(id)}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
  } catch (e) {
    // A gateway that did not answer is not an invoice that does not exist.
    throw new RequestError("GATEWAY_UNAVAILABLE", `Request gateway did not answer: ${asMessage(e)}`);
  }
  if (!res.ok) {
    throw new RequestError("GATEWAY_UNAVAILABLE", `Request gateway answered HTTP ${res.status} for ${id}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    throw new RequestError("MALFORMED_TRANSACTION", `Request gateway returned non-JSON: ${asMessage(e)}`);
  }

  const transactions = asArray(dig(body, "result", "transactions"));
  if (transactions.length === 0) {
    throw new RequestError("CHANNEL_EMPTY", `no transactions on channel ${id}; this invoice does not exist here`);
  }

  // `transaction.data` is a JSON STRING, not an object: parse each before reading it.
  const actions = transactions.map((tx, index) => {
    const raw = dig(tx, "transaction", "data");
    if (typeof raw !== "string") {
      throw new RequestError("MALFORMED_TRANSACTION", `transaction ${index} on channel ${id} carries no data string`);
    }
    try {
      return { index, data: dig(JSON.parse(raw), "data") };
    } catch (e) {
      throw new RequestError(
        "MALFORMED_TRANSACTION",
        `transaction ${index} on channel ${id} is not parseable JSON: ${asMessage(e)}`,
      );
    }
  });

  const create = actions.find((a) => asString(dig(a.data, "name")) === "create");
  if (!create) {
    throw new RequestError(
      "NO_CREATE_ACTION",
      `channel ${id} has no create action (${actions.length} transaction(s)); there is no invoice to read`,
    );
  }

  // A Request channel is an append-only log of ACTIONS, and `create` is only the first. A
  // creditor can cancel the request, increase the expected amount or reduce it, and each of those
  // is another action on the same channel. Reading `create` alone means reading the invoice as it
  // was when it was raised, which is a different invoice from the one that exists now: a
  // cancelled debt still settles, and a reduced one overpays. Neither is recoverable -- the money
  // has moved.
  //
  // These are applied below, after the create's own fields are parsed, because a delta has to be
  // applied to something.
  const everyAction = actions.map((a) => ({
    index: a.index,
    name: asString(dig(a.data, "name")),
    parameters: dig(a.data, "parameters"),
  }));
  const later = everyAction.filter((a) => a.index > create.index);

  // Refuse a name this reader does not understand, rather than skipping it.
  //
  // The loop below applies the actions it knows about and ignored everything else, which reads as
  // "those do not change the debt" — a claim about Request's whole action set that this file is in
  // no position to make. An action that moves the amount under a name nobody here has heard of is
  // exactly the case where being quiet costs money, so an unknown name stops the settlement and
  // says which one it was. All 46 recorded invoices carry nothing but a `create`, so nothing in
  // this deployment is refused by it today.
  const UNDERSTOOD = new Set(["create", "cancel", "accept", "increaseExpectedAmount", "reduceExpectedAmount"]);
  const unknown = everyAction.find((a) => a.name === undefined || !UNDERSTOOD.has(a.name));
  if (unknown) {
    throw new RequestError(
      "MALFORMED_TRANSACTION",
      `invoice ${id} carries an action this reader does not understand (${unknown.name ?? "unnamed"} at ${unknown.index}); ` +
        "refusing rather than assuming it leaves the debt unchanged",
    );
  }

  // A cancel ANYWHERE on the channel cancels it.
  //
  // This searched only actions after the create, so a cancel that appeared earlier in the array
  // was silently dropped and the invoice came back payable. A reviewer produced exactly that by
  // replaying a real channel with the actions reordered. The code was already refusing to assume
  // the create comes first — and then assumed everything before it was irrelevant, which is the
  // same assumption wearing a different hat. There is no un-cancelling, so position cannot matter.
  const cancelled = everyAction.find((a) => a.name === "cancel");
  if (cancelled) {
    throw new RequestError(
      "INVOICE_CANCELLED",
      `invoice ${id} was cancelled by a later action on its channel (action ${cancelled.index}); ` +
        "there is no debt to settle, and paying it would move money nobody is owed",
    );
  }

  const p = dig(create.data, "parameters");
  const currencyType = asString(dig(p, "currency", "type"));
  if (currencyType !== "ERC20") {
    throw new RequestError(
      "WRONG_NETWORK",
      `invoice ${id} is denominated in ${currencyType ?? "an unstated currency type"}, not ERC20`,
    );
  }
  assertSepolia(id, "currency.network", asString(dig(p, "currency", "network")));

  const extension = asArray(dig(p, "extensionsData")).find(
    (e) => asString(dig(e, "id")) === FEE_PROXY_EXTENSION_ID,
  );
  if (!extension) {
    const found = asArray(dig(p, "extensionsData")).map((e) => asString(dig(e, "id")) ?? "?");
    throw new RequestError(
      "NO_FEE_PROXY_EXTENSION",
      `invoice ${id} carries no ${FEE_PROXY_EXTENSION_ID} extension (found: ${found.join(", ") || "none"}); ` +
        "this settlement path only knows how to pay the ERC20 fee proxy",
    );
  }
  const ep = dig(extension, "parameters");
  assertSepolia(id, "paymentNetworkName", asString(dig(ep, "paymentNetworkName")));

  const tokenAddress = assertAddress("currency.value", asString(dig(p, "currency", "value")));
  const payee = assertAddress("paymentAddress", asString(dig(ep, "paymentAddress")));
  const payeeOfRecord = assertAddress("payee.value", asString(dig(p, "payee", "value")));
  const feeRecipient = assertAddress("feeAddress", asString(dig(ep, "feeAddress")));
  const salt = assertBareHex("salt", asString(dig(ep, "salt")));
  // The amount as the channel stands now: the create's expectedAmount with every later
  // increase and reduction applied, in order. Request states deltas, not new totals.
  let amount = BigInt(assertBaseUnits("expectedAmount", asString(dig(p, "expectedAmount"))));
  // Deltas that predate the create are malformed: there is nothing yet to adjust. Refused rather
  // than ignored, for the same reason as the cancel above.
  const earlyDelta = everyAction.find(
    (a) => a.index < create.index && (a.name === "increaseExpectedAmount" || a.name === "reduceExpectedAmount"),
  );
  if (earlyDelta) {
    throw new RequestError(
      "MALFORMED_TRANSACTION",
      `invoice ${id} adjusts its amount at action ${earlyDelta.index}, before the create at ${create.index}`,
    );
  }

  const raisedAt = amount;
  let changingActions = 0;
  for (const a of later) {
    if (a.name === "increaseExpectedAmount") {
      amount += BigInt(assertBaseUnits(`action ${a.index} deltaAmount`, asString(dig(a.parameters, "deltaAmount"))));
      changingActions++;
    } else if (a.name === "reduceExpectedAmount") {
      amount -= BigInt(assertBaseUnits(`action ${a.index} deltaAmount`, asString(dig(a.parameters, "deltaAmount"))));
      changingActions++;
    }
  }
  if (amount < 0n) {
    throw new RequestError(
      "MALFORMED_TRANSACTION",
      `invoice ${id} reduces below zero across its channel; refusing rather than guessing at the debt`,
    );
  }
  const invoiceBaseUnits = amount.toString();
  // Carried so the sentence a human approves can name it. These actions are not authenticated —
  // nothing here recovers an ECDSA signer — so an amount that moved after the invoice was raised
  // is the one figure on that screen with nothing behind it but the gateway's word.
  const amountChangedBy =
    changingActions > 0 ? { actions: changingActions, fromBaseUnits: raisedAt.toString() } : undefined;
  const feeBaseUnits = assertBaseUnits("feeAmount", asString(dig(ep, "feeAmount")));

  return {
    requestId: id,
    chainId: SEPOLIA_CHAIN_ID,
    tokenAddress,
    payee,
    payeeOfRecord,
    invoiceBaseUnits,
    feeBaseUnits,
    feeRecipient,
    salt,
    paymentReference: derivePaymentReference(id, salt, payee),
    ...(amountChangedBy ? { amountChangedBy } : {}),
    ...storageAnchor(body, create.index),
  };
}

/**
 * The plain shape the rest of the codebase passes around (`plan.ts`'s `InvoiceFacts`),
 * returned as a plain object rather than an import so this module stays independent of the
 * plan and policy files.
 *
 * The mapping exists because this is exactly where a wiring slip is invisible: `payee` here
 * must be the extension's payment address, and the ceiling is a human's number that has no
 * safe default, so it is a required argument rather than something inferred from the invoice.
 */
export function toInvoiceFacts(
  f: InvoiceFactsFromRequest,
  maxTotalDebitBaseUnits: string,
): {
  requestId: string;
  paymentReference: string;
  payee: string;
  amountBaseUnits: string;
  feeAmount: string;
  feeAddress: string;
  maxTotalDebitBaseUnits: string;
  tokenAddress: string;
  anchorBlock?: number;
} {
  return {
    requestId: f.requestId,
    paymentReference: f.paymentReference,
    payee: f.payee,
    amountBaseUnits: f.invoiceBaseUnits,
    feeAmount: f.feeBaseUnits,
    feeAddress: f.feeRecipient,
    maxTotalDebitBaseUnits: assertBaseUnits("maxTotalDebitBaseUnits", maxTotalDebitBaseUnits),
    tokenAddress: f.tokenAddress,
    // Carried so the recovery scan has a floor. A payment cannot predate its invoice, so this is
    // what turns "I saw nothing in the window I looked at" into "nothing ever paid this". Absent
    // while Request has not confirmed the create, and omitted rather than defaulted to zero: a
    // zero floor would claim a scan to genesis that never happened.
    ...(f.anchor ? { anchorBlock: f.anchor.blockNumber } : {}),
  };
}

/**
 * `meta.storageMeta` is an array aligned with `result.transactions`, and its entries carry the
 * Sepolia block and transaction hash of the create. Absent or null while unconfirmed, which is
 * reported by omission rather than by inventing a zero block.
 */
function storageAnchor(body: unknown, index: number): { anchor?: { blockNumber: number; transactionHash: string } } {
  const metas = asArray(dig(body, "meta", "storageMeta"));
  // This array is aligned with `result.transactions`, so the create's anchor is the entry at the
  // create's index and nowhere else. There used to be a `.find(Boolean)` fallback to the first
  // entry carrying an ethereum block, which on a channel with later actions (an amount increase,
  // a cancel) silently returned a LATER block. The anchor is used as the floor below which no
  // payment for this invoice can exist, so too-high is the unsafe direction: it asserts coverage
  // of a window the scan never reached. An absent anchor is handled everywhere; a wrong one is not.
  const eth = dig(metas[index], "ethereum");
  const blockNumber = dig(eth, "blockNumber");
  const transactionHash = asString(dig(eth, "transactionHash"));
  if (typeof blockNumber !== "number" || !transactionHash) return {};
  return { anchor: { blockNumber, transactionHash } };
}

function assertSepolia(id: string, field: string, network: string | undefined): void {
  if (network !== "sepolia") {
    throw new RequestError(
      "WRONG_NETWORK",
      `invoice ${id} states ${field}=${network ?? "nothing"}; this settlement is Sepolia ` +
        `(chain ${SEPOLIA_CHAIN_ID}) only`,
    );
  }
}

/** Hex with no `0x`, the spelling requestIds and salts are recorded and hashed in. */
function assertBareHex(field: string, value: string | undefined): string {
  if (typeof value === "string" && /^[0-9a-fA-F]+$/.test(value)) return value;
  const hint = typeof value === "string" && /^0x/i.test(value) ? " (drop the 0x: it is part of the preimage)" : "";
  throw new RequestError("BAD_IDENTIFIER", `${field} must be bare hex${hint}, got ${JSON.stringify(value)}`);
}

function assertAddress(field: string, value: string | undefined): string {
  // `0X` is accepted alongside `0x`: the preimage is lowercased, so the two spell one address.
  // Contrast assertBareHex, where a prefix would change the hash and is therefore refused.
  if (typeof value === "string" && /^0[xX][0-9a-fA-F]{40}$/.test(value)) return value;
  throw new RequestError("BAD_IDENTIFIER", `${field} must be a 20-byte address, got ${JSON.stringify(value)}`);
}

/** Base units cross as a decimal string. See money.ts: no floats, ever. */
function assertBaseUnits(field: string, value: string | undefined): string {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  throw new RequestError(
    "MALFORMED_TRANSACTION",
    `${field} must be a base-unit decimal string, got ${JSON.stringify(value)}`,
  );
}

/** Walk a path through unknown JSON without trusting any level of it to be an object. */
function dig(value: unknown, ...path: string[]): unknown {
  let cur = value;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
