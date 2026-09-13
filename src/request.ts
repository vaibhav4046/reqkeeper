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
import { personalSignDigest, recoverAddress } from "./secp256k1.ts";

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
  | "ACTION_FOREIGN"
  /** A party really took an extension action (addFee, addPaymentAddress) this reader cannot apply. */
  | "EXTENSION_ACTION_UNSUPPORTED";

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
  /**
   * Actions on this channel that did not authenticate, and were therefore not applied.
   *
   * Request ignores these too, so an invoice carrying them is still a payable invoice — but the
   * person approving the payment should be told that somebody has been appending to the channel.
   * Absent when the whole channel authenticated, which is every invoice this deployment knows.
   */
  readonly ignoredActions?: ReadonlyArray<IgnoredAction>;
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
  /** Unix seconds of the block, when the reader could learn it. See `bindAnchor`. */
  blockTimestamp?: number;
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
      // The transaction's own state and timestamp travel with it. Request splits a channel into
      // CONFIRMED actions, reduced from nothing, and PENDING ones reduced on top -- and exposes
      // the two separately. A pending action is not anchored on Sepolia and costs nothing to post.
      const state = asString(dig(tx, "state")) ?? "confirmed";
      const at = dig(tx, "timestamp");
      return { index, data: dig(signed, "data"), signed, state, timestamp: typeof at === "number" ? at : null };
    } catch (e) {
      throw new RequestError(
        "MALFORMED_TRANSACTION",
        `transaction ${index} on channel ${id} is not parseable JSON: ${asMessage(e)}`,
      );
    }
  });

  // The create is the one whose bytes hash to the channel id -- not the first one in the array.
  //
  // Selecting by position and then checking the hash meant a stranger's create appended to a real
  // channel and served ahead of the genuine one made the whole invoice REQUEST_ID_MISMATCH: the
  // refusal that says "substituted in transit", about an invoice that was fine, for ever. The
  // comment on the cancel check below says position must not matter; this made it matter.
  const creates = actions.filter((a) => asString(dig(a.data, "name")) === "create");
  if (creates.length === 0) {
    throw new RequestError(
      "NO_CREATE_ACTION",
      `channel ${id} has no create action (${actions.length} transaction(s)); there is no invoice to read`,
    );
  }
  const create = creates.find((c) => channelIdOf(c.signed) === id);
  if (!create) {
    throw new RequestError(
      "REQUEST_ID_MISMATCH",
      `channel ${id} served ${creates.length} create action(s) and none hashes to ${id}. The request id is a ` +
        "hash of the signed create action, so these are not the bytes that id refers to — the invoice has " +
        "been substituted somewhere between Request and here.",
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
  const authentication = authenticateActions(id, actions, create.index, {
    payee: asString(dig(create.data, "parameters", "payee", "value")),
    payer: asString(dig(create.data, "parameters", "payer", "value")),
  });

  // Only what authenticated. Everything else is ignored exactly as Request ignores it, counted,
  // and named to the human below -- rather than refusing the invoice, which let any stranger wedge
  // a real debt for ever by appending junk to a public channel.
  const ignored: IgnoredAction[] = [...authentication.ignored];
  const everyAction = actions
    .filter((a) => authentication.applicable.has(a.index))
    .filter((a) => {
      // The create is read whatever its state -- an unconfirmed create is exactly the unanchored
      // invoice, handled by the absent anchor. A pending LATER action is not applied to the
      // figures a human approves: Request keeps it out of the confirmed state, and it is not
      // anchored anywhere. It is named, so the approver hears that a change is on its way.
      if (a.index === create.index || a.state === "confirmed") return true;
      ignored.push({
        index: a.index,
        name: asString(dig(a.data, "name")) ?? "unnamed",
        reason: `action ${a.index} is ${a.state}, not confirmed: Request has not anchored it and does not apply it to the confirmed invoice yet`,
      });
      return false;
    })
    .map((a) => ({
      index: a.index,
      name: asString(dig(a.data, "name")),
      parameters: dig(a.data, "parameters"),
      timestamp: a.timestamp,
      role: authentication.applicable.get(a.index) ?? null,
    }))
    // Request orders a channel by timestamp before applying it (`computeRequestFromRequestId`
    // sorts on `timestamp`), and with per-step arithmetic the order changes the answer. The array
    // index breaks ties, which is the order Request falls back to as well.
    .sort((x, y) => (x.timestamp ?? 0) - (y.timestamp ?? 0) || x.index - y.index);
  const later = everyAction.filter((a) => a.index > create.index);

  // Refuse a name this reader does not understand, rather than skipping it.
  //
  // The loop below applies the actions it knows about and ignored everything else, which reads as
  // "those do not change the debt" — a claim about Request's whole action set that this file is in
  // no position to make. An action that moves the amount under a name nobody here has heard of is
  // exactly the case where being quiet costs money, so an unknown name stops the settlement and
  // says which one it was. All 46 recorded invoices carry nothing but a `create`, so nothing in
  // this deployment is refused by it today.
  //
  // AUTHENTICATED names only, now. A stranger's junk action never reaches this check -- it was
  // dropped upstream, as Request drops it -- so the refusal means what it says: a party to this
  // invoice really took an action, and this reader cannot tell what it did to the debt.
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
  // With Request's preconditions. A payer-created request starts ACCEPTED; a payer may cancel
  // only from CREATED and accept only from CREATED; a payee may cancel from anything but
  // CANCELED (`request-logic/src/actions/{create,cancel,accept}.ts`). An action a party really
  // signed outside those rules is one Request ignores, so it is ignored here and named.
  const payerCreated = (authentication.applicable.get(create.index) ?? null) === "payer";
  let requestState: "CREATED" | "ACCEPTED" | "CANCELED" = payerCreated ? "ACCEPTED" : "CREATED";
  let cancelled: (typeof everyAction)[number] | undefined;
  for (const a of everyAction) {
    if (a.index === create.index) continue;
    if (a.name === "accept") {
      if (requestState !== "CREATED" || a.role !== "payer") {
        ignored.push({ index: a.index, name: "accept", reason: `accept at action ${a.index} by the ${a.role} while the request is ${requestState}; Request allows it only by the payer from CREATED` });
        continue;
      }
      requestState = "ACCEPTED";
    } else if (a.name === "cancel") {
      const allowed = a.role === "payee" ? requestState !== "CANCELED" : a.role === "payer" && requestState === "CREATED";
      if (!allowed) {
        ignored.push({ index: a.index, name: "cancel", reason: `cancel at action ${a.index} by the ${a.role} while the request is ${requestState}; Request allows a payer to cancel only from CREATED` });
        continue;
      }
      requestState = "CANCELED";
      cancelled ??= a;
    }
  }
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
  // Optional on the extension (`pn-any-reference-based-types.ts`: `paymentNetworkName?`), and used
  // by Request only as a cross-check against `currency.network`, which is checked above and is the
  // authority. Requiring it refused every ERC20FeeProxy invoice from a client that omits it; every
  // invoice this deployment made carried it only because its own generator hardcodes the field.
  const paymentNetworkName = asString(dig(ep, "paymentNetworkName"));
  if (paymentNetworkName !== undefined) assertSepolia(id, "paymentNetworkName", paymentNetworkName);

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
  /**
   * An invoice with no fee is an invoice, not a malformed one.
   *
   * `feeAddress` and `feeAmount` are OPTIONAL on Request's fee-proxy extension: its
   * `fee-reference-based.ts#createCreationAction` validates each only if present, and enforces one
   * rule about the pair -- neither, or both. So the ordinary invoice created through Request's own
   * app with no fee carries neither field, and this reader refused every one of them as
   * malformed. Every invoice this deployment made carries an explicit `"0"` and the zero address,
   * which is why the gap survived: the fixture and the product agreed with each other.
   *
   * Absent means no fee, which is what the ERC20FeeProxy call expresses as amount 0 to the zero
   * address -- the exact calldata this system already builds for its own zero-fee invoices. Half a
   * pair is refused, because Request refuses to create one and a half-stated fee is not a fee this
   * reader can guess at.
   */
  const statedFeeAddress = asString(dig(ep, "feeAddress"));
  const statedFeeAmount = asString(dig(ep, "feeAmount"));
  if ((statedFeeAddress === undefined) !== (statedFeeAmount === undefined)) {
    throw new RequestError(
      "MALFORMED_TRANSACTION",
      `invoice ${id} states ${statedFeeAddress === undefined ? "a feeAmount with no feeAddress" : "a feeAddress with no feeAmount"}. ` +
        "Request's own builder refuses that pairing (fee-reference-based.ts#createCreationAction: " +
        '"feeAmount requires feeAddress"); its reader would accept the half. This one does not: a fee ' +
        "with no recipient, or a recipient with no fee, is not a fee this reader will complete by guessing.",
    );
  }
  const feeRecipient =
    statedFeeAddress === undefined ? `0x${"0".repeat(40)}` : assertAddress("feeAddress", statedFeeAddress);
  const salt = assertBareHex("salt", asString(dig(ep, "salt")));
  // Request's read path (`reference-based.ts#applyCreation`) requires `/[0-9a-f]{16,}/`.
  if (!/^[0-9a-f]{16,}$/.test(salt)) {
    throw new RequestError("BAD_IDENTIFIER", `salt must be at least 16 lowercase hex characters, got ${JSON.stringify(salt)}`);
  }
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
    // Each delta is its own step, and a step that would go below zero is DROPPED and the previous
    // amount carried forward -- `utils/src/amount.ts#reduceAmount` throws on a negative result and
    // `computeRequestFromTransactions` ignores the action. This used to sum every delta and check
    // the sign once at the end: `create 100 → reduce 150 → increase 100` read 50 here and 200 on
    // Request, a fourfold underpayment on a channel where every signature and role was right.
    if (a.name === "increaseExpectedAmount") {
      amount += BigInt(assertBaseUnits(`action ${a.index} deltaAmount`, asString(dig(a.parameters, "deltaAmount"))));
      changingActions++;
    } else if (a.name === "reduceExpectedAmount") {
      const delta = BigInt(assertBaseUnits(`action ${a.index} deltaAmount`, asString(dig(a.parameters, "deltaAmount"))));
      if (delta > amount) {
        ignored.push({ index: a.index, name: a.name, reason: `reduce of ${delta} at action ${a.index} would take the amount below zero; Request ignores that step and keeps ${amount}` });
        continue;
      }
      amount -= delta;
      changingActions++;
    }
    // An extension action on a later transaction -- `addFee`, `addPaymentAddress` -- changes what
    // the invoice declares, and this reader applies extensions from the create only. A party
    // really signed it, so it is neither applied nor quietly dropped: the settlement stops and
    // says which action, rather than paying a fee recipient nothing and calling the invoice paid.
    const laterExtensions = asArray(dig(a.parameters, "extensionsData")).filter(
      (e) => asString(dig(e, "id")) === FEE_PROXY_EXTENSION_ID,
    );
    if (laterExtensions.length > 0) {
      throw new RequestError(
        "EXTENSION_ACTION_UNSUPPORTED",
        `invoice ${id} carries a ${FEE_PROXY_EXTENSION_ID} action (${asString(dig(laterExtensions[0], "action")) ?? "unstated"}) ` +
          `on action ${a.index}, signed by the ${a.role}. This reader applies the extension's create entry only; a ` +
          "fee or payment address changed afterwards is not something it will guess at.",
      );
    }
  }
  const invoiceBaseUnits = amount.toString();
  // Carried so the sentence a human approves can name it. The action is authenticated now --
  // `assertActionsAreSigned` has recovered a signer and checked it against Request's role rules,
  // so an increase really was signed by the payer -- but "signed by the right party" is not
  // "expected by the human who is about to approve it". An amount that moved after the invoice
  // was raised belongs on that screen.
  const amountChangedBy =
    changingActions > 0 ? { actions: changingActions, fromBaseUnits: raisedAt.toString() } : undefined;
  const feeBaseUnits = statedFeeAmount === undefined ? "0" : assertBaseUnits("feeAmount", statedFeeAmount);

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
    // Deliberately NOT part of the facts a plan hashes. Anyone can append to a public channel, so
    // hashing this would let a stranger invalidate a human's approval on demand -- the wedge this
    // change removes, rebuilt one layer up. It reaches the approval sentence instead.
    ...(ignored.length > 0 ? { ignoredActions: ignored } : {}),
    ...(await boundAnchorFor(id, body, create.index, opts, asNumber(dig(create.data, "parameters", "timestamp")))),
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
  createdAt?: number,
): Promise<{ anchor?: { blockNumber: number; transactionHash: string } }> {
  const claimed = storageAnchor(body, index).anchor;
  if (!claimed) return {};
  const cid = asString(asArray(dig(body, "meta", "transactionsStorageLocation"))[index]);
  const bound = await bindAnchor(id, claimed, cid, opts.readReceipt ?? defaultReceiptReader, opts.rpcUrl, createdAt);
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
/**
 * How long after a create's signed timestamp its anchoring transaction may be mined. Request
 * batches to Sepolia within minutes; a day is generous. What it rules out is the attack: an anchor
 * moved forward by months.
 */
const ANCHOR_LAG_SECONDS = 24 * 3600;

async function bindAnchor(
  id: string,
  anchor: { blockNumber: number; transactionHash: string },
  cid: string | undefined,
  readReceipt: ReceiptReader,
  rpcUrl?: string,
  createdAt?: number,
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

  // The CID check below proves the named transaction stored SOME Request bytes identified by the
  // CID the gateway served -- and the CID comes from the same untrusted blob as the block and the
  // hash, so a gateway that lies can hand over any real storage transaction and its real CID,
  // months after this invoice, and the triple is self-consistent. The anchor is the floor of every
  // scan and decides whether a negative is conclusive; moved forward, "paid 460,000 blocks ago"
  // reads as NOT_PAID and the invoice is paid again. Reproduced by a red-team pass.
  //
  // The create's own timestamp is signed and hash-bound to the channel id, so it cannot be moved.
  // Its anchoring transaction cannot sit in a block mined long after it. A block whose time the
  // reader could not learn binds nothing -- unread, not disproved, and no floor is the safe
  // direction: every scan for this invoice stays truncated until a reader that can say answers.
  if (createdAt !== undefined) {
    if (receipt.blockTimestamp === undefined) return undefined;
    if (receipt.blockTimestamp > createdAt + ANCHOR_LAG_SECONDS) {
      throw new RequestError(
        "ANCHOR_UNBOUND",
        `invoice ${id} was created at ${createdAt} (its own signed timestamp) but names an anchoring ` +
          `transaction in a block mined at ${receipt.blockTimestamp}, ${Math.round((receipt.blockTimestamp - createdAt) / 3600)} hours later. ` +
          "An anchor that late is a floor somebody chose, and it decides whether a scan that found no payment " +
          "means the invoice is unpaid.",
      );
    }
  }

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
 * The address that signed one action, under whichever of Request's two ECDSA methods it used.
 *
 * `ecdsa` recovers over the action digest itself. `ecdsa-ethereum` is `personal_sign`, so the
 * signature is over the EIP-191 prefix and the digest — and clients differ on what they hand the
 * wallet: some pass the 32 raw bytes, some the `0x…` text of the same digest. Both are tried, and
 * a candidate only wins by recovering to a party this invoice names. That is what makes trying
 * two encodings safe rather than lax: a wrong guess recovers to a stranger and is refused by the
 * role check below exactly as it was before, so the worst case of this function is the behaviour
 * it replaced. It cannot manufacture an authorisation, only recognise one of two spellings of the
 * same one.
 */
export function recoverActionSigner(
  method: string,
  normalized: string,
  value: string,
): string | null {
  // `ecdsa` signs keccak256 of the normalised text. `ecdsa-ethereum` is `personal_sign` over the
  // normalised TEXT ITSELF -- `utils/src/signature.ts`: `ethers.utils.hashMessage(normalize(data))`,
  // produced by `signMessage(Buffer.from(normalize(data)))` -- so the EIP-191 message is the JSON
  // string, not its hash and not the hex of its hash. A previous version of this function tried
  // both of those, which are encodings no Request client has ever used, and a real wallet-signed
  // action recovered to a stranger: a genuine cancel was dropped and the dead invoice read as
  // payable. One candidate now, the right one, and no guessing.
  const bytes = new TextEncoder().encode(normalized);
  const digest = method === "ecdsa" ? keccak256(bytes) : personalSignDigest(bytes);
  return recoverAddress(digest, value)?.toLowerCase() ?? null;
}

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
/** Why one action on a channel was not applied, in the words a human would want. */
export interface IgnoredAction {
  readonly index: number;
  readonly name: string;
  readonly reason: string;
}

/**
 * Every action on the channel, split into the ones that authenticate and the ones that do not.
 *
 * The create is the invoice's identity and must authenticate: a create this reader cannot tie to
 * a party it names is not an invoice it will read at all. Every LATER action that fails is
 * IGNORED and reported, which is what Request itself does --
 * `request-logic/src/request-logic.ts#computeRequestFromTransactions` applies each action inside a
 * try and, in its own words, "if an error occurs while applying we ignore the action", keeping the
 * rest of the channel.
 *
 * This used to throw on the first bad action and refuse the whole invoice. Channels are public and
 * append-only, so that handed any stranger a permanent denial of service: post one junk action to
 * a channel and the debt can never be settled through this system again, while every other Request
 * client goes on showing the invoice as payable. Refusing a real debt for ever is not the cautious
 * direction -- it is the same defect as paying a forged one, pointed at the creditor instead.
 *
 * What does NOT change: nothing unauthenticated is ever applied. An ignored action moves no
 * amount, cancels nothing, and is named to the human who approves the payment.
 */
function authenticateActions(
  id: string,
  actions: ReadonlyArray<{ index: number; data: unknown; signed: unknown }>,
  createIndex: number,
  parties: { payee?: string; payer?: string },
): { applicable: ReadonlyMap<number, "payee" | "payer">; ignored: IgnoredAction[] } {
  const payee = parties.payee?.toLowerCase();
  const payer = parties.payer?.toLowerCase();
  /**
   * Every signature already applied on this channel.
   *
   * A signature authorises ONE action, and nothing counted them. The gateway could serve the same
   * signed `increaseExpectedAmount` five times and the reader applied five increases -- one
   * signature, five deltas, all of them "signed by the payer" and every one of them true. A
   * reviewer measured it: one authorised increase of 500 became 2,500.
   */
  const seen = new Set<string>();
  const applicable = new Map<number, "payee" | "payer">();
  const ignored: IgnoredAction[] = [];

  for (const action of actions) {
    const name = asString(dig(action.data, "name")) ?? "unnamed";
    const failure = failureFor(id, action, name, { payee, payer }, seen);
    if (failure.role !== undefined) {
      applicable.set(action.index, failure.role);
      continue;
    }
    // The create is the one action whose failure is the invoice's, not an intruder's: the channel
    // id is a hash of these exact bytes, so a create that does not authenticate cannot be somebody
    // else's contribution to the channel. Request refuses to CREATE one
    // (`request-logic/src/actions/create.ts`: "Signer must be the payee or the payer"), and this
    // reader refuses to read one.
    if (action.index === createIndex) throw new RequestError(failure.code, failure.message);
    ignored.push({ index: action.index, name, reason: failure.message });
  }
  return { applicable, ignored };
}

/**
 * One action, checked. A `role` means it authenticates and may be applied, by that party.
 *
 * Every check here answers "did a party this invoice names really take this action, once, on this
 * invoice, in a role Request allows" -- and each returns rather than throws, because the caller
 * decides whether a failure refuses the invoice or merely drops the action.
 */
function failureFor(
  id: string,
  action: { index: number; data: unknown; signed: unknown },
  name: string,
  parties: { payee?: string; payer?: string },
  seen: Set<string>,
): { code: RequestErrorCode; message: string; role?: undefined } | { role: "payee" | "payer"; code?: undefined; message?: undefined } {
  const { payee, payer } = parties;
  const method = asString(dig(action.signed, "signature", "method"));
  const value = asString(dig(action.signed, "signature", "value"));
  // Both of Request's ECDSA methods. `ecdsa` signs the digest directly; `ecdsa-ethereum` is what
  // a browser wallet produces, the same digest under the EIP-191 personal_sign prefix. Refusing
  // the second meant refusing every invoice created from a wallet that cannot sign raw digests
  // -- a whole class of real invoices called forgeries, which is the same failure as accepting
  // one, pointed the other way.
  if (method !== "ecdsa" && method !== "ecdsa-ethereum") {
    return {
      code: "ACTION_UNSIGNED",
      message:
        `action ${action.index} (${name}) on invoice ${id} is signed with ${method ?? "no method"}, which this ` +
        "reader cannot check. An action it cannot authenticate is not one it will act on.",
    };
  }
  if (!value) {
    return {
      code: "ACTION_UNSIGNED",
      message: `action ${action.index} (${name}) on invoice ${id} carries no signature value`,
    };
  }

  const normalized = JSON.stringify(normalizeForHash(action.data)).toLowerCase();
  const digest = keccak256(new TextEncoder().encode(normalized));
  const signer = recoverActionSigner(method, normalized, value);
  if (signer === null) {
    return {
      code: "ACTION_SIGNATURE_INVALID",
      message:
        `action ${action.index} (${name}) on invoice ${id} carries a signature that recovers to no address; ` +
        "the bytes have been altered or the signature is not over this action",
    };
  }

  // Keyed on the DIGEST and the signer, not on the signature's spelling.
  //
  // One authorised signature has four accepted spellings: with or without `0x`, and with `s` or
  // `N - s` (ECDSA is malleable and `recoverAddress` accepts both). A gateway replaying the
  // same authorisation in two spellings applied two deltas -- so the guard that exists because a
  // reviewer measured one increase of 500 becoming 2,500 was defeated by dropping two
  // characters, with no cryptography involved at all. What a signature authorises is one action
  // by one party, and that is what the key says now.
  const authorised = `${signer}:${Buffer.from(digest).toString("hex")}`;
  if (seen.has(authorised)) {
    return {
      code: "ACTION_REPLAYED",
      message:
        `action ${action.index} (${name}) on invoice ${id} carries a signature that already appears ` +
        "earlier on this channel. A signature authorises one action; serving it twice is two " +
        "actions on one authorisation.",
    };
  }

  // And it has to be about THIS invoice.
  //
  // Request's actions name the request they act on. Nothing compared that to the channel being
  // read, so an increase legitimately signed by a payer on THEIR OWN invoice could be lifted
  // onto somebody else's and applied there -- a real signature, a real party, the wrong debt.
  const about = asString(dig(action.data, "parameters", "requestId"));
  if (about !== undefined && about.toLowerCase() !== id.toLowerCase()) {
    return {
      code: "ACTION_FOREIGN",
      message:
        `action ${action.index} (${name}) served on invoice ${id} says it acts on ${about}. A ` +
        "signature over another invoice's action is not authorisation for this one.",
    };
  }

  const role = signer === payee ? "payee" : signer === payer ? "payer" : null;
  if (role === null) {
    return {
      code: "ACTION_SIGNATURE_INVALID",
      message:
        `action ${action.index} (${name}) on invoice ${id} was signed by ${signer}, who is neither the payee ` +
        `(${payee ?? "unnamed"}) nor the payer (${payer ?? "unnamed"}) this invoice names`,
    };
  }

  const allowed = SIGNER_ROLES[name];
  // A name this reader has never heard of is handled by the caller, which refuses an
  // AUTHENTICATED one -- an amendment a party really made and this reader cannot interpret is an
  // "I do not know", and those do not get read as "nothing changed". Failing it HERE would refuse
  // it for the wrong reason: "Request only allows no party to take it" is not true of an action
  // nobody here understands.
  if (allowed && !allowed.includes(role)) {
    return {
      code: "ACTION_ROLE_VIOLATION",
      message:
        `action ${action.index} on invoice ${id} is a ${name} signed by the ${role}, and Request only allows ` +
        `${allowed.join(" or ")} to take it. An increase signed by the party being PAID ` +
        "is somebody raising a debt against themselves' counterparty, which is not a thing this settles.",
    };
  }
  seen.add(authorised);
  return { role };
}

/**
 * `a <= b`, over Request's three-part action versions. Missing parts count as zero.
 *
 * Written out rather than compared as strings because "10.0.0" sorts below "2.0.0" as text, and a
 * version comparison that is wrong in that direction would take the pre-2.0.0 hashing path for
 * every future version of the protocol.
 */
function versionAtMost(version: string | undefined, ceiling: string): boolean {
  const parse = (v: string) => v.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(version ?? "0.0.0"), parse(ceiling)];
  for (let i = 0; i < 3; i++) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    if (x !== y) return x < y;
  }
  return true;
}

/**
 * The channel id these bytes hash to, the way Request derives it.
 *
 * `request-logic/src/action.ts#getActionHash` says it in one line: "Before the version 2.0.0, the
 * hash was computed without the signature". So a create stating 2.0.0 or older hashes over its
 * `data` alone and a later one over the whole signed envelope. An ABSENT version is not an old
 * one: Request stamps every action it makes, and reading "no version" as "older than 2.0.0" would
 * hand an attacker the weaker binding by deleting a field.
 */
function channelIdOf(signedCreate: unknown): string {
  const version = asString(dig(signedCreate, "data", "version"));
  const hashed = version !== undefined && versionAtMost(version, "2.0.0") ? dig(signedCreate, "data") : signedCreate;
  return `01${keccak256Hex(JSON.stringify(normalizeForHash(hashed)).toLowerCase()).replace(/^0x/, "")}`;
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

const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

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
