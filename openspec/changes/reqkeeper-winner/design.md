## Context

Dependency-free TypeScript on Node 24, `node --test`, SQLite through `node:sqlite` with a transactional outbox, leases and fencing, a 24-state settlement machine, a byte-identity calldata gate, REST and MCP clients for KeeperHub, a public-RPC chain reader, a hand-built console and a read-only hosted MCP. Verified strengths to preserve: the settle order (reservation before approval before simulate before durable attempt before send), pre-write refusals at zero sends, the audit hash chain, the reduced-motion console path. Constraints: about 32 working hours after the VIVA deadline, a payer wallet with 58 FAU of allowance, a flaky public Sepolia RPC, a hackathon rubric with five lines and no weights, finalists presenting live.

## Goals / Non-Goals

**Goals:**
- Every rubric line backed by an artifact a judge can regenerate without credentials, and one command that checks all of them.
- Request Network read for real: facts fetched, references derived and verified, mismatches refused.
- Exactly-once demonstrated under real concurrency and real crashes, fixture and live, with a second wave at zero sends.
- KeeperHub used through both REST and MCP with execution ids and status polling recorded.
- A console whose first screen states the invariant and shows only computed numbers, legible on a phone.
- A README that a stranger can execute in five minutes and that never contradicts the evidence.

**Non-Goals:**
- New product surfaces, AI features, mainnet, multiple payees, a general payment agent, a redesign of the console identity.
- Observing the 24 h KeeperHub key expiry live.
- The upstream KeeperHub PR (separate session, `extras/UPSTREAM_PR_PROMPT.md`).

## Decisions

- **Hardening over rebuilding.** The machine, store and gate stay; only the two proven defects (retryable preflight, non-CAS `markSent`) and the two proof gaps (RPC quorum, strict log matching) change in the core.
- **Facts from Request, zero dependencies.** The public gateway serves the invoice payload unauthenticated; decoding it locally keeps the "no npm dependencies in src" property and makes the reference verifiable with the existing keccak.
- **Race and crash as scripts with a counting fixture.** Deterministic in CI, identical code path to live, and the fixture is the only honest way to count physical sends without trusting the provider's own log. One live run each for the artifact a judge clicks.
- **Evidence schema first, numbers generated.** A single `docs/evidence/` shape and a generator for README, console and `TRUTH.md` removes the drift class of defect (187 vs 192, gate-a line, tautology card) permanently.
- **MCP transport for real settlements.** Three rows over MCP with polling make the "surfaces used" answer true rather than aspirational; REST stays the default because it is simpler to run live in front of judges.
- **Console identity kept, judge mode added in front.** The organisers judge at repository level and on a call; the first screen must state the invariant and the computed counters. Motion is vanilla and inlined so the page has no runtime dependency.
- **Judge loop with deterministic gates before LLM judges**, chair-weighted toward the KeeperHub engineer and the red team, because those two views decide the ranking.

## Risks / Trade-offs

- Public RPC flakiness during the finalist call. Mitigation: quorum across providers, `ChainReadInconclusive` surfaced as pending, runbook playbook.
- KeeperHub rate limits (60 req/min, daily caps) during the race and the live demo. Mitigation: `PREFLIGHT_UNAVAILABLE`, fixture mode for the matrix, live runs scheduled and counted against the 58 FAU allowance.
- Gateway payload decoding drift. Mitigation: recorded fixture, one curl before coding, tests against all 41 known references.
- Time. Mitigation: fixture artifacts first, live runs second; cuts named in the master prompt.
- History rewrite to drop 72 MB of video blobs. Mitigation: only with Vaibhav's yes; otherwise remove from the tree and accept the size.
