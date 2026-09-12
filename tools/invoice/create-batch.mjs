/**
 * Create a batch of real Request Network invoices on Sepolia and record their facts.
 *
 * Phase A of the live harness. Kept here rather than in scripts/ because this is the one
 * step that needs the official Request SDK; everything downstream stays zero-dependency.
 *
 * Resumable on purpose: a gateway timeout halfway through a batch of forty should cost the
 * remaining invoices, not the ones already created. Re-running tops the file up to the target.
 *
 *   node create-batch.mjs [count]      # default 40
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import rnPkg from "@requestnetwork/request-client.js";
import epkPkg from "@requestnetwork/epk-signature";
import detectionPkg from "@requestnetwork/payment-detection";
import ethersPkg from "ethers";

const { RequestNetwork, Types, Utils } = rnPkg;
const { EthereumPrivateKeySignatureProvider } = epkPkg;
const { Wallet } = ethersPkg;

// Resolved from this file, not from the shell's cwd and not from one machine's drive letter.
const ROOT = new URL("../../", import.meta.url);
const ENV = fileURLToPath(new URL(".env", ROOT));
const DOCS = fileURLToPath(new URL("docs/", ROOT));
const OUT = fileURLToPath(new URL("docs/live-invoices.json", ROOT));
const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const KEEPERHUB_PAYER = "0x027D54A692e0e80173141777BdB847c1726FA1F3";
const AMOUNT = "1000000000000000000"; // 1 FAU each
const ZERO = `0x${"0".repeat(40)}`;
const CONCURRENCY = 4;

for (const line of existsSync(ENV) ? readFileSync(ENV, "utf8").split(/\r?\n/) : []) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const target = Number(process.argv[2] ?? 40);
if (!Number.isInteger(target) || target < 1 || target > 90) {
  console.error("count must be an integer between 1 and 90 (the payer holds 98 FAU)");
  process.exit(2);
}

let pk = process.env.INVOICE_SIGNER_KEY;
if (!pk) {
  pk = `0x${randomBytes(32).toString("hex")}`;
  appendFileSync(ENV, `\nINVOICE_SIGNER_KEY=${pk}\n`);
}
const burner = new Wallet(pk);
const signer = { type: Types.Identity.TYPE.ETHEREUM_ADDRESS, value: burner.address };

const rn = new RequestNetwork({
  nodeConnectionConfig: { baseURL: "https://sepolia.gateway.request.network/" },
  signatureProvider: new EthereumPrivateKeySignatureProvider({
    method: Types.Signature.METHOD.ECDSA,
    privateKey: pk,
  }),
});

/** Existing rows are kept as-is; only the shortfall is created. */
const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { invoices: [] };
const invoices = existing.invoices ?? [];
const need = target - invoices.length;

console.log(`payee (burner) : ${burner.address}`);
console.log(`already have   : ${invoices.length}`);
console.log(`creating       : ${Math.max(0, need)}\n`);

async function createOne(index) {
  const request = await rn.createRequest({
    requestInfo: {
      currency: { type: Types.RequestLogic.CURRENCY.ERC20, value: FAU, network: "sepolia" },
      expectedAmount: AMOUNT,
      payee: signer,
      payer: { type: Types.Identity.TYPE.ETHEREUM_ADDRESS, value: KEEPERHUB_PAYER },
      timestamp: Utils.getCurrentTimestampInSecond(),
    },
    paymentNetwork: {
      id: Types.Extension.PAYMENT_NETWORK_ID.ERC20_FEE_PROXY_CONTRACT,
      parameters: {
        paymentNetworkName: "sepolia",
        paymentAddress: burner.address,
        feeAddress: ZERO,
        feeAmount: "0",
      },
    },
    signer,
  });
  await request.waitForConfirmation();

  const data = request.getData();
  const key = Object.keys(data.extensions).find((k) => k.includes("fee-proxy-contract"));
  const { salt, paymentAddress } = data.extensions[key].values;
  const reference = detectionPkg.PaymentReferenceCalculator.calculate(
    request.requestId,
    salt,
    paymentAddress,
  );

  return {
    index,
    requestId: request.requestId,
    paymentReference: `0x${reference}`,
    salt,
    payee: paymentAddress,
    amountBaseUnits: AMOUNT,
    feeAmount: "0",
    feeAddress: ZERO,
    state: data.state,
  };
}

function persist() {
  if (!existsSync(DOCS)) mkdirSync(DOCS);
  writeFileSync(
    OUT,
    `${JSON.stringify({ createdAt: new Date().toISOString(), payee: burner.address, invoices }, null, 2)}\n`,
    "utf8",
  );
}

let created = 0;
let failed = 0;
const queue = Array.from({ length: Math.max(0, need) }, (_, i) => invoices.length + i);

// Modest concurrency: enough to make forty invoices practical, low enough not to hammer a
// public gateway. Each worker persists as it goes so a crash keeps what already succeeded.
async function worker() {
  for (;;) {
    const index = queue.shift();
    if (index === undefined) return;
    try {
      const row = await createOne(index);
      invoices.push(row);
      created++;
      persist();
      console.log(`  ${String(created).padStart(3)}  ${row.requestId.slice(0, 18)}…  ref ${row.paymentReference}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL index ${index}: ${String(e).slice(0, 120)}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
persist();

console.log(`\n${invoices.length} invoices on file (${created} new, ${failed} failed)`);
console.log(`written to ${OUT}`);
