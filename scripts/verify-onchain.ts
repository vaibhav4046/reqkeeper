/**
 * Independent on-chain verification of the addresses and selectors this build depends on.
 *
 * Reads a public Sepolia RPC. No credentials, no accounts, no signing. Run it before Gate A
 * and any time a docs page disagrees with reality — a widely repeated wrong answer gives
 * Request's ERC20FeeProxy as 0x370DE27f..., which is actually the FAU token.
 *
 * Usage: node --experimental-strip-types scripts/verify-onchain.ts
 */

import { selector } from "../src/keccak.ts";

const RPCS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://rpc.sepolia.org",
];

const CHAIN_ID = 11155111;

const CONTRACTS = [
  { name: "ERC20FeeProxy", address: "0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE" },
  { name: "FAU (FaucetToken, 18dp)", address: "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C" },
  { name: "FakeUSDC (6dp)", address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
];

const SIGNATURES = [
  "transferFromWithReferenceAndFee(address,address,uint256,bytes,uint256,address)",
  "approve(address,uint256)",
  "allowance(address,address)",
  "mint(address,uint256)",
  "decimals()",
];

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  let lastError: unknown;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json()) as { result?: unknown; error?: { message: string } };
      if (body.error) throw new Error(body.error.message);
      return body.result;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`all RPCs failed: ${lastError}`);
}

/** PUSH4 immediates in a dispatcher are its function selectors. */
function selectorsIn(bytecode: string): Set<string> {
  const found = new Set<string>();
  for (let i = 2; i + 10 <= bytecode.length; i += 2) {
    if (bytecode.slice(i, i + 2) === "63") found.add(`0x${bytecode.slice(i + 2, i + 10)}`);
  }
  return found;
}

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
}

const observedChain = Number(await rpc("eth_chainId", []));
console.log(`\nchain id: ${observedChain}`);
check(observedChain === CHAIN_ID, "RPC is on Ethereum Sepolia", `expected ${CHAIN_ID}`);

console.log("\ncomputed selectors:");
const selectors = new Map<string, string>();
for (const sig of SIGNATURES) {
  const sel = selector(sig);
  selectors.set(sig, sel);
  console.log(`  ${sel}  ${sig}`);
}

console.log("\ndeployed code:");
const codeByName = new Map<string, string>();
for (const { name, address } of CONTRACTS) {
  const code = (await rpc("eth_getCode", [address, "latest"])) as string;
  codeByName.set(name, code);
  const bytes = (code.length - 2) / 2;
  check(bytes > 0, `${name} is a contract`, `${address}, ${bytes} bytes`);
}

console.log("\nselector presence in deployed dispatchers:");
const paySel = selectors.get(SIGNATURES[0]) as string;
const proxyCode = codeByName.get("ERC20FeeProxy") as string;
check(
  selectorsIn(proxyCode).has(paySel),
  `ERC20FeeProxy answers ${paySel}`,
  `transferFromWithReferenceAndFee; dispatcher exposes ${[...selectorsIn(proxyCode)].join(" ")}`,
);

const fauCode = codeByName.get("FAU (FaucetToken, 18dp)") as string;
const fauSelectors = selectorsIn(fauCode);
for (const sig of ["approve(address,uint256)", "mint(address,uint256)"]) {
  const sel = selectors.get(sig) as string;
  check(fauSelectors.has(sel), `FAU answers ${sel}`, sig);
}

// Decimals are load-bearing: the same "100" is a 10^12 difference between FAU and FakeUSDC.
console.log("\ntoken decimals, read from the chain:");
const decSel = selectors.get("decimals()") as string;
for (const { name, address } of CONTRACTS.slice(1)) {
  const raw = (await rpc("eth_call", [{ to: address, data: decSel }, "latest"])) as string;
  const decimals = Number(BigInt(raw));
  const expected = name.includes("18dp") ? 18 : 6;
  check(decimals === expected, `${name} reports ${decimals} decimals`, `expected ${expected}`);
}

console.log(
  failures === 0
    ? "\nAll on-chain checks passed.\n"
    : `\n${failures} check(s) FAILED — do not proceed to Gate A.\n`,
);
process.exit(failures === 0 ? 0 : 1);
