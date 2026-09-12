/**
 * Probe the MCP surface, not just claim it.
 *
 * Runs the same calldata through KeeperHub's own MCP server that `verify-seam.ts` runs
 * through the REST route, and reads the audit trail back.
 *
 * This script used to be `npm run verify:mcp`, and that name was a lie by omission. Check 1
 * calls `provider.simulate(...)`, which is `execute_contract_call` with `simulate: true`
 * against the live platform with a real key and a real payee — and this repository's own
 * hazard note (`src/provider.ts:12-15`) says that route can be ignored and execute for real
 * (#1959). `src/settle.ts` carries a whole branch for a dry run that broadcast. So the
 * dangerous check is opt-in behind `--live-simulate`, and the command is named for what it
 * does. Nothing called `verify:*` in this repository can move money; that is the whole point
 * of handing a judge the verify commands.
 *
 * Usage:
 *   npm run probe:mcp                     read-only: the calldata gate and the audit read
 *   npm run probe:mcp -- --live-simulate  also dry-runs a real payment through the platform
 */

import { existsSync, readFileSync } from "node:fs";
import { encodeCall } from "../src/abi.ts";
import { DEFAULT_RPC } from "../src/chain.ts";
import { KeeperHubMcpProvider } from "../src/keeperhub-mcp.ts";
import { ERC20_FEE_PROXY, FAU, PAY_SIGNATURE, SEPOLIA } from "../src/plan.ts";
import { ProviderError } from "../src/provider.ts";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const API_KEY = process.env.KEEPERHUB_API_KEY ?? "";
const PAYEE = (process.env.PAYEE_BURNER ?? "").toLowerCase();

let failures = 0;
const ok = (label: string, detail = ""): void =>
  console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
const bad = (label: string, detail: string): void => {
  failures++;
  console.log(` FAIL ${label} — ${detail}`);
};

console.log("\nMCP surface check — KeeperHub's own server, not the REST route\n");

if (!API_KEY) {
  console.log("  BLOCKED — set KEEPERHUB_API_KEY in .env\n");
  process.exit(2);
}

const provider = new KeeperHubMcpProvider({
  apiKey: API_KEY,
  chainId: SEPOLIA,
  rpcUrl: DEFAULT_RPC,
});

// ---- 1. the handshake and a dry run through the MCP tool -----------------

const approved = encodeCall(PAY_SIGNATURE, [
  FAU,
  PAYEE || "0x000000000000000000000000000000000000dEaD",
  "1000000000000000000",
  "0x0102030405060708",
  "0",
  `0x${"0".repeat(40)}`,
]);

const LIVE_SIMULATE = process.argv.includes("--live-simulate");

console.log("1. dispatching approved calldata through the MCP tool");
if (!LIVE_SIMULATE) {
  console.log("  SKIPPED - this check calls execute_contract_call against the live platform.");
  console.log("           A dry run on that route is documented as possibly executing for");
  console.log("           real (src/provider.ts:12-15, #1959), so it is not run by default");
  console.log("           and it is not part of any verify:* command. Opt in with:");
  console.log("             npm run probe:mcp -- --live-simulate");
  console.log("           Checks 2 and 3 below move nothing and run either way.");
} else try {
  const sim = await provider.simulate({ to: ERC20_FEE_PROXY, data: approved, value: "0" });
  if (sim.transactionHash) {
    bad("dry run", `returned a transaction hash: ${sim.transactionHash}`);
  } else {
    ok(
      "handshake, session and execute_contract_call all answered",
      `wouldRevert=${sim.wouldRevert}, gasEstimate=${sim.gasEstimate}, no hash`,
    );
  }
} catch (e) {
  bad("MCP simulate", String(e));
}

// ---- 2. the calldata gate holds on this surface too ----------------------

console.log("\n2. the same gate, on a different transport");
const tampered: Array<[string, string]> = [
  ["trailing bytes appended", `${approved}deadbeef`],
  ["unknown selector", `0xdeadbeef${approved.slice(10)}`],
];
for (const [label, data] of tampered) {
  try {
    await provider.simulate({ to: ERC20_FEE_PROXY, data, value: "0" });
    bad(label, "was dispatched; the gate did not hold on the MCP path");
  } catch (e) {
    if (e instanceof ProviderError && !e.retryable) ok(`${label} refused`, e.code);
    else bad(label, `refused for the wrong reason: ${String(e)}`);
  }
}

// ---- 3. the audit trail ---------------------------------------------------

console.log("\n3. reading the audit trail back through MCP");
try {
  // observe() wraps get_direct_execution_status. A known-good execution id proves the
  // audit surface answers; an unknown one proves it refuses rather than inventing a row.
  // If the server answers for an execution id that does not exist, that row was invented and
  // this check has FAILED. Reporting `ok` for either outcome, as this once did, makes the
  // whole script decorative: a verification whose label asserts more than its code tests is
  // the one thing that must not be in here.
  await provider
    .observe("definitely-not-an-execution-id")
    .then(() =>
      bad(
        "unknown execution id is refused, not invented",
        "the MCP server answered for an execution id that does not exist — that row was invented",
      ),
    )
    .catch((e) =>
      ok(
        "unknown execution id is refused, not invented",
        e instanceof ProviderError ? `refused: ${e.code}` : `threw: ${String(e)}`,
      ),
    );
} catch (e) {
  bad("audit read", String(e));
}

console.log(
  failures === 0
    ? `\nMCP surface holds: ${LIVE_SIMULATE ? "handshake, execution tool, " : ""}calldata gate, audit read.${LIVE_SIMULATE ? "" : "\nThe live dry run was skipped; pass --live-simulate to include it."}\n`
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
