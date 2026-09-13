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

import { keccak256, keccak256Hex } from "./keccak.ts";
import { recoverAddress } from "./secp256k1.ts";

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
  | "INVOICE_CANCELLED"
  /** The served create does not hash to the channel id it was served under. */
  | "REQUEST_ID_MISMATCH"
  /** An action carries no signature this reader can check. */
  | "ACTION_UNSIGNED"
  /** An action's signature recovers to nobody, or to a party the invoice does not name. */
  | "ACTION_SIGNATURE_INVALID"
  /** An action was signed by a real party of this invoice, in a role Request does not allow it. */
  | "ACTION_ROLE_VIOLATION"
  /** The anchor names a transaction that did not store this invoice's bytes. */
  | "ANCHOR_UNBOUND"
  /** One signature, served twice. A signature authorises one action. */
  | "ACTION_REPLAYED"
  /** A genuinely signed action, lifted from another invoice onto this one. */
  | "ACTION_FOREIGN";

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
  /**
   * The money goes somewhere other than the party of record.
   *
   * Legitimate in Request -- an invoice may name a payment address that is not the payee -- and
   * so never a refusal here. It is carried so the human approving can be told, which is what the
   * comment above this field promised and nothing delivered.
   */
  readonly payeeDiffersFromRecord?: boolean;
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

/**
 * Read one receipt, for the anchor binding below.
 *
 * A function rather than a chain module import, for two reasons. `src/chain.ts` imports nothing
 * from here and this keeps it that way; and a test that has to reach a public endpoint to read an
 * invoice is a test that fails for reasons it is not about.
 */
export type ReceiptReader = (
  hash: string,
  rpcUrl?: string,
) => Promise<{
  blockNumber?: number;
  logs?: ReadonlyArray<{ address?: string; data?: string }>;
}>;

/** The real one. Lazily imported so this module has no load-time dependency on the chain reader. */
const defaultReceiptReader: ReceiptReader = async (hash, rpcUrl) => {
  const { DEFAULT_RPC, readReceipt } = await import("./chain.ts");
  return readReceipt(rpcUrl ?? DEFAULT_RPC, hash);
};

export interface FetchInvoiceOptions {
  readonly gatewayUrl?: string;
  readonly timeoutMs?: number;
  /** Where to read the anchor's own transaction from. Defaults to `SEPOLIA_RPC`. */
  readonly rpcUrl?: string;
  /** Injectable for tests; see `ReceiptReader`. */
  readonly readReceipt?: ReceiptReader;
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
      const signed = JSON.parse(raw) as unknown;
      // The whole signed action is kept, not just its `data`. The channel id is a hash OVER the
      // signed action, so verifying it needs the signature and every other field exactly as
      // served. See `assertChannelIdBindsCreate`.
      return { index, data: dig(signed, "data"), signed };
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
  // The channel id is a hash of the signed create, so it can be checked without a credential.
  //
  // Everything else here trusts the gateway's bytes: no ECDSA signer is recovered, so a forged
  // create served under a genuine request id was accepted silently — attacker payee, attacker
  // payment address, any amount — and the reference then derived self-consistently from the
  // forgery, so every downstream guard protected the wrong debt. A reviewer demonstrated exactly
  // that. It is reachable through REQUEST_GATEWAY_URL, `opts.gatewayUrl`, or a gateway that has
  // been compromised.
  //
  // Request derives the id as `01` + keccak256 of the signed create, normalised: keys deep-sorted
  // and the whole string lowercased. Verified against all 46 invoices this deployment knows,
  // 46 of 46. It costs one hash and no network call, and it turns "the gateway says this is the
  // invoice" into "these bytes are the only ones that hash to the id I asked for".
  //
  // It binds the CREATE, which is where the payee, the payment address, the amount, the token and
  // the salt live — everything the payment reference derives from. Later actions are bound by
  // their own signatures, immediately below.
  assertChannelIdBindsCreate(id, create.signed);

  // And every action is checked against the signature it carries.
  //
  // The id binding above covers the CREATE and nothing else. Everything after it -- a cancel, an
  // amount increase -- was taken on the gateway's word, and an increase is the action that costs
  // money: it raises what this system is about to pay, on bytes nobody authenticated. Recovering
  // the signer turns each action from "the gateway says" into "this address said", and the role
  // rules below decide whether that address was allowed to say it.
  //
  // The create's own payee and payer are the authority for those rules, and they are safe to
  // read here for exactly one reason: the line above has already proved the create hashes to the
  // id that was asked for, so they cannot have been substituted.
  assertActionsAreSigned(id, actions, {
    payee: asString(dig(create.data, "parameters", "payee", "value")),
    payer: asString(dig(create.data, "parameters", "payer", "value")),
  });

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

  // The extension's CREATE entry, and only one of them.
  //
  // This took the first entry with the right id, whatever action it carried. Request applies
  // `extensionsData` as an ordered reduce and its own abstract extension throws "The extension
  // should be created before receiving any other action" -- so a channel carrying
  // `addPaymentAddress` before `create` is a channel Request rejects, and this reader accepted,
  // taking the payee and the payment reference from the attacker's entry. Demonstrated on
  // identical bytes.
  //
  // Two entries with the same id is the same hazard wearing a second hat: which one is the
  // invoice? Refused rather than answered by array order.
  const feeProxyEntries = asArray(dig(p, "extensionsData")).filter(
    (e) => asString(dig(e, "id")) === FEE_PROXY_EXTENSION_ID,
  );
  if (feeProxyEntries.length > 1) {
    throw new RequestError(
      "NO_FEE_PROXY_EXTENSION",
      `invoice ${id} carries ${feeProxyEntries.length} ${FEE_PROXY_EXTENSION_ID} entries. Which one ` +
        "states the payment address decides where the money goes, and array order is not an answer.",
    );
  }
  const extension = feeProxyEntries.find((e) => asString(dig(e, "action")) === "create") ?? undefined;
  if (feeProxyEntries.length === 1 && extension === undefined) {
    throw new RequestError(
      "NO_FEE_PROXY_EXTENSION",
      `invoice ${id} carries a ${FEE_PROXY_EXTENSION_ID} entry whose action is ` +
        `${asString(dig(feeProxyEntries[0], "action")) ?? "unstated"}, not "create". Request applies ` +
        "these in order and refuses any other action before the create; so does this.",
    );
  }
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
  // Recorded and, when they differ, CARRIED -- not compared and refused.
  //
  // Request lets an invoice be paid to an address that is not the party of record, and that is a
  // legitimate arrangement, so refusing here would refuse real invoices. But the docblock on this
  // type promised "if the two disagree, a human should look before anything is settled", and
  // nothing read the field: the control existed only as a sentence. It reaches the sentence a
  // human approves now, which is where "a human should look" actually happens.
  const payeeDiffersFromRecord = payee.toLowerCase() !== payeeOfRecord.toLowerCase();
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
  // Carried so the sentence a human approves can name it. The action is authenticated now --
  // `assertActionsAreSigned` has recovered a signer and checked it against Request's role rules,
  // so an increase really was signed by the payer -- but "signed by the right party" is not
  // "expected by the human who is about to approve it". An amount that moved after the invoice
  // was raised belongs on that screen.
  const amountChangedBy =
    changingActions > 0 ? { actions: changingActions, fromBaseUnits: raisedAt.toString() } : undefined;
  const feeBaseUnits = assertBaseUnits("feeAmount", asString(dig(ep, "feeAmount")));

  return {
    requestId: id,
    chainId: SEPOLIA_CHAIN_ID,
    tokenAddress,
    payee,
    payeeOfRecord,
    ...(payeeDiffersFromRecord ? { payeeDiffersFromRecord: true } : {}),
    invoiceBaseUnits,
    feeBaseUnits,
    feeRecipient,
    salt,
    paymentReference: derivePaymentReference(id, salt, payee),
    ...(amountChangedBy ? { amountChangedBy } : {}),
    ...(await boundAnchorFor(id, body, create.index, opts)),
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
  payeeDiffersFromRecord?: boolean;
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
    // The party of record and the address being paid are not the same. Request allows it; the
    // human approving should still be told, and this is the only path that can tell them.
    ...(f.payeeDiffersFromRecord ? { payeeDiffersFromRecord: true } : {}),
  };
}

/**
 * `meta.storageMeta` is an array aligned with `result.transactions`, and its entries carry the
 * Sepolia block and transaction hash of the create. Absent or null while unconfirmed, which is
 * reported by omission rather than by inventing a zero block.
 */
/**
 * The anchor for this create, bound or absent. Pulls the CID `meta` served beside it.
 *
 * `meta.transactionsStorageLocation[i]` is aligned with `result.transactions[i]` -- Request's own
 * `data-read.ts` builds the three arrays with parallel maps over one list -- so the create's CID
 * is the entry at the create's index and nowhere else. Same alignment rule the anchor itself uses.
 */
async function boundAnchorFor(
  id: string,
  body: unknown,
  index: number,
  opts: FetchInvoiceOptions,
): Promise<{ anchor?: { blockNumber: number; transactionHash: string } }> {
  const claimed = storageAnchor(body, index).anchor;
  if (!claimed) return {};
  const cid = asString(asArray(dig(body, "meta", "transactionsStorageLocation"))[index]);
  const bound = await bindAnchor(id, claimed, cid, opts.readReceipt ?? defaultReceiptReader, opts.rpcUrl);
  return bound ? { anchor: bound } : {};
}

/**
 * Request's storage contract on Sepolia. The anchor's own transaction must emit from it.
 *
 * Sourced from the gateway's own responses (`meta.storageMeta[].ethereum.smartContractAddress`,
 * identical across all 46 invoices this deployment knows) and cross-checked against Request's
 * published `subgraph-sepolia.yaml`.
 */
const REQUEST_STORAGE = "0xd6c085a4d14e9e171f4af58f7f48bd81173f167e";

/**
 * Prove the anchor belongs to THIS invoice, or do not have one.
 *
 * The anchor is the floor of every payment scan for this invoice, and it decides whether a
 * negative is conclusive at all: without one, `findPaymentByReference` reports `truncated` and the
 * already-paid gate refuses. So an anchor a caller can choose is an anchor that can turn "this
 * invoice was paid 460,000 blocks ago" into "not paid" — and then the invoice is paid a second
 * time. A reviewer demonstrated exactly that by moving the anchor forward.
 *
 * It arrives in `meta`, which the channel id does NOT hash, so the id binding says nothing about
 * it. The first repair checked the receipt of the transaction the anchor names and compared block
 * numbers — which proves a transaction with that hash is in that block, and any real recent
 * transaction on Sepolia satisfies that.
 *
 * This binds it to the invoice. The anchoring transaction is the one that wrote this channel's
 * bytes to Request's storage contract, and that contract's event carries the IPFS CID of the
 * bytes it stored. The CID is a content hash: it cannot name this invoice's create unless it IS
 * this invoice's create. So the anchor is believed when, and only when, the transaction it names
 * emitted from Request's storage contract a log carrying the CID the gateway served alongside it.
 *
 * Three outcomes, and the difference between them is the point:
 *   - bound        -> the anchor is returned and scans may conclude from it
 *   - unreadable   -> no anchor; scans stay inconclusive, which costs liveness and never money
 *   - disproved    -> REFUSED. A receipt in another block, or one that stored other bytes, is a
 *                     fabricated anchor, and the invoice around it is not to be acted on.
 */
async function bindAnchor(
  id: string,
  anchor: { blockNumber: number; transactionHash: string },
  cid: string | undefined,
  readReceipt: ReceiptReader,
  rpcUrl?: string,
): Promise<{ blockNumber: number; transactionHash: string } | undefined> {
  let receipt: Awaited<ReturnType<ReceiptReader>>;
  try {
    receipt = await readReceipt(anchor.transactionHash, rpcUrl);
  } catch {
    return undefined; // unread, not disproved
  }
  if (receipt.blockNumber === undefined) return undefined;
  if (receipt.blockNumber !== anchor.blockNumber) {
    throw new RequestError(
      "ANCHOR_UNBOUND",
      `invoice ${id} claims it was anchored at block ${anchor.blockNumber}, but the transaction it ` +
        `names is in block ${receipt.blockNumber}. The anchor bounds every search for a payment on ` +
        "this invoice, so a wrong one hides payments that exist.",
    );
  }
  if (!cid) return undefined; // nothing to bind it to; unproven rather than disproved

  const wanted = Buffer.from(cid, "utf8").toString("hex").toLowerCase();
  const stored = (receipt.logs ?? []).some(
    (log) =>
      typeof log.address === "string" &&
      log.address.toLowerCase() === REQUEST_STORAGE &&
      typeof log.data === "string" &&
      log.data.toLowerCase().includes(wanted),
  );
  if (!stored) {
    throw new RequestError(
      "ANCHOR_UNBOUND",
      `invoice ${id} names ${anchor.transactionHash} as the transaction that anchored it, but that ` +
        `transaction stored no bytes identified by ${cid} in Request's storage contract. A block ` +
        "number anybody can choose is not a floor: it decides whether a scan that found no payment " +
        "means the invoice is unpaid.",
    );
  }
  return anchor;
}

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

/** Deep-sorted keys, then lowercased — Request's own normalisation before hashing. */
function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalizeForHash((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Who is allowed to say what, on a Request channel.
 *
 * Request's action set is not symmetric, and the asymmetry is the whole point: only the party who
 * OWES more can agree to owe more. Enforcing that is what makes a recovered signer useful rather
 * than decorative -- without it, a payee could sign an increase and this system would pay it.
 *
 * `create` and `cancel` are open to both parties because Request allows both; `accept` and
 * `increaseExpectedAmount` are the payer's, `reduceExpectedAmount` is the payee's.
 */
const SIGNER_ROLES: Readonly<Record<string, ReadonlyArray<"payee" | "payer">>> = {
  create: ["payee", "payer"],
  cancel: ["payee", "payer"],
  accept: ["payer"],
  increaseExpectedAmount: ["payer"],
  reduceExpectedAmount: ["payee"],
};

/**
 * Every action on the channel recovers to a party the create names, in a role Request allows it.
 *
 * The digest is the one Request signs: keccak256 over the action's `data`, keys deep-sorted and
 * the whole JSON lowercased -- the same normalisation the channel id uses, over `data` instead of
 * the envelope. That was not assumed: `scripts/verify-signatures.ts` recovers every action of
 * every invoice this deployment knows and checks the address against the create's own parties.
 *
 * Refusals here are deliberate in both directions. A signature that does not recover, a method
 * this reader does not understand, a signer who is neither party, and a party acting outside its
 * role all stop the settlement -- including the ones that would REDUCE what is paid, because an
 * invoice whose history cannot be authenticated is not an invoice whose amount can be trusted in
 * either direction.
 */
function assertActionsAreSigned(
  id: string,
  actions: ReadonlyArray<{ index: number; data: unknown; signed: unknown }>,
  parties: { payee?: string; payer?: string },
): void {
  const payee = parties.payee?.toLowerCase();
  const payer = parties.payer?.toLowerCase();
  /**
   * Every signature already seen on this channel.
   *
   * A signature authorises ONE action, and nothing counted them. The gateway could serve the same
   * signed `increaseExpectedAmount` five times and the reader applied five increases -- one
   * signature, five deltas, all of them "signed by the payer" and every one of them true. A
   * reviewer measured it: one authorised increase of 500 became 2,500.
   *
   * Bounded downstream by the ceiling and by the human, which is why this is an overpay within
   * limits rather than an unbounded loss. It is still a debt nobody agreed to.
   */
  const seen = new Set<string>();

  for (const action of actions) {
    const name = asString(dig(action.data, "name")) ?? "unnamed";
    // The create is authenticated by the channel id, which is a hash over the whole signed create
    // -- a stronger binding than its signature, because it ties the bytes to the id the CALLER
    // asked for rather than to a key the caller has never seen. Its signature is deliberately not
    // role-checked on top of that: Request allows a delegate identity to sign on a party's
    // behalf, so a rule saying "the create must be signed by the payee or the payer" would refuse
    // legitimate invoices to re-prove something already proved. Every action AFTER the create has
    // no such binding, and those are the ones that move the debt.
    if (name === "create") continue;
    const method = asString(dig(action.signed, "signature", "method"));
    const value = asString(dig(action.signed, "signature", "value"));
    if (method !== "ecdsa") {
      throw new RequestError(
        "ACTION_UNSIGNED",
        `action ${action.index} (${name}) on invoice ${id} is signed with ${method ?? "no method"}, which this ` +
          "reader cannot check. An action it cannot authenticate is not one it will act on.",
      );
    }
    if (!value) {
      throw new RequestError(
        "ACTION_UNSIGNED",
        `action ${action.index} (${name}) on invoice ${id} carries no signature value`,
      );
    }

    const digest = keccak256(new TextEncoder().encode(JSON.stringify(normalizeForHash(action.data)).toLowerCase()));
    const signer = recoverAddress(digest, value)?.toLowerCase() ?? null;
    if (signer === null) {
      throw new RequestError(
        "ACTION_SIGNATURE_INVALID",
        `action ${action.index} (${name}) on invoice ${id} carries a signature that recovers to no address; ` +
          "the bytes have been altered or the signature is not over this action",
      );
    }

    if (seen.has(value.toLowerCase())) {
      throw new RequestError(
        "ACTION_REPLAYED",
        `action ${action.index} (${name}) on invoice ${id} carries a signature that already appears ` +
          "earlier on this channel. A signature authorises one action; serving it twice is two " +
          "actions on one authorisation.",
      );
    }
    seen.add(value.toLowerCase());

    // And it has to be about THIS invoice.
    //
    // Request's actions name the request they act on. Nothing compared that to the channel being
    // read, so an increase legitimately signed by a payer on THEIR OWN invoice could be lifted
    // onto somebody else's and applied there -- a real signature, a real party, the wrong debt.
    const about = asString(dig(action.data, "parameters", "requestId"));
    if (about !== undefined && about.toLowerCase() !== id.toLowerCase()) {
      throw new RequestError(
        "ACTION_FOREIGN",
        `action ${action.index} (${name}) served on invoice ${id} says it acts on ${about}. A ` +
          "signature over another invoice's action is not authorisation for this one.",
      );
    }

    const role = signer === payee ? "payee" : signer === payer ? "payer" : null;
    if (role === null) {
      throw new RequestError(
        "ACTION_SIGNATURE_INVALID",
        `action ${action.index} (${name}) on invoice ${id} was signed by ${signer}, who is neither the payee ` +
          `(${payee ?? "unnamed"}) nor the payer (${payer ?? "unnamed"}) this invoice names`,
      );
    }

    const allowed = SIGNER_ROLES[name];
    // A name this reader has never heard of is refused a few lines further down, by the check
    // that exists to say so. Failing it HERE would refuse it for the wrong reason -- "Request
    // only allows no party to take it" is not true of an action nobody here understands -- and a
    // refusal that misstates its own cause sends the next reader looking in the wrong place.
    if (!allowed) continue;
    if (!allowed.includes(role)) {
      throw new RequestError(
        "ACTION_ROLE_VIOLATION",
        `action ${action.index} on invoice ${id} is a ${name} signed by the ${role}, and Request only allows ` +
          `${allowed.join(" or ")} to take it. An increase signed by the party being PAID ` +
          "is somebody raising a debt against themselves' counterparty, which is not a thing this settles.",
      );
    }
  }
}

function assertChannelIdBindsCreate(id: string, signedCreate: unknown): void {
  if (signedCreate === undefined) {
    throw new RequestError("MALFORMED_TRANSACTION", `channel ${id} served a create this reader could not re-read`);
  }
  const derived = `01${keccak256Hex(JSON.stringify(normalizeForHash(signedCreate)).toLowerCase()).replace(/^0x/, "")}`;
  if (derived !== id) {
    throw new RequestError(
      "REQUEST_ID_MISMATCH",
      `channel ${id} served a create that hashes to ${derived}. The request id is a hash of the ` +
        "signed create action, so these are not the bytes that id refers to — the invoice has been " +
        "substituted somewhere between Request and here.",
    );
  }
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
