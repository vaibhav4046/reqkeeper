## Purpose
Exactly-once settlement is demonstrated under real concurrency, real crashes, both KeeperHub transports and a flaky chain reader, with artifacts a judge can regenerate without credentials.

## ADDED Requirements

### Requirement: Chain reads use a quorum
Receipt and log reads SHALL use an ordered list of RPC providers; a null receipt SHALL be inconclusive rather than absent; log results SHALL be accepted only when two providers agree or one provider repeats the same answer.

#### Scenario: Provider returns null then a receipt
- **WHEN** the first provider returns null for a mined transaction
- **THEN** the reader retries on the next provider and returns the receipt, and no state becomes `EXECUTION_REVERTED` or "no receipt"

### Requirement: Strict log matching
A payment log SHALL match on emitter, token, `to`, reference, amount and fee before a settlement is recorded.

#### Scenario: Foreign log
- **WHEN** a log carries the right reference but a different `to` or token
- **THEN** the obligation enters `EVIDENCE_CONFLICT` and is never `SETTLED`

### Requirement: Retryable preflight does not brick
A retryable preflight failure SHALL enter `PREFLIGHT_UNAVAILABLE`, replannable only while no attempt has `first_send_at`.

#### Scenario: KeeperHub 429 on simulate
- **WHEN** simulation returns 429
- **THEN** the obligation is `PREFLIGHT_UNAVAILABLE`, a later call retries at zero prior sends, and the machine never answers `ALREADY_DISPATCHED`

### Requirement: markSent is compare-and-set
`markSent` SHALL succeed for exactly one caller per attempt.

#### Scenario: Two processes race the same attempt
- **WHEN** two processes call `markSent` for one attempt
- **THEN** exactly one observes `changes === 1` and the other refuses to execute

### Requirement: Concurrency artifact
`npm run race` SHALL spawn N independent processes on one store against a counting KeeperHub fixture and SHALL record per-worker decisions and total physical sends.

#### Scenario: Ten workers, one invoice
- **WHEN** ten processes race one obligation
- **THEN** `docs/evidence/race.json` shows `sends: 1, settled: 1, duplicates: 0`, and a second wave shows `sends: 0`

#### Scenario: Live race
- **WHEN** the race runs once with `--live` against KeeperHub on Sepolia
- **THEN** one transaction hash and one execution id are recorded and every other worker's decision is a refusal

### Requirement: Crash artifact
`npm run crash` SHALL kill the settlement at each of nine checkpoints and recover by reconciliation.

#### Scenario: Crash after markSent before execute
- **WHEN** the process is killed after `first_send_at` is written and before the provider call is made
- **THEN** recovery finds no receipt and no log, the obligation stays `EXECUTION_OUTCOME_UNKNOWN` for reconciliation, sends remain 0, and nothing is resent

#### Scenario: Crash after execute before receipt
- **WHEN** the process is killed after the provider accepted the send and before the receipt is read
- **THEN** recovery reconciles by receipt and log, total sends are exactly one, and `duplicate: false`

### Requirement: Both KeeperHub transports
At least three obligations SHALL settle through the KeeperHub MCP transport with status polling, recorded with `transport` and execution id.

#### Scenario: MCP settlement
- **WHEN** `KEEPERHUB_TRANSPORT=mcp`
- **THEN** simulation runs before broadcast, the broadcast carries an `idempotency_key`, `get_direct_execution_status` is polled until terminal, and the row records `transport: "mcp"`

### Requirement: One verification command
`npm run verify:all` SHALL verify every public claim without credentials and SHALL fail when any README or console number disagrees with evidence.

#### Scenario: Clean clone
- **WHEN** `verify:all` runs five times on a clean clone
- **THEN** all five runs pass and `docs/evidence/verify.json` carries a timestamp

#### Scenario: Edited number
- **WHEN** a README number is changed by hand
- **THEN** `verify:all` fails naming the line
