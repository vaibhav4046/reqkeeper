# DoraHacks BUIDL — copy-paste content

For **KeeperHub: The Agent Economy**, main track: *Best Integration into a Live Project*.
Deadline 18 Sep 2026 11:00 UTC. Submission requires a DoraHacks login, so the owner posts this.

Every number below is produced by a command in this repository. If one is stale, run the
command and change it — do not round, and do not keep a figure you have not just seen.

---

## Name

ReqKeeper

## Tagline

KeeperHub as the execution layer inside Request Network invoicing — one invoice, paid exactly
once, with a human between the agent and the money.

## The live project

**Request Network.** A running protocol with users, its own invoice format, its own payment
reference derivation and its own on-chain detection. Not a wrapper: the invoices are raised
through Request's protocol gateway with the official SDK, the payment reference is Request's
own `PaymentReferenceCalculator` output, and reconciliation reads the `ERC20FeeProxy` event log
that Request's own indexer reads.

`npm run gate-a` reads one of this project's invoices back out of Request's node by channel id,
with no credential, and shows its Sepolia storage anchor.

## What the integration does

Request triggers, KeeperHub executes, and a human sits between them.

1. **Request triggers.** `npm run watch` polls the invoices this deployment knows about and asks
   the chain which are still unpaid. An unpaid Request invoice is what causes a payment proposal
   to exist — no human types a command to start it. The poller passes no approval, and beyond
   that it holds a provider whose every method throws, so it cannot dispatch anything even if a
   later edit let an unapproved plan through.

   Real output, against 41 live Request invoices (`docs/request-trigger.txt`):

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
4. **KeeperHub executes.** Through two different surfaces behind one interface: the REST
   direct-execution API and KeeperHub's own MCP server. Both go through the same calldata gate.
5. **The chain and Request both have to agree.** A provider status string is never sufficient:
   settlement needs an independently read receipt *and* the payment reference present in the fee
   proxy's log for that exact transaction and amount.

## The problem it solves

An agent retries. When the thing being retried moves money, the retry is a second payment, and
no layer owns the problem: the agent framework re-runs the tool, the payment rail leaves
duplicate semantics unspecified, and an idempotency cache that forgets a key after 24 hours
executes again. Stripe documents the same 24-hour pruning; this is an industry pattern, not one
vendor's bug.

It is not hypothetical. ICON Network, August 2026: a broken uniqueness check let two signed
withdrawal messages replay 1,492 times, releasing 119,866,000 ICX. City of Richmond's auditor,
May 2026: 50 duplicate payments totalling $5,759,563.64, the largest a single $5,092,722.08 wire
processed twice.

And the second half of the problem is the seam itself. KeeperHub accepts no pre-encoded calldata:
it takes `(contractAddress, functionName, functionArgs)` and re-encodes server-side. So **the
bytes a human approved are not the bytes that get signed** — the encoder is downstream of the
display, which is precisely the case clear signing does not catch. ReqKeeper decodes the approved
calldata, re-encodes it locally, and requires byte identity before anything is dispatched.

## Proof

Nothing here rests on this codebase reporting on itself.

- **38 real payments on Sepolia. 38 replays refused. 0 sends by those replays.**
- **45 live refusals before any provider write**, 83 rows in total.
- `npm run verify:live` re-derives every one from a public RPC in about seven seconds, **with no
  credentials**: 38/38 receipts successful, 38/38 references present in the fee-proxy log, each
  for exactly 1000000000000000000 base units.
- `npm run harness` — 26 fault-injection cases, 26 as specified, 18 of the 24 refusals happening
  before any provider write, asserted against a provider that counts physical sends rather than
  reporting a status string.
- 239 unit tests, `tsc --noEmit` clean, CI runs all three on every push.

Sepolia, paying in FAU — a faucet token anyone can mint for free. Real transactions, real
receipts, an asset worth nothing. Mainnet is refused in code, with a test per chain.

## What is honest about it

The README concedes, in its first screen, that **MetaMask's Delegation Framework already ships
both of these gates on-chain and that is better**: `IdEnforcer` keeps a BitMap of used ids,
`ExactCalldataEnforcer` requires `keccak256(termsCallData) == keccak256(callData)`. If your payer
can be an ERC-7710 delegator smart account, use those. This exists for the payer that cannot be:
a custodial or relayed EOA, where there is no smart account to attach a caveat to.

It also carries a published retraction of a platform bug that did not reproduce when probed, a
self-reported bug the harness found in this codebase, and a limitations list that includes the
sharpest one — the policy gate is only as strong as the operator's standing policy.

## Links

- **Live console:** https://reqkeeper.vercel.app
- **Hosted agent surface (MCP over HTTP):** https://reqkeeper.vercel.app/api/mcp — four read-only
  tools. No tool there can move money; approval belongs next to a human, not behind a URL.
- **Repository:** https://github.com/vaibhav4046/reqkeeper
- **Demo video:** a release asset, not committed — six cuts of it were 72 MB of this repository
- **Evidence:** `docs/refusals-live.json` — all 83 rows

## Tech

Node 24, TypeScript with `--experimental-strip-types`, `node:sqlite`. **Zero runtime
dependencies** in `src/` and `scripts/` — the ABI codec and keccak-256 are implemented here and
tested byte-for-byte against KeeperHub's own ethers 6.17.0 output. The only dependency in the
project is the official Request SDK, isolated in `tools/invoice/`, used once to raise invoices.

Sepolia (11155111). ERC20FeeProxy `0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE`, FAU
`0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C`.

---

## Bounty — a separate BUIDL

*Best KeeperHub Feature ($1,000, two winners)* is a different BUIDL and a mergeable pull request
to the KeeperHub repository. A BUIDL can only enter one track, so the main-track entry above must
not be reused for it.

## Before posting

- [ ] `npm test`, `npm run harness`, `npm run verify:live` — re-read every number above
- [ ] the released video is the current cut and shows no credential in any frame
- [ ] https://reqkeeper.vercel.app and `/api/mcp` both answer
- [ ] the repository is public and `git status` is clean
