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
 *   8  Request says hasBeenPaid                             (independent read)
 *
 * Usage: node --experimental-strip-types scripts/gate-a.ts
 * Secrets come from the environment or .env. Nothing is printed but a masked prefix.
 */

import { existsSync, readFileSync } from "node:fs";
import { selector } from "../src/keccak.ts";

const SEPOLIA = 11155111;
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const REQUEST_API = "https://api.request.network/v2";
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
function mask(v: string): string {
  return v ? `${v.slice(0, 6)}…(${v.length} chars)` : "absent";
}

// ---- reporting ------------------------------------------------------------

type Status = "ok" | "FAIL" | "BLOCKED";
const results: Array<{ step: string; status: Status; detail: string }> = [];

function record(step: string, status: Status, detail: string): void {
  results.push({ step, status, detail });
  const tag = status === "ok" ? "  ok  " : status === "FAIL" ? " FAIL " : "BLOCKED";
  console.log(`${tag} ${step}${detail ? ` — ${detail}` : ""}`);
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
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

if (!RN_API_KEY && !RN_CLIENT_ID) {
  record(
    "3  Request credential present",
    "BLOCKED",
    "sign in at dashboard.request.network with a BURNER wallet, generate a Client ID, " +
      "set REQUEST_CLIENT_ID (or REQUEST_API_KEY) in .env",
  );
} else if (!PAYEE) {
  record("3  payee configured", "BLOCKED", "set PAYEE_ADDRESS in .env (the burner receiving address)");
} else {
  record("3  Request credential present", "ok", RN_API_KEY ? "using x-api-key" : "using x-client-id");

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

const blockedReason = !KH_KEY ? "needs KEEPERHUB_API_KEY" : !requestId ? "needs a created invoice" : "";
if (blockedReason) {
  record("6  land payment through KeeperHub", "BLOCKED", blockedReason);
  record("7  eth_getTransactionReceipt says success", "BLOCKED", blockedReason);
  record("8  Request reports hasBeenPaid", "BLOCKED", blockedReason);
} else {
  record("6  land payment through KeeperHub", "BLOCKED", "live execution intentionally not automated yet — see docs/MASTER.md section 9");
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
    "BLOCKED steps need a credential, not a code change. Nothing downstream is claimed until they pass,\n" +
      "and no harness row may be tagged LIVE_TESTNET until step 7 produces a real hash.\n",
  );
  process.exit(2);
}
console.log("Gate A passed. The composed integration is real.\n");
