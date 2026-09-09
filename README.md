# ReqKeeper

**Exactly-once settlement of Request Network obligations through KeeperHub.**

Your agent proposes. You approve the exact bytes. KeeperHub executes. ReqKeeper refuses the
second payment.

- **Integrated project:** [Request Network](https://request.network) — invoices on Ethereum Sepolia
- **Execution:** KeeperHub direct execution (`/api/execute/contract-call`)
- **Network:** Ethereum Sepolia (11155111). Testnet only, deliberately. Mainnet is disabled in code.
- **Cost to run:** $0. No paid API, no card. `src/` and every `scripts/` entry have zero
  dependencies; the one-time invoice-creation step in `tools/invoice/` uses the official
  Request SDK, and is separate for exactly that reason.
- **Credentials needed:** one. A KeeperHub API key. No Request Client ID — see below.

---

## The problem, in one paragraph

An agent retries. That is the defining property of an agent harness. When the thing being
retried moves money, a retry is a second payment, and nothing in the stack owns the problem:

| Layer | Its position |
|---|---|
| Wallet SDK | [`coinbase/agentkit#1483`](https://github.com/coinbase/agentkit/issues/1483) — "With no idempotency key, a retry is a second, independently valid transaction… Nothing in either response marks it as a duplicate." The key already exists in the CDP SDK signature; the one call path that moves value does not pass it. |
| Agent framework | [`crewAI#5802`](https://github.com/crewAIInc/crewAI/issues/5802) — `stripe.charge(amount, recipient)  # fires twice on retry` |
| Orchestrator | [`langgraph#7417`](https://github.com/langchain-ai/langgraph/issues/7417) — tool calls over ~3 minutes "silently re-dispatched from the last checkpoint while the original is still running" |
| Payment rail | [`x402#452`](https://github.com/x402-foundation/x402/issues/452) — "the spec never states how facilitators must deal with duplicate requests". [`#1805`](https://github.com/x402-foundation/x402/issues/1805) — 5 concurrent requests, **4 got the same settlement proof**, duplicate debits refunded after the fact |
| Execution layer | KeeperHub's own docs: idempotency "replay lasts 24 hours… Past that the stored response is gone and **the same key executes again, silently**" |

KeeperHub owns reliability *within* a run. Nothing owns obligation identity *across* runs.
That gap is what this fills.

## Why Request Network specifically

**The invoice is the idempotency key.** Every Request invoice carries a canonical request id
and a 16-character payment reference embedded in the calldata. That is a stable obligation
identity issued by an external system — it survives a payer wallet change, an API key
rotation, a re-import, regenerated calldata, and the 24-hour replay expiry.

We did not invent an identity scheme. Request already ships one.

And the loop closes without fabrication: pay with the reference embedded, and Request's own
payment detection flips the invoice to paid. `SETTLED` requires **both** an independently read
`eth_getTransactionReceipt` **and** Request's `hasBeenPaid`. A provider status string is never
sufficient.

---

## The approved bytes are not the signed bytes

This was found by probing the live API, and it is the sharpest edge in the composition.

Request Network hands you **finished calldata**. `GET /request/{id}/pay` returns
`{to, data, value}`, fully encoded, payment reference embedded.

KeeperHub will not send finished calldata. Probed on 2026-09-09, with the refusals printed
verbatim by `npm run verify:seam`:

```
contract-call, data      -> HTTP 400 {"error":"Missing required field","field":"functionName"}
contract-call, callData   -> HTTP 400 {"error":"Missing required field","field":"functionName"}
raw route                 -> HTTP 400 {"error":"Invalid action type: raw"}
transaction route         -> HTTP 400 {"error":"Invalid action type: transaction"}
```

The only write surface is `(contractAddress, functionName, functionArgs)`, and KeeperHub
re-encodes it against an ABI **it** resolves, using ethers 6.17.0. So between "the human
approved these bytes" and "the signer signed these bytes" there is a decode step, a transport,
and a re-encode performed by the execution platform on an ABI nobody in the approval loop saw.

That is not a hypothetical. It is the ordinary path for paying a Request invoice through
KeeperHub, and it is invisible unless you go looking.

**What ReqKeeper does about it.** [`src/abi.ts`](src/abi.ts) decodes the approved calldata and
re-encodes it locally; the arguments are dispatched only if the re-encode is byte-identical to
what was approved. Anything else refuses, non-retryably, before a single network call:

| Smuggled variant | Refusal |
|---|---|
| trailing bytes appended after the arguments | `calldata_mismatch` |
| a selector that is not on the allowlist | `selector_not_allowed` |
| dirty high bytes packed above an address | `calldata_mismatch` |

The codec is deliberately tiny and refuses every type it does not implement, because a codec
that silently mis-encodes an argument is worse than none — it fails the byte-comparison that
was supposed to be the safety net. Its correctness is not self-asserted: `npm test` checks it
against **KeeperHub's own encoder output**, captured byte-for-byte from a live simulate's
revert payload. Two independent implementations, same 260 bytes.

### And the `to` address is not the contract you named either

Reading a real executed transaction back off the chain shows a second layer of the same thing.
Asking KeeperHub to call `mint` on FAU produced tx
[`0x5b722787…`](https://sepolia.etherscan.io/tx/0x5b722787ce6523d7d0d7094a4d82159809c06a395bf990bce90b107712040a74)
(Sepolia block 11664587), and what actually got signed was:

| Field | Value | What was approved |
|---|---|---|
| `tx.from` | `0x809d8252…` | — a KeeperHub relayer, not the payer |
| `tx.to` | `0x5af5194b…` (3963-byte contract) | FAU, `0x370DE27f…` |
| selector | `0x9aefaff8` on the forwarder | `0x40c10f19` — `mint(address,uint256)` |
| gas payer | the relayer, 0.000119 ETH | — |

The named call survives, but as an *inner payload*: a 65-byte ECDSA signature (v=`0x1c`)
followed by `0x40c10f19` and its arguments, submitted to a forwarder by a relayer that pays
the gas. So `(to, data)` as approved never appears in a transaction anywhere. Only the
resulting `Transfer(0x0 → payer, 100e18)` log proves the intended call happened.

Two consequences worth stating plainly:

- **Gas is sponsored.** The payer's balance is untouched by an execution. A funded payer
  wallet is not a precondition for a contract call, contrary to what this project assumed
  before measuring it.
- **`msg.sender` is still the payer.** This mattered enough to test before relying on it:
  after an `approve` through KeeperHub, `allowance(payer → ERC20FeeProxy)` reads `100e18`
  on-chain while `allowance(forwarder → proxy)` stays `0`. Had it been the other way, a
  Request payment could never settle through this route at all.

This is why `SETTLED` requires an independent `eth_getTransactionReceipt` and Request's own
`hasBeenPaid`. There is no point at which a returned status string is the evidence.

---

## What another team should look at first

Six files, in the order that explains the design:

| File | Why it matters |
|---|---|
| [`src/identity.ts`](src/identity.ts) | The three identities: obligation, plan, step. All derived from persisted state — no clock, no randomness, no generated text ever enters a key. |
| [`src/money.ts`](src/money.ts) | Exact fixed-point money. Throws rather than truncating. |
| [`src/abi.ts`](src/abi.ts) | The calldata integrity gate. Verified against ethers 6.17.0. |
| [`src/settle.ts`](src/settle.ts) | The dispatch protocol. **The order of checks is the safety property.** |
| [`src/store.ts`](src/store.ts) | Transactional outbox, job leases, fencing generations. |
| [`scripts/harness.ts`](scripts/harness.ts) | The refusal table. This is the deliverable. |

## Run it

Needs Node 24+. Nothing else — no `npm install`, no `node_modules`.

```bash
npm test                  # 128 unit tests
npm run harness           # 24 refusal cases -> docs/refusals.json
npm run verify:onchain    # reads Sepolia via public RPC, no credentials
npm run verify:seam       # proves the calldata gate against the live API (needs the KeeperHub key)
npm run settle:live       # settles one real Request obligation; run twice to see the refusal
```

`verify:onchain` needs no wallet, no account and no API key. It independently confirms the
addresses and selectors this build depends on:

```
chain id: 11155111
  ok   ERC20FeeProxy is a contract — 0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE, 2165 bytes
  ok   FAU (FaucetToken, 18dp) is a contract — 0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C, 3044 bytes
  ok   ERC20FeeProxy answers 0xc219a14d — transferFromWithReferenceAndFee
  ok   FAU answers 0x40c10f19 — mint(address,uint256)
  ok   FAU reports 18 decimals · FakeUSDC reports 6 decimals
```

Worth running before anything else: a widely repeated answer online gives Request's
ERC20FeeProxy as `0x370DE27f…`, which is actually the FAU **token**. Both are deployed. They
are different contracts. This script tells you so.

## Live on Sepolia: one obligation, paid once

A real Request invoice, paid through KeeperHub by the same `settle()` function that produces
the 24 refusals. `npm run settle:live` reproduces it, and running it **twice** is the point.

```
requestId        : 011a5eca74adfa1e61276d5d3b3c41339c2daddaaa406b6f1b7344c2a4679a2403
paymentReference : 0x3ad3fe6653fb8827
obligationId     : 3a79273eb6cab086a787cf5bbee3864982acda2e61b44875fdc6562e6e662f8d
```

| Run | State | Refusal | Provider write | Tx |
|---|---|---|---|---|
| **1st** | `SETTLED` | — | `true` | [`0x134f352d…`](https://sepolia.etherscan.io/tx/0x134f352dc69843105a01d1b9d6cc9799b660bd28e08920144bb67cb3852bfeff) |
| **2nd** | `SETTLED` | `ALREADY_SETTLED` | **`false`** | *nothing sent* |

> `obligation is already SETTLED; nothing to do and nothing sent`

The second run is the entire product. Same obligation, same approved plan, a fresh process, and
no second payment.

Duplicate protection is layered, and the layers refuse at different distances from the money:

| Guard | Fires when | Refusal |
|---|---|---|
| terminal-state check | the obligation already settled | `ALREADY_SETTLED` — refuses before a plan is even built |
| `UNIQUE(plan_hash, step_index)` + `firstSendAt` | a plan's step was already sent but the outcome is unresolved | `ALREADY_DISPATCHED` — harness case C24 |
| `UNIQUE(obligation_id)` reservation | a rival plan holds the same obligation | `OBLIGATION_RESERVED` |

All three live in the local store, so all three outlive the provider's 24-hour idempotency
window rather than depending on it.

**The approval sentence a human actually signed off**, derived from the same values as the
calldata at the same moment:

> Pay 1 FAU to 0xc43d766cb7c48b9b198db87441b97c09e81717a1 on chain 11155111, plus 0 fee.
> Total leaving the wallet: 1 FAU (1000000000000000000 base units).

**Three independent confirmations**, because a provider's status string is never evidence:

| Source | Says |
|---|---|
| `eth_getTransactionReceipt` | `success`, `verified=true`, `gasUsed=74618` |
| ERC20FeeProxy event log | reference `0x3ad3fe6653fb8827` for exactly `1000000000000000000` |
| Request Network's own detection | `balance: 1000000000000000000`, 1 payment event, `hasBeenPaid: true` |

Setup executions, also live and also verified by reading the chain:

| What | Transaction | Verified by |
|---|---|---|
| mint 100 FAU to the payer | [`0x5b722787…`](https://sepolia.etherscan.io/tx/0x5b722787ce6523d7d0d7094a4d82159809c06a395bf990bce90b107712040a74) | `Transfer(0x0 → payer, 100e18)`, block 11664587 |
| approve ERC20FeeProxy | [`0x0e6b631a…`](https://sepolia.etherscan.io/tx/0x0e6b631ad0071e33c1d94601cbbafa4f0f0ac5d64926f84043c71bf148b88d61) | `allowance(payer → proxy)` reads `100e18` |

Payer: [`0x027D54A6…`](https://sepolia.etherscan.io/address/0x027D54A692e0e80173141777BdB847c1726FA1F3)
— KeeperHub's own Turnkey wallet, not a browser wallet.

### No Request Client ID was used

Request's v2 REST API requires one, and it is only obtainable by hand: sign into the dashboard
with a wallet, then generate it *inside a payment destination's settings*. The protocol itself
requires nothing — `sepolia.gateway.request.network` accepts `persistTransaction` unauthenticated
— so [`tools/invoice/`](tools/invoice/) creates the invoice there, signing with a burner keypair
generated on the spot. The whole demo runs on **one** credential: the KeeperHub API key.

## The agent surface, and the one thing it cannot do

[`src/mcp.ts`](src/mcp.ts) is an MCP server over stdio. Five tools:

| Tool | What an agent can do |
|---|---|
| `propose_payment` | build a plan, get back the sentence a human must read. Never dispatches. |
| `settle_obligation` | settle an obligation a human already approved. Cannot pay twice. |
| `obligation_status` | state and full audit trail |
| `verify_payment` | confirm a payment from the chain, without asking the provider |
| `refusal_codes` | the refusal vocabulary, each with do-not-retry guidance |

**There is no approve tool.** Not a disabled one, not one behind a permission flag — the
capability is absent from the protocol surface. An agent connected to this server cannot, by
any sequence of calls, authorise money to move. Approval is written only by
[`scripts/approve.ts`](scripts/approve.ts), a separate human CLI the server neither exposes
nor can invoke.

`test/mcp.test.ts` asserts the absence, including that the handler refuses `approve`,
`approve_payment`, `record_approval`, `authorize` and `sign_plan` if a client guesses at them.
An agent calling `settle_obligation` twenty-five times before a human has decided moves
nothing — the test asserts `totalSends() === 0`.

And the approval CLI does not accept a plan hash. It **recomputes** one from the invoice
facts you type and compares it against the plan the agent actually reserved:

Asking it to approve 5 FAU for an obligation whose plan says 1 FAU:

```
REFUSED: the plan reserved for this obligation is not the plan these arguments describe.
  reserved by : be7830f4d60c3e9f9a409faf680d51840a93ff8a55922a4e72a9470c3d0a579b
  you typed   : 7fbdadaff7d772ad7f73659f15bce30eb94b03a3b383cb9bdeeeaa34bd76e032

Something proposed a different payment than the one you are approving. Investigate
before recording any decision.
```

An approval flow that trusts the proposer's own summary of what it proposed is not an
approval flow. That is why the CLI takes the invoice rather than an id.

```jsonc
// register with any MCP client
{ "mcpServers": { "reqkeeper": {
    "command": "node",
    "args": ["--experimental-strip-types", "scripts/mcp-server.ts"],
    "cwd": "/path/to/reqkeeper" } } }
```

## The refusal table


Generated by `npm run harness`, written to [`docs/refusals.json`](docs/refusals.json).
24 cases, 24 as specified, **16 of 22 refusals happen before any provider write**.

The provider used here counts *physical sends*, so "0 gas burned" is asserted against a
number rather than inferred from a status string.

| Case | Scenario | Refusal | Sends |
|---|---|---|---|
| C01 | clean approved obligation | `SETTLED` | 1 |
| C02 | recipient not allowlisted | `PAYEE_NOT_ALLOWED` | 0 |
| C04 | invoice under cap that a **fee** pushes over | `LIMIT_EXCEEDED` | 0 |
| C07 | token decimals differ from policy | `TOKEN_DECIMALS_MISMATCH` | 0 |
| C12 | no human decision yet | `AWAITING_APPROVAL` | 0 |
| C14 | source facts changed after approval | `PLAN_CHANGED` | 0 |
| C15 | rival plan holds the obligation | `OBLIGATION_RESERVED` | 0 |
| C17 | cached failure replays forever (#1840) | `CACHED_FAILURE` | 0 |
| C19 | dry run actually executed (#1959) | `SIMULATE_EXECUTED` | 1 |
| C21 | provider claims success, chain has no receipt | `EVIDENCE_CONFLICT` | 1 |
| **C23** | **replay 25h later, provider cache expired** | `PLAN_EXPIRED` | **1** |
| **C24** | **replay inside plan TTL, provider cache expired** | `ALREADY_DISPATCHED` | **1** |

C23 and C24 are the thesis. The send count does not move across a replay.

**C24 found a real bug in this codebase.** A plan still inside its TTL whose provider
idempotency cache had lapsed re-entered dispatch, reused the same attempt row, called
`execute()` again — and the provider, having forgotten the key, paid a second time. The guard
is now on `firstSendAt` in `src/settle.ts`, and C24 exists so it cannot regress.

## Three platform hazards, modelled explicitly

Each one is documented and money-critical, not hypothetical. Each has a fault injection in
[`src/provider.ts`](src/provider.ts).

| Hazard | Source | Defence |
|---|---|---|
| Replay window expires at 24h, same key silently executes again | `docs.keeperhub.com/api/direct-execution` | `UNIQUE(obligation_id)` + `firstSendAt` guard, both outliving the provider cache |
| Reused key replays a **cached failure**, so retry can never succeed | issue #1840 | Distinguished from "unpaid". Requires a new approved plan — never a key rotation |
| `?simulate=true` is ignored and the transaction really executes | issues #1959 / #1929 | A dry run is not treated as a safety boundary. A tx hash returned from a simulate call is `EVIDENCE_CONFLICT` and treated as a real send |

### Retraction: #1959 did not reproduce

Probed live on 2026-09-09 against `POST /api/execute/transfer` with `simulate: true` from a
zero-balance wallet. The response was a correct dry run — `{"status":"simulated",
"wouldRevert":true,"code":"insufficient_balance","balanceWei":"0"}` — with **no transaction
hash and no execution**.

So the hazard behind harness case `C19` is **modelled, not observed**. Either the issue is
fixed at this version, or it only affects the protocol-action route, which was not probed.
The defensive check stays in `src/settle.ts` because it costs nothing and a returned hash
would be unambiguous evidence of a real send — but this codebase does not claim the bug is
live, and `C19` is labelled accordingly.

Stated here rather than quietly dropped: the claim was made earlier in this project's notes
on the strength of the issue tracker alone, and the live API contradicts it.

That third one is why the bounty PR and this product are the same body of understanding.

---

## Honest limitations

These are published because they are true, and because vague claims poison the credible ones.

1. **Duplicate protection is deployment-scoped.** It prevents a second successful payment of
   the same canonical Request obligation *through this deployment*. It cannot stop an
   independent wallet, another deployment, or a human paying the invoice out of band.
2. **No semantic dedup across request ids.** Two different Request ids may represent the same
   real-world invoice. Not detected.
3. **Revocation is not an onchain undo.** Already-broadcast work completes. Cancellation only
   stops unsent actions.
4. **The audit trail is tamper-evident, not tamper-proof.** The same database administrator
   can rewrite it. It is not blockchain evidence and is not described as such.
5. **`simulate` is not a safety boundary on KeeperHub today.** ReqKeeper asserts around the
   bug; it does not fix the platform.
6. **A restored older database can forget broadcasts** that happened after the backup.
   Restored environments must start with writes disabled pending reconciliation.
7. **Sepolia only.** Request supports no other testnet. Untested on mainnet, by design.
8. **Single-operator mode.** The owner reviews their own proposal and it is labelled as such.
   An agent credential can never approve, in any mode.
9. **No prompt-injection detection.** A guarded signer enforces a declarative policy. It does
   not detect injection, and does not claim to.
10. **Approval fatigue is real and not solved here.** Measured over 11,429 reviews across 7
    months, approval rates drift 30.1% → 36.8% while inline comments fall 22% (p=0.0014,
    arXiv 2606.22721). This design reduces prompt *count* — one approval per policy,
    escalating only on objective risk lanes — rather than pretending a per-action queue is safe.

## What is not done

Stated plainly rather than left for a reviewer to discover.

- **The 24 harness rows are still `FIXTURE`.** One obligation has settled live and refused a
  live replay, but the other 23 scenarios — a lapsed replay window, a cached provider failure,
  a rival plan holding the obligation — are reproduced against `FixtureProvider`, because
  provoking them for real would mean deliberately paying twice. The refusal *logic* is the same
  code in both cases; the fault injection is not.
- **The live settlement used a burner payee.** The invoice's payee is a keypair generated by
  `tools/invoice/`, not a counterparty. That is what makes it reproducible by a stranger, but it
  does mean no third party has confirmed receipt.
- **`Idempotency-Key` is accepted by KeeperHub but its behaviour is unconfirmed.** The header is
  sent on every execution and the API does not reject it. Whether it actually deduplicates
  cannot be tested without deliberately paying twice, so no claim is made about it here — which
  is the entire reason duplicate protection lives in this codebase's `UNIQUE(obligation_id)` and
  `firstSendAt` guard rather than depending on the provider's.
- No frontend yet. No demo video yet.
- The bounty PR for #1959/#1929 is not opened.

Everything claimed above is reproducible by running the commands in "Run it". Everything not
claimed is in this section.

## Architecture

```
src/money.ts       exact fixed-point money, uint256-safe
src/keccak.ts      Keccak-256 (Node ships sha3-256, which is NOT this)
src/abi.ts         minimal ABI codec + the calldata integrity gate
src/identity.ts    obligation / plan / step identities, canonical JSON
src/policy.ts      deterministic gate -> 9 refusal codes
src/machine.ts     24 states, one transition table
src/store.ts       node:sqlite, 6 tables, outbox, leases, fencing
src/provider.ts    execution boundary + fault injection
src/keeperhub.ts   the live provider; independent receipt reads
src/settle.ts      the dispatch protocol
scripts/           harness, on-chain verification, seam verification
docs/MASTER.md     full build spec, evidence status, source register
```

Zero dependencies. TypeScript runs directly under Node's strip-only type erasure; tests use
`node:test`; persistence uses `node:sqlite`.

## Licence

MIT.
