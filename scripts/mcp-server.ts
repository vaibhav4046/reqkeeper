/**
 * MCP stdio entry point.
 *
 * stdout is the protocol channel and nothing else may be written to it — a stray console.log
 * corrupts the JSON-RPC stream and the client disconnects with no useful error. Every
 * diagnostic here goes to stderr.
 *
 * Register with a client (Claude Code, Claude Desktop) as:
 *
 *   {
 *     "mcpServers": {
 *       "reqkeeper": {
 *         "command": "node",
 *         "args": ["--experimental-strip-types", "scripts/mcp-server.ts"],
 *         "cwd": "/path/to/reqkeeper"
 *       }
 *     }
 *   }
 */

import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { DEFAULT_RPC } from "../src/chain.ts";
import { handleRequest, SERVER_INFO, TOOLS, type McpContext } from "../src/mcp.ts";
import { KeeperHubProvider } from "../src/keeperhub.ts";
import { SEPOLIA } from "../src/plan.ts";
import { Store } from "../src/store.ts";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const apiKey = process.env.KEEPERHUB_API_KEY;
if (!apiKey) {
  process.stderr.write("reqkeeper-mcp: KEEPERHUB_API_KEY is not set; refusing to start\n");
  process.exit(2);
}

if (!existsSync(".data")) mkdirSync(".data");

/**
 * Two operational overrides, both off by default.
 *
 * REQKEEPER_DB lets an operator run more than one workspace, and lets the end-to-end test drive
 * this exact binary against a temporary file instead of the live database.
 *
 * KEEPERHUB_BASE_URL points the provider somewhere else. It exists so `npm run mcp:e2e` can
 * exercise the REAL server, the REAL provider and the REAL settle path against a counting
 * fixture — the alternative is an end-to-end test that either spends money or tests a stub, and
 * neither of those is an end-to-end test. It is not a test-only branch: the provider has always
 * taken a base URL, this only surfaces it.
 */
const dbPath = process.env.REQKEEPER_DB ?? ".data/live.sqlite";
const baseUrl = process.env.KEEPERHUB_BASE_URL;

const ctx: McpContext = {
  // The same durable store the human approval CLI writes to. In-memory would mean an agent
  // could never see a human's decision, and a restart would forget what was already sent.
  store: new Store(dbPath),
  provider: new KeeperHubProvider({ apiKey, chainId: SEPOLIA, rpcUrl: DEFAULT_RPC, ...(baseUrl ? { baseUrl } : {}) }),
  rpcUrl: DEFAULT_RPC,
};

if (baseUrl) {
  process.stderr.write(`reqkeeper-mcp: provider pointed at ${baseUrl} (not app.keeperhub.com)
`);
}

process.stderr.write(
  `reqkeeper-mcp ${SERVER_INFO.version} ready — ${TOOLS.length} tools, none of which can approve a payment\n`,
);

const rl = createInterface({ input: process.stdin, terminal: false });

/**
 * In-flight calls are tracked so stdin closing does not kill them.
 *
 * Exiting on 'close' alone drops any request still awaiting a chain read and answers it with
 * silence, which a client cannot distinguish from a hang. It shows up the moment you pipe a
 * batch of requests in rather than holding the pipe open.
 */
const inFlight = new Set<Promise<void>>();

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;

  // Each line is handled independently; a malformed one must not kill the server.
  const task = (async () => {
    let response;
    try {
      response = await handleRequest(ctx, JSON.parse(trimmed));
    } catch (e) {
      process.stderr.write(`reqkeeper-mcp: ${(e as Error).message}\n`);
      response = {
        jsonrpc: "2.0" as const,
        id: null,
        error: { code: -32700, message: `parse or handler error: ${(e as Error).message}` },
      };
    }
    if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`);
  })();

  inFlight.add(task);
  void task.finally(() => inFlight.delete(task));
});

rl.on("close", () => {
  void (async () => {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    // Close the database and let the loop drain rather than calling process.exit, which
    // aborts on Windows with a libuv assertion when readline's handle is already closing.
    ctx.store.close();
  })();
});
