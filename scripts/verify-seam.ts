/**
 * Verify the claim this project rests on: that a decode/re-encode step sits between the
 * bytes a human approves and the bytes a signer signs, and that ReqKeeper closes it.
 *
 * Three things get checked, in the order that a sceptic would check them:
 *
 *   A  KeeperHub genuinely cannot send finished calldata. Probed, not assumed — every write
 *      route is asked directly and the refusals are printed verbatim.
 *   B  This codebase's ABI codec agrees with KeeperHub's own encoder (ethers 6.17.0)
 *      byte-for-byte, so re-deriving arguments from approved calldata is safe to do.
 *   C  The calldata gate refuses smuggled variants before anything is dispatched.
 *
 * Steps A and C need the KeeperHub key; B needs nothing at all.
 *
 * Usage: node --experimental-strip-types scripts/verify-seam.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { encodeCall } from "../src/abi.ts";
import { KeeperHubProvider } from "../src/keeperhub.ts";
import { ProviderError } from "../src/provider.ts";

const KEEPERHUB_API = "https://app.keeperhub.com/api";
const SEPOLIA = 11155111;
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";

const PROXY = "0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE";
const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PAY_SIG = "transferFromWithReferenceAndFee(address,address,uint256,bytes,uint256,address)";

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

const KH_KEY = process.env.KEEPERHUB_API_KEY ?? "";
const PAYEE = (process.env.PAYEE_ADDRESS ?? "0x0e2bb1c8d52315cad63f341424c5a7dd81a50f53").toLowerCase();

let failures = 0;
function ok(label: string, detail = ""): void {
  console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
}
function bad(label: string, detail: string): void {
  failures++;
  console.log(` FAIL ${label} — ${detail}`);
}

/** Calldata exactly as Request Network's /pay endpoint returns it for an FAU invoice. */
const APPROVED_CALLDATA = encodeCall(PAY_SIG, [
  FAU, PAYEE, "1000000000000000000", "0x0102030405060708", "0", PAYEE,
]);

console.log("\nSeam check — can the approved bytes reach the signer unchanged?\n");

// ---- A. KeeperHub cannot send finished calldata --------------------------

console.log("A. does any KeeperHub write route accept finished calldata?");
if (!KH_KEY) {
  console.log("  BLOCKED — set KEEPERHUB_API_KEY in .env\n");
} else {
  const headers = {
    authorization: `Bearer ${KH_KEY}`,
    "content-type": "application/json",
    accept: "application/json",
  };
  const probes: Array<[string, string, unknown]> = [
    ["contract-call, data", "execute/contract-call", { simulate: true, chainId: SEPOLIA, contractAddress: PROXY, data: APPROVED_CALLDATA }],
    ["contract-call, callData", "execute/contract-call", { simulate: true, chainId: SEPOLIA, contractAddress: PROXY, callData: APPROVED_CALLDATA }],
    ["raw route", "execute/raw", { simulate: true, chainId: SEPOLIA, to: PROXY, data: APPROVED_CALLDATA }],
    ["transaction route", "execute/transaction", { simulate: true, chainId: SEPOLIA, to: PROXY, data: APPROVED_CALLDATA }],
  ];
  for (const [label, path, body] of probes) {
    try {
      const res = await fetch(`${KEEPERHUB_API}/${path}`, {
        method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      });
      const text = (await res.text()).slice(0, 160);
      if (res.ok) bad(label, `unexpectedly accepted raw calldata: ${text}`);
      else ok(`${label} refused`, `HTTP ${res.status} ${text}`);
    } catch (e) {
      bad(label, String(e));
    }
  }
  console.log("  => finished calldata cannot be dispatched; arguments must be re-derived.\n");
}

// ---- B. our encoder agrees with theirs -----------------------------------

console.log("B. does this codec agree with KeeperHub's encoder (ethers 6.17.0)?");
// Captured from a live simulate's revert payload on 2026-09-09. See test/abi.test.ts.
const ETHERS_REFERENCE =
  "0xc219a14d" +
  "000000000000000000000000370de27fdb7d1ff1e1baa7d11c5820a324cf623c" +
  "0000000000000000000000000e2bb1c8d52315cad63f341424c5a7dd81a50f53" +
  "0000000000000000000000000000000000000000000000000de0b6b3a7640000" +
  "00000000000000000000000000000000000000000000000000000000000000c0" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000e2bb1c8d52315cad63f341424c5a7dd81a50f53" +
  "0000000000000000000000000000000000000000000000000000000000000008" +
  "0102030405060708000000000000000000000000000000000000000000000000";

if (APPROVED_CALLDATA.toLowerCase() === ETHERS_REFERENCE.toLowerCase()) {
  ok("byte-for-byte identical", `${(APPROVED_CALLDATA.length - 2) / 2} bytes`);
} else {
  bad("encoder disagreement", `\n    ours:   ${APPROVED_CALLDATA}\n    ethers: ${ETHERS_REFERENCE}`);
}
console.log("");

// ---- C. the gate refuses smuggled calldata -------------------------------

console.log("C. does the dispatch gate refuse calldata it cannot reproduce?");
const provider = new KeeperHubProvider({ apiKey: KH_KEY || "kh_offline", chainId: SEPOLIA, rpcUrl: RPC });

const tampered: Array<[string, string]> = [
  ["trailing bytes appended", `${APPROVED_CALLDATA}deadbeef`],
  ["unknown selector", `0xdeadbeef${APPROVED_CALLDATA.slice(10)}`],
  [
    "dirty high bytes in the payee address",
    APPROVED_CALLDATA.replace(`000000000000000000000000${PAYEE.slice(2)}`, `0000000000000000000000ff${PAYEE.slice(2)}`),
  ],
];

for (const [label, data] of tampered) {
  if (data === APPROVED_CALLDATA) { bad(label, "fixture did not actually differ"); continue; }
  try {
    // A refusal must happen locally, before any network call is made.
    await provider.execute({ to: PROXY, data, value: "0" }, "verify-seam");
    bad(label, "was DISPATCHED — the gate did not hold");
  } catch (e) {
    if (e instanceof ProviderError && !e.retryable) ok(`${label} refused`, e.code);
    else bad(label, `refused for the wrong reason: ${String(e)}`);
  }
}

// The canonical calldata must survive the gate and reach the chain.
if (KH_KEY) {
  try {
    const sim = await provider.simulate({ to: PROXY, data: APPROVED_CALLDATA, value: "0" });
    if (sim.transactionHash) bad("canonical calldata simulate", `dry run returned a hash: ${sim.transactionHash}`);
    else ok("canonical calldata passes the gate and reaches the chain", `wouldRevert=${sim.wouldRevert} (no balance yet), no hash returned`);
  } catch (e) {
    bad("canonical calldata simulate", String(e));
  }
}

console.log(failures === 0 ? "\nSeam holds.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
