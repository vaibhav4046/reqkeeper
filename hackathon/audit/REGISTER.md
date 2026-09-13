# Finding register

One row per finding raised by an independent review pass. A row closes on demonstrated behaviour,
never on "code was edited" or "CI passed".

States: **OPEN** · **FIXED_UNVERIFIED** (fixed, not yet retested by someone other than the fixer) ·
**VERIFIED** (independently retested) · **ACCEPTED_LIMITATION** · **BLOCKED**.

Baseline for this register: `d0e81a8`. CI green. Deployed revision byte-identical to HEAD
(`2cc5c9ec85de1f1210618029eb0bb1bc`).

## Coverage, with denominators

| Measure | Count | Note |
|---|---|---|
| LIVE rows corroborated against the chain | **41 / 41** | was 1 / 41 actually read (3 claimed). One `eth_getLogs` carrying all 41 reference topics |
| Payment references re-derived from the invoice | **46 / 46** | by calling Request's own `PaymentReferenceCalculator` |
| Rows in the hosted verifier's table | **86** (41 payments) | was 83 / 38; the three MCP settlements were absent |
| Crash checkpoints exercised | **9 / 9** | 0 duplicates |
| Refusal harness cases | **26 / 26** | 18 / 24 refusals before any provider write |
| Unit tests | **394**, 78 suites | 0 failures |
| Settlements carrying a KeeperHub execution id | **3 / 41** | REST rows predate the field. Not fixable without re-running live; see KH-EXEC |
| Duplicate-payment paths found by red team | 4 found, 4 fixed | rounds 1, 2, 3 |

## Duplicate payment — one class, four instances

All four were the same defect: a value that could mean "I do not know" consumed as "no". Fixed as
instances in rounds 1-3; the class was closed by changing the contract.

| ID | Sev | Reproduction | Root cause | Fix | Mutation proof | State |
|---|---|---|---|---|---|---|
| RT-1 | blocker | simulate executes then times out, propose twice | `everSent` read before `openAttempt` exists, so the gate was structurally vacuous; collapsed to `retryable` | 3ba342a | revert → 3 tests red | **VERIFIED** — red team re-ran its own repro at round 3: 1 send |
| RT2-1 | blocker | same, with any 4xx (409, non-JSON body) | non-retryable tail still concluded "nothing executed" from `!retryable` | 7b40807 | revert → 2 tests red | **VERIFIED** — round-3 re-run: 1 send on all four non-retryable codes |
| RT3-1 | blocker | dry run broadcasts, then answers `{"success":false}` | `wouldRevert` set from `success===false \|\| error!==undefined` by both transports, then read as a verdict | 5ee04e8 | revert → test red | FIXED_UNVERIFIED |
| CLASS | blocker | — | booleans cannot carry three states, so every caller could re-introduce the bug | d0e81a8 | delete a `case` → **does not compile** (`not assignable to type 'never'`) | FIXED_UNVERIFIED |

`SimulateOutcome` = `WOULD_SUCCEED | WOULD_REVERT | EXECUTED | UNKNOWN`, one classifier shared by
both transports, exhaustive switch in `settleOrRefuse`.

## Liveness — the other half of the same repair

| ID | Sev | Reproduction | Root cause | Fix | State |
|---|---|---|---|---|---|
| LIVE-1 | major | wedge an obligation, drain 24h of resolver passes | `truncated: floor > 0` is always true on real Sepolia, so `PREFLIGHT_UNAVAILABLE` was unreachable and every failed dry run wedged permanently | agent fix + d0e81a8 | **FIXED_UNVERIFIED** — `truncated` now means "could not cover the window"; the invoice anchor travels Request → facts → store → worker → scan; cutting it at the worker turns `test/preflight-liveness.test.ts` red while the fail-safe control still passes |

Safety without liveness is not recovery. Never paying twice is not the whole property.

## Evidence integrity

| ID | Sev | Reproduction | Fix | State |
|---|---|---|---|---|
| KH2-10 | major | inflate an MCP row's amount 999x, set payee `0x…dEaD` → `21 ok · 0 failed` | corroborate each row against its own token/payee/amount | **VERIFIED** — retested by the KeeperHub judge: `20 ok · 1 failed`, exit 1 |
| KH3-1 | major | replace 37 REST tx hashes with fabricated values → `21 ok`, exit 0 | the fix covered 3 of 41 rows; now one sweep over all 41, expectation joined from `live-invoices.json` | FIXED_UNVERIFIED — tamper run: `37/38 rows disagree with the chain`, exit 1 |
| KH3-2 | major | inject a second broadcast into `race-live.json` rows → still "0 duplicates" | `race.live` read `totals`, the anti-pattern the file's own header forbids; now recomputed from rows | FIXED_UNVERIFIED — three tamper shapes all exit 1 |
| KH3-3 | major | live `verify_payment` returned `paid:false` for all three headline MCP references | compiled evidence was built from one of two artifacts, generated three days before those settlements | **VERIFIED on the deployed revision** — all three now `paid: true, corroboratedBy: "project-evidence"`; `0xdeadbeefdeadbeef` control returns `paid: false` |
| DOC-1 | major | set README's own verify tally to "21 ok · 9 failed · 4 blocked" → guard stayed green | guard watched 1 README claim | FIXED_UNVERIFIED — 24 claims watched; tamper → 2 FAILs naming file:line |

## Request Network correctness

| ID | Sev | Finding | State |
|---|---|---|---|
| RQ-1 | major | the money scripts took payee/amount/fee/reference from `.env` and a JSON file, never reading the invoice — violating this repo's own spec | **VERIFIED** — Request judge ran the real script with a foreign reference: `REFUSED before any write (REFERENCE_MISMATCH)`, SQLite byte-identical after |
| RQ-FALSE | major | README misstated Request's own detection ("sums events carrying it") | **VERIFIED** — judge checked the new wording clause-by-clause against installed SDK source |
| RQ-ATTRIB | major | four surfaces credited Request with what ReqKeeper verified itself | FIXED_UNVERIFIED |
| RQ-2 | major | watcher accepted a reference-only sighting as proof of payment (grief: suppress a real invoice) | FIXED_UNVERIFIED |

## Accepted limitations

| ID | Why it stays open |
|---|---|
| KH-EXEC | 38 of 41 settlements carry no KeeperHub execution id. The field post-dates those rows. Closing it means re-running the live harness against fresh invoices with real credentials — an owner decision, and newly generated evidence must not rewrite the provenance of old rows |
| REVERT-1 | `EXECUTION_REVERTED` is terminal and not replannable, and the obligation keeps its payment reference, so the same debt cannot be re-proposed. Money-safe (nothing moved). Both agent surfaces now say the honest remedy — a fresh Request invoice — instead of naming one no code path provides |
| ALLOWANCE | The FAU allowance is manual and no command performs it; `settleOrRefuse` structurally cannot, since it dispatches only a plan's last step. Documented in `docs/RUNBOOK.md` with both addresses and the exact request body |
| POLICY-ASYM | `policy.json` allowlists one payee, so a fresh clone refuses every agent-surface path, while `settle-live.ts` builds its own inline policy. Documented rather than "fixed" by making the shipped policy permissive |
| TOKEN-FIELD | `live-invoices.json` records no token, so the REST expectation states FAU from `plan.ts` — the only token this deployment settles in. Said out loud in the check's own detail line |
