/**
 * ReqKeeper's hosted agent surface: MCP over HTTP, read-only.
 *
 * The stdio server in `src/mcp.ts` can propose and settle, because it runs beside a durable
 * store and beside the human who approves. This one is reachable by anyone with the URL, and
 * the correct number of payment tools for that situation is zero. `propose_payment` and
 * `settle_obligation` are not disabled here or gated behind a token: they are absent, the
 * same way `approve` is absent from the local server.
 *
 * POST JSON-RPC here. GET returns a short description, so a human who opens the URL in a
 * browser is told what this is rather than shown a stack trace.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { handlePublic, PUBLIC_SERVER_INFO, PUBLIC_TOOLS } from "./_gen/mcp-public.js";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version",
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = body === null ? "" : JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    // A public endpoint takes a bounded amount of input, or it is a denial-of-service target.
    if (bytes > 256 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method === "GET") {
    send(res, 200, {
      server: PUBLIC_SERVER_INFO,
      transport: "MCP JSON-RPC over HTTP POST",
      tools: PUBLIC_TOOLS.map((t) => t.name),
      cannot:
        "There is no tool here that moves money. Approval belongs next to a human, not behind " +
        "a URL. Run the stdio server from the repository to propose or settle.",
      source: "https://github.com/vaibhav4046/reqkeeper",
    });
    return;
  }

  if (req.method !== "POST") {
    send(res, 405, { error: "method not allowed" });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch (e) {
    send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: (e as Error).message } });
    return;
  }

  if (!parsed || typeof parsed !== "object") {
    send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: expected object or batch" } });
    return;
  }

  if (Array.isArray(parsed) && parsed.length === 0) {
    send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: empty batch" } });
    return;
  }

  // A batch is a list. Notifications produce no reply, so they are filtered out of it.
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  if (requests.length > 20) {
    send(res, 413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch too large" } });
    return;
  }

  const replies: unknown[] = [];
  for (const one of requests) {
    const reply = await handlePublic(one as { id?: string | number | null; method?: string });
    if (reply !== null) replies.push(reply);
  }

  if (replies.length === 0) {
    res.writeHead(202, CORS);
    res.end();
    return;
  }
  send(res, 200, Array.isArray(parsed) ? replies : replies[0]);
}
