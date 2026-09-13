/**
 * Every action of every invoice this deployment knows, checked against the signature it carries.
 *
 *   npm run verify:signatures
 *
 * `src/request.ts` refuses an action whose signature does not recover to a party the create
 * names, in a role Request allows. That guard is only worth having if the scheme it implements is
 * the scheme Request actually uses -- and the scheme was not documented anywhere this project
 * could cite. It was RECOVERED: candidate digests were tried against a real signature until one
 * produced the payee's own address, and this script is that finding, run over the whole set.
 *
 * A credential-free read. The gateway is public and the signatures are public; nothing here signs
 * anything or holds a key.
 *
 * Writes `docs/evidence/signatures.json` so the number in the documentation has a file behind it.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { keccak256 } from "../src/keccak.ts";
import { recoverAddress } from "../src/secp256k1.ts";

const GATEWAY = process.env.REQUEST_GATEWAY_URL ?? "https://sepolia.gateway.request.network";

type Row = {
  requestId: string;
  index: number;
  name: string;
  method: string;
  signer: string | null;
  role: "payee" | "payer" | null;
  ok: boolean;
  note?: string;
};

function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = deepSort((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const digestOf = (data: unknown): Uint8Array =>
  keccak256(new TextEncoder().encode(JSON.stringify(deepSort(data)).toLowerCase()));

const invoices = JSON.parse(readFileSync("docs/live-invoices.json", "utf8")) as {
  invoices: Array<{ requestId: string }>;
};

console.log(`\nRequest channel actions — signature and role, over ${invoices.invoices.length} invoice(s)\n`);

const rows: Row[] = [];
for (const invoice of invoices.invoices) {
  const url = `${GATEWAY}/getTransactionsByChannelId?channelId=${encodeURIComponent(invoice.requestId)}`;
  let body: { result?: { transactions?: Array<{ transaction?: { data?: string } }> } };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    body = (await res.json()) as typeof body;
  } catch (e) {
    rows.push({
      requestId: invoice.requestId,
      index: -1,
      name: "-",
      method: "-",
      signer: null,
      role: null,
      ok: false,
      note: `gateway unreachable: ${(e as Error).message}`,
    });
    continue;
  }

  const transactions = body.result?.transactions ?? [];
  // The create names the parties, and every action on the channel is checked against them.
  const parsed = transactions.map((t) => JSON.parse(t.transaction?.data ?? "{}") as {
    data?: { name?: string; parameters?: { payee?: { value?: string }; payer?: { value?: string } } };
    signature?: { method?: string; value?: string };
  });
  const create = parsed.find((a) => a.data?.name === "create");
  const payee = create?.data?.parameters?.payee?.value?.toLowerCase() ?? null;
  const payer = create?.data?.parameters?.payer?.value?.toLowerCase() ?? null;

  parsed.forEach((action, index) => {
    const method = action.signature?.method ?? "none";
    const value = action.signature?.value ?? "";
    const signer = method === "ecdsa" && value ? recoverAddress(digestOf(action.data), value)?.toLowerCase() ?? null : null;
    const role = signer !== null && signer === payee ? "payee" : signer !== null && signer === payer ? "payer" : null;
    rows.push({
      requestId: invoice.requestId,
      index,
      name: action.data?.name ?? "unnamed",
      method,
      signer,
      role,
      ok: role !== null,
    });
  });
}

const ok = rows.filter((r) => r.ok).length;
for (const row of rows.filter((r) => !r.ok)) {
  console.log(`  FAIL  ${row.requestId.slice(0, 12)}… action ${row.index} (${row.name}): ${row.note ?? `signer ${row.signer ?? "unrecoverable"} is neither party`}`);
}
const byRole = rows.reduce<Record<string, number>>((acc, r) => {
  const key = r.role ?? "unrecovered";
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});
console.log(`  ${ok} of ${rows.length} action(s) recover to a party the invoice names`);
console.log(`  by role: ${Object.entries(byRole).map(([k, v]) => `${k}=${v}`).join(", ")}\n`);

writeFileSync(
  "docs/evidence/signatures.json",
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      mode: "LIVE_READ",
      note:
        "Every action of every invoice this deployment knows, read from Request's public gateway with no " +
        "credential, with the ECDSA signer recovered and checked against the payee and payer the create names. " +
        "The digest is keccak256 over the action's data, keys deep-sorted and the whole JSON lowercased.",
      gateway: GATEWAY,
      totalsFrom: {
        actions: { count: true },
        recovered: { count: true, where: { field: "ok", equals: true } },
      },
      totals: { actions: rows.length, recovered: ok },
      rows,
    },
    null,
    2,
  )}\n`,
);
console.log("  written to docs/evidence/signatures.json\n");
process.exit(ok === rows.length && rows.length > 0 ? 0 : 1);
