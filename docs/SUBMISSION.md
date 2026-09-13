# DoraHacks BUIDL — copy-paste content

For **KeeperHub: The Agent Economy**, main track: *Best Integration into a Live Project*
($4,000, ranked). Submissions close 18 Sep 2026, 12:00 CEST. Submission requires a DoraHacks
login, so the owner posts this.

Every number below is produced by a command in this repository and checked by
`node --experimental-strip-types scripts/readme-numbers.ts --check`, which fails naming the line
if a figure here stops matching `docs/evidence/`. Do not round, and do not keep a figure you have
not just seen.

---

## The three required things

The rules say an incomplete submission cannot be judged, and name three:

| Required | Link |
|---|---|
| Source code | https://github.com/vaibhav4046/reqkeeper |
| Demo video | https://github.com/vaibhav4046/reqkeeper/releases/tag/v1.0.0 (`demo.mp4`, 95 s) |
| A transaction executed through KeeperHub | [`0x41b01a14…e353f52`](https://sepolia.etherscan.io/tx/0x41b01a14cbdb8dd65c41eeb13285bfe9d47e1dc95990e33b0486ca5e5e353f52) — the one payment three racing workers produced |

Live console: https://reqkeeper.vercel.app · Hosted agent surface:
https://reqkeeper.vercel.app/api/mcp

---

## Name

ReqKeeper

## Tagline

KeeperHub as the execution layer inside Request Network invoicing — one invoice, paid exactly
once, with a human between the agent and the money.

---

## Form answers

### Which project did you integrate with, and what does the integration do?

**Request Network.** A running protocol with users, its own invoice format, its own payment
reference derivation and its own on-chain detection. Not a wrapper: the invoices are raised
through Request's protocol gateway with the official SDK, the payment reference is Request's own
`PaymentReferenceCalculator` output, and reconciliation reads the `ERC20FeeProxy` event log that
Request's own indexer reads.

`npm run gate-a` reads one of this project's invoices back out of Request's node by channel id,
with no credential, and shows its Sepolia storage anchor.

An unpaid Request invoice is what starts the work, KeeperHub executes, and a human sits between them.

1. **An unpaid invoice starts it.** `npm run watch` polls the invoices this deployment knows about and asks
   the chain which are still unpaid. An unpaid Request invoice is what causes a payment proposal
   to exist — no human types a command to start it. The poller passes no approval, and beyond
   that it holds a provider whose every method throws, so it cannot dispatch anything even if a
   later edit let an unapproved plan through.

   Real output, against the 46 live Request invoices this deployment knows about (`docs/request-trigger.txt`):

   ```
   016ff0225b1dd706b7…  0xd9e6ee9360a89ed9  unpaid   AWAITING_APPROVAL

   40 already paid, 1 proposed and waiting on a human, 0 refused. 0 provider writes.
   ```

2. **The agent proposes.** Over MCP, an agent calls `propose_payment` and gets back the exact
   sentence a human must read. There is no approve tool on the surface — not disabled, not
   permission-flagged, absent from the protocol.
3. **A human approves.** `scripts/approve.ts` recomputes the plan hash from the invoice the human
   types and refuses if it differs from what the agent reserved. An approval flow that trusts the
   proposer's own summary is not an approval flow.
4. **KeeperHub executes.** Through two surfaces behind one interface, both proven with money.
5. **The chain and Request both have to agree.** A provider status string is never sufficient:
   settlement needs an independently read receipt *and* the payment reference present in the fee
   proxy's log for that exact transaction and amount.

### Which KeeperHub surfaces did you use?

Two, and it is worth being exact about which, because the other four are named in the question and
this entry does not use them.

| Surface | Used | Evidence |
|---|---|---|
| **Direct-execution REST API** (`/api/execute/contract-call`) | Yes | 38 settlements, `docs/refusals-live.json` |
| **KeeperHub's own MCP server** | Yes | 3 settlements, `docs/evidence/mcp-settlements.json`, each carrying the KeeperHub execution id that produced it and its Sepolia transaction |
| CLI | No | — |
| x402 | No | — |
| MPP | No | — |
| Agent-authored workflows | No | ReqKeeper's plan is derived from the invoice, not authored by the agent; that is the point of the design |
| Audit trail | Read only | Execution ids are read back and recorded against each settlement; nothing here writes to KeeperHub's audit surface |

Both surfaces sit behind one `PaymentProvider` interface and pass the same calldata gate, so the
seam is proven twice rather than once. The three MCP settlements are
`a8h3pjg9wymv0b84xllla`, `wft98bw4s4jzm02ucr21b` and `1i5q3nmtdwx5wnw8paami`.

### Testnet or mainnet?

**Testnet — Sepolia (11155111), paying in FAU**, a faucet token anyone can mint for free. Real
transactions, real receipts, an asset worth nothing. Mainnet chain ids are refused in code, with a
test per chain. No mainnet payment has ever been made from this project.

### What still breaks or is unfinished?

The full list is `hackathon/audit/STATUS.md`. None of these is a duplicate-payment path; each was
checked for that specifically. The five worth a judge's time:

1. **Reorg after settlement is not watched.** Depth is checked before `SETTLED`
   (`REQKEEPER_MIN_CONFIRMATIONS`, default 2); nothing re-checks afterwards. So the honest claim
   is "confirmed by an independently read receipt plus the fee-proxy event for the same
   transaction and amount, at a stated depth" — never "final" or "irreversible".
2. **The 38 recorded settlements predate the depth gate.** They are real payments with real
   receipts. They are not evidence that the depth gate works, and nothing here says they are.
3. **The recorded run under-counts this system's payments.** At least 40 payments have gone
   through KeeperHub; the artifact captures the 38 of one harness run. Found by this project's own
   verification disagreeing with this project's own evidence file — two invoices absent from the
   artifact turned out to be paid on chain at blocks 11,665,974 and 11,665,976.
4. **`transport: "mcp"` is not durable.** `src/settle.ts` writes the same REST endpoint string on
   every attempt whichever provider carries it, so that field is backed by the run that produced
   those rows, not by a record in the store. The execution ids, transactions and blocks beside it
   were read back from KeeperHub and from Sepolia.
5. **A reverted payment cannot be retried under the same obligation.** `EXECUTION_REVERTED` is
   terminal and not replannable, and the obligation keeps its payment reference, so the same debt
   cannot be re-proposed here or under a second obligation without colliding with the uniqueness
   index. Nothing moved — the receipt says status 0 — and the exclusion is deliberate, but the
   only route onward is a fresh Request invoice, which is now what both agent surfaces say.
6. **`payeeOfRecord !== payee` is recorded, not refused.** Request lets an invoice's creditor
   differ from its payment address. An invoice where the two differ is something a human should
   see before settlement, and right now it is only written down.

### Contact

*Owner fills before posting: email, plus an X or Discord handle.* The rules invite up to ten
finalists to present on a call and say finalists are invited by email, so this field is
load-bearing.

---

## The problem it solves

An agent retries. When the thing being retried moves money, the retry is a second payment, and no
layer owns the problem: the agent framework re-runs the tool, the payment rail leaves duplicate
semantics unspecified, and an idempotency cache that forgets a key after 24 hours executes again.
Stripe documents the same 24-hour pruning; this is an industry pattern, not one vendor's bug.

It is not hypothetical. ICON Network, August 2026: a broken uniqueness check let two signed
withdrawal messages replay 1,492 times, releasing 119,866,000 ICX. City of Richmond's auditor,
May 2026: 50 duplicate payments totalling $5,759,563.64, the largest a single $5,092,722.08 wire
processed twice.

And the second half of the problem is the seam itself. KeeperHub accepts no pre-encoded calldata:
it takes `(contractAddress, functionName, functionArgs)` and re-encodes server-side. So **the bytes
a human approved are not the bytes that get signed** — the encoder is downstream of the display,
which is precisely the case clear signing does not catch. ReqKeeper decodes the approved calldata,
re-encodes it locally, and requires byte identity before anything is dispatched.

## Proof

Nothing here rests on this codebase reporting on itself. `npm run verify:all` re-derives every
figure below from `docs/evidence/*.json` and public Sepolia RPCs, **with no credentials**, and
writes `docs/TRUTH.md`.

- **38 real payments on Sepolia. 38 replays refused. 0 sends by those replays.**
- **45 live refusals before any provider write**, 83 rows in total, at zero gas.
- **50 concurrent worker processes** against one obligation, each its own OS process on one SQLite
  file, released by a barrier: 1 broadcast, 1 transaction, 0 duplicates. Exactly-once is
  ReqKeeper's, not KeeperHub's idempotency cache — 1 post reached the provider and 0 were deduped
  by key, because the losers never got that far.
- **3 workers against real KeeperHub and real Sepolia**: one payment, reference
  `0xd9e6ee9360a89ed9`, and live the chain is the counter — one fee-proxy event carrying that
  reference is one payment, which is the same query Request's own detection runs.
- **9 crash checkpoints**, a real `SIGKILL` at each, kill points driven from outside `src/`: zero
  duplicate payments.
- **46 of 46 payment references** re-derive from `last8Bytes(keccak256(lowercase(requestId + salt + paymentAddress)))`.
- `npm run harness` — 26 fault-injection cases, asserted against a provider that counts physical
  sends rather than reporting a status string.
- 506 unit tests, `tsc --noEmit` clean, CI runs typecheck, tests and a build with a clean-tree
  check on every push.

## What is honest about it

The README concedes, in its own "When you should not use this" section, that **MetaMask's Delegation Framework already ships both
of these gates on-chain and that is better**: `IdEnforcer` keeps a BitMap of used ids,
`ExactCalldataEnforcer` requires `keccak256(termsCallData) == keccak256(callData)`. If your payer
can be an ERC-7710 delegator smart account, use those. This exists for the payer that has no
delegation to attach a caveat to — which is not the same as "not a smart account". This
deployment's own funding account is an EIP-7702 delegated EOA (`eth_getCode` returns
`0xef0100955d84…`); what it lacks is an ERC-7710 delegation carrying enforcers, and the payment is
a `transferFrom` broadcast by a relayer, so no caveat sits in the path.

It also carries a published retraction of a platform bug that did not reproduce when probed, a
self-reported bug the harness found in this codebase, and a limitations list that includes the
sharpest one — the policy gate is only as strong as the operator's standing policy.

## Tech

Node 24, TypeScript with `--experimental-strip-types`, `node:sqlite`. **Zero runtime dependencies**
in `src/` and `scripts/` — the ABI codec and keccak-256 are implemented here and tested
byte-for-byte against KeeperHub's own ethers 6.17.0 output. The only dependency in the project is
the official Request SDK, isolated in `tools/invoice/`, used once to raise invoices.

Sepolia (11155111). ERC20FeeProxy `0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE`, FAU
`0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C`.

---

## Bounty — a separate BUIDL

*Best KeeperHub Feature ($1,000, two winners at $500 each).* The rules are explicit that **a BUIDL
can only be applied to one track**, and that the bounty stacks with the main track, so this is a
second BUIDL pointing at a pull request, not a re-post of the entry above.

**Pull request:** https://github.com/KeeperHub/keeperhub/pull/2372 — *fix: #1840 release the
idempotency key on a definite failure*.

Judged on mergeability, value to the platform, code quality and tests, and scope. Against those:

- **Mergeability.** Scoped to the disposition decision and its tests. It deliberately does *not*
  refactor the write core — that would force a full re-review inside the submission window, and
  mergeability is the bounty's first criterion.
- **Value.** The bug is the one this whole entry is about, seen from inside the platform: an
  execution whose transaction may already have landed was being settled as `failed`, and `failed`
  releases the idempotency key. Releasing it invites the retry that broadcasts a second
  transaction from the same wallet. The fix keeps such an execution `unconfirmed` so the
  reconciler settles it from the chain instead.
- **Tests.** 9 new cases in `tests/unit/execute-protocol-idempotency-disposition.test.ts`, 17 in
  the file in total, each pinning one disposition.
- **Scope.** The disposition logic, the two documentation passages that contradicted it, and a
  stale comment. Nothing else.

## Before posting

- [ ] `npm test`, `npm run verify:all`, `node --experimental-strip-types scripts/readme-numbers.ts --check`
- [ ] the released video is the current cut and shows no credential in any frame
- [ ] https://reqkeeper.vercel.app and `/api/mcp` both answer
- [ ] the repository is public and `git status` is clean
- [ ] register as a hacker (separate action from submitting), and apply to the bounty on its own
      bounty page
- [ ] contact field filled with a real email and handle
