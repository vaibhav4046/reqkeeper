# KeeperHub / MCP execution-surface audit

Scope: the KeeperHub execution surface only (`src/keeperhub.ts`, `src/keeperhub-mcp.ts`,
the dispatch section of `src/settle.ts`, `src/identity.ts`, `api/mcp.ts`, `src/mcp*.ts`,
`scripts/mcp-server.ts`). Read-only: no product file was modified.

Date: 2026-09-12. Commit state: `src/chain.ts` and `scripts/gate-a.ts` carry uncommitted
session changes (RPC fallback); both were read as-is, neither reverted.

## What was run

| Command | Result |
|---|---|
| `npm test` | `tests 239 / pass 239 / fail 0 / duration_ms 1175.0317` |
| `npm run typecheck` | clean, no output |
| `curl -s https://reqkeeper.vercel.app/api/mcp` (GET) | HTTP 200, 4 tools — output below |
| JSON-RPC `tools/list` POST to the same URL | HTTP 200, 4 tool schemas — output below |
| `curl` GET + unauthenticated `initialize` POST to `https://app.keeperhub.com/mcp` | HTTP 200, `serverInfo keeperhub 1.2.0`, `authentication.required: true` |
| 4 offline probes (stubbed `fetch` / in-memory `Store` / stub provider) | outputs quoted inline |

**`npm run verify:mcp` was NOT run.** It is not write-free. `scripts/verify-mcp.ts:61`
calls `provider.simulate(...)`, which is `execute_contract_call` with `simulate: true`
(`src/keeperhub-mcp.ts:222-226`) against the live platform with a real API key and a real
payee. This repository's own hazard model says that route can execute for real
(`src/provider.ts:12-15`, "`?simulate=true` is ignored ... and the transaction really
executes"), and `src/settle.ts:417-428` exists specifically to handle a dry run that
broadcast. A script that dispatches on a route documented as possibly-executing does not
meet "dispatches nothing", so it was skipped rather than run.

## Classification

| # | Claim under audit | Verdict |
|---|---|---|
| 1 | Two providers, same protocol, different transport | **VERIFIED** |
| 2 | Idempotency key is deterministic and scoped to obligation + plan + step | **VERIFIED** locally; provider-side scoping **UNPROVEN** |
| 2b | No ambiguous resourceId | **PARTIAL** — `"unknown"` placeholder execution id |
| 3a | 409 holds the key | **VERIFIED** |
| 3b | 429 on `execute` holds the key | **VERIFIED** |
| 3c | timeout on `execute` holds the key | **VERIFIED** |
| 3d | HTTP 200 + error body on `execute` is never success | **VERIFIED** |
| 3e | missing tx hash after a send holds the key | **VERIFIED** |
| 3f | 429 / timeout at **preflight** | **BROKEN** — obligation is permanently stranded (F-1) |
| 4 | HTTP 200 + error body never reads as success | **BROKEN** at the preflight gate (F-2) |
| 5 | MCP handshake, session rotation, authorization | **VERIFIED**; session re-handshake **BROKEN** (F-4) |
| 5b | ReqKeeper's hosted MCP surface is read-only | **VERIFIED** live |
| 6 | Live surfaces respond | **VERIFIED** |
| 7 | Settlement never rests on KeeperHub's own state | **VERIFIED**; receipt read skips the RPC fallback (F-5) |

---

## 1. The two providers

Identical `ExecutionProvider` contract (`src/provider.ts:64-71`), identical calldata gate
(`decodeAllowedCall`, imported by both), different transport.

**REST — `src/keeperhub.ts`**

- Base URL `https://app.keeperhub.com/api` (`:61`), override via `cfg.baseUrl`.
- Auth: `authorization: Bearer ${apiKey}` (`:91`). Headers: `content-type`, `accept:
  application/json`, plus `Idempotency-Key` **only when a key is passed** (`:95`).
- Writes: `POST /api/execute/contract-call` for both `simulate` (`:134`, body
  `{...step, simulate: true}`) and `execute` (`:150`).
- Reads: `GET /api/execute/{executionId}` for `observe` (`:157`); chain receipt via
  `POST cfg.rpcUrl` `eth_getTransactionReceipt` (`:178-183`) — never KeeperHub.
- Body shape: `{chainId, contractAddress, functionName, functionArgs, value}` where
  `functionArgs` is a JSON **string** (`:77-87`).

**MCP — `src/keeperhub-mcp.ts`**

- Endpoint `https://app.keeperhub.com/mcp` (`:84`), protocol `2025-06-18` (`:37`),
  clientInfo `reqkeeper 0.1.0` (`:38`).
- Auth: `authorization: Bearer ${apiKey}` (`:92`), `accept: application/json,
  text/event-stream` (`:95`), `mcp-session-id` once held (`:97`).
- Tools called: `execute_contract_call` for simulate and execute (`:222`, `:246`),
  `get_direct_execution_status` for observe (`:255`).
- Argument names are snake_case and every value is a string (`:207-217`) — deliberate, so a
  retry re-serialises byte-identically.
- Receipt: same independent `cfg.rpcUrl` read (`:265-290`).

## 2. Idempotency contract

```
idempotencyKey = sha256("reqkeeper.step.v1:" + obligationId + ":" + planHash + ":" + stepIndex)      identity.ts:134
obligationId   = sha256("reqkeeper.obligation.v1:" + len(ns) + ":" + ns + ":" + len(id) + ":" + id)  identity.ts:95
```

`planHash` content-addresses `{obligationId, chainId, token, decimals, payee,
invoiceBaseUnits, feeBaseUnits, totalDebitBaseUnits, steps, sourceFactsHash, policyHash}`
(`settle.ts:305-320`). Inputs are validated as 64-hex and `stepIndex` in `0..255`
(`identity.ts:125-133`). No clock, no randomness, no model text.

**Scoping, precisely:** by obligation (namespace + requestId), by approved plan content,
and by step index. **Not** by organization/account and **not** by route or protocol — the
same key value is sent as the `Idempotency-Key` HTTP header on REST and as the
`idempotency_key` tool argument on MCP. That is not ambiguous locally, because what
actually prevents a second dispatch is the durable attempt row, `CREATE UNIQUE INDEX
attempts_step ON attempts (plan_hash, step_index)` (`store.ts:108`) plus the
`firstSendAt !== null` guard (`settle.ts:481-503`), and both are transport-agnostic.
Whether KeeperHub scopes its own replay cache per-account or per-route is **UNPROVEN** —
proving it requires a write.

Second identity layer: `payment_reference` carries a partial UNIQUE index
(`store.ts:182`), lower-cased at the boundary (`identity.ts:147-153`), and step 0 of
settle refuses a second obligation over a claimed reference (`settle.ts:181-201`).

**Ambiguous resource id (PARTIAL).** Both mappers fall back to the literal string
`"unknown"` when the provider returns no id and no hash:

```
keeperhub.ts:213      const id = res.executionId ?? res.id ?? hash ?? "unknown";
keeperhub-mcp.ts:295  const id = payload.executionId ?? payload.execution_id ?? hash ?? "unknown";
```

That value is persisted into `attempts.execution_id` (`settle.ts:546`) and would be sent
as a path segment by `observe()` (`keeperhub.ts:157`). Not currently exploitable —
`worker.ts:163-183` resolves outcomes from the chain and never calls `observe()` — but it
is a placeholder standing where a resource identifier belongs, and two different stranded
attempts record the same one.

## 3. Disposition on failure

Probe 1 stubbed `globalThis.fetch` with canned responses (no network) and called the real
`KeeperHubProvider`:

```
--- execute() disposition by HTTP response ---
(a) HTTP 409                          -> THREW code=idempotency_conflict retryable=false
(b) HTTP 429                          -> THREW code=rate_limited retryable=true
(c) timeout / no response             -> THREW code=timeout retryable=true
(d) HTTP 200 + error body             -> RESOLVED {"executionId":"unknown","status":"pending"}
(e) HTTP 200 completed, NO tx hash    -> RESOLVED {"executionId":"exec-1","status":"completed"}
(f) HTTP 401 + parseable JSON body    -> RESOLVED {"executionId":"unknown","status":"pending"}
(g) HTTP 400 + parseable JSON body    -> RESOLVED {"executionId":"unknown","status":"pending"}

--- simulate() disposition ---
(h) simulate, HTTP 200 + error body   -> RESOLVED {"status":"simulated","wouldRevert":false,"gasEstimate":"0"}
(i) simulate, HTTP 401 + JSON body    -> RESOLVED {"status":"simulated","wouldRevert":false,"gasEstimate":"0"}
(j) simulate, timeout                 -> THREW code=timeout retryable=true

--- was an Idempotency-Key header sent on simulate? ---
   simulate headers: {"authorization":"Bearer kh_probe","content-type":"application/json","accept":"application/json"}
   execute  headers: {"authorization":"Bearer kh_probe","content-type":"application/json","accept":"application/json","Idempotency-Key":"key-abc"}
```

Mapped through `settle.ts`, with HOLD meaning "the attempt keeps its key, no second
dispatch is possible" and RELEASE meaning "the reservation is given back and a fresh
dispatch may follow":

| Case | Provider result | settle.ts | State | Key |
|---|---|---|---|---|
| (a) 409 on execute | `idempotency_conflict`, non-retryable (`keeperhub.ts:119-121`) | `:513-518` | `EVIDENCE_CONFLICT`, attempt `INTEGRITY_CONFLICT` | **HOLD** |
| (b) 429 on execute | `rate_limited`, retryable (`:122-124`) | `:519-529` | `EXECUTION_OUTCOME_UNKNOWN` + `OBSERVE_EXECUTION` job | **HOLD** |
| (c) timeout on execute | `timeout`, retryable (`:105-109`) | `:519-529` | `EXECUTION_OUTCOME_UNKNOWN` + job | **HOLD** |
| (d) 200 + error body | resolves `status:"pending"` | `:546-552` | recorded `SENT`, then `NO_HASH` then `EXECUTION_OUTCOME_UNKNOWN` | **HOLD** |
| (e) success, no hash | resolves `completed`, no hash | `:550-552` | `EXECUTION_OUTCOME_UNKNOWN` | **HOLD** |

All five hold. `markSent` is stamped **before** `execute()` (`settle.ts:507`,
`store.ts:708-712`, `COALESCE` so it is never overwritten), and `releaseObligation`
independently refuses once any attempt on the plan has `first_send_at` set
(`store.ts:553-556`). `EXECUTION_OUTCOME_UNKNOWN` and `EVIDENCE_CONFLICT` are excluded from
`REPLANNABLE` (`machine.ts:157-170`), so step 0b (`settle.ts:212-226`) refuses re-entry.
**No violation of the safe rule on the execute path.**

### F-1 (HIGH) — a retryable failure at *preflight* strands the obligation forever

`settle.ts:438` calls `releaseObligation` from inside the catch **before** any state
change, i.e. while the obligation is still `PAYMENT_PREFLIGHT` (set at `:414`).
`PAYMENT_PREFLIGHT` is not in `REPLANNABLE` (`machine.ts:157-170`), so
`store.releaseObligation` returns `{released:false, reason:"already dispatched
(PAYMENT_PREFLIGHT)"}` (`store.ts:550`) and the return value is discarded. The comment at
`settle.ts:443-445` — "leaves the obligation in PAYMENT_PREFLIGHT, which is replannable" —
is factually wrong.

Probe 3, `FixtureProvider("RATE_LIMITED")`, real `Store`, real `settleObligation`:

```
pass 1 (429 at preflight): state=PAYMENT_PREFLIGHT refusal=rate_limited
   guidance given to the agent: preflight unavailable: rate_limited. This is the platform
   being busy, not the payment being wrong - propose again later. Nothing was sent.
   is PAYMENT_PREFLIGHT replannable? false
   reservation held: YES
   pending jobs for the worker / resolve_pending to drain: 0

pass 2, same plan, platform healthy: state=PAYMENT_PREFLIGHT refusal=ALREADY_DISPATCHED
pass 3, a corrected plan:            state=PAYMENT_PREFLIGHT refusal=ALREADY_DISPATCHED

final state: PAYMENT_PREFLIGHT   physical sends: 0
```

The invoice can never be paid again by this system. No attempt row and no job were created
(the attempt is opened at `:463`, after simulate), so `resolve_pending` and the worker have
nothing to drain (`worker.ts:126-157` requires a job and an attempt); the only exits from
`PAYMENT_PREFLIGHT` in the transition table (`machine.ts:102-108`) are reachable only from
inside `settleObligation`, which refuses to re-enter; and a re-import under a new request id
is refused by `REFERENCE_ALREADY_CLAIMED` (`settle.ts:181-201`).

Money-safe (0 sends) but a liveness failure, and the agent guidance at `:451` states two
things that are not true: "propose again later" is guaranteed to return
`ALREADY_DISPATCHED`, and "Nothing was sent" is asserted on a `timeout`, which is by
definition an unknown outcome on a route this repo models as possibly-executing
(`provider.ts:12-15`). Probe 2 modelled exactly that (#1959 leak plus a lost reply) and
produced the same stranded `PAYMENT_PREFLIGHT`; the hold is accidental — it comes from the
release silently failing, not from a deliberate refusal to release on an unknown outcome.

Fix shape: split `timeout` from `rate_limited`; move to an explicit state before releasing;
and check `releaseObligation`'s return value instead of discarding it.

### F-2 (MEDIUM to HIGH) — an error body reads as a clean simulation

`wouldRevert: res.wouldRevert === true || res.success === false`
(`keeperhub.ts:138`; `keeperhub-mcp.ts:230`). A body carrying neither field — `{"error":
"insufficient funds for gas"}` — yields `wouldRevert: false`, probe cases (h) and (i)
above. `keeperhub.ts:111-128` also returns a parseable non-2xx body without throwing for
any status other than 409/429/5xx, so an HTTP **401** reads as a clean dry run too. Control
then falls through `settle.ts:430` to `:462` and dispatches a real payment. `parsed.error`
is declared (`keeperhub.ts:43`) and consulted only in the 409 and 5xx branches (`:120`,
`:126`).

This is the direct answer to "is an HTTP 200 with an error body ever treated as success":
**yes, at the preflight gate.** It does not reach `SETTLED` — that still needs a hash, an
independently read receipt and Request reconciliation — but the gate whose job is to say
"this would revert" answers "looks fine" to an error.

The MCP transport is partly covered here: `reply.result.isError` is checked
(`keeperhub-mcp.ts:186-196`). The REST route has no equivalent.

### F-3 (MEDIUM) — a 4xx that definitively did not execute is recorded as a send

Probe cases (f) and (g): HTTP 401/400 with a JSON body resolve as `status:"pending"`, so
`settle.ts:546` writes `outcome: SENT` and the obligation lands in
`EXECUTION_OUTCOME_UNKNOWN` via `NO_HASH`. A revoked API key therefore converts every
in-flight obligation into a manual investigation. Safe direction, wrong disposition.

### F-6 (MEDIUM) — a stuck reservation blocks a *corrected* plan

Same root cause as F-1: `settle.ts:438` fires before `:457` sets `SIMULATION_BLOCKED`, so
the release fails and the reservation stays with the refused plan. Probe 4, non-retryable
preflight error:

```
pass 1 (non-retryable preflight error): state=SIMULATION_BLOCKED refusal=bad_response
   reservation after the refusal: 3264175b160e
pass 2 (a CORRECTED plan, different bytes): state=OBLIGATION_RESERVED refusal=OBLIGATION_RESERVED
   detail: already reserved by plan 3264175b160e...
pass 3 (the identical plan again): state=SETTLED refusal=undefined sends=1
```

Re-proposing the identical plan recovers; changing the plan is refused permanently. That is
precisely the failure `releaseObligation`'s docstring (`store.ts:537-541`) says it exists to
prevent. The `wouldRevert` path at `:430-433` sets state first and releases correctly — only
the catch path is wrong.

## 4. HTTP 200 with an error body

Covered above. Execute path: never success (VERIFIED). Preflight path: treated as a clean
simulation (**BROKEN**, F-2). Neither mapper ever consults the `error` field when deciding
status — `keeperhub.ts:211-227` and `keeperhub-mcp.ts:293-313` branch only on `success`,
`status` and the presence of a hash, and default to `"pending"`, never `"completed"`.

## 5. MCP specifics

**Client against KeeperHub** (`src/keeperhub-mcp.ts`):

- Handshake is sequential: `initialize` then `notifications/initialized` (`:121-145`), not
  concurrent. Skipped entirely once a session exists (`:122`).
- Session id is taken from the `mcp-session-id` response header on **every** response and
  the newest wins (`:113-115`) — correct for a rotating token.
- Auth failure detection: a rejected key still answers 200, so the absence of the session
  header is the signal (`:136-142`). Confirmed live — the unauthenticated `initialize`
  below returned 200 with no `mcp-session-id`:

```
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},
 "serverInfo":{"name":"keeperhub","version":"1.2.0"},
 "authentication":{"required":true,"resource_metadata":"https://app.keeperhub.com/.well-known/oauth-protected-resource"}}}
```

- SSE framing is handled (`:166-169`); 429 and 5xx are mapped before parsing (`:158-161`).
- `simulate: true` is sent as a real boolean (`:225`), never the string.

**F-4 (MEDIUM) — an expired session can never re-handshake.** `#handshake()` returns early
whenever `#session` is non-null (`:122`), and nothing ever clears `#session`. A `-32003`
"Session not initialized" is classified retryable (`:176`), but a retry on the same
provider instance re-sends the dead session id and fails identically. Every current caller
constructs a fresh provider per process, so impact today is low; the retryable flag is a
promise the code cannot keep.

**ReqKeeper's own MCP surfaces — tool counts and mutability:**

| Surface | Tools | Can move money? |
|---|---|---|
| Hosted, `api/mcp.ts` then `src/mcp-public.ts:20-60` | **4**: `settlement_evidence`, `verify_payment`, `refusal_codes`, `how_it_works` | **No.** All four read a generated evidence file, a credential-free public RPC, or a static table. No store and no provider is imported. |
| stdio, `src/mcp.ts:60-115` | **6**: `propose_payment`, `settle_obligation`, `obligation_status`, `verify_payment`, `resolve_pending`, `refusal_codes` | 3 read-only; `propose_payment` writes locally but passes no approval so it always stops at `AWAITING_APPROVAL` before preflight; `resolve_pending` only drains jobs, no send path; **`settle_obligation` is the one dispatch-capable tool.** |

`settle_obligation` cannot supply its own authority: the approval is read from the store by
plan hash and can only have been written by the human CLI (`src/mcp.ts`, settle handler —
`const reserved = ctx.store.getObligation(oid)?.reservedByPlan; const recorded = reserved ?
ctx.store.getApproval(reserved) : undefined`). No MCP tool on either surface can write an
approval. `scripts/mcp-server.ts:36-40` refuses to start without `KEEPERHUB_API_KEY` and
writes only to stderr (`:52-54`), keeping stdout clean for JSON-RPC.

## 6. Live surface check (read-only)

```
$ curl -s -i https://reqkeeper.vercel.app/api/mcp
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Server: Vercel

{"server":{"name":"reqkeeper-public","version":"0.1.0"},"transport":"MCP JSON-RPC over HTTP POST",
 "tools":["settlement_evidence","verify_payment","refusal_codes","how_it_works"],
 "cannot":"There is no tool here that moves money. Approval belongs next to a human, not behind a URL.
 Run the stdio server from the repository to propose or settle.",
 "source":"https://github.com/vaibhav4046/reqkeeper"}
```

The `tools/list` POST returned the same four tools with full input schemas, HTTP 200. No
payment tool is present on the hosted surface — matching the claim in `api/mcp.ts:1-12`
that they are absent rather than gated.

`https://app.keeperhub.com/mcp` answers: GET 200 (`content-type: application/json`, CORS
exposing `Mcp-Session-Id, WWW-Authenticate`, Cloudflare), and the unauthenticated
`initialize` POST returns the `keeperhub 1.2.0` / `authentication.required: true` body
quoted in section 5.

## 7. Is KeeperHub's own state ever taken as proof of settlement?

**No.** `SETTLED` requires, in order: a transaction hash (`settle.ts:550`), a receipt read
from `cfg.rpcUrl` with `status === "0x1"` (`keeperhub.ts:175-196`,
`keeperhub-mcp.ts:265-290` — both post `eth_getTransactionReceipt` to the RPC, never to
KeeperHub), and `sourceSaysPaid` matching **this** transaction hash and **this** amount
against the ERC20FeeProxy event log (`src/mcp.ts` settle handler; `chain.ts:117+`).
`CHAIN_CONFIRMED` cannot jump to `SETTLED` — `RECONCILING` is a mandatory stop
(`machine.ts:116`). The worker re-reads the receipt in `RECONCILE_SOURCE` rather than
trusting the earlier pass (`worker.ts:186-210`). Unrecognised provider statuses map to
`"pending"`, never `"completed"` (`keeperhub.ts:216-219`, `keeperhub-mcp.ts:298-305`).

**F-5 (MEDIUM) — the settlement receipt read does not use the RPC fallback.** Both
providers do a bare single-endpoint `fetch` to `cfg.rpcUrl`. `src/chain.ts:11-25`
(uncommitted session change) documents that publicnode answers
`eth_getTransactionReceipt` with `result: null` for transactions it still has, and adds
`RPC_FALLBACKS` plus `NULLABLE_IS_UNKNOWN` so a null is treated as "this endpoint does not
know". `keeperhub.ts` and `keeperhub-mcp.ts` import nothing from `chain.ts`, so the
settlement path — the one place the distinction decides money — still reads a pruned null
as `not_found`, which `settle.ts:559-563` turns into `EVIDENCE_CONFLICT`. Fails safe, but
for the wrong reason, and the fix already exists two modules away.

## Findings, by severity

| ID | Severity | Summary | Where |
|---|---|---|---|
| F-1 | HIGH | 429/timeout at preflight strands the obligation in `PAYMENT_PREFLIGHT` with no recovery path; agent guidance is wrong on both counts | `settle.ts:438,443-454`; `machine.ts:157-170`; `store.ts:544-562` |
| F-2 | MEDIUM to HIGH | An error body (200 or 401) reads as `wouldRevert: false` and the payment dispatches | `keeperhub.ts:111-128,138`; `keeperhub-mcp.ts:230` |
| F-3 | MEDIUM | 4xx with a JSON body is recorded as a send (`outcome: SENT`) and drives `EXECUTION_OUTCOME_UNKNOWN` | `keeperhub.ts:111-128`; `settle.ts:546-552` |
| F-4 | MEDIUM | Expired MCP session can never re-handshake though `-32003` is flagged retryable | `keeperhub-mcp.ts:122,176` |
| F-5 | MEDIUM | Settlement receipt read bypasses `chain.ts`'s RPC fallback; a pruned null becomes `EVIDENCE_CONFLICT` | `keeperhub.ts:175-196`; `keeperhub-mcp.ts:265-290`; `chain.ts:11-89` |
| F-6 | MEDIUM | Non-retryable preflight error leaves the reservation stuck; a corrected plan is refused `OBLIGATION_RESERVED` forever | `settle.ts:438,457` |
| F-7 | LOW | `"unknown"` placeholder used as an execution id and persisted | `keeperhub.ts:213`; `keeperhub-mcp.ts:295` |
| F-8 | LOW | REST 409 does not distinguish "in progress" from "same key, different body"; both become `EVIDENCE_CONFLICT` | `keeperhub.ts:119-121`; cf. `provider.ts:21-22` |
| F-9 | LOW | No test covers provider HTTP-status disposition; `test/keeperhub*.test.ts` cover the calldata gate and receipt reads only | `test/keeperhub.test.ts`, `test/keeperhub-mcp.test.ts` |

What held under adversarial probing: the execute-path disposition table (all five cases
hold the key), the durable-attempt guard, the reference UNIQUE index, the human-authority
boundary on both MCP surfaces, and the refusal to call anything settled without an
independent chain read.
