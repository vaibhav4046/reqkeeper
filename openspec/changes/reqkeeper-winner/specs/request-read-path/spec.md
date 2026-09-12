## Purpose
Invoice facts and payment references are sourced from Request Network and verified locally, so the integration is specific to Request and no caller can substitute its own facts.

## ADDED Requirements

### Requirement: Facts come from Request
The system SHALL fetch payee, amount, currency, decimals and salt for a `requestId` from the Request Network Sepolia gateway and SHALL NOT accept those facts from the caller on any settlement path.

#### Scenario: Propose by requestId
- **WHEN** an agent calls `propose_payment` with only a `requestId`
- **THEN** the obligation is imported with facts fetched from the gateway and the audit row records the gateway response hash

#### Scenario: Caller-supplied fact differs
- **WHEN** a caller supplies a payee, amount, token or reference that differs from the fetched facts
- **THEN** the obligation is refused with `REFERENCE_MISMATCH` (or `FACT_MISMATCH` naming the field) before any write and with zero sends

### Requirement: Reference derivation
The system SHALL derive the payment reference as the last 8 bytes of `keccak256(lowercase(requestId + salt + payee))` and SHALL match every reference in the recorded invoice set.

#### Scenario: Known invoices
- **WHEN** the derivation runs over the 41 recorded invoices
- **THEN** every derived reference equals the reference Request's calculator produced

### Requirement: Unpaid invoice trigger
The watcher SHALL detect invoices to the configured payee with no matching proxy log and propose them at zero sends.

#### Scenario: Three unpaid invoices
- **WHEN** three unpaid invoices exist for the payee
- **THEN** `docs/evidence/trigger.json` records three detections and three proposals with `sends: 0`, and each later settles through the normal path

### Requirement: Paid verdict
Each settled row SHALL carry a `requestVerdict` computed by re-deriving the reference and matching the proxy log on emitter, token, `to`, reference, amount and fee.

#### Scenario: Settled row
- **WHEN** a settlement reaches `SETTLED`
- **THEN** the row's `requestVerdict` is `paid` with the block number, or the row is `EVIDENCE_CONFLICT`
