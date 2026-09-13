/**
 * The human approval door, run as a human runs it.
 *
 * `scripts/approve.ts` is the only thing in this repository that can authorise money, and it
 * recomputes the plan hash instead of accepting one: an approval flow that believes the
 * proposer's summary is not an approval flow. That recomputation was built from the typed flags
 * ALONE — and three source facts come from Request rather than from a flag: the anchor block, an
 * amount changed by later signed channel actions, and a payment address that is not the party of
 * record. All three are in `SourceFacts`, therefore in the facts hash, therefore in the plan hash.
 *
 * So for any invoice Request had confirmed — which is every invoice worth paying — the door
 * computed a hash that could not equal the one the proposal reserved, printed "no such plan
 * locally" for a plan sitting in the table two rows away, and the human approval step could not
 * be completed at all. Measured here end to end: propose through the MCP surface, then spawn the
 * real CLI exactly as `watch-request.ts` prints it and as `docs/RUNBOOK.md` documents it.
 *
 * The door reads Request itself now. That is not trusting the agent: Request's gateway is the
 * source the agent had to agree with in the first place, every typed flag is still checked
 * against it, and a gateway that will not answer refuses the approval rather than falling back
 * to a hash that authorises nothing.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";

import { EXPECTED_CHAIN_ID } from "../src/chain.ts";
import { keccak256Hex } from "../src/keccak.ts";
import { handleRequest, type McpContext } from "../src/mcp.ts";
import { NAMESPACE } from "../src/plan.ts";
import { obligationId } from "../src/identity.ts";
import { FixtureProvider } from "../src/provider.ts";
import { derivePaymentReference, fetchInvoice } from "../src/request.ts";
import { PAYER_KEY, addressOf, signAction } from "./signing.ts";
import { Store } from "../src/store.ts";

const SALT = "8682e8e726d1b4f1";
const PAYMENT_ADDRESS = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
/** The party the invoice names as payee, which Request allows to differ from the paid address. */
const PARTY_OF_RECORD = "0x5555000000000000000000000000000000005555";
const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const ONE_FAU = "1000000000000000000";
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const STORAGE_CID = "QmFixtureCidForTheApprovalDoor";
const REQUEST_STORAGE = "0xd6c085a4d14e9e171f4af58f7f48bd81173f167e";
const ANCHOR_TX = `0x${"11".repeat(32)}`;
const HEAD = 11_692_278;
const ANCHORED_AT = HEAD - 2_000;

/** `01` + keccak256 over the normalised signed create: keys deep-sorted, whole string lowercased. */
function channelIdFor(signedCreate: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return `01${keccak256Hex(JSON.stringify(sort(signedCreate)).toLowerCase()).replace(/^0x/, "")}`;
}

/**
 * One invoice, with the payee of record either the paid address or somebody else.
 *
 * Signed by the payer of record: `assertActionsAreSigned` authenticates the create like every
 * other action, because Request itself refuses a create signed by neither party.
 */
function createAction(payeeOfRecord: string) {
  const data = {
      name: "create",
      version: "2.0.3",
      parameters: {
        currency: { type: "ERC20", value: FAU, network: "sepolia" },
        expectedAmount: ONE_FAU,
        payee: { type: "ethereumAddress", value: payeeOfRecord },
        payer: { type: "ethereumAddress", value: addressOf(PAYER_KEY) },
        timestamp: 1788932300,
        extensionsData: [
          {
            action: "create",
            id: "pn-erc20-fee-proxy-contract",
            version: "0.2.0",
            parameters: {
              feeAddress: ZERO_ADDRESS,
              feeAmount: "0",
              paymentAddress: PAYMENT_ADDRESS,
              paymentNetworkName: "sepolia",
              salt: SALT,
            },
          },
        ],
      },
  };
  return signAction(data, PAYER_KEY);
}

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

async function startGateway(action: unknown): Promise<string> {
  const body = {
    meta: {
      storageMeta: [{ ethereum: { blockNumber: ANCHORED_AT, transactionHash: ANCHOR_TX } }],
      transactionsStorageLocation: [STORAGE_CID],
    },
    result: { transactions: [{ state: "confirmed", transaction: { data: JSON.stringify(action) } }] },
  };
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  assert.ok(address && typeof address === "object", "the stub gateway did not bind a port");
  return `http://127.0.0.1:${address.port}`;
}

/** A Sepolia that can only answer the one question the anchor binding asks. */
async function startChain(): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      const { method, params } = JSON.parse(body) as { method: string; params: unknown[] };
      let result: unknown = [];
      if (method === "eth_chainId") result = `0x${EXPECTED_CHAIN_ID.toString(16)}`;
      else if (method === "eth_blockNumber") result = `0x${HEAD.toString(16)}`;
      else if (method === "eth_getTransactionReceipt") {
        const hash = String((params as string[])[0] ?? "").toLowerCase();
        result =
          hash === ANCHOR_TX.toLowerCase()
            ? {
                status: "0x1",
                blockNumber: `0x${ANCHORED_AT.toString(16)}`,
                logs: [{ address: REQUEST_STORAGE, data: `0x${Buffer.from(STORAGE_CID, "utf8").toString("hex")}`, topics: [] }],
              }
            : null;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  servers.push(server);
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  assert.ok(address && typeof address === "object", "the stub chain did not bind a port");
  return `http://127.0.0.1:${address.port}`;
}

function runApprove(db: string, env: Record<string, string>, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", resolve("scripts/approve.ts"), `--db=${db}`, ...args],
      { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (d) => (output += String(d)));
    child.stderr.on("data", (d) => (output += String(d)));
    child.on("error", reject);
    child.on("close", (code) => done({ code, output }));
  });
}

/** Propose exactly as an agent does, against the same stub gateway the door will read. */
async function propose(db: string, requestId: string, reference: string, gatewayUrl: string, rpcUrl: string) {
  const store = new Store(db);
  try {
    const ctx = {
      store,
      provider: new FixtureProvider(),
      rpcUrl,
      // Conclusive, and unpaid: this test is about the door, not about the chain reader.
      findPayment: async () => ({ found: false, truncated: false, conflictingLogs: [], negativeCorroborations: 2 }),
      fetchInvoice: (id: string) => fetchInvoice(id, { gatewayUrl, rpcUrl }),
    } as unknown as McpContext;
    const reply = (await handleRequest(ctx, {
      id: 1,
      method: "tools/call",
      params: {
        name: "propose_payment",
        arguments: {
          requestId,
          paymentReference: reference,
          payee: PAYMENT_ADDRESS,
          amountBaseUnits: ONE_FAU,
          maxTotalDebitBaseUnits: ONE_FAU,
          feeAmount: "0",
          feeAddress: ZERO_ADDRESS,
          tokenAddress: FAU,
        },
      },
    })) as { result?: { content?: Array<{ text?: string }> } };
    const body = JSON.parse(reply?.result?.content?.[0]?.text ?? "{}") as { state?: string; planHash?: string };
    assert.equal(body.state, "AWAITING_APPROVAL", JSON.stringify(body).slice(0, 300));
    return body.planHash as string;
  } finally {
    store.close();
  }
}

function flagsFor(requestId: string, reference: string): string[] {
  return [
    `--requestId=${requestId}`,
    `--reference=${reference}`,
    `--payee=${PAYMENT_ADDRESS}`,
    `--amount=${ONE_FAU}`,
    `--max=${ONE_FAU}`,
    `--fee=0`,
    `--feeAddress=${ZERO_ADDRESS}`,
    "--approver=owner@reqkeeper.local",
    "--yes",
  ];
}

describe("the approval a human is told to give is one they can actually give", () => {
  test("an anchored invoice proposed by the agent is approvable at the door", async () => {
    const action = createAction(PAYMENT_ADDRESS);
    const requestId = channelIdFor(action);
    const reference = derivePaymentReference(requestId, SALT, PAYMENT_ADDRESS);
    const gatewayUrl = await startGateway(action);
    const rpcUrl = await startChain();
    const db = join(mkdtempSync(join(tmpdir(), "reqkeeper-approve-door-")), "live.sqlite");

    const reservedByPlan = await propose(db, requestId, reference, gatewayUrl, rpcUrl);

    const ran = await runApprove(
      db,
      { REQUEST_GATEWAY_URL: gatewayUrl, SEPOLIA_RPC: rpcUrl, REQKEEPER_RPC_ENDPOINTS: rpcUrl },
      flagsFor(requestId, reference),
    );

    assert.equal(ran.code, 0, `the door refused an approval of a plan it had just been handed:\n${ran.output}`);
    assert.match(ran.output, /recorded APPROVED/, ran.output);

    // And the decision is against the plan that reserved the obligation, not some other hash.
    const store = new Store(db);
    const approval = store.getApproval(reservedByPlan);
    store.close();
    assert.equal(approval?.decision, "APPROVED", "nothing was recorded against the reserved plan");
  });

  test("a payment address that is not the party of record is on the screen, not in a docblock", async () => {
    const action = createAction(PARTY_OF_RECORD);
    const requestId = channelIdFor(action);
    const reference = derivePaymentReference(requestId, SALT, PAYMENT_ADDRESS);
    const gatewayUrl = await startGateway(action);
    const rpcUrl = await startChain();
    const db = join(mkdtempSync(join(tmpdir(), "reqkeeper-approve-door-payee-")), "live.sqlite");

    await propose(db, requestId, reference, gatewayUrl, rpcUrl);

    const ran = await runApprove(
      db,
      { REQUEST_GATEWAY_URL: gatewayUrl, SEPOLIA_RPC: rpcUrl, REQKEEPER_RPC_ENDPOINTS: rpcUrl },
      flagsFor(requestId, reference),
    );

    assert.equal(ran.code, 0, ran.output);
    assert.match(ran.output, /NOT THE PARTY OF RECORD/i, ran.output);
    assert.ok(ran.output.includes(PARTY_OF_RECORD), "the address of record is not shown");
    assert.match(ran.output, /NOT the party of record/, "the approval sentence itself must carry it too");
  });

  test("a gateway that will not answer refuses the approval rather than guessing", async () => {
    // The door cannot type an anchor, so it cannot produce a matching hash without Request. The
    // old failure mode was worse than a refusal: it recorded nothing and said "no such plan".
    const action = createAction(PAYMENT_ADDRESS);
    const requestId = channelIdFor(action);
    const reference = derivePaymentReference(requestId, SALT, PAYMENT_ADDRESS);
    const gatewayUrl = await startGateway(action);
    const rpcUrl = await startChain();
    const db = join(mkdtempSync(join(tmpdir(), "reqkeeper-approve-door-offline-")), "live.sqlite");

    await propose(db, requestId, reference, gatewayUrl, rpcUrl);

    const ran = await runApprove(
      db,
      { REQUEST_GATEWAY_URL: "http://127.0.0.1:1", SEPOLIA_RPC: rpcUrl, REQKEEPER_RPC_ENDPOINTS: rpcUrl },
      flagsFor(requestId, reference),
    );

    assert.equal(ran.code, 1, ran.output);
    assert.match(ran.output, /could not be read from Request/i, ran.output);
    const store = new Store(db);
    const rows = store.auditTrail(obligationId(NAMESPACE, requestId));
    store.close();
    assert.ok(
      !rows.some((r) => r.action === "HUMAN_APPROVED"),
      "an approval was recorded on a read that never happened",
    );
  });
});
