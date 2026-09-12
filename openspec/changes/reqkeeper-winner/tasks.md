## 1. Foundations (Phase 0)

- [ ] 1.1 Node 24 confirmed; kit files in place; `.judging/`, the master prompt, judge agents, walker and `/judge-round` gitignored; `npx ui-ux-pro-max-cli init --ai claude`; 15 fresh unpaid invoices created with the fixed `create-batch.mjs`
- [ ] 1.2 `docs/evidence/` created; existing artifacts migrated with the new row fields
- [ ] 1.3 `SEPOLIA_RPC_URLS` (two providers) in `.env.example` and Vercel; `KEEPERHUB_TRANSPORT`, `REQUEST_GATEWAY_URL` documented
- [ ] 1.4 `settlement` blob removed from `tools/web/build.mjs`; Windows paths fixed in four files; `harness` output deterministic
- [ ] 1.5 README test count and gate-a lines replaced by generated blocks; `scripts/readme-numbers.ts` created; `npm test` gains a 90 % line-coverage threshold
- [ ] 1.6 CI runs build with clean-tree check and `verify:all`
- [ ] 1.7 Gate: test, typecheck, build green; tree clean after every documented command

## 2. Verification that passes (Phase 1, builder-reliability)

- [ ] 2.1 RPC quorum in `src/chain.ts`; `ChainReadInconclusive`; all readers routed through it
- [ ] 2.2 Strict log field matching; "receipt belongs to another obligation" test
- [ ] 2.3 `PREFLIGHT_UNAVAILABLE` state; `markSent` compare-and-set; tests
- [ ] 2.4 Evidence rows enriched (block, explorer, execution id, transport, request verdict)
- [ ] 2.5 `scripts/verify-all.ts` writing `docs/evidence/verify.json`; hosted `verify_payment` fixed
- [ ] 2.6 Gate: `verify:all` 5/5 green from a clean clone; `gate-a` reports observed values

## 3. Request read path (Phase 2, builder-request)

- [ ] 3.1 `src/request.ts` gateway fetch and decode with recorded fixture
- [ ] 3.2 Reference derivation tested against all 41 known references
- [ ] 3.3 `propose_payment({requestId})`, `approve --requestId`, watcher take requestId only; `REFERENCE_MISMATCH` refusal
- [ ] 3.4 Watcher polling the gateway; `docs/evidence/trigger.json` with three detections
- [ ] 3.5 `requestVerdict` per settled row; `check-paid.mjs` paths fixed
- [ ] 3.6 Gate: a real invoice settled from requestId alone; wrong reference refused at 0 sends

## 4. Race, crash, MCP transport (Phase 3, builder-reliability)

- [ ] 4.1 Counting KeeperHub fixture server
- [ ] 4.2 `scripts/race.ts` fixture N=10 and N=50; second wave; `docs/evidence/race.json`
- [ ] 4.3 `scripts/race.ts --live` once with a real unpaid invoice
- [ ] 4.4 `scripts/crash.ts` nine checkpoints in fixture mode; two live (`after_execute_before_receipt`, `while_polling`); `docs/evidence/crash.json`
- [ ] 4.5 `KEEPERHUB_TRANSPORT=mcp` path; `observe()` polling in unknown-outcome recovery; three live MCP settlements
- [ ] 4.6 `scripts/mcp-e2e.ts` for the local agent surface
- [ ] 4.7 Gate: zero duplicates everywhere; execution ids recorded; second wave `sends: 0`

## 5. Console (Phase 4, builder-console)

- [ ] 5.1 Design-system run persisted; contrast and type minimums applied
- [ ] 5.2 Document shell: doctype, lang, viewport, favicon, OG
- [ ] 5.3 Proof view as default with computed counters and the five-step proof strip
- [ ] 5.4 Honesty fixes: verification card from `verify.json`, no decorative live dot, no `settlement` blob, fixture rows unlinked and tagged TEST, badges from evidence
- [ ] 5.5 Legibility: inspector `.kv`, keyboard rows, tooltips, normalised codes
- [ ] 5.6 Verify view; inlined Motion; rAF loop stops after reveal
- [ ] 5.7 `docs/RUNBOOK.md`
- [ ] 5.8 Gate: walker green at 390 and 1440; Lighthouse mobile ≥ 95; page < 120 KB gzip as served

## 6. README, truth ledger, agent DX (Phase 5)

- [ ] 6.1 README rewritten judge-first (≤ 160 lines) with generated number blocks
- [ ] 6.2 `docs/TRUTH.md` with a row per public claim; `readme-numbers --check` green
- [ ] 6.3 `docs/ARCHITECTURE.md` from MASTER and SUBMISSION; those two deleted; video moved to a release asset and YouTube
- [ ] 6.4 `.mcp.json` and Cursor snippet; tool descriptions rewritten; `list_pending`
- [ ] 6.5 Gate: fresh clone executes the README first screen cold

## 7. Judge loop (Phase 6)

- [ ] 7.1 `/judge-round 1` … until `done` or round 4
- [ ] 7.2 `.judging/RESIDUALS.md` feeds the "what still breaks" answer

## 8. Submission (Phase 7)

- [ ] 8.1 `/ship-check` green
- [ ] 8.2 Video recorded against the final build; link in BUIDL text
- [ ] 8.3 Two BUIDLs submitted on DoraHacks before 18 Sep 2026 12:00 CEST; transaction link and execution id included
