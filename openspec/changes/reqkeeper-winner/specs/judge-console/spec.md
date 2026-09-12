## Purpose
The console states the invariant on its first screen, shows only computed numbers, distinguishes live from recorded from test, and is legible on a phone, without changing the product's visual identity.

## ADDED Requirements

### Requirement: Proof view first
The default route SHALL be a Proof view showing the race metric with real totals and date, four computed counters (real payments, replays refused, refused before write, unexplained sends), and a five-step proof strip for one obligation with identifiers and links.

#### Scenario: First screen
- **WHEN** the console loads at `/`
- **THEN** the Proof view renders, every counter equals the value in `docs/evidence/verify.json`, and Request Network, KeeperHub and `/api/mcp` are named on screen

### Requirement: Mode labels
Every view SHALL label its data LIVE, RECORDED (with run date) or TEST, and TEST rows SHALL never link to an explorer.

#### Scenario: Fixture row
- **WHEN** a fixture row renders in the obligations table
- **THEN** it is tagged TEST and its hash is plain text

### Requirement: No tautologies or typed numbers
The verification card SHALL render the result and timestamp of `verify:all`; the console SHALL contain no number typed by hand.

#### Scenario: Verification card
- **WHEN** `verify.json` is absent at build time
- **THEN** the build fails rather than rendering placeholder values

### Requirement: Legible on phones
The document SHALL declare a doctype, `lang`, and a viewport meta; labels SHALL be at least 12 px; text contrast SHALL be at least 4.5:1; the inspector SHALL fit the viewport at 1440 and 390.

#### Scenario: 390 px phone
- **WHEN** the console opens at 390×844
- **THEN** the 760 px breakpoint applies, tap targets are at least 44 px, and no text is smaller than 12 px

### Requirement: Motion budget
Animations SHALL use the inlined Motion dist on transform and opacity only, the pixel-mark loop SHALL stop after its reveal, and reduced motion SHALL set final values.

#### Scenario: Throttled CPU
- **WHEN** the walker samples frames at 4× CPU throttle
- **THEN** dropped frames are 0 % and there are no long tasks at idle
