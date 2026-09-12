// Create a real Request Network invoice on Sepolia with NO Client ID and NO dashboard,
// by talking to the public gateway node through the official protocol client.
//
// The signing identity is a burner keypair generated here and now: 32 random bytes, not an
// account anywhere. It becomes the payee, so no existing wallet's private key is needed.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import rnPkg from "@requestnetwork/request-client.js";
import epkPkg from "@requestnetwork/epk-signature";
import detectionPkg from "@requestnetwork/payment-detection";
import ethersPkg from "ethers";
import { fileURLToPath } from "node:url";

const { RequestNetwork, Types, Utils } = rnPkg;
const { EthereumPrivateKeySignatureProvider } = epkPkg;
const { Wallet, utils } = ethersPkg;

const ENV = fileURLToPath(new URL("../../.env", import.meta.url));
for (const l of existsSync(ENV) ? readFileSync(ENV, "utf8").split(/\r?\n/) : []) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const KEEPERHUB_PAYER = "0x027D54A692e0e80173141777BdB847c1726FA1F3";
const AMOUNT = "1000000000000000000"; // 1 FAU

let pk = process.env.INVOICE_SIGNER_KEY;
if (!pk) {
  pk = `0x${randomBytes(32).toString("hex")}`;
  appendFileSync(ENV, `\nINVOICE_SIGNER_KEY=${pk}\n`);
  console.log("generated a burner signer, appended to .env (gitignored)");
}
const burner = new Wallet(pk);
console.log(`burner payee     : ${burner.address}`);

const rn = new RequestNetwork({
  nodeConnectionConfig: { baseURL: "https://sepolia.gateway.request.network/" },
  signatureProvider: new EthereumPrivateKeySignatureProvider({
    method: Types.Signature.METHOD.ECDSA,
    privateKey: pk,
  }),
});

const signer = { type: Types.Identity.TYPE.ETHEREUM_ADDRESS, value: burner.address };

console.log("creating request against the public Sepolia gateway...");
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
      feeAddress: "0x0000000000000000000000000000000000000000",
      feeAmount: "0",
    },
  },
  signer,
});

console.log(`requestId        : ${request.requestId}`);
console.log("waiting for gateway confirmation...");
await request.waitForConfirmation();

const data = request.getData();
console.log(`state            : ${data.state}`);
console.log(`expectedAmount   : ${data.expectedAmount}`);
console.log(`balance          : ${data.balance?.balance ?? "null"}`);

const pnKey = Object.keys(data.extensions).find((k) => k.includes("fee-proxy-contract"));
const ext = data.extensions[pnKey];
const { salt, paymentAddress, feeAddress, feeAmount } = ext.values;
console.log(`\npn extension     : ${pnKey}`);
console.log(`salt             : ${salt}`);
console.log(`paymentAddress   : ${paymentAddress}`);
console.log(`feeAddress       : ${feeAddress ?? "(none)"}`);
console.log(`feeAmount        : ${feeAmount ?? "0"}`);

// Use Request's OWN calculator, not a reimplementation.
const reference = detectionPkg.PaymentReferenceCalculator.calculate(
  request.requestId, salt, paymentAddress,
);
console.log(`paymentReference : 0x${reference}`);

// Cross-check: keccak256 over the UTF-8 TEXT of the concatenated hex strings, not their bytes.
const mine = utils
  .keccak256(utils.toUtf8Bytes((request.requestId + salt + paymentAddress).toLowerCase()))
  .slice(-16);
console.log(`independent calc : 0x${mine}   ${mine === reference ? "MATCH" : "MISMATCH"}`);

appendFileSync(
  ENV,
  `REQUEST_ID=${request.requestId}\nPAYMENT_REFERENCE=0x${reference}\nPAYMENT_SALT=${salt}\nPAYEE_BURNER=${burner.address}\nFEE_ADDRESS=${feeAddress ?? "0x0000000000000000000000000000000000000000"}\nFEE_AMOUNT=${feeAmount ?? "0"}\n`,
);
console.log("\nwrote invoice facts to .env");
