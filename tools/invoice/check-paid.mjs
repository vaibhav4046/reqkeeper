// Does Request Network's OWN payment detection consider the invoice paid?
import { existsSync, readFileSync } from "node:fs";
import rnPkg from "@requestnetwork/request-client.js";
const { RequestNetwork } = rnPkg;

const ENV = "D:/project/reqkeeper/.env";
for (const l of existsSync(ENV) ? readFileSync(ENV, "utf8").split(/\r?\n/) : []) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const rn = new RequestNetwork({
  nodeConnectionConfig: { baseURL: "https://sepolia.gateway.request.network/" },
});

const request = await rn.fromRequestId(process.env.REQUEST_ID);
const data = request.getData();

console.log(`requestId      : ${data.requestId}`);
console.log(`state          : ${data.state}`);
console.log(`expectedAmount : ${data.expectedAmount}`);
console.log(`balance        : ${data.balance?.balance ?? "null"}`);
console.log(`events         : ${(data.balance?.events ?? []).length}`);
for (const e of data.balance?.events ?? []) {
  console.log(`   ${e.name} amount=${e.amount} tx=${e.parameters?.txHash ?? "?"}`);
}
const paid = BigInt(data.balance?.balance ?? "0") >= BigInt(data.expectedAmount);
console.log(`\nhasBeenPaid    : ${paid}`);
