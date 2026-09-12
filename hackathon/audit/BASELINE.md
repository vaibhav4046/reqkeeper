# ReqKeeper — Phase 1 Baseline

Recorded 2026-09-12. Every row below is either a command I ran with its real output, or is
marked UNVERIFIED. Nothing here is inherited from prior session notes without re-checking.

---

## 1. Identity: repository vs deployment

| Fact | Value | How established |
|---|---|---|
| Local branch | `main` | `git rev-parse --abbrev-ref HEAD` |
| Local HEAD | `b2cb6984` — "docs: update unit test count to 239 in README.md", 2026-09-09 18:38:36 +0100 | `git log -1` |
| Remote | `https://github.com/vaibhav4046/reqkeeper.git` | `git remote -v` |
| origin/main | `2b022e81` — "docs: sync ElevenLabs voiceover narration with 1080p demo video" | `gh repo view` + `git fetch` |
| **Local vs origin** | **2 commits AHEAD — unpushed** | `git rev-list --left-right --count origin/main...HEAD` → `0  2` |
| Deployed page | 73,806 bytes, md5 `ae1988b76c3ab44e259b022a7824e7d4` | `curl -s https://reqkeeper.vercel.app/` |
| HEAD page | 73,872 bytes, md5 `1c0b77bb…` | `git show HEAD:web/index.html` |
| **Deployed commit** | **NONE — no commit in this repo produces the deployed bytes** | md5 of `web/index.html` at all 10 commits that touch it; zero matches |

### 1a. BLOCKER — the live site is stale and unreproducible

The deployed console embeds `"tests": 192`. The repository at HEAD has **239** tests, and I ran
them: `ℹ tests 239 / ℹ pass 239 / ℹ fail 0`. The deployed artifact also matches no commit, so a
judge cannot check out any revision and obtain the live site.

The two unpushed commits are not cosmetic. `git diff --stat origin/main..HEAD`:

```
 src/store.ts             |  34 +-
 src/policy.ts            |  20 +-
 src/mcp-public.ts        |  18 +-
 test/adversarial.test.ts | 884 +++++++++++++++++++++++++++++++++++++++
 docs/JUDGE_EVALUATION.md | 105 +++++
 docs/demo.mp4            | Bin 20228809 -> 50203719 bytes
 ... 25 files changed, 1468 insertions(+), 39 deletions(-)
```

The adversarial hardening and its 884-line test suite — the single strongest reliability
argument this project has — exist **only on this machine**. They are not on GitHub and not
deployed. Judging is explicitly done "at repository level".

---

## 2. Event facts (verified from source, not from notes)

Read from `https://dorahacks.io/hackathon/agent-economy/detail` on 2026-09-12 via browser
(curl is blocked: HTTP 405 + captcha).

- **Submissions close: Sep 18, 12:00 CEST (UTC+2).** Page banner read "5 days left".
- Judging Sep 18–25. Live finalist panel inside that window.
- Prize pool $5,000 in stablecoins. Main track "Best Integration into a Live Project" $4,000
  ranked — 1st $2,000, 2nd $1,200, 3rd $800, single ranking.
- Field: **210 hackers, 1 bounty** listed.

### Official main-track rubric (quoted)

| Dimension | Question as published |
|---|---|
| Integration depth | "Is there a real, named project on the other side, and is the integration specific to it?" |
| Execution through KeeperHub | "Did value actually move through KeeperHub, and can we see it?" |
| Reliability and observability | "Does the build survive conditions that are not the happy path?" |
| Usefulness and originality | "Does it solve something real for users of the integrated project?" |
| Developer experience and code quality | "Could another team pick this up?" |

### Submission requirements (quoted)

> "Three things: a source code link, a short demo video showing the integration working, and a
> link to a transaction executed through KeeperHub. **Incomplete submissions cannot be judged.**"

Form also asks: "What still breaks or is unfinished? A candid answer here has never hurt a
submission." — this rewards the honest-limitations section, it does not punish it.

Bounty rubric (separate, maps to the upstream PR): Mergeability, Value to the platform, Code
quality and tests, Scope and completeness.

---

## 3. Exactly-once invariant — where it is actually enforced

| Layer | File | Mechanism |
|---|---|---|
| Durable claim | `src/store.ts` | SQLite `BEGIN IMMEDIATE`; `UNIQUE(namespace,request_id)`, `UNIQUE(payment_reference)`, `UNIQUE(plan_hash,step_index)`; `reserveObligation` |
| Staleness | `src/store.ts` | `lease_expires_at` + `fencing_generation` |
| Delivery | `src/store.ts` | transactional outbox; `src/worker.ts` read-only drainer |
| States | `src/machine.ts` | 24 states, explicit transition table, `TERMINAL` / `REPLANNABLE` / `PRE_DISPATCH_REFUSALS` |
| Ordering | `src/settle.ts:193+` | ordered gate enforcement |

Not a process mutex. Adversarial verification of these claims is delegated and lands in
`REDTEAM.md` — until then they are **structurally present, independently unproven**.

---

## 4. Chain and contract identity

| Item | Value |
|---|---|
| Network | Ethereum Sepolia, chainId 11155111 |
| ERC20FeeProxy | `0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE` (2165 bytes deployed) |
| FAU token | `0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C` (3044 bytes) |
| Payment selector | `0xc219a14d` |
| Forwarder/relayer | `0x5af5194b4b0909eb978e3cf1e25333852277f07d` (gas sponsored, meta-tx) |

**Testnet only. No mainnet economics are claimed or implied.**

---

## 5. Independently re-derived evidence

I did not accept the evidence files at face value. For recorded row L001:

- tx `0xb90a0771858581547abeb9310777f4430f892be130765eda1096202b9dd9f7f6`, block 11665983
- Receipt `status: 0x1`, `gasUsed 74618`
- ERC20FeeProxy log topic0 = `TransferWithReferenceAndFee(...)`
- topic1 matches `keccak256(0x050562a52ec69fa2)` computed with the repo's own `src/keccak.ts`

So request id → payment reference → KeeperHub execution → tx → receipt → fee-proxy log is a
closed chain for at least one obligation, checked against the chain rather than the recording.

**Finality: receipt observed at unspecified depth. No confirmation-depth logic exists in the
codebase.** The honest phrasing is "receipt observed, finality unverified".

---

## 6. Defect found and fixed this session

`npm run gate-a` was failing step 7 and blocking step 8. Root cause was **not** a pruned receipt
alone, and **not** the lookback window (the evidence sits 21,820 blocks back, well inside the
450k lookback — I checked before changing anything).

`https://ethereum-sepolia-rpc.publicnode.com` returns **false negatives with no error**:

```
eth_getTransactionReceipt 0xb90a0771…  → result: null      (tenderly: status 0x1)
findPaymentByReference 0x050562a52ec69fa2
  publicnode → {"found":false,"truncated":true}
  tenderly   → {"found":true,"txHash":"0xb90a0771…"}
```

An empty `eth_getLogs` reads downstream as *"this invoice is unpaid"* — the exact conclusion
that authorises a payment. Fixed in `src/chain.ts`: negatives are re-checked against fallback
endpoints before being believed; positives still cost one pass. `scripts/gate-a.ts` carried a
**private duplicate** of the RPC helper and stayed broken after the shared fix — that
duplication was the bug, and it is now deleted in favour of the shared `rpcCall`.

Result: `10 ok · 0 failed · 2 blocked` (the 2 blocked are the hosted REST convenience API,
documented as a non-dependency).

---

## 7. Integrity risks — highest priority, not code

| # | Item | Why it matters |
|---|---|---|
| 1 | `docs/JUDGE_EVALUATION.md` — self-authored simulated panel scoring 10/10, titled "DoraHacks Judge Panel Evaluation" with an evaluation date | Reads as external validation that was never received. Judging is at repository level. This is a disqualification-grade presentation risk, not a points deduction. |
| 2 | Live console "receipts 38/38" and "references 38/38" shown as two independent chain checks | Both are `liveRows.filter(r => r.tx_hash).length` — one field printed twice |
| 3 | Fixture row C19 renders `0x5i5i5i…` as a live Etherscan link | Not valid hex; a judge clicking it sees a dead link on a verification console |
| 4 | No `<meta name="viewport">` on the console | 208px fixed rail ⇒ loads zoomed-out on a phone |

---

## 8. Status ledger

| Area | Status |
|---|---|
| Request Network integration is real protocol | VERIFIED (reference topic re-derived on-chain) |
| Value moved through KeeperHub, visible on explorer | VERIFIED (38 payments, 1 independently re-checked) |
| Exactly-once machinery present | VERIFIED structurally / adversarially UNPROVEN pending REDTEAM.md |
| Unit tests | VERIFIED 239/239 pass, `tsc --noEmit` clean |
| Gate A end-to-end | VERIFIED green after this session's fix |
| Finality semantics | PARTIAL — receipt observed, depth unverified |
| Live deployment reproducible from repo | **BROKEN** |
| Strongest work visible to judges | **BROKEN** — 2 commits unpushed |
| Demo video meets "shows the integration working" | UNVERIFIED — `docs/demo.mp4` exists (50 MB), not reviewed |
| Transaction link for the submission form | AVAILABLE — Sepolia explorer link to a real KeeperHub execution |
| `fixtures/` directory | EMPTY |
| Standing policy (`REQKEEPER_ALLOWED_PAYEES`/`MAX_DEBIT`) | PARTIAL — unset by default; `.env.example` is honest about it |

---

## 9. Uncommitted working-tree state (preserved, not reverted)

```
 M docs/refusals.json   # generatedAt line only, touched by an audit run
 M scripts/gate-a.ts    # use shared rpcCall, drop private duplicate
 M src/chain.ts         # RPC fallback on negative reads
```

Nothing has been committed or pushed. No irreversible external action has been taken.
