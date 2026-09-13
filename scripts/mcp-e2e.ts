/**
 * The agent surface, end to end, through the real binary.
 *
 *   npm run mcp:e2e
 *
 * Spawns `scripts/mcp-server.ts` as a child process and speaks JSON-RPC to it over stdin/stdout,
 * exactly as Claude Code or Cursor would. Nothing is imported and called directly: the thing
 * under test is the server a judge would actually register, including its stdout discipline —
 * a stray `console.log` anywhere in the settle path corrupts the protocol stream, and only a
 * test that parses stdout as a protocol can catch that.
 *
 * It does not spend. The provider is pointed at the counting fixture through
 * `KEEPERHUB_BASE_URL`, so the real `KeeperHubProvider`, the real calldata gate and the real
 * settle path all run, and every call that would have moved money is counted in this process
 * where a crash in the child cannot erase it. The alternative is an end-to-end test that either
 * spends real money or exercises a stub, and neither is end to end.
 *
 * The Request read is NOT stubbed. `propose_payment` fetches the invoice from Request's public
 * gateway and re-derives the payment reference, because that is the integration this project
 * claims and a test that skips it proves the wrong thing.
 *
 * What it asserts, in order:
 *   1. the handshake works and the tool list is what the README says it is
 *   2. NO tool on the surface can approve a payment — checked by name and by attempting it
 *   3. propose_payment stops at AWAITING_APPROVAL and sends nothing
 *   4. settle_obligation with no human decision sends nothing
 *   5. a reference the invoice does not derive is refused before any write
 *   6. with a human approval written by the CLI path, settle_obligation pays exactly once
 *   7. hammering settle_obligation afterwards pays zero more times
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { KeeperHubFixture } from "./fixture-keeperhub.ts";
import { obligationId } from "../src/identity.ts";
import { NAMESPACE } from "../src/plan.ts";
import { Store } from "../src/store.ts";

const SERVER = new URL("mcp-server.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

let failures = 0;
const ok = (what: string, detail = ""): void => console.log(`  ok   ${what}${detail ? ` — ${detail}` : ""}`);
const bad = (what: string, detail: string): void => {
  failures++;
  console.log(` FAIL  ${what} — ${detail}`);
};
const check = (cond: boolean, what: string, detail = ""): void => (cond ? ok(what, detail) : bad(what, detail || "assertion failed"));

/** A JSON-RPC client that talks to the child over pipes, the way a real MCP client does. */
class ServerUnderTest {
  #kid: ChildProcessWithoutNullStreams;
  #pending = new Map<number, (v: Record<string, unknown>) => void>();
  #id = 0;
  readonly stderr: string[] = [];
  /** Anything on stdout that was not a JSON-RPC message. Must stay empty. */
  readonly garbage: string[] = [];

  constructor(env: Record<string, string>) {
    this.#kid = spawn(process.execPath, ["--experimental-strip-types", SERVER], {
      env: { ...process.env, ...env, NODE_NO_WARNINGS: "1" },
      cwd: process.cwd(),
    }) as ChildProcessWithoutNullStreams;

    createInterface({ input: this.#kid.stdout, terminal: false }).on("line", (line) => {
      const t = line.trim();
      if (t === "") return;
      try {
        const msg = JSON.parse(t) as { id?: number };
        const resolve = typeof msg.id === "number" ? this.#pending.get(msg.id) : undefined;
        if (resolve) {
          this.#pending.delete(msg.id as number);
          resolve(msg as Record<string, unknown>);
        }
      } catch {
        // stdout is the protocol channel. Anything unparseable here is a corrupted stream.
        this.garbage.push(t.slice(0, 160));
      }
    });
    this.#kid.stderr.on("data", (c: Buffer) => this.stderr.push(String(c)));
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.#id;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#kid.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<{ json: Record<string, unknown> | null; text: string; isError: boolean }> {
    const res = await this.send("tools/call", { name, arguments: args });
    const result = (res.result ?? {}) as { content?: Array<{ text: string }>; isError?: boolean };
    const text = result.content?.[0]?.text ?? "";
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { json, text, isError: result.isError === true };
  }

  async stop(): Promise<void> {
    this.#kid.stdin.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.#kid.kill();
        resolve();
      }, 4000);
      this.#kid.on("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

// A real invoice, read back from Request's gateway by the server itself.
const invoices = JSON.parse(readFileSync("docs/live-invoices.json", "utf8")) as {
  invoices: Array<{ requestId: string; paymentReference: string; payee: string; amountBaseUnits: string; feeAmount?: string; feeAddress?: string }>;
};
const inv = invoices.invoices[0];

const fx = new KeeperHubFixture();
await fx.start();
const dir = mkdtempSync(join(tmpdir(), "rk-e2e-"));
const dbPath = join(dir, "e2e.sqlite");

const server = new ServerUnderTest({
  KEEPERHUB_API_KEY: "kh_e2e_fixture",
  KEEPERHUB_BASE_URL: fx.baseUrl,
  SEPOLIA_RPC: fx.rpcUrl,
  // Pinned to the fixture. Without this the negative from the fixture is corroborated
  // against real public endpoints, where these invoices really are paid -- two different
  // worlds, and the run refuses on the contradiction between them.
  REQKEEPER_RPC_ENDPOINTS: fx.rpcUrl,
  REQKEEPER_DB: dbPath,
});

console.log("\nMCP end to end — the real server binary, over stdin/stdout\n");

const INVOICE = {
  requestId: inv.requestId,
  paymentReference: inv.paymentReference,
  payee: inv.payee,
  amountBaseUnits: inv.amountBaseUnits,
  maxTotalDebitBaseUnits: inv.amountBaseUnits,
  feeAmount: inv.feeAmount ?? "0",
  feeAddress: inv.feeAddress ?? `0x${"0".repeat(40)}`,
};

try {
  // ---- 1. handshake and tool list ----------------------------------------
  const init = (await server.send("initialize", {})) as { result?: { serverInfo?: { name?: string } } };
  check(init.result?.serverInfo?.name === "reqkeeper", "handshake", init.result?.serverInfo?.name ?? "no serverInfo");

  const listed = (await server.send("tools/list", {})) as { result?: { tools?: Array<{ name: string }> } };
  const names = (listed.result?.tools ?? []).map((t) => t.name);
  check(names.length === 6, "six tools on the agent surface", names.join(", "));

  // ---- 2. the security property ------------------------------------------
  const approvalish = names.filter((n) => /approve|authoris|authoriz|sign|confirm|decide/i.test(n));
  check(approvalish.length === 0, "no tool is named like an approval", approvalish.join(", ") || "none");

  const guessed = await server.call("approve");
  check(guessed.isError && /unknown tool/i.test(guessed.text), "an invented approve tool is refused, not improvised", guessed.text.slice(0, 60));

  // ---- 3. propose stops at the human --------------------------------------
  const proposed = await server.call("propose_payment", INVOICE);
  check(proposed.json?.state === "AWAITING_APPROVAL", "propose_payment stops at AWAITING_APPROVAL", `${proposed.json?.state} ${proposed.json?.refusal ?? ""} ${String(proposed.json?.detail ?? "").slice(0, 120)}`);
  check(typeof proposed.json?.approvalSentence === "string", "and returns the sentence a human must read", String(proposed.json?.approvalSentence).slice(0, 58));
  check(fx.counters().broadcasts === 0, "nothing was sent", `${fx.counters().broadcasts} broadcast`);

  // ---- 4. settle without a decision ---------------------------------------
  const unapproved = await server.call("settle_obligation", INVOICE);
  check(unapproved.json?.state === "AWAITING_APPROVAL", "settle_obligation with no human decision refuses", String(unapproved.json?.state));
  check(fx.counters().broadcasts === 0, "still nothing sent", `${fx.counters().broadcasts} broadcast`);

  // ---- 5. a reference the invoice does not derive --------------------------
  const forged = await server.call("propose_payment", { ...INVOICE, paymentReference: "0xdeadbeefdeadbeef" });
  check(forged.json?.refusal === "REFERENCE_MISMATCH", "a forged payment reference is refused", String(forged.json?.refusal));
  check(forged.json?.providerWriteIssued === false, "refused before any provider write");

  // ---- 6. a human approves, out of band -----------------------------------
  // Exactly what `npm run approve` does: a separate process writing to the same database. The
  // agent surface cannot do this, which is the entire authority boundary.
  const oid = obligationId(NAMESPACE, INVOICE.requestId);
  {
    const humanStore = new Store(dbPath);
    const planHash = humanStore.getObligation(oid)?.reservedByPlan;
    if (!planHash) throw new Error("no reserved plan to approve — propose_payment did not persist one");
    humanStore.recordApproval({
      planHash,
      obligationId: oid,
      approver: "human:e2e",
      decision: "APPROVED",
      restatement: String(proposed.json?.approvalSentence ?? ""),
      now: Date.now(),
    });
    humanStore.close();
    ok("a human wrote the approval from a separate process", `plan ${planHash.slice(0, 12)}…`);
  }

  const settled = await server.call("settle_obligation", INVOICE);
  check(settled.json?.state === "SETTLED", "settle_obligation settles once approved", `${settled.json?.state} ${settled.json?.refusal ?? ""}`);
  check(fx.counters().broadcasts === 1, "exactly one payment", `${fx.counters().broadcasts} broadcast`);

  // ---- 7. hammer it --------------------------------------------------------
  const before = fx.counters().broadcasts;
  for (let i = 0; i < 10; i++) await server.call("settle_obligation", INVOICE);
  const after = fx.counters();
  check(after.broadcasts === before, "ten more settle calls pay nothing", `${after.broadcasts - before} extra broadcast(s)`);
  check(after.posts === 1, "and nine of them never reached the provider at all", `${after.posts} post(s) total`);

  // ---- stdout discipline ---------------------------------------------------
  check(server.garbage.length === 0, "stdout carried only protocol messages", server.garbage[0] ?? "clean");
} catch (e) {
  bad("end-to-end run", (e as Error).message.slice(0, 200));
} finally {
  await server.stop();
  await fx.stop();
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "\nThe agent surface holds: six tools, no approval among them, one payment.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
