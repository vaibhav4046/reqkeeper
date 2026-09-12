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
import { readFileSync } from "node:fs";
import { after, describe, test } from "node:test";

/** The invoice the stub gateway serves. Same real Sepolia invoice as test/request.test.ts. */
const REQUEST_ID = "0108b3f7d7d7d3c1fd21d37ba996b21d019c59cbaaa75c5cb5801fc3d9a371c142";
const SALT = "8682e8e726d1b4f1";
const PAYMENT_ADDRESS = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
/** What `derivePaymentReference` produces from the three values above, and nothing else. */
const DERIVED_REFERENCE = "0x050562a52ec69fa2";
const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const ONE_FAU = "1000000000000000000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** A real reference — for a different invoice. The kind of value a hand-edited file carries. */
const SOMEBODY_ELSES_REFERENCE = "0xfaac1220a314c4a9";

function gatewayBody(): unknown {
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
  return {
    meta: { storageMeta: [] },
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
async function startGateway(): Promise<{ url: string; channels: string[] }> {
  const channels: string[] = [];
  const server = createServer((req, res) => {
    channels.push(String(req.url));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(gatewayBody()));
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

function run(script: string, env: Record<string, string>, args: string[] = []): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", script, ...args],
      {
        // A real KeeperHub key in the environment or in .env must not be what makes this
        // test safe, so the key is overridden with a value that could not authenticate.
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (d) => (output += String(d)));
    child.stderr.on("data", (d) => (output += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
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
    assert.match(gateway.channels[0], /getTransactionsByChannelId\?channelId=0108b3f7/);
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
      ["--limit", "1"],
    );

    assert.notEqual(ran.code, 0, `the run should not have succeeded:\n${ran.output}`);
    assert.match(ran.output, /REFERENCE_MISMATCH/, ran.output);
    assert.ok(gateway.channels.length >= 1, "live-harness never asked the gateway anything");
    const asked = /channelId=([0-9a-fA-F]+)/.exec(gateway.channels[0])?.[1];
    assert.ok(asked && known.has(asked), `asked the gateway for ${asked}, which is not in the file`);
    // Nothing was sent, and nothing could have been: the refusal is in the read, before the
    // first settleObligation call.
    assert.doesNotMatch(ran.output, /approved obligation settles/, ran.output);
  });
});
