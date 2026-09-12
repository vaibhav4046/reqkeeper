## Purpose
An agentic evaluation protocol that runs deterministic gates from a fresh clone, then four judge personas and a QA walker, merges their findings through a chair, and loops fixes until a fixed bar is met.

## ADDED Requirements

### Requirement: Gates before judges
A round SHALL run tests, typecheck, build with a clean-tree check, `verify:all` five times, the race, the crash matrix and the MCP end-to-end script from a fresh clone, plus the console and hosted-MCP walk, before any judge, and SHALL abort on a red gate.

#### Scenario: Dirty tree after build
- **WHEN** `npm run build` changes a tracked file
- **THEN** the gate is red, no judge runs, and the round restarts after the fix

### Requirement: Strict judge output
Each judge SHALL write a JSON file matching the schema (judge, round, score, verdict, headline, praise, loopholes with id, severity, where, repro, evidence, why_it_matters, fix) and SHALL run the product rather than only read it.

#### Scenario: Malformed verdict
- **WHEN** a judge file fails schema validation
- **THEN** the chair records score 0 for that judge and adds a major loophole "re-run judge"

### Requirement: Chair decision
The chair SHALL weight 0.40 keeperhub, 0.30 redteam, 0.15 request, 0.15 dx, merge duplicates, rank by severity with any demonstrated duplicate payment first, assign owners, check the completion contract, and end the verdict with `DECISION: continue|done|blocked`.

#### Scenario: Stop condition
- **WHEN** two consecutive rounds have every judge at or above 9.0, zero blockers, zero majors, green gates and no credible duplicate path from the red team
- **THEN** the decision is `done`

### Requirement: Artifacts stay out of the repo
Judging, walker and gate artifacts SHALL live under `.judging/`, which SHALL be gitignored; product evidence under `docs/evidence/` is committed.

#### Scenario: Accidental add
- **WHEN** `git status` shows a file under `.judging/`
- **THEN** the ship check fails
