## Purpose
Every public claim about ReqKeeper, in the README, the console, the video and the BUIDL text, is traceable to an evidence row with a status, a date and a reproduction command.

## ADDED Requirements

### Requirement: Ledger rows
`docs/TRUTH.md` SHALL hold one row per public claim with CLAIM, STATUS (`PROVEN_LIVE`, `PROVEN_PUBLIC_CHAIN`, `PROVEN_TEST`, `OBSERVED_ONCE`, `PARTIAL`, `UNPROVEN`, `SUPERSEDED`), EVIDENCE path and row ids, DATE, REPRODUCTION command, and LIMITATION.

#### Scenario: New number in README
- **WHEN** a number appears in `README.md` outside a generated block
- **THEN** `scripts/readme-numbers.ts --check` fails naming the line

### Requirement: Generated numbers
Numbers in `README.md`, the console payload and `docs/TRUTH.md` SHALL be generated from `docs/evidence/*.json` by one script.

#### Scenario: Evidence changes
- **WHEN** a new race artifact is written
- **THEN** running the generator updates the README metric block, the console counters and the ledger row in one pass, and `git diff` shows only those blocks

### Requirement: Candid limitations
The ledger SHALL list every known limitation, and the BUIDL's "what still breaks" answer SHALL be drawn from it.

#### Scenario: Submission text
- **WHEN** the BUIDL form is filled
- **THEN** each limitation sentence corresponds to a ledger row with status `PARTIAL` or `UNPROVEN`
