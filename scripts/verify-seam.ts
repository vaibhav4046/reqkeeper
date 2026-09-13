/**
 * Verify the claim this project rests on: that a decode/re-encode step sits between the
 * bytes a human approves and the bytes a signer signs, and that ReqKeeper closes it.
 *
 * Three things get checked, in the order that a sceptic would check them:
 *
 *   A  KeeperHub genuinely cannot send finished calldata. Probed on 2026-09-09 and RECORDED
 *      here, not re-probed: the probe is four live write routes being handed the finished
 *      calldata for a real payment, and that is a thing this script must not be able to do.
 *   B  This codebase's ABI codec agrees with KeeperHub's own encoder (ethers 6.17.0)
 *      byte-for-byte, so re-deriving arguments from approved calldata is safe to do.
 *   C  The calldata gate refuses smuggled variants before anything is dispatched.
 *
 * None of the three needs a credential and none of them can send. That is the point: README:126
 * promises that nothing named `verify:*` can spend, and a promise about capability is only true
 * if the capability is absent — an opt-in flag still leaves it there. There is no `fetch` in this
 * file, and the one provider it builds is pointed at an unroutable host.
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
//
// RECORDED, not re-probed, and that is a deliberate downgrade.
//
// The four bodies below ARE the probe: each hands a live KeeperHub write route the finished
// calldata for a real FAU payment. Sending them is how the refusal was established on
// 2026-09-09 — and it is also how this script could spend. `src/provider.ts:12-15` records
// that `simulate: true` is ignored on the transfer and protocol-action routes (#1959/#1929)
// and the transaction really executes, so the `simulate: true` in those bodies is decoration
// and not a boundary. Re-running the probe is a coin flip between "refused, as recorded" and
// a payment nobody approved, dispatched under a hardcoded body by a command a judge is
// invited to run.
//
// README:126 says nothing named `verify:*` can spend. Section C holds that line by pointing
// its provider at an unroutable host; this section holds it by not sending at all. What the
// probe established is recorded, dated and quoted verbatim at src/keeperhub.ts:7 and
// docs/ARCHITECTURE.md:315 — a recorded finding, never restyled as a live one.
//
// To reach the live platform on purpose the command is `npm run probe:mcp -- --live-simulate`:
// named for what it does, opt-in, and outside the `verify:*` family this claim is about.

console.log("A. does any KeeperHub write route accept finished calldata?");
const probes: Array<[string, string, unknown]> = [
  ["contract-call, data", "execute/contract-call", { simulate: true, chainId: SEPOLIA, contractAddress: PROXY, data: APPROVED_CALLDATA }],
  ["contract-call, callData", "execute/contract-call", { simulate: true, chainId: SEPOLIA, contractAddress: PROXY, callData: APPROVED_CALLDATA }],
  ["raw route", "execute/raw", { simulate: true, chainId: SEPOLIA, to: PROXY, data: APPROVED_CALLDATA }],
  ["transaction route", "execute/transaction", { simulate: true, chainId: SEPOLIA, to: PROXY, data: APPROVED_CALLDATA }],
];
for (const [label, path, body] of probes) {
  console.log(`  NOT SENT  ${label} — POST ${KEEPERHUB_API}/${path}`);
  console.log(`            ${JSON.stringify(body).slice(0, 108)}…`);
}
console.log("  RECORDED  probed 2026-09-09: every write route rejected `data`/`callData`, and");
console.log("            /execute/{raw,transaction,send,write,tx} all answered");
console.log(`            {"error":"Invalid action type"}. Quoted at src/keeperhub.ts:7.`);
console.log("  => on that evidence finished calldata cannot be dispatched, so arguments must be");
console.log("     re-derived — which is what section B and section C are about.\n");

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
/**
 * Pointed at nowhere, on purpose.
 *
 * Section C proves the gate refuses smuggled calldata by handing it to `provider.execute`.
 * That is the right integration claim — the gate lives inside the provider, not beside it —
 * but against the real base URL it is testing a parachute by jumping: if the gate ever failed
 * to throw, the very next thing that happens is a real payment, broadcast under a hardcoded
 * idempotency key. Port 1 on loopback refuses connections, so a gate failure surfaces as a
 * loud FAIL with nothing sent. The gate runs identically either way: it throws before any
 * transport is touched.
 */
const UNROUTABLE = "http://127.0.0.1:1/api";
const provider = new KeeperHubProvider({
  apiKey: "kh_offline",
  chainId: SEPOLIA,
  rpcUrl: RPC,
  baseUrl: UNROUTABLE,
});

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

// The canonical calldata's live dry run does NOT live in this script any more.
//
// It called `provider.simulate`, which is `POST execute/contract-call` with `simulate: true` —
// the one route src/provider.ts:12-15 records as ignoring that flag and executing for real
// (#1959). Behind an opt-in flag or not, that made a `verify:*` script ABLE to spend, and
// README:126 claims none of them can. Capability is the claim, so the capability is what had
// to go; the same dry run is still one command away, under the name the README gives it:
//
//   npm run probe:mcp -- --live-simulate

console.log("\n  No live dry run here. It is `npm run probe:mcp -- --live-simulate`, because that");
console.log("  route can execute for real (src/provider.ts:12-15, #1959) and nothing named");
console.log("  `verify:*` is allowed to be able to spend.");

console.log(failures === 0 ? "\nSeam holds.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
