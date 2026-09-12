# REDTEAM — adversarial review of "one obligation, one payment, no retry pays twice"

Scope: `src/store.ts`, `src/machine.ts`, `src/settle.ts`, `src/worker.ts`, plus the two
reconcilers that exist in this repo (`src/mcp.ts`, `scripts/resolve.ts`, `scripts/settle-live.ts`).
Method: read the code, then try to break it with runnable probes. Nothing in `src/`, `api/`,
`scripts/`, `web/` or `test/` was modified by this audit. No payment was broadcast. Probes live in
`hackathon/audit/probes/` and are run with `node --experimental-strip-types`.

**Note on a moving target.** Another session was editing this repo while the audit ran.
`scripts/settle-live.ts`, `src/keeperhub.ts` and `src/mcp.ts` changed under me; one of those changes
fixes BREAK-1. Every finding below has been re-checked against the working tree as it stood at the
end, and each one says whether it is still live. `src/store.ts`, `src/settle.ts`, `src/worker.ts` and
`src/machine.ts` were untouched throughout, so findings 1a-1c, 2, 3, 3b, 4, 4b, 5, 6a, 7 and 8 all
stand against current code.

**Headline.** The money invariant survived every attack I could build: across 40 two-process
races and 6 real mid-flight process kills, `provider.execute()` was never called twice for one
obligation, and no retry path ever re-broadcast. Two things broke anyway:

* **BREAK-1 (evidence) — FIXED IN THE WORKING TREE WHILE THIS AUDIT WAS RUNNING.**
  `scripts/settle-live.ts:147` — the reconciler on the live money path — ignored both of its
  arguments. Combined with BREAK-2 it lands `SETTLED` on a transaction nobody checked belonged to
  this invoice. Reproduced against the committed code; the uncommitted tree now binds the hash and
  the amount. See section 6 for the before/after.
* **BREAK-2 (integrity).** `Store.recordOutcome` has no fencing and no compare-and-set, and
  `COALESCE(?, tx_hash)` means **last write wins**. A worker whose lease expired 30 seconds ago can
  replace the recorded transaction hash and execution id of a payment that already happened. Reproduced.

And one class of defect that costs money in the other direction: **four of six crash points, and any
single 429 on preflight, leave the obligation permanently unpayable** — no duplicate, but no
convergence either, and in two cases a real payment is left with an empty outbox.

---

## Verdict matrix

| # | Attack | Verdict | Evidence |
|---|---|---|---|
| 1 | Two concurrent proposers | **HOLDS** (money) / **BREAKS** (refusal surface) | `p1-race.ts` |
| 1b | `getAttempt` then `markSent` test-and-set atomicity | **BREAKS** (non-atomic; saved by serialisation, not by design) | `p1-race.ts` Part A |
| 1c | Two processes opening one database | **BREAKS** (~50% of concurrent opens on a fresh db throw `database is locked`) | `p6-open-race.ts` |
| 2 | Expired lease, fencing on the write path | **PARTIAL BREAK** — job rows fenced, domain writes not | `p2-fencing.ts` |
| 3 | Crash points: duplicate send | **HOLDS** — 0 duplicates at 6/6 points | `p3-crash.ts` |
| 3b | Crash points: convergence | **BREAKS** — 4/6 wedge; 2 of those with money moved and 0 jobs | `p3-crash.ts` |
| 4 | Unknown outcome releases the claim / re-broadcasts | **HOLDS** | `p4-claim-and-scope.ts` |
| 4b | `releaseObligation` return value ignored at 3 call sites | **BREAKS** (liveness) | `p4-claim-and-scope.ts` |
| 5 | Replay scope / cross-namespace collision | **WEAK, latent** | `p4-claim-and-scope.ts` |
| 6a | Recorded tx hash is overwritable | **BREAKS** — still live | `p5-evidence.ts` |
| 6b | Reconciler accepts a foreign transaction | **BROKE** on `settle-live.ts`; fixed mid-audit; **HOLDS** elsewhere | `p5-evidence.ts` |
| 7 | Decision on an in-memory flag | **HOLDS** | grep, below |
| 8 | Prompt injection / memo into SQL, shell, or a decision | **HOLDS** (no such field exists) | grep, below |

---

## 1. Two concurrent proposers for the same obligation — HOLDS on money

Forty trials, two OS processes, one SQLite file, barrier-synchronised to the same millisecond,
each running the full `settleObligation` with an instrumented provider that counts `execute()` calls.

```
PART B two-process race, trials = 40
  x11  SETTLED|NO_JSON|execs=1
  x8  SETTLED|THREW(UNIQUE constraint failed: obligations.payment_reference)|execs=1
  x7  THREW(UNIQUE constraint failed: obligations.payment_reference)|SETTLED|execs=1
  x4  NO_JSON|SETTLED|execs=1
  x3  SETTLED|THREW(cannot propose a new plan from SETTLED: this settlement is past the point of no return)|execs=1
  x2  SETTLED|THREW(illegal transition SETTLED -> AWAITING_APPROVAL)|execs=1
  x1  SETTLED|SETTLED|execs=1
  x1  THREW(cannot propose a new plan from SETTLED: this settlement is past the point of no return)|SETTLED|execs=1
  x1  SETTLED|THREW(cannot propose a new plan from PAYMENT_EXECUTING: this settlement is past the point of no return)|execs=1
  x1  THREW(illegal transition SETTLED -> APPROVED)|SETTLED|execs=1
  x1  THREW(illegal transition SETTLED -> AWAITING_APPROVAL)|SETTLED|execs=1
  trials where BOTH processes called provider.execute(): 0
```

`execs=1` in every trial. Exactly one proposer ever reached the provider. **HOLDS.**
The clean case looks like this (raw child output, trial 4 of a separate six-trial run):

```
A: {"state":"SETTLED","refusal":null,"executeCalls":1,"providerWriteIssued":true}
B: {"state":"SETTLED","refusal":"ALREADY_SETTLED","executeCalls":0,"providerWriteIssued":false}
```

That is the designed behaviour — step 0b's re-entry refusal. It happened in 1 trial in 40. The other
39 the loser died on an uncaught exception. Three sub-findings:

**1a. The loser does not get the designed refusal.** `settleObligation` checks
`obligationForReference` at step 0 and `importObligation` inserts at step 0c, with no transaction
spanning them. Under a race the second process gets a raw
`UNIQUE constraint failed: obligations.payment_reference` thrown out of `settleObligation` instead of
the `REFERENCE_ALREADY_CLAIMED` / `OBLIGATION_RESERVED` refusal, and no `REFUSED` audit row is written
for the correct code. On the MCP surface this is caught in-band (`src/mcp.ts:388-398`) and returned as
`refused: UNIQUE constraint failed: ...`, so it is not a crash — it is a misleading refusal and a hole
in the audit trail. `scripts/watch-request.ts` has no such catch. **Fails closed.**

The same race also produces `cannot propose a new plan from SETTLED` (out of `store.replan`, step 1)
and `illegal transition SETTLED -> AWAITING_APPROVAL` (out of `store.setState`, step 4) when the
winner finishes between the loser's step-0b read and its later write. All three are the same shape:
`settleObligation` reads state, then acts on it in a separate statement. All three fail closed.

**1b. The load-bearing guard is a non-atomic test-and-set.** `src/settle.ts` section 8 reads
`store.getAttempt(attemptId).firstSendAt`, then separately calls `store.markSent()`. Two statements,
no transaction:

```
PART A store-level test-and-set
  A read firstSendAt = null -> A would send: true
  B read firstSendAt = null -> B would send: true
  both callers passed the guard: true
  first_send_at after both: 100 (COALESCE keeps the first)
```

Both callers pass the guard the module comment calls "the load-bearing guard ... local durable state,
not the provider's cache, is what makes this exactly-once." What actually stops the second send in
practice is that Node runs `openAttempt` then `getAttempt` then `markSent` synchronously (no `await`
between them) and SQLite serialises writers — so process B's read lands after A's write. That is an
accident of the runtime, not a property of the schema. Insert any `await` between the read and
`markSent`, or move to a store without single-writer serialisation, and the guard is gone.
Fix: fold the read and the stamp into one `UPDATE attempts SET first_send_at = ? WHERE id = ? AND
first_send_at IS NULL` and send only if `changes === 1`.

**1c. Two processes opening the same database concurrently crash about half the time.**
15 of 80 racing children in the run above produced no JSON at all. Raw output:

```
A: file:///D:/project/reqkeeper/src/store.ts:227
       this.#db.exec(SCHEMA);
              ^
   Error: database is locked
       at new Store (file:///D:/project/reqkeeper/src/store.ts:227:14)
B: {"state":"SETTLED","refusal":null,"executeCalls":1,"providerWriteIssued":true}
```

Isolated in `p6-open-race.ts`, 25 trials x 2 processes, three consecutive runs:

```
fresh db, as shipped               concurrent opens that failed: 29/50, 23/50, 22/50
fresh db, busy_timeout first       concurrent opens that failed: 15/50, 13/50, 16/50
EXISTING db, as shipped            concurrent opens that failed:  3/50,  4/50,  4/50
```

`PRAGMA busy_timeout = 5000` is set inside `SCHEMA` itself and carries the comment "Without this a
second process contending for the same database fails instantly with SQLITE_BUSY. Two processes
settling is the exact scenario this project is about." It does not cover the window that opens the
database. **Cause: UNPROVEN.** The obvious hypothesis — that `PRAGMA journal_mode = WAL` runs before
`busy_timeout` is armed — is wrong on its own: moving `busy_timeout` first roughly halves the failure
rate but does not remove it, and the failure persists at ~7% against an already-created database. What
is proven is the symptom and its blast radius: a `settle` and a `resolve` started together, or two
`resolve` runs, will sometimes die on `new Store(path)`. It fails closed — the crash is before any
work — but it is the exact contention the comment claims to have handled. A retry loop around the
constructor would cover it; identifying why `busy_timeout` does not needs a node:sqlite-level trace.

## 2. Expired lease — fencing is enforced on the job row, not on the domain writes — PARTIAL BREAK

Worker 1 claims a job (generation 1) and stalls. The lease expires, the real `drainOnce` re-claims
(generation 2) and completes the recovery. Worker 1 then wakes up and performs exactly the writes
`resolveJob` performs, holding its stale generation:

```
worker1 claimed job 1 generation 1
after worker2: state = CHAIN_PENDING outcome = SENT txHash = 0x11111111

-- worker1 (stale generation 1) now attempts its writes --
  completeJob REJECTED: stale fencing generation for job 1: held 1
  deferJob REJECTED: stale fencing generation for job 1: held 1
  writes that LANDED despite the stale fence: recordOutcome, enqueue, setState
  attempt.outcome: SENT -> CLOBBERED_BY_ZOMBIE
  attempt.txHash : 0x99999999 <- worker2 recorded 0x11111111
  state          : CHAIN_PENDING -> EXECUTION_OUTCOME_UNKNOWN
```

`completeJob` and `deferJob` do put the generation in the `WHERE` clause — that half of the claim in
the `store.ts` comment is true and I could not break it. But `recordOutcome`, `setState` and `enqueue`
carry no generation at all, and `drainOnce` swallows the eventual `STALE_FENCE` with `continue`
(`src/worker.ts:83`) *after* those writes have already landed. So a zombie worker cannot finish a job
it no longer owns, but it can rewrite the obligation's state and the attempt's recorded evidence.

The blast radius is limited by the transition table (`setState` refuses illegal moves, which is why a
zombie cannot drag a `SETTLED` row backwards) and by the worker having no `execute` path — so this is
not a route to a second payment. It is a route to corrupted evidence, which is BREAK-2 below.

## 3. Crash points — no duplicate send anywhere, but four of six wedge

Real `process.exit(9)` inside a child process at each point. The "chain" is a sidecar file the crash
cannot erase, so a send that happened stays happened. After the crash the parent reopens the database,
runs the real worker (`drainUntilQuiet`, the same code `scripts/resolve.ts` runs), and then re-runs
`settleObligation` the way an agent would — with a provider that throws `SECOND_SEND_ATTEMPTED` if
anything tries to send again.

```
crash point  child said                                    sends  after worker               jobs  agent retry                                   final                      total sends
-----------  --------------------------------------------  -----  -------------------------  ----  --------------------------------------------  -------------------------  -----------
NONE         {"state":"SETTLED","refusal":null,"sends":1}  1      SETTLED                    0     SETTLED/ALREADY_SETTLED                       SETTLED                    1
SIMULATE     CRASH@SIMULATE                                0      PAYMENT_PREFLIGHT          0     PAYMENT_PREFLIGHT/ALREADY_DISPATCHED          PAYMENT_PREFLIGHT          0
BEFORE_SEND  CRASH@BEFORE_SEND                             0      EXECUTION_OUTCOME_UNKNOWN  1     EXECUTION_OUTCOME_UNKNOWN/ALREADY_DISPATCHED  EXECUTION_OUTCOME_UNKNOWN  0
AFTER_SEND   CRASH@AFTER_SEND                              1      SETTLED                    0     SETTLED/ALREADY_SETTLED                       SETTLED                    1
RECEIPT      CRASH@RECEIPT                                 1      CHAIN_PENDING              0     CHAIN_PENDING/ALREADY_DISPATCHED              CHAIN_PENDING              1
RECONCILE    CRASH@RECONCILE                               1      RECONCILING                0     RECONCILING/ALREADY_DISPATCHED                RECONCILING                1
```

`total sends` is never 2. **The duplicate-payment invariant HOLDS at every crash point**, including
the one the design is proudest of: `AFTER_SEND` (money moved, response lost) recovers all the way to
`SETTLED` through `findPaidReference` without re-sending. That is the hard case and it works.

Convergence is a different story:

* **`SIMULATE`** — crash after `setState(PAYMENT_PREFLIGHT)` and before the attempt row exists.
  Nothing was sent. But `PAYMENT_PREFLIGHT` is not in `REPLANNABLE` (`src/machine.ts:157-170`), so
  step 0b refuses re-entry with `ALREADY_DISPATCHED`, and there is no job. Zero sends, zero jobs, zero
  ways forward: the invoice is permanently unpayable by this system.
* **`BEFORE_SEND`** — attempt committed and `first_send_at` stamped, nothing sent. The worker does the
  honest thing (`EXECUTION_OUTCOME_UNKNOWN`, one job deferring on `NOT_SEEN_ON_CHAIN`) and will defer
  that job forever, because the payment it is waiting to see will never appear. Money safe, invoice dead.
* **`RECEIPT` and `RECONCILE`** — the bad ones. Money moved. The `DISPATCH_STEP` job completes the
  moment `attempt.outcome` is non-null (`src/worker.ts:126`), and **the settle success path never
  enqueues `OBSERVE_EXECUTION`** — the only `enqueue` calls on that path are in the
  `ALREADY_DISPATCHED` branch (`settle.ts:481`), the `execute` catch (`:521`) and
  `RECONCILIATION_PENDING` (`:571`). So after the crash the outbox is **empty** while the obligation
  sits at `CHAIN_PENDING` / `RECONCILING`, and `scripts/resolve.ts` only drains existing jobs — it
  never enqueues a recovery job. This is precisely the failure `src/worker.ts`'s own header says it
  exists to prevent: "the money moved and nothing closed the loop."

Same hole on a non-crash path: when the provider reports success with no hash
(`settle.ts` section 9, `NO_HASH`), `recordOutcome` has already written `outcome = "SENT"`, so the
dispatch job completes and nothing is enqueued:

```
  first pass      : EXECUTION_OUTCOME_UNKNOWN / NO_HASH  sends = 1
  after worker    : EXECUTION_OUTCOME_UNKNOWN  pending jobs = 0
```

Fix: enqueue `OBSERVE_EXECUTION` in the same transaction as `recordOutcome(... "SENT")`, not only on
the failure branches. One `enqueue` call closes all four wedges that involve a real payment.

## 4. Unknown outcome — the claim is never released, nothing re-broadcasts — HOLDS

```
  first pass      : EXECUTION_OUTCOME_UNKNOWN / NO_HASH  sends = 1
  reservation held: true
  retry           : EXECUTION_OUTCOME_UNKNOWN / ALREADY_DISPATCHED  sends = 1
  releaseObligation as holder after send: {"released":false,"reason":"already dispatched (EXECUTION_OUTCOME_UNKNOWN)"}
```

`releaseObligation` refuses on two independent grounds — `!canReplan(state)` and "this plan has a
dispatched attempt" (`store.ts:552-556`) — and step 0b refuses re-entry before any send logic is
reached. I could not find a path where a missing hash after a possible send reopens the door. **HOLDS.**

**4b. But `releaseObligation`'s return value is discarded at three call sites, and at all three the
call is made while the state is `PAYMENT_PREFLIGHT` — so the release silently fails.**
`settle.ts:434` (`wouldRevert`), `:441` (retryable preflight error) and `:456` (non-retryable) all call
`store.releaseObligation(...)` *before* the `setState` that would make the state replannable. A single
429 from the platform therefore does this:

```
  outcome         : PAYMENT_PREFLIGHT / rate_limited
  detail says     : "preflight unavailable: rate_limited. This is the platform being busy, not the pa"
  reservation now : STILL HELD
  release attempt : {"released":false,"reason":"already dispatched (PAYMENT_PREFLIGHT)"}
  'propose again later' actually gives: PAYMENT_PREFLIGHT / ALREADY_DISPATCHED
  simulate called again? false
```

The code's own comment says "A retryable failure leaves the obligation in `PAYMENT_PREFLIGHT`, which is
replannable, so proposing again later is the right move and is the move the agent is told to make."
`PAYMENT_PREFLIGHT` is **not** in `REPLANNABLE`. The agent is told to do something the system will
refuse forever. Nothing was sent, so no money is at risk — the invoice is simply lost.
Fix: move the `releaseObligation` calls after the `setState`, and stop discarding the result.

## 5. Replay scope — the reference index is global — WEAK, latent

```
  tenant A imports ref 0xdeadbeef -> {"created":true,"state":"IMPORTED"}
  tenant B imports same ref -> REFUSED: UNIQUE constraint failed: obligations.payment_reference
  tenant B can read A's obligation id via obligationForReference: {"obligationId":"d56735a0...","state":"IMPORTED"}
  0xDEADBEEF resolves to the same row: {"obligationId":"d56735a0...","state":"IMPORTED"}
```

`obligations_reference` is `UNIQUE (payment_reference) WHERE payment_reference IS NOT NULL` with no
namespace predicate, and `obligationForReference` (`store.ts:419-425`) has no namespace filter either.
Case folding works (`0xDEADBEEF` and `0xdeadbeef` are one debt) — that defence holds.

For a single-operator deployment global is the **right** choice: one Request payment reference is one
debt regardless of how it was imported, and narrowing the index to `(namespace, payment_reference)`
would re-open the double-pay door the index was added to shut. For a multi-tenant deployment it is
wrong in two ways: the first tenant to import a reference denies it to every other tenant forever, and
`settle.ts:196-215` returns the other tenant's obligation id prefix and state in the refusal — the
comment at `store.ts:518-519` says "never another workspace's invoice data", which is true of the
invoice but not of the identifier and state.

Not exploitable in this checkout: `namespace` is the module constant `NAMESPACE` at every entry point
(`src/plan.ts:14`) and is absent from the MCP invoice schema, so no caller can choose it. It becomes
live the moment namespace becomes an argument.

## 6. Evidence spoofing — 6a still live, 6b fixed mid-audit

Two independent weaknesses that compose.

**6a. The recorded transaction hash is overwritable.** `Store.recordOutcome` is
`UPDATE attempts SET outcome = ?, execution_id = COALESCE(?, execution_id), tx_hash = COALESCE(?, tx_hash)`.
`COALESCE(new, old)` returns `new` whenever `new` is non-null — so this is last-write-wins, not
write-once. (Contrast `markSent`, which correctly uses `COALESCE(first_send_at, ?)`.) There is no
fencing generation and no `WHERE tx_hash IS NULL`:

```
== (a) overwrite the recorded transaction hash ==
  before: 0x1111...1111
  after : 0xffff...ffff  executionId: exec-EVIL
  overwritten: true   (UPDATE ... tx_hash = COALESCE(?, tx_hash) -> new value wins)
```

Reachable by the zombie worker of attack 2 without any privileged access.

**6b. `scripts/settle-live.ts` reconciled on the wrong question. FIXED MID-AUDIT.** `SettleDeps.sourceSaysPaid` is
documented at `settle.ts:53-58`: "Must confirm THIS transaction paid THIS amount: a boolean over the
payment reference alone accepts a different transaction's evidence." The live script passes
`sourceSaysPaid: async () => (await proxySawPayment(startBlock)).found` (`scripts/settle-live.ts:147`)
— both parameters dropped. `proxySawPayment` computes `txHash` and `amount` on the lines immediately
above and the closure throws them away.

Driving the **real worker** with a foreign hash in the attempt row and each reconciler shape in turn:

```
== (b1) a reconciler that ignores its arguments (settle-live.ts:147 before the mid-audit fix) ==
  final state: SETTLED  evidence hash: 0xffff...ffff
  SETTLED on a transaction nobody checked belonged to this invoice: true

== (b2) a reconciler that binds hash + amount (mcp.ts, resolve.ts, and settle-live.ts now) ==
  final state: RECONCILIATION_PENDING <- refuses to settle on the foreign hash
```

`src/mcp.ts:288-297` and `scripts/resolve.ts:80-88` got it right and refused. The one script that
spends real money did not.

**Status at the end of this audit.** `scripts/settle-live.ts` was edited in the working tree while
these probes were running, and now reads:

```ts
sourceSaysPaid: async (_requestId: string, txHash: string) => {
  const seen = await proxySawPayment(startBlock);
  return (
    seen.found &&
    seen.txHash?.toLowerCase() === txHash.toLowerCase() &&
    seen.amount === AMOUNT
  );
},
```

That is the fix, and it closes BREAK-1. The finding is left in this report because it was real in
`HEAD` (`git show HEAD:scripts/settle-live.ts`), because the b1 reproduction above is what a
reconciler of that shape does to the real worker, and because BREAK-2 — the thing that makes a wrong
hash reachable in the first place — is untouched.

**6c. Adjacent weaknesses in the receipt reader** (`src/keeperhub.ts`), found by inspection, not
separately exploited. Re-checked against the working tree after it was edited mid-audit — the private
`fetch` there has been replaced by the shared `rpcCall`, which changes the transport but none of the
three points below:

* No `eth_chainId` check anywhere on the settle path — `grep -rn "eth_chainId" src/` returns
  nothing, still true of the current working tree. `rpcUrl` comes from `SEPOLIA_RPC`
  (`src/chain.ts:9`). A receipt from a different chain for a colliding hash is accepted as this
  chain's receipt. The chain-id assertions that do exist live only in `scripts/gate-a.ts`,
  `verify-live.ts` and `verify-onchain.ts`, which the settle path never calls.
* The receipt is still parsed as `{ status?, gasUsed? }`. `to` and `logs` are never read, so nothing
  post-dispatch checks that the transaction hit the fee proxy, paid the right payee, or moved the right
  amount. Those are bound pre-dispatch only (`settle.ts:104-115`).
* `r.status === "0x1" ? success : reverted` — strict, no truthiness bug, but a receipt with a missing
  or malformed status is reported as `verified: true, "reverted"`, which is terminal. A real payment
  can be permanently labelled reverted by a malformed RPC response. `scripts/resolve.ts:62-65` does
  the correct three-way split; the production provider still does not
  (`r.status === "0x1" ? success : reverted`, verified as of the current working tree).
* The uncommitted `src/chain.ts` fallback is first-wins, not agreement: `if (second !== null && second
  !== undefined) return second;` (`chain.ts:83`) and `if (second.found) return second;` (`:145`). A
  negative from the primary can become a positive from the fallback, there is no chain-id cross-check
  on `RPC_FALLBACKS`, and the `catch {}` at `:147` makes "the fallback errored" indistinguishable from
  "the fallback agreed". Both consumers that refuse-to-pay are safe with this; `sourceSaysPaid` is the
  one that is not.

## 7. Decisions on in-memory flags — HOLDS

```
$ grep -rn "^let |^var |^const [a-z].* = new Map|^const [a-z].* = new Set|globalThis\." src/*.ts
(no output)
```

No module-level mutable state in `src/` at all. Every guard I traced reads the database at the moment
it decides: the reference check, the reservation, `firstSendAt`, the prior approval, the prior state.
`FixtureProvider`'s counters are instance state in test code only. The one caveat is 1b — the reads
are durable but the read-then-write pair is not one transaction.

## 8. Prompt injection / malicious invoice fields — HOLDS

* **SQL:** every statement is a bound `prepare(...).run(...)`. The only interpolation is
  `store.ts:161`, a loop over the two hardcoded literals `prev_hash` and `row_hash`. `rawExecForTests`
  (`store.ts:247`) has zero callers outside `test/`.
* **Shell:** one `execFileSync` in `scripts/demo.ts:37` with a fixed argv. No `exec`, no `spawn` with
  a shell, no caller-controlled path.
* **Decisions:** there is no `memo`, `contentData`, `description` or free-text note anywhere in
  `InvoiceFacts` (`src/plan.ts:24-49`) or `SourceFacts`. Every field a decision reads is an address, a
  base-units string, a chain id or a boolean. Nothing free-text reaches a policy branch.
* **Model output:** no AI endpoint in the codebase; the idempotency key is `sha256` over persisted
  state only (`src/identity.ts:112-135`).

The only text field that flows anywhere untrusted is `requestId`, interpolated unquoted into a
copy-pasteable command string printed by `src/watch.ts:148-163`. It is printed, never executed — but
it is a shell-paste hazard for the operator.

**Separate finding, same area:** with no standing policy configured — and this checkout has none (no
`policy.json`, no `REQKEEPER_*` in `.env`) — `buildPolicy` falls back to the caller's own values for
`allowedPayees`, `allowedFeeRecipients`, `maxTotalDebitBaseUnits` and `maxFeeBaseUnits`
(`src/plan.ts:70-75`). The agent is then checked against the ceiling the agent supplied. The code
comment acknowledges this and `policySource` reports it, and the human approval gate still stands in
front — but as deployed, `POLICY_DENIED` is decorative. Ship a `policy.json`.

---

## What I could not break

* One obligation, one `execute()` — 40 racing process pairs, 6 real crashes, every retry path
  I could reach. Never two.
* `EXECUTION_OUTCOME_UNKNOWN` never decaying into a fresh payment.
* The reservation ever coming back after a dispatch.
* The transition table — every illegal move I threw at `setState` was refused, including the
  zombie-worker moves in attack 2.
* Case-variant payment references minting a second debt.
* SQL injection, shell injection, or any free-text field reaching a decision.

## Priority

1. ~~`scripts/settle-live.ts:147` — bind the reconciler to the hash and the amount.~~ **Already done
   in the working tree.** *(BREAK-1, closed)*
2. `Store.recordOutcome` — `WHERE tx_hash IS NULL` (or a fencing generation) so recorded evidence is
   write-once, matching `markSent`. *(BREAK-2)*
3. Enqueue `OBSERVE_EXECUTION` in the same transaction as `recordOutcome(... "SENT")` — closes four
   wedges, two of which strand a real payment with an empty outbox.
4. Move the three `releaseObligation` calls after their `setState`, and stop discarding the result;
   or add `PAYMENT_PREFLIGHT` to `REPLANNABLE` so the comment and the table agree.
5. Make section 8 one atomic `UPDATE ... WHERE first_send_at IS NULL`, so the guard is a property of
   the schema rather than of Node's scheduler.
6. Check `eth_chainId` once at provider construction.
7. Retry `new Store(path)` on `database is locked`, and give the loser of a reference race the
   designed `REFERENCE_ALREADY_CLAIMED` refusal instead of a raw SQLite string.

---

## Reproducing

```
node --experimental-strip-types hackathon/audit/probes/p1-race.ts 40
node --experimental-strip-types hackathon/audit/probes/p2-fencing.ts
node --experimental-strip-types hackathon/audit/probes/p3-crash.ts
node --experimental-strip-types hackathon/audit/probes/p4-claim-and-scope.ts
node --experimental-strip-types hackathon/audit/probes/p5-evidence.ts
node --experimental-strip-types hackathon/audit/probes/p6-open-race.ts
```

All five are read-only against `src/` and write only to a temp directory they delete on exit.
None makes a network call. `p1`, `p3` and `p6` spawn child processes (`p1-child.ts`,
`p3-crash-child.ts`, `p6-open-race-child.ts`).
