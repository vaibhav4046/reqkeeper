# ReqKeeper

**Exactly-once settlement of Request Network obligations through KeeperHub.**

Agents can retry code. They must never retry money. ReqKeeper lets an agent retry a Request
invoice without paying it twice.

## 1 invoice. 50 workers. 1 payment.

```
payments broadcast              1
posts reaching the provider     1    the losing workers never got that far
deduped by idempotency key      0    KeeperHub's cache was not what stopped them
duplicate payments              0
second wave broadcasts          0    same plan, same key, after every process exited
```

Fifty independent OS processes — own process, own SQLite connection, no shared memory — settling
the same obligation against one database file, released from a barrier onto the same millisecond.
Run it: `npm run race -- --workers 50`. Artifact: [`docs/evidence/race.json`](docs/evidence/race.json).

**`posts: 1` is the number that matters.** Every worker computes the same idempotency key, because
it is derived from the obligation and the approved plan with no session input. So a run that only
showed KeeperHub refusing a duplicate key would prove KeeperHub's cache works and say nothing
about this project. The fixture counts *every* call that reaches it regardless of key and reports
the deduplicated ones separately — the losers were stopped locally, by the reservation and the
compare-and-set, before the provider was ever called.

### And once for real

The same race, three workers, against real KeeperHub and real Sepolia:
**one payment**, transaction
[`0x41b01a14…353f52`](https://sepolia.etherscan.io/tx/0x41b01a14cbdb8dd65c41eeb13285bfe9d47e1dc95990e33b0486ca5e5e353f52),
block 11,691,069. Exactly one `TransferWithReferenceAndFee` event carries that invoice's
reference. Artifact: [`docs/evidence/race-live.json`](docs/evidence/race-live.json).

Live, the payment count comes from the chain, not from a counter we own — and the two fields a
fixture can measure and a live run cannot (`postsReachingTheProvider`, `dedupedByKey`) are
recorded as `-1` rather than `0`, because `0` would read as the strongest claim on the page and
this run cannot make it.

### Both KeeperHub surfaces, both with money behind them

38 settlements through the REST direct-execution API, and **3 through KeeperHub's own MCP
server** — `execute_contract_call` with `simulate: true` first, then with `idempotency_key`, then
`get_direct_execution_status` called once for each execution id. That status is recorded, not
trusted: settlement is decided by an independently read receipt and the fee-proxy event for the
same transaction and amount. Each MCP row carries the KeeperHub execution id that produced it:

| execution id | transaction | block |
|---|---|---|
| `a8h3pjg9wymv0b84xllla` | [`0xe02fd64c…`](https://sepolia.etherscan.io/tx/0xe02fd64ced29c8e147817077c66eeac6b71b23a629dac6a3f33d73fcd8959119) | 11,691,257 |
| `wft98bw4s4jzm02ucr21b` | [`0xfe4b0168…`](https://sepolia.etherscan.io/tx/0xfe4b0168d7add3aeeae73a421f0821fa6aab789756960da11f1aeab015a7a0b9) | 11,691,260 |
| `1i5q3nmtdwx5wnw8paami` | [`0xf206bbaa…`](https://sepolia.etherscan.io/tx/0xf206bbaa9e25309b4c12643dda998b360014136f4a9bc911bc92d70a769bc940) | 11,691,264 |

Exactly one fee-proxy event per reference, verified from the chain by `npm run verify:all`, not
read back from the file that reports them. Artifact:
[`docs/evidence/mcp-settlements.json`](docs/evidence/mcp-settlements.json).

- **Console:** <https://reqkeeper.vercel.app> · **Agent surface:** <https://reqkeeper.vercel.app/api/mcp>
- **Demo video:** no narration, every figure in it read from `docs/evidence/` at render time — [v1.0.0 release asset](https://github.com/vaibhav4046/reqkeeper/releases/tag/v1.0.0) (not committed; six cuts of it were 72 MB of this repository)
- **Every claim, with its evidence:** [`docs/TRUTH.md`](docs/TRUTH.md) (generated, never typed)
- **Every open finding:** [`hackathon/audit/STATUS.md`](hackathon/audit/STATUS.md)

## When you should not use this

If your payer can be an ERC-7710 delegator smart account, **use MetaMask's Delegation Framework
instead — it ships both of these gates on-chain and that is strictly better.** `IdEnforcer` keeps
a BitMap of spent ids, and `ExactCalldataEnforcer` requires
`keccak256(termsCallData) == keccak256(callData)`. On-chain enforcement cannot be bypassed by a
bug in software like this one.

ReqKeeper exists for the payer that has no delegation to attach a caveat to. That is not the same
as "not a smart account", and this deployment is the proof: its funding account
`0x027d54a6…` answers `eth_getCode` with `0xef0100955d84…`, an EIP-7702 delegation designator, so
it *is* code-bearing. What it does not have is an ERC-7710 delegation with enforcers on it. The
tokens move by `transferFrom` under an allowance, broadcast by KeeperHub's relayer
(`0x809d8252…`, `eth_getCode` = `0x`), so there is no caveat in the path to enforce and nothing
on-chain that can refuse a second payment. The gate has to live where the decision is made.

Read both accounts yourself, no credentials needed:

```bash
curl -s https://ethereum-sepolia-rpc.publicnode.com -H 'content-type: application/json'   -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0x027d54a692e0e80173141777bdb847c1726fa1f3","latest"]}'
```

## Verify without credentials

```bash
npm run verify:all
```

No API key, no wallet, no `.env`. It reads local evidence and public Sepolia RPCs, imports no
provider, and cannot move money. Anything needing a credential is reported BLOCKED with the
reason — never silently skipped, never counted as a pass.

Totals are **recomputed from rows**, never read from a summary field: an artifact claiming
`duplicates: 0` in its own header proves nothing, because that is the number a bug gets wrong.
Tamper with a summary and leave its rows alone, and this exits 1.

Last run: **22 ok · 0 failed · 0 blocked**, including — checked against the chain with no credentials — a
successful receipt for `0xb90a0771…` at block 11,665,983, the ERC20FeeProxy event inside that
receipt's own logs, that same payment found again by its reference through the event query
Request's own detection uses, and **46 of 46** recorded payment references re-deriving from
`last8Bytes(keccak256(lowercase(requestId + salt + paymentAddress)))`.

## Run everything else

`verify:all` and `npm test` need no install — `src/` and `scripts/` have no runtime
dependencies. `typecheck` and `build` call `tsc`, so those two want `npm install` first.

```bash
npm install           # only for typecheck and build; everything above runs without it

npm test              # 471 tests, 96 suites
npm run typecheck     # tsc --noEmit
npm run build         # console + api; the tree must stay clean afterwards
npm run gate-a        # Request <-> KeeperHub <-> Sepolia end to end
                      #   9 ok, 0 failed, 3 blocked with no credential; 10/0/2 with a
                      #   KEEPERHUB_API_KEY in .env. Blocked is never counted as a pass.
npm run race          # 50 processes, one obligation, one payment
npm run crash         # kill the process at 9 checkpoints; zero duplicates at every one
npm run probe:mcp     # KeeperHub's own MCP server, read-only by default
```

Nothing named `verify:*` can spend. `probe:mcp` is named for what it does, and its one call that
reaches the live platform is behind `-- --live-simulate`, because this repository's own hazard
note records that a dry run on that route can execute for real (`src/provider.ts`).

## Use it from an agent

```jsonc
// .mcp.json
{ "mcpServers": { "reqkeeper": {
    "command": "node",
    "args": ["--experimental-strip-types", "scripts/mcp-server.ts"],
    "env": { "KEEPERHUB_API_KEY": "kh_..." } } } }
```

`propose_payment(requestId, ...)` -> a human runs `approve` -> `settle_obligation` ->
`resolve_pending`.

**No tool on the agent surface can approve a payment.** Approval is written by a human at a CLI
and read back by plan hash; there is no tool that writes one. The hosted surface at `/api/mcp` is
read-only and imports no store and no provider at all — the payment tools are *absent*, not gated.

## What is read from Request, and what is sent to KeeperHub

| | Source of truth | Where |
|---|---|---|
| Invoice facts: payee, amount, fee, token, salt | Request's Sepolia gateway, unauthenticated | [`src/request.ts`](src/request.ts) |
| Payment reference | **Derived**, `last8Bytes(keccak256(lowercase(requestId + salt + paymentAddress)))` | [`src/request.ts`](src/request.ts) |
| Obligation identity | `sha256("reqkeeper.obligation.v1:" + ns + requestId)` | [`src/identity.ts`](src/identity.ts) |
| Payment calldata | Encoded locally, proved byte-identical to KeeperHub's encoder | [`src/abi.ts`](src/abi.ts), `npm run verify:seam` |
| Execution | `POST /api/execute/contract-call` with an `Idempotency-Key` | [`src/keeperhub.ts`](src/keeperhub.ts) |
| Settlement evidence | An independently read receipt **and** the fee-proxy event for the same transaction and amount | [`src/chain.ts`](src/chain.ts) |

A caller-supplied reference that is not the one the invoice derives is `REFERENCE_MISMATCH`,
refused before any write. A payee, amount, fee or token the invoice disagrees with is
`FACTS_DISAGREE_WITH_INVOICE`. Both fail closed: an unreadable gateway is not permission to
proceed on the agent's word.

## Doesn't Request already prevent duplicate payments?

No, and the reason is specific.

Request solves **attribution**: the payment reference ties an on-chain `TransferWithReferenceAndFee`
event to an invoice, and the balance is computed from the matching events, net of refunds. That
matching is not loose — `ProxyERC20InfoRetriever` keeps only logs whose token and `to` also match
the request, and the TheGraph retriever filters on the proxy contract as well, so the reference
alone is not what Request trusts either. What Request does not solve is **submission control**. `ERC20FeeProxy.transferFromWithReferenceAndFee` is a stateless
forwarder with no uniqueness on the reference; `GET /v2/request/{id}/pay` returns calldata with no
nonce and no idempotency. A payer that retries after a timeout emits a second event, and the
invoice reads as overpaid.

Exactly-once has to live on the payer's execution side. KeeperHub gives that side idempotent
replay — within 24 hours, per key — plus `unconfirmed` as a poll-only state, and receipts. It does
not know what a Request obligation *is*, and a fresh agent session with a fresh key is a fresh
request to it.

ReqKeeper is the seam: it makes the **obligation**, not the API call, the unit of idempotency.
The invoice is the identity — Request already ships one, and it survives a wallet change, a key
rotation, a re-import, regenerated calldata and the 24-hour expiry. We did not invent an identity
scheme.

## What it refuses, and what it costs

45 recorded refusals happened before any provider write — zero gas. Mutated calldata, a changed
payee, amount, token, chain, proxy or reference, an expired approval, a foreign log, a
dust-griefed reference, a wrong-chain RPC, a receipt whose own logs do not contain the payment.
Full matrix in [`docs/refusals.json`](docs/refusals.json) and
[`docs/refusals-live.json`](docs/refusals-live.json).

The invariant, stated plainly: **the system may be temporarily uncertain; it never resolves
uncertainty by paying again.** Crash it at any of 9 checkpoints and it converges or stays
honestly open — never duplicates. `npm run crash`.

## Settle a real invoice

```bash
cp .env.example .env   # KEEPERHUB_API_KEY is the only credential the settle path needs
npm run gate-a         # prove the three systems line up before spending anything
npm run settle:live    # propose -> approve -> settle
npm run resolve        # drain the outbox; depth is checked before SETTLED
```

Sepolia only. Mainnet chain ids are refused in code, not in prose.

## Limitations

Testnet only. The recorded live run is a single payee. The token allowance was granted out of
band. The 24-hour key expiry is covered by a fixture test, not observed live. Settlement requires
a minimum confirmation depth (default 2) but **nothing re-checks after settlement** — the honest
phrase is "confirmed at a stated depth", never "final". The race proves the reservation and the
compare-and-set across real processes against a counting fixture; it is not a live-money run. The
38 recorded settlements predate several of the gates they sit alongside, and are not evidence
those gates work.

Everything still open, including the awkward parts, is in
[`hackathon/audit/STATUS.md`](hackathon/audit/STATUS.md) — four adversarial audits with runnable
probes, and what each one found that is *not* yet fixed.

## Architecture

```
Request gateway (read)                    KeeperHub (execute REST + MCP)
   invoice facts, salt, reference            simulate -> execute -> status
        |                                            |
        v                                            v
 src/request.ts ---> identity | policy | calldata gate | settle ---> keeperhub.ts
        |              reservation | CAS | outbox                        |
        v                                                                v
 src/chain.ts  <---------  worker.ts (observe, reconcile, never send)
   receipt | fee-proxy log | depth | chain id
```

`src/store.ts` is the durable spine: `UNIQUE(namespace, request_id)`, a partial
`UNIQUE(payment_reference)`, `UNIQUE(plan_hash, step_index)`, a transactional outbox, leases with
fencing generations, and a hash-chained audit trail.

## Development

Node 24, zero dependencies in `src/`. `node --experimental-strip-types`, `node --test`, SQLite via
`node:sqlite`. `npm test && npm run typecheck && npm run build` before every push.

## Licence

MIT.
