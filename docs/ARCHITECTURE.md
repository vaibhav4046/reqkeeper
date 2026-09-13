# Architecture

A map into `src/`, aimed at the two files that are too long to read cold: `src/store.ts`
(1,123 lines) and `src/settle.ts` (885 lines). It says where things are and why they are
shaped that way. It does not repeat the code, which carries its own reasoning in comments that
are usually more specific than anything here.

Line numbers are against the commit this file was last regenerated at; run `git log -1 --format=%h -- docs/ARCHITECTURE.md` for it, and treat any citation that does not land on the named symbol as stale rather than as the code having moved. `src/settle.ts` is easiest to
navigate by its numbered protocol sections (`// --- 0.` through `// --- 10.`), which are stable
even when line numbers move.

## The seam

Three systems, and the whole project is the boundary between them.

```
Request Network                 ReqKeeper                    KeeperHub
owns obligation identity        owns "did this already       owns execution
                                 happen?"

invoice facts, salt,      -->   obligationId, planHash,  --> simulate -> execute -> status
payment reference               idempotencyKey               (REST or MCP)
                                reservation, CAS, outbox
                                        |
                                        v
                          public Sepolia RPC (never KeeperHub)
                          receipt + fee-proxy event + depth
```

**Request owns identity.** An obligation is not something ReqKeeper invents. Request already
issues one per invoice, and it survives a payer wallet change, a key rotation, a re-import,
regenerated calldata and a 24-hour cache expiry. `src/request.ts` reads the invoice from the
public Sepolia gateway with no credential and derives the payment reference from the invoice's
own salt and payment address (`src/request.ts:108`). The reference is a *consequence* of the
obligation, never an input to it. That matters because every guard downstream protects,
faithfully, whatever reference it is handed: a wrong reference does not break the machine, it
aims it.

**KeeperHub owns execution.** It signs and relays from a Turnkey wallet whose key nobody here
holds, and it offers idempotent replay within 24 hours per key. What it cannot know is what a
Request *obligation* is. A fresh agent session with a fresh key is a fresh request to it.

**ReqKeeper owns the part in between:** whether a send for this obligation has already
happened. It makes the obligation, not the API call, the unit of idempotency. That is the
entire product.

The consequence worth stating: exactly-once cannot live on Request's side. The fee proxy is a
stateless forwarder with no uniqueness on the reference, and `GET /v2/request/{id}/pay` returns
calldata with no nonce. And it cannot live on KeeperHub's side, because their cache expires and
does not know about invoices. It has to live on the payer's execution side, keyed on the
invoice. `README.md` has the long version of this argument.

## Identity: `src/identity.ts` (166 lines)

Four hashes, all SHA-256 over a domain-separated preimage, all derived from persisted state.

| | Derivation | Line |
|---|---|---|
| `obligationId` | `sha256("reqkeeper.obligation.v1:" + len(ns) + ns + len(id) + id)` | `identity.ts:86` |
| `planHash` | `sha256("reqkeeper.plan.v1:" + canonicalJson(planBody))` | `identity.ts:99` |
| `policyHash` | `sha256("reqkeeper.policy.v1:" + canonicalJson(policy))` | `identity.ts:104` |
| `idempotencyKey` | `sha256("reqkeeper.step.v1:" + obligationId + planHash + stepIndex)` | `identity.ts:120` |

**No session, no clock, no randomness enters any of them.** This is not stylistic. A retry has
to reproduce the identical key byte for byte, or the provider treats it as a new payment and
pays again. So a timestamp, a request id from the transport, a UUID, or any model-generated
text in a key would be a duplicate-payment bug with a delay fuse. `canonicalJson`
(`identity.ts:39`) enforces the discipline mechanically: it sorts object keys, refuses
non-finite and fractional numbers, and refuses `bigint` outright, because money crosses as a
decimal string and a bigint here would mean someone forgot to convert and the hash was
unstable.

Two details that look like fussiness and are not:

- **Length-prefixed framing** in `obligationId`. A plain `ns:id` preimage lets `("a", "b:c")`
  and `("a:b", "c")` collide, and the real namespace is `request-network:sepolia`, so banning
  the delimiter was not available.
- **`canonicalReference`** (`identity.ts:156`) folds a reference to one spelling before it is
  ever stored or looked up. SQLite compares TEXT byte by byte, so `0xAA` and `0xaa` would be
  two rows under a UNIQUE index, and two rows is two payments. It accepts Request's bare
  16-character spelling and normalises *into* the prefixed form, because both spellings must
  land on one stored string.

`derivePlan` (`settle.ts:170`) lowercases `steps[].to` and `steps[].data` before hashing, so
the plan hash addresses the effect rather than one spelling of it. The calldata gate is
unaffected: it still runs byte identity against `p.steps` exactly as given.

## The state machine: `src/machine.ts` (252 lines)

25 states in one table (`machine.ts:12-39`), 11 on the happy path and 14 refusals and faults.
One module owns every legal transition, so an impossible move is a `TransitionError` and an
audit row rather than a silently corrupted row.

**Terminal (12)** (`machine.ts:61`): `SETTLED`, `POLICY_DENIED`, `SOURCE_ALREADY_PAID`,
`OBLIGATION_RESERVED`, `REVIEW_REJECTED`, `PLAN_EXPIRED`, `PLAN_CHANGED`, `CALLDATA_MISMATCH`,
`SIMULATION_BLOCKED`, `PREFLIGHT_UNAVAILABLE`, `EXECUTION_REVERTED`,
`CANCELLED_BEFORE_PAYMENT`.

**Deliberately not terminal:** `EXECUTION_OUTCOME_UNKNOWN`, `RECONCILIATION_PENDING` and
`EVIDENCE_CONFLICT`. Each is an open investigation with somewhere to go once evidence lands.
An unknown outcome never decays into failure; it resolves only by observing the work already
dispatched.

**Replannable (13)** (`machine.ts:176`) is the set a *fresh plan* may be proposed from.
Replanning is not a transition: a refusal is closed forever, and proposing again starts a new
settlement over the same debt, which is why it is a separate audited operation
(`store.replan`, `store.ts:627`) rather than an edge in the table. The set is exactly "no money
moved and the debt still stands". `SOURCE_ALREADY_PAID` is excluded because there is nothing
left to pay; everything from `PAYMENT_EXECUTING` onward is excluded because a second plan over
a live payment is the thing this project exists to refuse.

### `PREFLIGHT_UNAVAILABLE` is only entered after the chain has been read

This is the one member of `REPLANNABLE` whose safety does not follow from its name, and it is
worth understanding before touching anything near the preflight.

`PAYMENT_PREFLIGHT` is not replannable, because a `simulate` can time out and a timed-out dry
run may have executed for real (the `#1959` hazard: KeeperHub's dry-run route has been observed
returning a transaction hash). The provider's own `retryable` flag cannot separate "busy" from
"executed and lost the reply" (`rate_limited` and `timeout` are both retryable), so it is not
the discriminator.

**The settle path no longer enters this state at all.** `settle.ts:603-680` has exactly one
branch for a preflight that throws: hold the reservation, leave the already-committed
`OBSERVE_PREFLIGHT` job queued, and return `EXECUTION_OUTCOME_UNKNOWN` telling the caller to
run the resolver. An earlier version kept a second branch that released the reservation on a
non-retryable error, and a red-team pass walked through it to a second physical send; the
comment at `settle.ts:685` explains why there is deliberately no second branch now.

The only writer of `PREFLIGHT_UNAVAILABLE` in `src/` is `worker.ts:224`, and it is reached only
after `sightPayment` (`worker.ts:200`) has scanned the full window, found nothing carrying this
reference, and reported the scan as not truncated. Absence only counts when the read
could see the whole window; a truncated scan defers with `SCAN_TRUNCATED`, because "I could not
tell" must never become "go ahead".

> Note for a reader following the comments: `machine.ts:166-174` still says `settleObligation`
> enforces the precondition with `store.sentAttemptFor`. It does not, and cannot: `openAttempt`
> does not run until after `simulate` returns, so on a first proposal there is no attempt row
> to inspect. The guarantee is real but it is enforced by the worker's chain read, not by that
> check. The test it names (`test/preflight-unavailable.test.ts:280`) still passes.

## The dispatch protocol: `src/settle.ts`

`settleObligation` (`settle.ts:360`) is a thin wrapper; `settleOrRefuse` (`settle.ts:370`) is
the protocol. **The order of its numbered sections is itself the safety property.** Two rules
produce that order:

1. Everything that can refuse must refuse **before** the attempt row is committed, so a
   refusal costs zero provider writes and zero gas.
2. Nothing may reach the provider without a durable attempt row already behind it, so a crash
   mid-send is recoverable by observation rather than by paying again.

| § | Line | What | Why here and not elsewhere |
|---|---|---|---|
| 0 | 374 | reference index + `OBLIGATION_ID_MISMATCH` | The request id is caller-supplied free text. The reference is derived here from the invoice's own salt and payment address, by the same rule Request's calculator uses, and it is what the chain actually carries — so it is the identity that binds. The id check costs one hash and stops a caller describing two debts at once. |
| 0b | 413 | re-entry guard | Without it the pipeline re-runs on a settled obligation and `setState` drags it back to `PAYMENT_PREFLIGHT` before later guards refuse. Money stays safe; the recorded state regresses and the agent surface reports a finished payment as pre-dispatch. |
| 1 | 444 | policy | First, because it is the cheapest thing that can say no. |
| 1b | 458 | calldata vs facts | The only place both halves are in scope. Policy clears an *invoice*; the provider is handed *bytes*. The gate at the provider proves the bytes decode to an allowlisted call and has no idea what this invoice says. |
| 2 | 481 | immutable plan | The plan is content-addressed here so the approval can be bound to it. |
| 3 | 504 | reservation | Exclusive ownership, before a human is asked. |
| 4 | 519 | human authority | A prior `REJECTED` for this plan hash is consulted before a new decision is taken, so an agent cannot turn a no into a yes by attrition. Quorum counts *distinct* approvers of this plan hash. |
| 5 | 587 | re-check at the dispatch boundary | Plan TTL and `sourceFactsHash`. Facts can move between approval and dispatch. |
| 6 | 603 | simulate | Explicitly **not** a safety boundary. A dry run that returns a hash is treated as a real send. |
| 7 | 700 | commit the attempt | Before anything is sent. This is the local authority boundary. |
| 8 | 712 | send | Guarded by the compare-and-set below. |
| 9 | 809 | independent chain evidence | Receipt, then the receipt's *own* logs. |
| 10 | 873 | reconcile with Request | Even a good receipt is not settlement. |

Move any of these and you get a specific, known bug back. Section 1b before 1 and a plan whose
bytes were never checked against a cleared invoice; 7 after 8 and a crash mid-send leaves no
record that a payment may exist; 9 collapsed into 8 and a forwarder's `status: 0x1` settles a
payment that never happened.

Three refusals that read as implementation detail and are not:

- `calldataDisagreesWithFacts` (`settle.ts:80`) refuses a plan whose **last** step is not the
  payment (`settle.ts:131-134`), because section 6 dispatches `steps[steps.length - 1]`
  (`settle.ts:604`) and nothing else. A plan ending in an allowance would report a settled
  invoice while the payment was never sent. It also refuses an empty plan, which would reserve
  the obligation forever having authorised nothing.
- `receiptDisagreesWithPayment` (`settle.ts:318`) requires the receipt's own logs to contain a
  fee-proxy event that matches. Bound pre-dispatch is not the same as observed post-dispatch,
  and a forwarder that does not bubble an inner revert returns success regardless.
- `refusalForLostRace` (`settle.ts:252`) recognises a lost race by its *signature* rather than
  by where it happened, so one wrapper covers all five read-then-act sites including ones not
  written yet. Anything unrecognised is rethrown, so a real bug still surfaces as a real bug.

## The store: `src/store.ts`

Six tables in one SQLite file, `node:sqlite`, no dependencies. Schema at `store.ts:86-172`.

### The invariants

**`markSent` is a compare-and-set** (`store.ts:924`):

```sql
UPDATE attempts SET first_send_at = ? WHERE id = ? AND first_send_at IS NULL
```

and the caller checks `changes === 1`. The previous form was
`SET first_send_at = COALESCE(first_send_at, ?)`, which kept the right value and *always*
reported success, so it decided nothing. The real gate was a read followed by a write in a
separate statement: both callers read null, both passed, and what stopped the second send was
that Node runs the read and the write with no `await` between them while SQLite serialises
writers. An accident of the runtime, not a property of the schema. A red-team probe
(`hackathon/audit/probes/p1-race.ts`) drove both callers past it. Putting the condition in the
`WHERE` clause means losing the race is writing nothing and being told so
(`settle.ts:724`).

**Transactional outbox.** `openAttempt` (`store.ts:853`) writes the attempt row and its
`DISPATCH_STEP` job in one transaction, and marks the superseded `OBSERVE_PREFLIGHT` job done
in the same one, so the hand-off cannot be interrupted. Returning from it means the intent to
send is durable. `beginPreflight` (`store.ts:595`) applies the same discipline one step
earlier: it enters `PAYMENT_PREFLIGHT` and commits the `OBSERVE_PREFLIGHT` job together, which
is what closed the window where a crash inside `simulate` left an obligation in a
non-replannable state with no attempt, no job, and no way forward. `recordOutcome`
(`store.ts:955`) enqueues `OBSERVE_EXECUTION` beside the write that records the send, rather
than leaving it to call sites: leaving it to callers is what stranded real payments at
`CHAIN_PENDING` with an empty outbox in two of the crash checkpoints.

**Fencing generations.** `claimJobs` (`store.ts:1010`) bumps `fencing_generation` when it
leases a job. A worker that loses its lease holds a stale generation, and
`#assertFencingInTx` (`store.ts:1054`) rejects its writes *inside the same
`BEGIN IMMEDIATE`* as the write itself, because `assertFencing` followed by a write is two
statements and therefore a race. This was not always true of the domain writes: `setState`,
`enqueue` and `recordOutcome` originally carried no generation at all, so an expired worker
could rewrite an obligation's state and an attempt's evidence while another worker owned the
job (`hackathon/audit/probes/p2-fencing.ts`). The `Fence` parameter is optional on every method
that takes it, because the settle path holds no job lease and is correct without one. Fencing
protects local state; it cannot cancel an HTTP request already in flight. That is what the
immutable attempt row and the provider idempotency key are for.

**The partial UNIQUE index on `payment_reference`** (`store.ts:217`):

```sql
CREATE UNIQUE INDEX obligations_reference ON obligations (payment_reference)
  WHERE payment_reference IS NOT NULL
```

It is partial because the column was added long after the first live database existed, so
older rows can be NULL and a plain UNIQUE index would refuse to build. It is created in
`migrate()` rather than in `SCHEMA` because `CREATE TABLE IF NOT EXISTS` is not a migration: it
is a no-op on a table that already exists, whatever columns that table has, and on the first
live database this column and this index were therefore never created at all. If the index
cannot be built because rows already violate it, the error raised names the duplicate
references, because that condition is the exact thing this project exists to prevent and it
should not surface as a SQL error.

Alongside it: `obligations_identity` on `(namespace, request_id)` (`store.ts:103`), stated
twice on purpose (the PRIMARY KEY already enforces it), and `attempts_step` on
`(plan_hash, step_index)` (`store.ts:143`), which is what makes a retry reuse the row and
therefore the same idempotency key.

**Hash-chained audit.** Every row commits to the one before it (`store.ts:372`):
`row_hash = auditHash(prev_hash, obligationId, actor, action, detailJson, at)`.
`verifyAuditChain` (`store.ts:431`) walks it and reports the first row whose hash does not
follow, distinguishing "a row is missing or was reordered" from "a row's contents were edited".
The comment in the schema is careful about what this buys: it is not tamper-*proof*, since the
same administrator can recompute the whole chain. It turns silent edits into loud ones, which
is the difference between "trust me" and "check it".

## Execution: one interface, two transports

`ExecutionProvider` (`src/provider.ts:91`) is four methods: `simulate`, `execute`, `observe`,
`receipt`. `settle.ts` knows nothing else about how a payment is sent.

| | REST | MCP |
|---|---|---|
| File | `src/keeperhub.ts` (257 lines) | `src/keeperhub-mcp.ts` (331 lines) |
| Surface | `POST /api/execute/contract-call` | `execute_contract_call` / `get_direct_execution_status` at `app.keeperhub.com/mcp` |
| Selected by | default | `KEEPERHUB_TRANSPORT=mcp` |

The argument for the interface is the argument for the product: a guarded signer whose safety
depends on which transport it happens to be using is not a guarded signer. Swapping the whole
execution surface without touching `settle()`, the policy, the refusal table or the calldata
gate is the demonstration of that.

What both transports share, and must:

- **`src/calldata-gate.ts`, literally the same module.** `decodeAllowedCall`
  (`calldata-gate.ts:76`) binds three things, not two: the selector, the decoded arguments, and
  the **target**. An earlier version checked only the calldata, which left byte-perfect
  allowlisted payment calldata pointed at an attacker's contract passing cleanly, since both
  providers forwarded `step.to` straight through. Callers are handed back the target this
  module approved. The allowlist (`calldata-gate.ts:31-41`) is two entries:
  `transferFromWithReferenceAndFee` bound to the ERC20FeeProxy, and `approve` bound to the FAU
  token. `mint` is deliberately absent.
- **`idempotencyVerdict`** (`keeperhub.ts:73`), exported specifically so the MCP transport
  reaches the same verdict from a differently-shaped reply. Two things arrive as HTTP 409 and
  they mean opposite things: `idempotency_in_progress` is retryable (the platform is still
  working on *this* key, and asking again is asking about the same request), while
  `idempotency_conflict` is the same key with a *different body*, an integrity incident where
  rotating the key is exactly how the second payment happens. Collapsing both into conflict
  made the recoverable one terminal. A guard that exists on one transport and not the other is
  not a guard, it is a coin flip over which surface the settlement happened to use.
- **`readReceipt` from `src/chain.ts`, never the provider.** A provider reporting on its own
  success is not evidence of anything.
- **Unknown means unsafe on simulate.** Both transports return a `SimulateOutcome` from one
  shared `classifySimulateReply` (`provider.ts`), and the caller switches on it exhaustively with
  a `never` assertion, so a fifth outcome is a compile error rather than a payment. The four arms
  are `EXECUTED` (a hash came back — #1959, an integrity incident), `WOULD_REVERT`, `WOULD_SUCCEED`
  and `UNKNOWN`; a timeout, a 4xx, an HTML error page, `{"success": false}` and a body with no
  verdict all land in `UNKNOWN`. This paragraph used to describe a boolean expression
  (`wouldRevert = ... || ... || ...`) that no longer exists anywhere: the union replaced it after
  four duplicate-payment findings whose common shape was a caller reading a flag that could mean
  "I do not know" as though it meant "no".
- **Unrecognised statuses map to `pending`, never `completed`** (`keeperhub.ts:236`,
  `keeperhub-mcp.ts:315`), so a response shape this code has not seen cannot be mistaken for a
  finished payment.

Where they genuinely differ is the transport's own hazards, all documented in
`keeperhub-mcp.ts:14-25`: the handshake is sequential (`tools/list` before
`notifications/initialized` fails `-32003`), an authentication failure returns HTTP 200 with no
`mcp-session-id` header rather than a 401, the session id rotates and the latest response's
header wins, and `simulate` is compared with `=== true` so the string `"true"` signs and
broadcasts.

The awkward fact both transports exist to manage: **KeeperHub will not accept finished
calldata.** Every write route rejects `data`/`callData` and there is no raw-transaction route.
The only write surface is `(contractAddress, functionName, functionArgs)`, which KeeperHub
re-encodes with an ABI it resolves on its own side. So a decode/re-encode step sits between the
bytes a human approved and the bytes a signer signs, and it is performed by the platform. The
providers refuse to be where that goes wrong: they decode the approved calldata, re-encode it
locally (`src/abi.ts:181`, `decodeAndVerify`), and require byte identity before sending. What
they cannot verify is KeeperHub's own re-encoding, because the request that would prove it is
the one that spends the money. That is exactly why `receipt()` reads the chain.
`npm run verify:seam` is the standalone proof of the same claim.

## Reconciliation: `src/chain.ts` (480 lines) and `src/worker.ts` (389 lines)

Settlement is decided by two independent chain reads that must agree, plus a depth gate.

**The receipt.** `readReceipt` (`chain.ts:429`) reads more than `{status, gasUsed}`: the
transaction's own target, its own logs, and how far behind head its block is. Three outcomes,
not two: only `0x0` means the chain said no, and a missing or malformed status means this read
did not answer, because `EXECUTION_REVERTED` is terminal and a transport hiccup must not reach
it. Depth unknown is left `undefined` rather than treated as zero, so a caller can tell the
difference. And there is RPC fallback (`chain.ts:21-30`), because publicnode answers
`eth_getTransactionReceipt` with `result: null` for transactions it still returns in full from
`eth_getTransactionByHash`, which reads downstream exactly like "this payment never landed".

**The fee-proxy event.** `findPaymentByReference` (`chain.ts:257`) runs the same
`eth_getLogs` query Request's own detection uses. Two traps: `paymentReference` is an *indexed*
bytes parameter, so the topic is the keccak hash of the reference bytes rather than the bytes
themselves (`chain.ts:38`, `referenceTopic` at `chain.ts:87`), and getting it wrong returns
zero logs and looks exactly like "not paid yet"; and public endpoints cap ranges, so
`MAX_RANGE` is 45,000 blocks (`chain.ts:245`) and a scan that runs out reports `truncated`
rather than "not found".

**`matchPaymentLog` (`chain.ts:192`) is the invariant.** A log counts as paying *this*
obligation only when the **emitter** is the ERC20FeeProxy, and the **token**, **`to`**,
**amount**, **fee amount** and **fee address** all agree. The reference alone is not enough and
never was: the reference is derived from data anchored openly on Sepolia, so anyone can read
one and emit a fee-proxy event carrying it. Reconciling on the reference means accepting that
event as proof. `decodePaymentLogFields` (`chain.ts:226`) reads the five non-indexed words, and
the comment there earns its place: an indexed dynamic parameter is *removed* from `data` rather
than replaced by an offset placeholder, so `amount` is word 2, not word 3.

**The depth gate.** `REQKEEPER_MIN_CONFIRMATIONS`, default 2, read at call time from ONE
definition — `minConfirmations()` in `provider.ts`, which both the settle path and the worker
import — so two places cannot decide depth differently. They once could: this sentence claimed
the property while `settle.ts` read the variable at module scope and the worker read it per call,
so raising the depth changed one of them and not the other. Below it the
obligation goes to `RECONCILIATION_PENDING` with a queued job, not to a refusal: the payment is
almost certainly real, it is just not yet provable. A receipt one block deep can still be
reorged away.

**`src/worker.ts` is the thing that drains the outbox, and it can only look.** No provider
write path at all, which is what makes it safe to run on a timer: the worst a bug in it can do
is fail to advance a state, never pay twice. Four job kinds:

| Job | Line | Question it answers |
|---|---|---|
| `OBSERVE_PREFLIGHT` | 191 | Did a simulation that never came back actually execute? |
| `DISPATCH_STEP` | 238 | The attempt was sent and no outcome was ever written. Did the money move? |
| `OBSERVE_EXECUTION` | 269 | What does the receipt say? |
| `RECONCILE_SOURCE` | 331 | Does Request's evidence agree, about *this* transaction? |

`RECONCILE_SOURCE` re-reads the chain rather than trusting the earlier pass, because between
the send and this job the transaction can have been reorged out or found reverted, and a source
saying "paid" against a receipt saying "reverted" must never produce `SETTLED`. Every job that
cannot conclude defers with a *reason* (`SCAN_TRUNCATED`, `RECEIPT_NOT_FINAL`,
`SOURCE_NOT_INDEXED`, `AWAITING_CONFIRMATIONS`) rather than failing, and a terminal obligation
completes its job rather than deferring forever.

The operator entry point is `scripts/resolve.ts` (`npm run resolve`), which wires
`drainUntilQuiet` (`worker.ts:375`) to a public RPC and a store path. It passes
`lookaheadMs: 60_000` deliberately: run by hand, this is an operator asking, not a timer
polling, so it looks past the retry backoff rather than reporting "nothing moved" for work
scheduled a moment out.

## Policy, and where it actually applies

`src/policy.ts:90` (`checkPolicy`) is the gate; `src/plan.ts:86` (`buildPolicy`) constructs
what it checks against; `src/standing-policy.ts:61` (`loadStandingPolicy`) reads the operator's
ceilings from the environment first and then `policy.json`.

Two things are easy to get wrong here and were:

- **A policy's decimals must not come from the same place as the facts' decimals**, or
  `TOKEN_DECIMALS_MISMATCH` compares a value to itself. Policy decimals come from the
  operator's table (`plan.ts:77`), facts from the invoice. An unknown token gets 0, which no
  real token has, so it cannot quietly inherit 18 and settle at the wrong scale.
- **A ceiling is always the lower of the standing value and the caller's** (`plan.ts:87`). An
  agent may tighten its own limit and never raise it. Where no standing policy is set, the
  invoice's own value is used and `policySource` says so, so a bare clone still runs and nobody
  is told they are protected when they are not.

`scripts/settle-live.ts` does not use `buildPolicy`. It constructs a `Policy` inline from the
invoice it just read. So `policy.json` constrains the agent surface (`src/mcp.ts:476`), the
approval CLI (`scripts/approve.ts:61`) and the watcher (`src/watch.ts:261`), but not the live
settlement script. See `docs/RUNBOOK.md` step 6.

## Entry points

| | File | Can it move money? |
|---|---|---|
| Live settlement CLI | `scripts/settle-live.ts` | yes |
| Human approval CLI | `scripts/approve.ts` | no. It records a decision. |
| Invoice watcher | `scripts/watch-request.ts` → `src/watch.ts` | no. Runs with a provider that throws on every write. |
| Resolver | `scripts/resolve.ts` → `src/worker.ts` | no. Read-only by construction. |
| Local MCP server | `scripts/mcp-server.ts` → `src/mcp.ts` | yes, via `settle_obligation`, but it cannot approve |
| Hosted MCP | `api/mcp.ts` → `src/mcp-public.ts` | no. Imports no store and no provider; the payment tools are *absent*, not gated. |

`scripts/approve.ts` is the only thing in the repository that can authorise money to move, and
it is deliberately unreachable from the MCP server. It does not accept a plan hash: it
recomputes one from the invoice facts you type and compares that against the plan the agent
actually reserved. An approval flow that trusts the proposer's own summary is not an approval
flow, and that check is the reason the tool takes the invoice as arguments rather than an id.

## Where to start reading

- Settling one obligation end to end: `src/settle.ts`, sections 0 through 10, in order.
- Why a second run refuses: `settle.ts:413` (re-entry), then `store.ts:924` (`markSent`).
- What "settled" means: `settle.ts:809-885`, then `chain.ts:192` (`matchPaymentLog`).
- Why an uncertain outcome never retries: `settle.ts:603-680`, then `worker.ts:191-233`.
- What can never be dispatched: `src/calldata-gate.ts`, 126 lines, worth reading whole.
