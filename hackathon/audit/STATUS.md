# Audit status — what was fixed, what still breaks

Every row is the state on 2026-09-12 after the hardening pass, re-checked against the working
tree rather than inherited from the audit that raised it. FIXED rows name the evidence that
says so. OPEN rows are open; the submission form asks "what still breaks or is unfinished?" and
this is the source for that answer.

Reproduce any probe with `node --experimental-strip-types hackathon/audit/probes/<probe>.ts`.

Gates at the time of writing: `npm test` 278 pass / 0 fail / 51 suites · `npm run typecheck`
clean · `npm run build` clean · `npm run gate-a` 10 ok / 0 failed / 2 blocked.

---

## Fixed, with the evidence

| Finding | Was | Now |
|---|---|---|
| REDTEAM 1b · `getAttempt` then `markSent` is a non-atomic test-and-set | Both racing callers passed the guard; only SQLite's writer serialisation stopped the second send | `markSent` is `UPDATE … WHERE first_send_at IS NULL` and returns whether it won. Mutation-checked: reverting it turns the two race tests red and leaves the old "stamped once" test green — which is the point, that test never tested the guard |
| REDTEAM 1c · `new Store(path)` dies on concurrent open | 22–29 of 50 concurrent opens of a fresh file failed with `database is locked` | `p7-store-open-race.ts`, real constructor, three runs: retry disabled 12/50, 15/50, 10/50 · as shipped **0/50, 0/50, 0/50** |
| REDTEAM 2 · fencing enforced on the job row, not the domain writes | A worker 30 s past its lease could rewrite state and recorded evidence | `setState`, `enqueue` and `recordOutcome` take a fence checked inside the same immediate transaction, and the worker passes its generation. `test/fencing.test.ts` proves the real worker, losing its lease mid-flight, advances nothing |
| REDTEAM 3b · crash convergence, the two cases where money moved | Crash in `receipt` or `sourceSaysPaid` left a real payment at CHAIN_PENDING / RECONCILING with **zero** pending jobs | `recordOutcome` enqueues `OBSERVE_EXECUTION` in the same transaction. `p3-crash.ts` now reaches SETTLED at both checkpoints, still at 1 send. Mutation-checked: removing the enqueue reproduces the original table exactly |
| REDTEAM 4b · `releaseObligation` return value discarded at three sites | A single 429 held the reservation forever and the agent was told to retry into `ALREADY_DISPATCHED` | New `PREFLIGHT_UNAVAILABLE` state, entered only when no attempt on the obligation has `first_send_at`. State moves before the release. `test/preflight-unavailable.test.ts`, 8 tests, both orderings mutation-checked |
| REDTEAM 6a · recorded transaction hash overwritable | `COALESCE(?, tx_hash)` was last-write-wins | Write-once. `p2-fencing.ts` now shows the zombie failing to change the hash |
| REDTEAM 6b / PROTOCOL 7a · `settle-live.ts` reconciled on `.found` alone | The live-money script settled on a foreign hash | Binds transaction hash and amount, like its three siblings |
| REDTEAM 6c · no `eth_chainId` anywhere in `src/` | A receipt from another chain for a colliding hash was accepted | `assertChainId`, memoised per endpoint, on every chain read. A wrong-chain endpoint is refused and the refusal is memoised too |
| REDTEAM 6c · malformed receipt status reported as `reverted` | `status === "0x1" ? success : reverted` made a receipt we could not read a terminal failed payment | Three-way split in both providers. Mutation-checked |
| KEEPERHUB F-2 · an error body read as a clean simulation | HTTP 401, or 200 with `{"error":…}`, gave `wouldRevert: false` and the payment dispatched | Fails closed at both layers, `test/simulate-fail-closed.test.ts` |
| KEEPERHUB F-5 · settlement receipt read bypassed the RPC fallback | A pruned `null` became `EVIDENCE_CONFLICT` | `receipt()` routes through the shared `rpcCall` |
| KEEPERHUB F-6 · non-retryable preflight left the reservation stuck | A corrected plan was refused `OBLIGATION_RESERVED` forever | Same ordering fix; covered by a test |
| PROTOCOL 2c · reference-only "already paid" pre-check | A 1-wei transfer carrying a public reference blocked an invoice permanently | Full-field match. `matchPaymentLog` compares emitter, token, payee, amount and fee |
| BASELINE 1a · the deployed console matched no commit | A judge could not check out a revision and obtain the live site | Deployed page content is byte-identical to `web/index.html` at HEAD once line endings are normalised (`99b5f2f045894825886c6ee1f49f1326` both sides) |
| BASELINE 7.2–7.4 · console honesty and viewport | "receipts 38/38" and "references 38/38" were one field twice; fixture placeholders linked to Etherscan; no viewport meta | Three distinct computations, explorer links only on recorded rows, doctype/lang/viewport/favicon/OG |
| — · `verify:mcp` and `verify:seam` could spend | Both called the live platform on a route documented as possibly executing for real; `verify:seam` called `provider.execute()` and relied on the gate throwing | `probe:mcp` is renamed and its live check is opt-in; `verify:seam`'s gate section points at an unroutable address. No `verify:*` command can move money |

---

## Open — this is the candid list

**Money-safe but not live.** None of these can cause a duplicate payment. Every one has been
checked for that specifically.

| # | What still breaks | Consequence | Why it is still open |
|---|---|---|---|
| REDTEAM 3b | A crash *inside* `simulate` leaves the obligation in `PAYMENT_PREFLIGHT` with no attempt row and no job | Zero sends, but that invoice cannot be paid by this system again | `PAYMENT_PREFLIGHT` is deliberately not replannable: a simulate can time out, and a timed-out dry run may have executed for real (#1959). The `PREFLIGHT_UNAVAILABLE` discriminator does not reach this case because the crash happens before the catch. Rescuing it means widening a duplicate-payment door to fix a liveness bug, which is the wrong trade this close to a deadline |
| REDTEAM 1a | The loser of a reference race gets a raw `UNIQUE constraint failed: obligations.payment_reference` instead of `REFERENCE_ALREADY_CLAIMED` | Misleading refusal, and no `REFUSED` audit row for the right code | Fails closed. Cosmetic against the money invariant, real against the audit trail |
| REDTEAM 6c | The receipt is still parsed as `{status, gasUsed}` — `to` and `logs` are never read | Nothing *post*-dispatch checks the transaction hit the fee proxy. Those fields are bound pre-dispatch, and reconciliation reads the fee-proxy log independently, so this is redundancy that is missing rather than a hole | Would duplicate what `findPaymentByReference` already proves |
| PROTOCOL 6a | The runtime never re-derives the payment reference from `(requestId, salt, payee)` — it trusts `docs/live-invoices.json` | The cheapest attack in the audit: swap one reference in that file and every guard protects the wrong debt perfectly | This is the Request read path (§5 of the build mandate) and it is not built. **The single largest gap in the submission** |
| PROTOCOL 4 | `decimals: f.tokenDecimals ?? 18` on both sides of the comparison, so `TOKEN_DECIMALS_MISMATCH` cannot fire in production | Correct today — FAU is 18dp and `verify:onchain` proves it — and a 10^12 error the moment a 6-decimal token is added | Needs a token decimals read on the settle path |
| PROTOCOL 5 | No confirmation depth anywhere. A receipt one block deep settles | A reorg between `CHAIN_CONFIRMED` and a settlement claim is not defended against | "Receipt observed, finality unverified" is the honest phrasing and it is what the README should say |
| PROTOCOL 1b | `steps[].data` is not case-folded in `canonicalJson`, so two spellings of one calldata give two plan hashes | Blocked today by `reserveObligation` and `canReplan`; live the moment either is relaxed | Second-order |
| KEEPERHUB F-3 | A 4xx with a JSON body resolves as `status: "pending"` and is recorded `SENT` | A revoked API key turns every in-flight obligation into a manual investigation. Safe direction, wrong disposition | |
| KEEPERHUB F-4 | An expired MCP session can never re-handshake, though `-32003` is flagged retryable | Low impact today: every caller constructs a fresh provider per process | |
| KEEPERHUB F-7 | `"unknown"` is used as a placeholder execution id and persisted | Two stranded attempts record the same identifier | |
| KEEPERHUB F-8 | REST 409 does not distinguish "in progress" from "same key, different body" | Both become `EVIDENCE_CONFLICT`. Safe, imprecise | |
| REDTEAM 8 | With no standing policy configured — and this checkout has none — `buildPolicy` falls back to the caller's own ceilings | `POLICY_DENIED` is decorative as deployed. The human approval gate still stands in front | Ship a `policy.json` |
| — | `docs/demo-transcript.txt` is still in the tree | Repo hygiene says video sources live with the video | Removing it breaks `npm run demo:video` |

**Not defects, recorded so nobody re-raises them.** The global payment-reference index has no
namespace predicate — correct for a single-operator deployment, where one Request reference is
one debt however it was imported, and narrowing it would reopen the double-pay door it was added
to shut. `rpcCall`'s receipt fallback is first-non-null rather than agreement, which is the right
polarity for a receipt: a `null` means "this endpoint does not know". `findPaymentByReference`
does corroborate positives across endpoints, because a false positive there can mark an
obligation settled.

---

## What could not be broken

Across 40 racing process pairs, 6 real mid-flight process kills and every retry path reachable
from the settle API, `provider.execute()` was never called twice for one obligation and no retry
path ever re-broadcast. `EXECUTION_OUTCOME_UNKNOWN` never decayed into a fresh payment, the
reservation never came back after a dispatch, every illegal transition was refused, case-variant
references never minted a second debt, and no free-text field reaches a decision — there is no
`memo`, `description` or note anywhere in `InvoiceFacts`.
