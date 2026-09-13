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
import { fetchInvoice, recoverActionSigner } from "../src/request.ts";

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
/**
 * The anchor, bound or not.
 *
 * An anchor is the floor of every payment scan for an invoice, and the only thing that lets a
 * negative be conclusive at all -- so a gateway that can choose it can make an invoice that was
 * paid 450,000 blocks ago come back unpaid, and it is paid again. `fetchInvoice` refuses an anchor
 * unless the transaction it names emitted, from Request's storage contract, a log carrying the CID
 * of the bytes the gateway served beside it. This is that check over every invoice this deployment
 * knows, against the public gateway and a public RPC, with no credential.
 */
const anchors: Array<{ requestId: string; bound: boolean; block: number | null; note?: string }> = [];
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
    // The reader's own recovery, imported rather than reimplemented: this evidence is only worth
    // anything if it measures the function that guards the money. A second copy here is how the
    // evidence and the guard drift apart -- and it would have, the moment `ecdsa-ethereum` was
    // added to one of them.
    const signer =
      (method === "ecdsa" || method === "ecdsa-ethereum") && value
        ? recoverActionSigner(method, digestOf(action.data), value, {
            ...(payee === null ? {} : { payee }),
            ...(payer === null ? {} : { payer }),
          })
        : null;
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

for (const invoice of invoices.invoices) {
  try {
    const read = await fetchInvoice(invoice.requestId, { gatewayUrl: GATEWAY });
    anchors.push({
      requestId: invoice.requestId,
      bound: read.anchor !== undefined,
      block: read.anchor?.blockNumber ?? null,
      ...(read.anchor ? {} : { note: "no anchor could be bound; scans for it stay inconclusive" }),
    });
  } catch (e) {
    anchors.push({ requestId: invoice.requestId, bound: false, block: null, note: (e as Error).message.slice(0, 160) });
  }
}
const anchorsBound = anchors.filter((a) => a.bound).length;
for (const a of anchors.filter((x) => !x.bound)) {
  console.log(`  ANCHOR  ${a.requestId.slice(0, 12)}…: ${a.note ?? "unbound"}`);
}
console.log(`  ${anchorsBound} of ${anchors.length} anchor(s) bound to the transaction that stored the invoice`);

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
        anchorsBound: { count: true, from: "anchors", where: { field: "bound", equals: true } },
      },
      totals: { actions: rows.length, recovered: ok, anchors: anchors.length, anchorsBound },
      rows,
      anchors,
    },
    null,
    2,
  )}\n`,
);
console.log("  written to docs/evidence/signatures.json\n");
process.exit(ok === rows.length && anchorsBound === anchors.length && rows.length > 0 ? 0 : 1);
