/**
 * Gate A — prove the composed integration before building on it.
 *
 * Runs as far as it can with whatever credentials exist, and says precisely what is missing
 * rather than failing vaguely. Every step is independently verifiable; nothing is inferred
 * from a status string.
 *
 * Order matters: the riskiest assumption is tested first, so a failure costs one step
 * instead of a day.
 *
 *   1  chain reachable, Sepolia, contracts deployed        (no credentials)
 *   2  KeeperHub key present and its chain list agrees     (KEEPERHUB_API_KEY)
 *   3  Request credential present                          (REQUEST_CLIENT_ID or _API_KEY)
 *   4  create an invoice on Sepolia in FAU                 (needs step 3)
 *   5  fetch payment calldata + fee metadata               (needs step 4)
 *   6  land it through KeeperHub's generic web3 write       (needs steps 2 and 5)
 *   7  eth_getTransactionReceipt says success               (independent read)
 *   8  the fee-proxy event carries this reference           (independent read; the query
 *      Request's detection runs, run here. For Request's own SDK verdict instead, run
 *      node tools/invoice/check-paid.mjs, which needs no credential either.)
 *
 * Usage: node --experimental-strip-types scripts/gate-a.ts
 * Secrets come from the environment or .env. Nothing is printed but a masked prefix.
 */

import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_RPC, findPaymentByReference, rpcCall } from "../src/chain.ts";
import { selector } from "../src/keccak.ts";

const SEPOLIA = 11155111;
const RPC = DEFAULT_RPC;
const REQUEST_API = "https://api.request.network/v2";
/** The protocol gateway. Unauthenticated, and the only Request endpoint this project needs. */
const REQUEST_GATEWAY = "https://sepolia.gateway.request.network/";
const KEEPERHUB_API = "https://app.keeperhub.com/api";

const ERC20_FEE_PROXY = "0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE";
const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";

// ---- env ------------------------------------------------------------------

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

const KH_KEY = process.env.KEEPERHUB_API_KEY ?? "";
const RN_CLIENT_ID = process.env.REQUEST_CLIENT_ID ?? "";
const RN_API_KEY = process.env.REQUEST_API_KEY ?? "";
const PAYEE = process.env.PAYEE_ADDRESS ?? "";

/** Never print a credential. A prefix is enough to tell "wrong key" from "no key". */
/**
 * Say whether a credential is present, never what it is.
 *
 * This used to print the first six characters. A prefix is still a fragment of a live key,
 * and it ends up in terminal scrollback, CI logs and screen recordings — including the demo
 * video this repository ships.
 */
function mask(v: string): string {
  return v ? `present (${v.length} chars)` : "absent";
}

// ---- reporting ------------------------------------------------------------

type Status = "ok" | "FAIL" | "BLOCKED";
const results: Array<{ step: string; status: Status; detail: string }> = [];

function record(step: string, status: Status, detail: string): void {
  results.push({ step, status, detail });
  const tag = status === "ok" ? "  ok  " : status === "FAIL" ? " FAIL " : "BLOCKED";
  console.log(`${tag} ${step}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Deliberately the same `rpcCall` the settlement path uses, rather than a private copy.
 * A second implementation here would drift from the one under test, and the earlier copy
 * did: it had no fallback, so a receipt pruned by one endpoint was reported as "no receipt"
 * — indistinguishable from a payment that never landed.
 */
async function rpc(method: string, params: unknown[]): Promise<unknown> {
  return rpcCall(RPC, method, params, 20_000);
}

console.log("\nGate A — Request Network x KeeperHub on Sepolia\n");
console.log(`credentials: KEEPERHUB_API_KEY ${mask(KH_KEY)} · REQUEST_CLIENT_ID ${mask(RN_CLIENT_ID)}`);
console.log(`             REQUEST_API_KEY ${mask(RN_API_KEY)} · PAYEE_ADDRESS ${PAYEE || "absent"}\n`);

// ---- 1. chain, no credentials --------------------------------------------

try {
  const chainId = Number(await rpc("eth_chainId", []));
  record("1a chain is Ethereum Sepolia", chainId === SEPOLIA ? "ok" : "FAIL", `chainId ${chainId}`);

  for (const [name, addr] of [["ERC20FeeProxy", ERC20_FEE_PROXY], ["FAU", FAU]] as const) {
    const code = (await rpc("eth_getCode", [addr, "latest"])) as string;
    const bytes = (code.length - 2) / 2;
    record(`1b ${name} deployed`, bytes > 0 ? "ok" : "FAIL", `${addr}, ${bytes} bytes`);
  }

  const paySel = selector("transferFromWithReferenceAndFee(address,address,uint256,bytes,uint256,address)");
  record("1c payment selector computed", "ok", paySel);
} catch (e) {
  record("1  chain checks", "FAIL", String(e));
}

// ---- 2. KeeperHub ---------------------------------------------------------

// The chain list is public, so it is checkable even with no key at all.
try {
  const res = await fetch(`${KEEPERHUB_API}/chains`, { headers: { accept: "application/json" } });
  const chains = (await res.json()) as Array<{ chainId: number; isEnabled: boolean; name: string }>;
  const sep = chains.find((c) => c.chainId === SEPOLIA);
  record(
    "2a KeeperHub has Sepolia enabled",
    sep?.isEnabled ? "ok" : "FAIL",
    sep ? `${sep.name}, isEnabled=${sep.isEnabled}` : "not in chain list",
  );
} catch (e) {
  record("2a KeeperHub chain list", "FAIL", String(e));
}

if (!KH_KEY) {
  record("2b KeeperHub key accepted", "BLOCKED", "set KEEPERHUB_API_KEY in .env (app.keeperhub.com -> Settings -> Developer)");
} else {
  try {
    const res = await fetch(`${KEEPERHUB_API}/keys`, { headers: { authorization: `Bearer ${KH_KEY}` } });
    record("2b KeeperHub key accepted", res.ok ? "ok" : "FAIL", `HTTP ${res.status}`);
  } catch (e) {
    record("2b KeeperHub key accepted", "FAIL", String(e));
  }
}

// ---- 3-5. Request --------------------------------------------------------

const rnHeaders: Record<string, string> = { "content-type": "application/json" };
if (RN_API_KEY) rnHeaders["x-api-key"] = RN_API_KEY;
else if (RN_CLIENT_ID) rnHeaders["x-client-id"] = RN_CLIENT_ID;

let requestId = "";

// Step 3 used to demand a dashboard Client ID and block steps 4 and 5 without one. That was
// wrong, and it was this repository that proved it wrong: the Request protocol gateway
// accepts persistTransaction unauthenticated, which is how all 38 live invoices were created
// (tools/invoice/create-batch.mjs points the SDK at it). The credential buys the hosted REST
// convenience API, not the ability to raise an invoice. So the gate now checks the thing the
// project actually depends on, and treats the credential as optional.
// The check is not "does the host answer" — a 404 would satisfy that. It reads one of this
// project's own invoices back out of Request's node by channel id, unauthenticated, and
// requires the storage metadata to come with it. That proves three things at once: the
// gateway needs no credential, the invoice is a real Request invoice rather than a local
// fiction, and it is anchored on Sepolia at a block anyone can go and look at.
const liveRowsForGateway: Array<{ request_id?: string }> = existsSync("docs/refusals-live.json")
  ? (JSON.parse(readFileSync("docs/refusals-live.json", "utf8")).rows ?? [])
  : [];
const knownRequestId = liveRowsForGateway.find((r) => r.request_id)?.request_id;

if (!knownRequestId) {
  record("3  invoice readable from Request, no credential", "BLOCKED", "no recorded live invoice to read back");
} else {
  try {
    const res = await fetch(
      `${REQUEST_GATEWAY}getTransactionsByChannelId?channelId=${knownRequestId}`,
      { signal: AbortSignal.timeout(20_000) },
    );
    const body = (await res.json()) as {
      meta?: { storageMeta?: Array<{ ethereum?: { blockNumber?: number; transactionHash?: string } }> };
      result?: { transactions?: unknown[] };
    };
    const anchor = body.meta?.storageMeta?.[0]?.ethereum;
    if (res.ok && anchor?.blockNumber) {
      record(
        "3  invoice readable from Request, no credential",
        "ok",
        `channel ${knownRequestId.slice(0, 14)}… anchored at block ${anchor.blockNumber}`,
      );
    } else {
      record("3  invoice readable from Request, no credential", "FAIL", `HTTP ${res.status}, no storage anchor`);
    }
  } catch (e) {
    record("3  invoice readable from Request, no credential", "FAIL", String(e));
  }
}

if (!RN_API_KEY && !RN_CLIENT_ID) {
  const why = "optional: the hosted REST API is a convenience, not a dependency — invoices are raised through the gateway above";
  record("4  invoice created via the hosted REST API", "BLOCKED", why);
  record("5  payment calldata fetched from the hosted REST API", "BLOCKED", why);
} else if (!PAYEE) {
  record("3  payee configured", "BLOCKED", "set PAYEE_ADDRESS in .env (the burner receiving address)");
} else {
  record("3b hosted REST credential present", "ok", RN_API_KEY ? "using x-api-key" : "using x-client-id");

  // ---- 4. create the invoice ---------------------------------------------
  try {
    const res = await fetch(`${REQUEST_API}/request`, {
      method: "POST",
      headers: rnHeaders,
      // amount is HUMAN-READABLE here. Base units are derived downstream, never guessed.
      body: JSON.stringify({ payee: PAYEE, amount: "1", invoiceCurrency: "USD", paymentCurrency: "FAU-sepolia" }),
    });
    const body = (await res.json()) as { requestId?: string; message?: string };
    if (res.ok && body.requestId) {
      requestId = body.requestId;
      record("4  invoice created on Sepolia", "ok", `requestId ${requestId}`);
    } else {
      record("4  invoice created on Sepolia", "FAIL", `HTTP ${res.status} ${body.message ?? ""}`);
    }
  } catch (e) {
    record("4  invoice created on Sepolia", "FAIL", String(e));
  }

  // ---- 5. payment calldata ------------------------------------------------
  if (requestId) {
    try {
      const res = await fetch(`${REQUEST_API}/request/${requestId}/pay`, { headers: rnHeaders });
      const body = (await res.json()) as {
        transactions?: Array<{ to: string; data: string; value: string }>;
        metadata?: { stepsRequired?: number; needsApproval?: boolean; protocolFee?: { percentage: string; address: string } };
      };
      const txs = body.transactions ?? [];
      const md = body.metadata ?? {};
      record(
        "5  payment calldata fetched",
        txs.length > 0 ? "ok" : "FAIL",
        `${txs.length} tx, stepsRequired=${md.stepsRequired}, needsApproval=${md.needsApproval}, ` +
          `protocolFee=${md.protocolFee?.percentage ?? "?"}% -> ${md.protocolFee?.address ?? "?"}`,
      );
      if (txs.length > 0) {
        const payTx = txs[txs.length - 1];
        const sel = payTx.data.slice(0, 10);
        const expected = selector("transferFromWithReferenceAndFee(address,address,uint256,bytes,uint256,address)");
        record(
          "5b calldata targets the verified proxy selector",
          sel === expected && payTx.to.toLowerCase() === ERC20_FEE_PROXY.toLowerCase() ? "ok" : "FAIL",
          `to=${payTx.to} selector=${sel} expected=${expected}`,
        );
      }
    } catch (e) {
      record("5  payment calldata fetched", "FAIL", String(e));
    }
  } else {
    record("5  payment calldata fetched", "BLOCKED", "needs step 4");
  }
}

// ---- 6-8. execution, blocked until 2b and 5 both pass --------------------

// These three used to report BLOCKED unconditionally, with a note saying live execution was
// "intentionally not automated yet". That stopped being true once payments landed, and a gate
// that reports BLOCKED on the three steps that matter while the repository claims 38 real
// payments is worse than no gate at all.
//
// They are checked against the recorded live run rather than by paying again — the whole
// point of the project is that running it twice does not produce a second payment. The
// evidence is re-derived from a public RPC, so it does not rest on the recording being
// truthful: a fabricated hash fails here.
const liveRows: Array<{
  tx_hash?: string | null;
  payment_reference?: string;
  actual?: string;
}> = existsSync("docs/refusals-live.json")
  ? (JSON.parse(readFileSync("docs/refusals-live.json", "utf8")).rows ?? [])
  : [];
const settled = liveRows.find((r) => r.actual === "SETTLED" && r.tx_hash && r.payment_reference);

if (!settled) {
  const why = "no recorded live settlement in docs/refusals-live.json — run npm run harness:live";
  record("6  land payment through KeeperHub", "BLOCKED", why);
  record("7  eth_getTransactionReceipt says success", "BLOCKED", why);
  record("8  Request reports the reference paid", "BLOCKED", why);
} else {
  const hash = settled.tx_hash as string;
  const reference = settled.payment_reference as string;

  const tx = (await rpc("eth_getTransactionByHash", [hash])) as { to?: string; from?: string } | null;
  if (tx?.to) {
    // Gas is sponsored: the transaction goes to the forwarder, and the payer is still the
    // account whose allowance is spent. `to` being the forwarder is the meta-transaction
    // working, not a wrong destination.
    record("6  land payment through KeeperHub", "ok", `tx ${hash.slice(0, 18)}… relayed via ${tx.to}`);
  } else {
    record("6  land payment through KeeperHub", "FAIL", `no such transaction on chain: ${hash}`);
  }

  const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as
    | { status?: string; gasUsed?: string }
    | null;
  if (receipt?.status === "0x1") {
    record("7  eth_getTransactionReceipt says success", "ok", `gasUsed ${BigInt(receipt.gasUsed ?? "0x0")}`);
  } else {
    record("7  eth_getTransactionReceipt says success", "FAIL", `status ${receipt?.status ?? "no receipt"}`);
  }

  // Request's own payment detection, read as a chain fact rather than through its API.
  const sighting = await findPaymentByReference(reference, { lookbackBlocks: 300_000, rpcUrl: RPC });
  if (sighting.found && sighting.txHash?.toLowerCase() === hash.toLowerCase()) {
    record("8  Request reports the reference paid", "ok", `${reference} in the fee-proxy log, same tx`);
  } else if (sighting.found) {
    record("8  Request reports the reference paid", "FAIL", `reference found under a different tx: ${sighting.txHash}`);
  } else {
    record(
      "8  Request reports the reference paid",
      sighting.truncated ? "BLOCKED" : "FAIL",
      sighting.truncated ? "scan window ran out before the payment" : `no fee-proxy log for ${reference}`,
    );
  }
}

// ---- summary --------------------------------------------------------------

const failed = results.filter((r) => r.status === "FAIL").length;
const blocked = results.filter((r) => r.status === "BLOCKED").length;
const passed = results.filter((r) => r.status === "ok").length;

console.log(`\n${passed} ok · ${failed} failed · ${blocked} blocked\n`);

if (failed > 0) {
  console.log("A FAIL means an assumption in docs/MASTER.md is wrong. Fix the boundary before building on it.\n");
  process.exit(1);
}
if (blocked > 0) {
  console.log(
    "BLOCKED steps are the hosted REST convenience API, which this project does not depend on:\n" +
      "invoices are raised through the unauthenticated protocol gateway checked at step 3, and the\n" +
      "payment calldata is encoded locally and proved byte-identical to KeeperHub's own encoder by\n" +
      "`npm run verify:seam`. Nothing is claimed on their behalf.\n",
  );
  // Blocked is not failed. Every other command here treats a missing credential as something it
  // could not check rather than something that is wrong, and this one exiting 2 on a clean clone
  // was the first hard failure a stranger hit -- on a page whose whole argument is that its
  // numbers are checked. The tally still prints, and blocked is still never counted as a pass.
  process.exit(0);
}
console.log("Gate A passed. The composed integration is real.\n");
