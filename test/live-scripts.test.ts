/**
 * The two scripts that can move real money have to read the invoice.
 *
 * `src/request.ts` exists to make the payment reference a CONSEQUENCE of the obligation
 * rather than an input to it — and for a while neither money path used it. `settle-live.ts`
 * took the reference, payee, fee and fee recipient out of `.env` and hardcoded the amount;
 * `live-harness.ts`, which produced every recorded settlement, took the same facts out of a
 * local JSON file. Nothing downstream re-derives a reference, so a hand that could edit
 * either file chose which debt got paid, and every guard in the system would have protected
 * that choice faithfully.
 *
 * These tests spawn the real scripts against a stub gateway on localhost and assert the
 * refusal. They are deliberately end-to-end rather than a unit test of the read path: the
 * defect was never that the checking function was wrong, it was that the scripts did not
 * call it, and only running them can tell you whether they do.
 *
 * No credential is needed and none is used: every case refuses while reading the invoice,
 * which happens before the store is opened and before a provider exists.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { keccak256Hex } from "../src/keccak.ts";
import { derivePaymentReference } from "../src/request.ts";

import { EXPECTED_CHAIN_ID } from "../src/chain.ts";
import { ERC20_FEE_PROXY } from "../src/plan.ts";

/** The invoice the stub gateway serves. Same real Sepolia invoice as test/request.test.ts. */
const SALT = "8682e8e726d1b4f1";
const PAYMENT_ADDRESS = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
/** What `derivePaymentReference` produces from the three values above, and nothing else. */
const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const ONE_FAU = "1000000000000000000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** A real reference — for a different invoice. The kind of value a hand-edited file carries. */
const SOMEBODY_ELSES_REFERENCE = "0xfaac1220a314c4a9";

/**
 * The id is a hash of this signed create, and `fetchInvoice` re-derives it and refuses a mismatch
 * — so the fixture cannot claim a borrowed id any more than a hostile gateway can. Lifted to
 * module scope for exactly that: the constants below are derived from it rather than typed.
 */
const CREATE_ACTION = (() => {
  const action = {
    data: {
      name: "create",
      version: "2.0.3",
      parameters: {
        currency: { type: "ERC20", value: FAU, network: "sepolia" },
        expectedAmount: ONE_FAU,
        payee: { type: "ethereumAddress", value: PAYMENT_ADDRESS },
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
    },
  };
  return action;
})();

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

/** Derived, never typed: the id IS the hash of the create above. */
const REQUEST_ID = channelIdFor(CREATE_ACTION);
const DERIVED_REFERENCE = derivePaymentReference(REQUEST_ID, SALT, PAYMENT_ADDRESS);

function gatewayBody(anchor?: { blockNumber: number; transactionHash: string }): unknown {
  const action = CREATE_ACTION;
  return {
    // `meta.storageMeta` is where the Sepolia block of the create action lives. Empty is the
    // real shape while the create is still unconfirmed, which is why the anchor is optional
    // everywhere downstream.
    meta: { storageMeta: anchor === undefined ? [] : [{ ethereum: anchor }] },
    result: {
      transactions: [{ state: "confirmed", transaction: { data: JSON.stringify(action) } }],
    },
  };
}

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

/**
 * A gateway on localhost that answers every channel with the one invoice above, and records
 * what it was asked for. The record is the proof the script actually went and looked.
 */
async function startGateway(
  anchor?: { blockNumber: number; transactionHash: string },
): Promise<{ url: string; channels: string[] }> {
  const channels: string[] = [];
  const server = createServer((req, res) => {
    channels.push(String(req.url));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(gatewayBody(anchor)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object", "the stub gateway did not bind a port");
  return { url: `http://127.0.0.1:${address.port}`, channels };
}

interface Ran {
  readonly code: number | null;
  readonly output: string;
}

function run(
  script: string,
  env: Record<string, string>,
  args: string[] = [],
  cwd?: string,
): Promise<Ran> {
  return new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", resolve(script), ...args],
      {
        // A real KeeperHub key in the environment or in .env must not be what makes this
        // test safe, so the key is overridden with a value that could not authenticate.
        env: { ...process.env, ...env },
        // Scripts that open `.data/live.sqlite` are run somewhere else: the live store holds
        // real settlements, and a test must not be able to write an obligation into it.
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (d) => (output += String(d)));
    child.stderr.on("data", (d) => (output += String(d)));
    child.on("error", reject);
    child.on("close", (code) => done({ code, output }));
  });
}

function settleLiveEnv(gatewayUrl: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    REQUEST_GATEWAY_URL: gatewayUrl,
    KEEPERHUB_API_KEY: "not-a-credential-and-never-used",
    REQUEST_ID,
    PAYMENT_REFERENCE: DERIVED_REFERENCE,
    PAYEE_BURNER: PAYMENT_ADDRESS,
    FEE_ADDRESS: ZERO_ADDRESS,
    FEE_AMOUNT: "0",
    ...overrides,
  };
}

describe("scripts/settle-live.ts reads the invoice rather than trusting .env", () => {
  test("a .env reference that is not the derived one is refused, and the gateway was asked", async () => {
    const gateway = await startGateway();

    const ran = await run("scripts/settle-live.ts", settleLiveEnv(gateway.url, {
      PAYMENT_REFERENCE: SOMEBODY_ELSES_REFERENCE,
    }));

    assert.equal(ran.code, 2, `expected a refusal exit, got ${ran.code}:\n${ran.output}`);
    assert.match(ran.output, /REFERENCE_MISMATCH/, ran.output);
    // Both debts are named, and the derived one exists nowhere but in the invoice this run
    // fetched — so this message could not have been produced without reading it.
    assert.ok(ran.output.includes(SOMEBODY_ELSES_REFERENCE), ran.output);
    assert.ok(ran.output.includes(DERIVED_REFERENCE), ran.output);
    assert.equal(gateway.channels.length, 1, "the invoice was not fetched exactly once");
    assert.ok(gateway.channels[0].includes(`getTransactionsByChannelId?channelId=${REQUEST_ID}`), gateway.channels[0]);
  });

  test("a .env payee the invoice does not name is refused, naming the field", async () => {
    const gateway = await startGateway();

    const ran = await run("scripts/settle-live.ts", settleLiveEnv(gateway.url, {
      PAYEE_BURNER: "0x000000000000000000000000000000000000dEaD",
    }));

    assert.equal(ran.code, 2, ran.output);
    assert.match(ran.output, /FACT_MISMATCH/, ran.output);
    assert.match(ran.output, /payee/, ran.output);
    assert.ok(ran.output.includes(PAYMENT_ADDRESS), "the refusal does not quote what Request states");
  });

  test("a .env fee the invoice does not state is refused", async () => {
    const gateway = await startGateway();

    const ran = await run("scripts/settle-live.ts", settleLiveEnv(gateway.url, { FEE_AMOUNT: "500" }));

    assert.equal(ran.code, 2, ran.output);
    assert.match(ran.output, /FACT_MISMATCH/, ran.output);
    assert.match(ran.output, /feeAmount/, ran.output);
  });
});

describe("scripts/live-harness.ts reads the invoice rather than trusting the local file", () => {
  test("the first payable invoice is fetched, and a file that disagrees ends the run", async () => {
    const gateway = await startGateway();
    // Which invoice is first in line depends on what an earlier live run already settled, so
    // the assertion is that whatever it asked for is one of the file's invoices — not a
    // guess at which one.
    const known = new Set(
      (
        JSON.parse(readFileSync("docs/live-invoices.json", "utf8")) as {
          invoices: Array<{ requestId: string }>;
        }
      ).invoices.map((i) => i.requestId),
    );

    // --limit 1 so exactly one invoice is in play. The stub serves the same invoice for every
    // channel, so the reference the file carries cannot be the one that invoice derives — the
    // same shape as a file somebody edited, and the run must not proceed to pay anything.
    const ran = await run(
      "scripts/live-harness.ts",
      {
        REQUEST_GATEWAY_URL: gateway.url,
        KEEPERHUB_API_KEY: "not-a-credential-and-never-used",
      },
      // --out so a spawned production script cannot write into the repository. It used to, and
      // replaced the committed live evidence with a stub run's output.
      ["--limit", "1", "--out", join(tmpdir(), "reqkeeper-harness-out.json")],
    );

    assert.notEqual(ran.code, 0, `the run should not have succeeded:\n${ran.output}`);
    assert.match(ran.output, /REQUEST_ID_MISMATCH|REFERENCE_MISMATCH/, ran.output);
    assert.ok(gateway.channels.length >= 1, "live-harness never asked the gateway anything");
    const asked = /channelId=([0-9a-fA-F]+)/.exec(gateway.channels[0])?.[1];
    assert.ok(asked && known.has(asked), `asked the gateway for ${asked}, which is not in the file`);
    // Nothing was sent, and nothing could have been: the refusal is in the read, before the
    // first settleObligation call.
    assert.doesNotMatch(ran.output, /approved obligation settles/, ran.output);
  });
});

/**
 * The already-paid guard, and the window it searched.
 *
 * The guard reads the fee proxy before anything is proposed, and a `false` from it is what lets
 * the run proceed to move money — so the window behind that `false` is the whole guarantee. It
 * was `head - 200`: about forty minutes of Sepolia. A red-team pass pointed it at this project's
 * own LIVE settled reference, which sat 1033 blocks behind head, and the guard did not see it —
 * it missed exactly the payment it exists to catch, and printed "no payment seen" while doing it.
 *
 * The invoice's own anchor block bounds the window when the create is confirmed; while it is not,
 * the invoice is minutes old and the default lookback covers it many times over. Either way the
 * run now prints which window it checked, because a negative is worth what its window is worth.
 *
 * Driven through the real script against a stub gateway and a stub Sepolia, in a scratch working
 * directory: `settle-live.ts` opens `.data/live.sqlite`, and that store holds real settlements.
 */
const HEAD = 11692278;
/** How far behind head the red team's LIVE reference actually sat. Measured, not chosen. */
const PAYMENT_DEPTH = 1033;
const PAID_TX = `0x${"9c".repeat(32)}`;

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** The five non-indexed words of `TransferWithReferenceAndFee`, paying THIS invoice exactly. */
const PAYMENT_LOG_DATA =
  "0x" +
  word(FAU) +
  word(PAYMENT_ADDRESS) +
  word(BigInt(ONE_FAU).toString(16)) +
  word("0") +
  word(ZERO_ADDRESS);

/** A Sepolia at 11692278 carrying this invoice's payment 1033 blocks back, and nowhere else. */
async function startChain(): Promise<{ url: string; ranges: Array<{ from: number; to: number }> }> {
  const ranges: Array<{ from: number; to: number }> = [];
  const paidAt = HEAD - PAYMENT_DEPTH;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      const { method, params } = JSON.parse(body) as { method: string; params: unknown[] };
      let result: unknown = [];
      if (method === "eth_chainId") result = `0x${EXPECTED_CHAIN_ID.toString(16)}`;
      else if (method === "eth_blockNumber") result = `0x${HEAD.toString(16)}`;
      else if (method === "eth_getLogs") {
        const filter = params[0] as { fromBlock: string; toBlock: string };
        const from = Number(BigInt(filter.fromBlock));
        const to = Number(BigInt(filter.toBlock));
        ranges.push({ from, to });
        if (from <= paidAt && paidAt <= to) {
          result = [
            {
              data: PAYMENT_LOG_DATA,
              transactionHash: PAID_TX,
              address: ERC20_FEE_PROXY,
              blockNumber: `0x${paidAt.toString(16)}`,
            },
          ];
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  servers.push(server);
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  assert.ok(address && typeof address === "object", "the stub chain did not bind a port");
  return { url: `http://127.0.0.1:${address.port}`, ranges };
}

describe("scripts/settle-live.ts searches a window that can contain the payment", () => {
  test("an invoice already paid 1033 blocks ago stops the run, and the window is stated", async () => {
    const gateway = await startGateway();
    const chain = await startChain();
    const scratch = mkdtempSync(join(tmpdir(), "reqkeeper-settle-live-"));

    const ran = await run(
      "scripts/settle-live.ts",
      settleLiveEnv(gateway.url, { SEPOLIA_RPC: chain.url }),
      [],
      scratch,
    );

    assert.equal(ran.code, 2, `the run should have refused before any write:\n${ran.output}`);
    assert.match(ran.output, /REFUSED before any write/, ran.output);
    assert.ok(ran.output.includes(PAID_TX), "the refusal does not name the payment it found");
    // The window is part of the answer, not decoration: a reader has to be able to tell what
    // "no payment seen" would have meant.
    assert.match(ran.output, /searched\s+: the last 450000 blocks/, ran.output);
    assert.ok(
      chain.ranges.some((r) => r.from <= HEAD - PAYMENT_DEPTH && r.to >= HEAD - PAYMENT_DEPTH),
      `the guard never asked about block ${HEAD - PAYMENT_DEPTH}; it asked ${JSON.stringify(chain.ranges)}`,
    );
  });

  test("a confirmed invoice is searched from its own anchor block, and says so", async () => {
    // The preferred shape: the create is anchored, so the floor is a fact about this invoice
    // rather than a guess about how far back to look.
    const anchoredAt = HEAD - 2_000;
    const gateway = await startGateway({ blockNumber: anchoredAt, transactionHash: `0x${"11".repeat(32)}` });
    const chain = await startChain();
    const scratch = mkdtempSync(join(tmpdir(), "reqkeeper-settle-live-anchored-"));

    const ran = await run(
      "scripts/settle-live.ts",
      settleLiveEnv(gateway.url, { SEPOLIA_RPC: chain.url }),
      [],
      scratch,
    );

    assert.equal(ran.code, 2, ran.output);
    assert.ok(
      ran.output.includes(`searched         : blocks ${anchoredAt}..latest`),
      `the run did not search from the invoice's anchor block:\n${ran.output}`,
    );
    assert.match(ran.output, /REFUSED before any write/, ran.output);
  });
});
