# Audit status — what was fixed, what still breaks

Every row is the state on 2026-09-12, re-checked against the working tree rather than inherited
from the audit that raised it. FIXED rows name the evidence. The submission form asks "what
still breaks or is unfinished?" and the last section is the source for that answer.

Reproduce any probe with `node --experimental-strip-types hackathon/audit/probes/<probe>.ts`.

Gates: `npm test` 344 pass / 0 fail / 64 suites · `npm run typecheck` clean · `npm run build`
clean, and reproducible from a bare clone: the page is a function of the committed evidence and
reads no environment at all, so `git diff --exit-code web api/_gen` passes on a machine that has
never had a `.env` · `npm run gate-a` 10 ok / 0 failed / 2 blocked here, 9 ok / 0 failed / 3
blocked from a clone with no credentials (the blocked steps are the hosted REST convenience API,
which this project does not depend on; blocked is never counted as a pass).

Every fix below is mutation-checked: the fix reverted, the dangerous test confirmed red, the
control confirmed green, the fix restored. A test that passes both with and without the code it
tests is noted where it exists, because that is worth knowing.

---

## Closed

### The invoice is read from Request now (PROTOCOL 6a — was the largest gap)

Every guard sat downstream of facts the **caller** supplied — payee, amount, fee, and the
payment reference. Nothing re-derived it. Hand over a reference you control and the whole
machine protects the wrong debt perfectly, and the payee check does not save you because the
payee came from the same place.

`src/request.ts` reads the invoice from Request's own Sepolia gateway (no credential) and
re-derives `last8Bytes(keccak256(requestId + salt + paymentAddress))` over the UTF-8 text of
those concatenated hex strings, lowercased. Verified against four live invoices and, offline,
against every reference in `docs/live-invoices.json` — **41/41 reproduce**. Those recorded
references are therefore correct; the point is that they no longer have to be trusted.

`propose_payment` and `settle_obligation` refuse `REFERENCE_MISMATCH` and
`FACTS_DISAGREE_WITH_INVOICE` before any write. Against the live gateway: a real reference
proposes, `0xdeadbeefdeadbeef` is refused, and an attacker payee carrying the *correct*
reference is refused. It fails closed — an unreadable gateway is not permission to proceed on
the agent's word, or the check would be bypassable by breaking one HTTP request.

### A simulation that never came back (REDTEAM 3b — the last wedged checkpoint)

A process killed inside `simulate` left `PAYMENT_PREFLIGHT` with no attempt row and no job:
zero sends, and that invoice could never be paid again. The attempt row is what makes later
steps recoverable and it is not written until *after* the simulation, because an attempt means
intent to send.

Making `PAYMENT_PREFLIGHT` replannable would have been the wrong fix and a test now pins it
shut: a simulate can time out, and a timed-out dry run may have executed for real (#1959).
Instead `beginPreflight` commits an `OBSERVE_PREFLIGHT` job in the same transaction as the
state, before the risky call; the settle path cancels it the moment it gets past the simulation
under its own power; only a crash leaves it to be claimed. The worker then asks the chain — a
payment found means the dry run executed, which is `EVIDENCE_CONFLICT` and a human's problem;
no payment across a complete, untruncated window means nothing ran, so the reservation goes back
and the debt is payable again. **An inconclusive read rescues nothing.**

Crash matrix now, `p3-crash.ts`, total sends never above 1:

| checkpoint | before | after |
|---|---|---|
| `RECEIPT` | CHAIN_PENDING, **0 jobs** | SETTLED |
| `RECONCILE` | RECONCILING, **0 jobs** | SETTLED |
| `SIMULATE` | PAYMENT_PREFLIGHT, **0 jobs** | PAYMENT_PREFLIGHT, **1 job** — recovers wherever a chain reader is wired (see residuals) |
| `BEFORE_SEND` | EXECUTION_OUTCOME_UNKNOWN, 1 job | unchanged — this is the specified outcome, not a defect |

### Everything else

| Finding | Was | Now |
|---|---|---|
| REDTEAM 1a · race refusal | The loser got a raw `UNIQUE constraint failed: obligations.payment_reference` in 39 of 40 trials, with no audit row under the right code | All three read-then-write sites convert a lost race into `REFERENCE_ALREADY_CLAIMED` or `ALREADY_DISPATCHED`, and rethrow anything unrecognised so a real bug still looks like one |
| REDTEAM 1b · non-atomic test-and-set | Both racing callers passed the guard; only SQLite's writer serialisation stopped the second send | `markSent` is `UPDATE … WHERE first_send_at IS NULL` and reports whether it won |
| REDTEAM 1c · `database is locked` | 22–29 of 50 concurrent opens of a fresh file died in the constructor | `p7-store-open-race.ts` on the real constructor: retry disabled 12/50, 15/50, 10/50 · as shipped **0/50, 0/50, 0/50** |
| REDTEAM 2 · fencing | A worker 30 s past its lease could rewrite state and recorded evidence | `setState`, `enqueue`, `recordOutcome` take a fence checked inside the same transaction; the real worker losing its lease mid-flight advances nothing |
| REDTEAM 6a · overwritable evidence | `COALESCE(?, tx_hash)` was last-write-wins | Write-once |
| REDTEAM 6b / PROTOCOL 7a · `settle-live.ts` | The live-money script settled on a foreign hash | Binds transaction hash and amount |
| REDTEAM 6c · no `eth_chainId` | `grep -rn "eth_chainId" src/` returned nothing; a hash is only unique within a chain | `assertChainId`, memoised per endpoint, on every chain read. An unreachable endpoint is "could not read"; a **wrong-chain** endpoint is a refusal and propagates |
| REDTEAM 6c · malformed receipt status | `status === "0x1" ? success : reverted` made an unreadable receipt a *terminal* failed payment | Three-way split in both providers |
| REDTEAM 6c · receipt `to`/`logs` never read | Nothing post-dispatch checked the transaction touched the fee proxy. The real shape is a meta-transaction, and a forwarder that does not bubble an inner revert returns `0x1` regardless | The receipt's own fee-proxy log must pay this invoice — emitter, token, payee, amount, fee — or it is `EVIDENCE_CONFLICT` |
| REDTEAM 8 · decorative policy | With no standing policy, `buildPolicy` fell back to the caller's own ceilings: the agent was checked against the ceiling the agent supplied | `policy.json` ships. An attacker payee is now `PAYEE_NOT_ALLOWED` and 9 FAU against a 5 FAU operator cap is `LIMIT_EXCEEDED`, even when the invoice claims a 999 FAU ceiling |
| PROTOCOL 1b · calldata case | The reference was folded and `steps[].data` was not, so two spellings of one calldata gave two plan hashes and two idempotency keys | Folded for the hash only. The dispatched bytes are untouched, so the byte-identity gate is unaffected |
| PROTOCOL 2c · reference-only pre-check | A 1-wei transfer carrying a public reference blocked an invoice permanently | Full-field match via `matchPaymentLog` |
| PROTOCOL 4 · decimals | Both sides of `TOKEN_DECIMALS_MISMATCH` read `f.tokenDecimals ?? 18`, so it compared 18 to 18 and could not fire | Policy decimals come from the operator's table, facts from the invoice. A 6-decimal claim for FAU is refused, and an unknown token cannot inherit 18 |
| PROTOCOL 5 · no finality | A receipt one block deep settled exactly like one a hundred deep | `REQKEEPER_MIN_CONFIRMATIONS`, default 2, enforced on both the settle path and the worker. Insufficient depth is `RECONCILIATION_PENDING` with a job, not a refusal. Unknown depth is not treated as zero |
| KEEPERHUB F-2 · error body as clean simulation | HTTP 401, or 200 with `{"error":…}`, gave `wouldRevert: false` and the payment dispatched | Fails closed at both layers |
| KEEPERHUB F-3 · 4xx recorded as a send | A 401 with a JSON body resolved as `pending`, so `outcome: SENT` was written | Non-2xx throws, non-retryable. Covered by a status-disposition table |
| KEEPERHUB F-4 · dead MCP session | `-32003` was flagged retryable but nothing cleared `#session`, so every retry re-sent the dead id | The session is dropped on `-32003`, so the next call re-handshakes |
| KEEPERHUB F-5 · receipt bypassed the fallback | Fixed in the REST provider only; the **MCP transport kept its own private `fetch`** and had none of it | One shared `readReceipt` in `chain.ts` for both transports. This was the fourth private copy; there are none left |
| KEEPERHUB F-6 · stuck reservation | A non-retryable preflight error left the reservation on a plan that never ran | State moves before the release |
| KEEPERHUB F-7 · `"unknown"` execution id | A placeholder string was persisted where an identifier belongs, and would have been sent as a path segment | `null`. An absent id is absent |
| KEEPERHUB F-8 · 409 conflation | `idempotency_in_progress` (retryable — the same request) and `idempotency_conflict` (an incident) both became the latter | Distinguished. Rotating the key on a conflict is how the second payment happens, and it stays non-retryable |
| KEEPERHUB F-9 · no disposition tests | Provider HTTP-status behaviour was untested | A table over 401, 400, 200-with-error, 429, both 409s, 5xx and a missing execution id |
| — · `verify:*` could spend | `verify:mcp` called the live platform on a route documented as possibly-executing; `verify:seam` called `provider.execute()` and relied on the gate throwing | `probe:mcp`, live check opt-in; `verify:seam`'s gate section points at an unroutable address. No `verify:*` command can move money |
| — · repo hygiene | `docs/demo-transcript.txt` was committed | It is generated by `scripts/demo.ts`; now ignored. `npm run demo:video` still works, because it writes the file before reading it |
| BASELINE 1a · unreproducible deployment | The deployed console matched no commit and advertised 192 tests | Deployed content is identical to `web/index.html` at HEAD once line endings are normalised |
| BASELINE 7.2–7.4 · console | "receipts 38/38" and "references 38/38" were one field twice; fixture placeholders linked to Etherscan; no viewport | Three distinct computations, explorer links only on recorded rows, doctype/lang/viewport/favicon/OG |

---

## What still breaks — the candid list

Nothing here is a duplicate-payment path. Each was checked for that specifically.

1. **The `SIMULATE` crash recovers only where a chain reader is wired.** The recovery needs the
   `sightPayment` dependency, which `scripts/resolve.ts` and the MCP `resolve_pending` both
   supply. `p3-crash.ts` uses a fixture with no chain behind it, so its `SIMULATE` row still
   shows `PAYMENT_PREFLIGHT` — correctly: without something that can look, concluding "nothing
   ran" would be the exact assumption this system refuses. It is money-safe either way (zero
   sends), and `test/preflight-crash.test.ts` proves both outcomes with a reader wired.

2. **Confirmation depth changes live timing, and the recorded evidence predates it.** With the
   default of 2, a live settlement will now usually return `RECONCILIATION_PENDING` on the
   first pass and finish on a `resolve` drain about a block later. The 38 recorded settlements
   in `docs/refusals-live.json` were made before this gate existed and settled at whatever depth
   they happened to have. They are still real payments with real receipts; they are not evidence
   that the depth gate works, and nothing here claims they are.

3. **`verifyAgainstRequest: false` exists.** It is the documented offline path and the tests use
   it, which means the Request verification is skippable by a caller who controls the context
   object. That is a deliberate seam for offline work, not a hole an agent can reach — an MCP
   client cannot set it — but it is a seam, and it should be tagged TEST in any evidence.

4. **`payeeOfRecord !== payee` is recorded, not refused.** Request lets an invoice's creditor
   differ from its payment address. The payment address is what is paid and what the reference
   derives from, which is correct, but an invoice where the two differ is something a human
   should see before settlement, and right now it is only written down.

5. **Reorg after settlement is still not watched.** Depth is checked before `SETTLED`; nothing
   re-checks afterwards. The honest claim remains "confirmed by an independently read receipt
   plus the fee-proxy event for the same transaction and the same amount, at a stated depth" —
   never "final" or "irreversible".

6. **The scripts still read `docs/live-invoices.json` for the salt.** The *runtime* derives the
   reference from the gateway now, but `scripts/live-harness.ts` and friends still start from
   that file. A corrupted file would be caught by the runtime check rather than silently
   obeyed — which is the whole point — but the scripts have not been rewritten to fetch first.

7. **The global payment-reference index has no namespace predicate.** Deliberate, and recorded
   so nobody re-raises it: for a single-operator deployment one Request reference is one debt
   however it was imported, and narrowing the index would reopen the double-pay door it was
   added to shut. It becomes wrong the day `namespace` becomes a caller-supplied argument.

8. **CLOSED for the MCP rows, still open for the REST ones.** `docs/evidence/mcp-settlements.json` carries a `keeperhubExecutionId` on all three of its rows. The original finding stands for `docs/refusals-live.json`: `docs/refusals-live.json`
   has `tx_hash` and `payment_reference` on all 38 settled rows but no `keeperhub_execution_id`,
   which `CLAUDE.md` specifies for LIVE rows. The console's proof strip therefore shows `—` at
   the KeeperHub step and says why, rather than borrowing the fixture race's id. Closing it means
   re-running `npm run harness:live` with credentials against fresh invoices — real money on
   Sepolia — so it is recorded rather than faked.

9. **The recorded run under-counts this system's payments.** Building the live race needed a
   provably-unpaid invoice, so all three invoices absent from `docs/refusals-live.json` were
   checked against the chain rather than against the file. Two of them are paid: references
   `0xfaac1220a314c4a9` and `0xd2a39f9e7e8e6a7b`, transactions `0x8ad0ce96…` and `0x08af9292…`,
   at blocks 11,665,974 and 11,665,976 — both genuine KeeperHub executions through the same
   forwarder, both immediately BEFORE the recorded run's first block (11,665,983). So at least
   40 payments have gone through KeeperHub; the artifact captures the 38 of one harness run.
   Everything the console says about "the recorded run" is true of that run. Nothing claims a
   lifetime total, and this is why it should not. Found by the project's own verification
   disagreeing with the project's own evidence file, which is the behaviour that was wanted.

10. **The first live race shipped with meaningless totals, and the fix is visible.** It reported
    the FIXTURE's counters, which are zero live because nothing reaches the fixture — so a
    correct run (one payment, two workers refused `REFERENCE_ALREADY_CLAIMED`, second wave zero)
    was described by numbers that meant nothing and the gate failed on its own bookkeeping. The
    obvious repair — run it again — was not available: the invoice was now paid, and paying a
    second one to fix a reporting bug is the exact thing this project exists to prevent. So
    `npm run race -- --live --recount` recomputes the totals from the chain, preserves the worker
    lines verbatim, and records in the artifact that it happened and why. `verify:all` then counts
    the payment from the chain independently rather than believing the artifact.

11. **Not built, and out of scope for this pass:** `scripts/mcp-e2e.ts` (piping JSON-RPC through the
   stdio server as a test rather than by hand), and a live `--live` mode for the race. The race,
   the crash matrix, `verify:all` and a generated `docs/TRUTH.md` all now exist and run.

---

## What could not be broken

Across 40 racing process pairs, 6 real mid-flight process kills and every retry path reachable
from the settle API, `provider.execute()` was never called twice for one obligation and no retry
path ever re-broadcast. `EXECUTION_OUTCOME_UNKNOWN` never decayed into a fresh payment, the
reservation never came back after a dispatch, every illegal transition was refused, case-variant
references never minted a second debt, and no free-text field reaches a decision — there is no
`memo`, `description` or note anywhere in `InvoiceFacts`.
