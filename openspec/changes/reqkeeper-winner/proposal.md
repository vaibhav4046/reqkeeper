## Why

ReqKeeper's core mechanics are real (38 verified Sepolia settlements, replays at zero sends, a byte-identity calldata gate, a durable outbox with fencing), but the submission does not yet prove what the rubric asks. `src/` never reads Request Network; no payment has gone through KeeperHub's MCP surface and the status endpoint is never polled; there is no multi-process or crash evidence; the credential-free verifier fails on a flaky RPC; a retryable preflight failure bricks an obligation; reconciliation matches a log by reference alone; the console shows a tautology as verification, a decorative live dot and does not render on phones; README numbers drift. Submissions close 18 Sep 2026 12:00 CEST. This change turns the existing architecture into a proven, legible, reproducible entry without redesigning it.

## What Changes

- Request read path: fetch invoice facts from the Sepolia gateway, derive and verify the payment reference, refuse mismatches before write, poll for unpaid invoices.
- Reliability: RPC quorum, strict log field matching, `PREFLIGHT_UNAVAILABLE` state, compare-and-set `markSent`, multi-process race script (fixture and live), crash lottery, KeeperHub MCP-transport settlements with status polling, `verify:all`.
- Evidence: unified `docs/evidence/*.json` schema with mode, block, explorer, execution id, transport, request verdict; numbers in README, console and `TRUTH.md` generated from evidence.
- Console: judge-first Proof view, honesty fixes, viewport and accessibility, inlined vanilla Motion, verify view, runbook.
- Repository: judge-first README, truth ledger, CI with build and verification, video out of the tree, Windows paths removed.
- Process: agentic judge loop with four judges, a walker and a chair; upstream PR handled in a separate session.

## Capabilities

### New Capabilities
- `request-read-path`: invoice facts and payment references sourced from Request Network and verified.
- `exactly-once-evidence`: concurrency, crash, transport and verification artifacts that a judge can regenerate.
- `judge-console`: the first-screen proof view and honesty rules for the console.
- `truth-ledger`: every public number traceable to an evidence row.
- `judge-loop`: the evaluation protocol, gates, schema and stop condition.

### Modified Capabilities
- (none: the repo has no `openspec/specs`; all requirements are introduced here)

## Impact

- New: `src/request.ts`, `scripts/{race,crash,verify-all,mcp-e2e,readme-numbers}.ts`, `docs/evidence/`, `docs/TRUTH.md`, `docs/RUNBOOK.md`, `.mcp.json`, `design-system/reqkeeper/`.
- Changed: `src/{chain,settle,store,machine,worker,keeperhub,keeperhub-mcp,mcp,mcp-public,watch}.ts`, `tools/web/{template.html,build.mjs}`, `README.md`, CI.
- Removed from the tree: `docs/demo.mp4`, `docs/demo-transcript.txt`, `docs/MASTER.md`, `docs/SUBMISSION.md` (folded into `ARCHITECTURE.md` and `TRUTH.md`).
- Env: `SEPOLIA_RPC_URLS`, `KEEPERHUB_TRANSPORT`, `REQKEEPER_CRASH_AT`, `REQUEST_GATEWAY_URL`.
