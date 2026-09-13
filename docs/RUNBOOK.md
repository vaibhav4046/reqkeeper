# Runbook

From a bare clone to one settled Request obligation on Sepolia, in the order the steps
actually have to happen.

`README.md` compresses this to four commands. Those four commands do not work from a bare
clone, and this file exists because a reviewer followed them verbatim and could not reproduce
a settlement. Two prerequisites are missing there: the invoice has to exist before
`settle:live` can name one, and the payer's FAU allowance has to exist before the payment can
simulate. Neither is in the README, and the allowance is in no file in this repository.

Read the last section first if you only want to know whether *you* can reproduce the live
settlement. The short answer is that steps 0 to 3 reproduce for anyone, and steps 4 onward
need a KeeperHub account whose wallet you control.

## What each step costs

| | Cost |
|---|---|
| FAU (the test token) | Free and worthless. `mint(address,uint256)` on `0x370DE27f…` is permissionless: an `eth_call` of it from an arbitrary address returns true (verified 2026-09-13, selector `0x40c10f19`). It is a faucet token with no value. |
| Gas | Sponsored by KeeperHub. The settlement is a meta-transaction: the transaction is submitted by KeeperHub's relayer to a forwarder, and only the *allowance* is spent from the payer wallet. `scripts/gate-a.ts` step 6 records the forwarder as `to` for exactly this reason. You need no Sepolia ETH. |
| Request invoice creation | Free. The public Sepolia gateway accepts `persistTransaction` unauthenticated. |
| KeeperHub API key | Free tier at the time of writing; you must create the account yourself. |

Nothing in this runbook can spend anything that has value.

## Prerequisites, and which need a credential

| Step | Needs a credential | What |
|---|---|---|
| 0 Node 24 | no | `node --experimental-strip-types` and `node:sqlite` are both Node 24 features |
| 1 credential-free verification | no | `npm run verify:all` |
| 2 invoice bootstrap | no | pnpm, and a locally generated burner key |
| 3 Gate A | partly | reads more with `KEEPERHUB_API_KEY`, runs without it |
| 4 KeeperHub key | **yes** | `app.keeperhub.com` → Settings → Developer |
| 5 FAU balance and allowance | **yes** | your KeeperHub wallet must hold FAU and have approved the fee proxy |
| 6 policy.json | no | the standing allowlist ships naming somebody else's payee |
| 7 settle | **yes** | `KEEPERHUB_API_KEY` |
| 8 resolve | no | public RPC only |

---

## 0. Clone, and check Node

```bash
git clone https://github.com/vaibhav4046/reqkeeper && cd reqkeeper
node --version          # must be >= 24; package.json pins "engines": { "node": ">=24" }
```

`src/` and `scripts/` have no runtime dependencies, so nothing needs installing to run the
tests or the verifier. `npm install` is only needed for `typecheck` and `build`, which call
`tsc`.

## 1. Verify everything that needs no credential

```bash
npm test
npm run verify:all
```

`verify:all` reads `docs/evidence/*.json` and public Sepolia RPCs, imports no provider, and
cannot move money. Anything needing a credential is reported BLOCKED with the reason. Do this
before anything else: if the recorded evidence does not re-derive from the chain on your
machine, nothing below is worth attempting.

## 2. Create the invoice (the step the README omits)

`scripts/settle-live.ts` names an invoice by `REQUEST_ID` in `.env` and refuses to start
without one:

```
missing REQUEST_ID in .env — run the invoice creation step first.
```

That step is `tools/invoice`, documented only in `tools/invoice/README.md` which the README
never links.

```bash
cp .env.example .env
cd tools/invoice
pnpm install
pnpm create          # -> node create-invoice.mjs
cd ../..
```

Three things about this that will bite you:

- **pnpm specifically.** `npm install` fails here. A transitive dependency of the Request SDK
  resolves to an `ssh://git@github.com/…` URL and npm's Windows submodule clone breaks on it
  even with the URL rewritten.
- **ethers is pinned to 5.7.2** (`tools/invoice/package.json`). The Request packages call
  `ethers.utils.getAddress`, which is v5 API. Installing v6 alongside them fails at
  construction with `Cannot read properties of undefined (reading 'getAddress')`.
- **The signing key is a burner generated here and now.** `create-invoice.mjs:29-33` writes 32
  random bytes to `INVOICE_SIGNER_KEY` in `.env` if one is not already there. It is the payee,
  so no existing wallet's private key is ever required. `.env` is gitignored; treat it as a
  secret anyway.

`pnpm create` appends `REQUEST_ID`, `PAYMENT_REFERENCE`, `PAYMENT_SALT`, `PAYEE_BURNER`,
`FEE_ADDRESS` and `FEE_AMOUNT` to `.env` (`create-invoice.mjs:98-101`). The invoice is 1 FAU,
zero fee, ERC20FeeProxy payment network, on Sepolia.

`pnpm check` (`check-paid.mjs`) asks Request's own SDK whether it considers the invoice paid.
Use it later as a third opinion; the settlement path never depends on it.

For a batch instead of one invoice, `npm run invoices` runs `create-batch.mjs`. It writes the
invoice facts to `docs/live-invoices.json` (not to `.env`; it touches `.env` only to persist a
burner key if there is not one already), and that file is what `scripts/watch-request.ts` and
the live harness read. It is resumable on purpose: re-running tops the file up to the target
count rather than starting over, so a gateway timeout halfway through a batch of forty costs
the remaining invoices and not the ones already created.

### What the invoice says about the payer, and why it does not matter

`create-invoice.mjs:25` and `create-batch.mjs:30` hardcode
`KEEPERHUB_PAYER = 0x027D54A692e0e80173141777BdB847c1726FA1F3` as the invoice's `payer`
identity. That is *this* project's KeeperHub wallet, not yours. Nothing in `src/` reads the
invoice's payer field: `ERC20FeeProxy.transferFromWithReferenceAndFee` pulls from `msg.sender`,
so the account that actually pays is whichever wallet your KeeperHub key belongs to. The field
is informational for Request. It is still wrong on an invoice you create, and the script gives
you no way to change it without editing it.

## 3. Gate A, before spending anything

```bash
npm run gate-a
```

Real output from this tree, 2026-09-13:

```
  ok   1a chain is Ethereum Sepolia — chainId 11155111
  ok   1b ERC20FeeProxy deployed — 0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE, 2165 bytes
  ok   1b FAU deployed — 0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C, 3044 bytes
  ok   1c payment selector computed — 0xc219a14d
  ok   2a KeeperHub has Sepolia enabled — Ethereum Sepolia, isEnabled=true
  ok   2b KeeperHub key accepted — HTTP 200
  ok   3  invoice readable from Request, no credential — channel 0108b3f7d7d7d3… anchored at block 11665964
BLOCKED 4  invoice created via the hosted REST API — optional: …
BLOCKED 5  payment calldata fetched from the hosted REST API — optional: …
  ok   6  land payment through KeeperHub — tx 0xb90a077185858154… relayed via 0x5af5194b4b0909eb978e3cf1e25333852277f07d
  ok   7  eth_getTransactionReceipt says success — gasUsed 74618
  ok   8  the fee-proxy event carries this reference — 0x050562a52ec69fa2 in the fee-proxy log, same tx

10 ok · 0 failed · 2 blocked
```

**`npm run gate-a` exits 0 on this, the expected path.** Steps 4 and 5 are BLOCKED by design:
they exercise Request's hosted REST API, which needs a dashboard Client ID and which this project
deliberately does not depend on. Blocked is not failed — it is "I could not check this", the same
distinction every other command here draws — so a clean clone exits 0 and the commands chain with
`&&` safely. Only a FAIL exits non-zero (`scripts/gate-a.ts:322`).

This paragraph used to say the opposite, because the script used to exit 2 on any BLOCKED step and
that was the first hard failure a stranger hit on a clean clone. The code was fixed and the page
was not, which is its own lesson: a runbook that teaches a bug outlives the bug.

Also understand what Gate A does *not* prove. Steps 6, 7 and 8 re-derive the **recorded** live
settlement from `docs/refusals-live.json` against a public RPC. They say nothing about your
invoice, your key or your wallet. Step 2b is the only step that tests your credential, and all
it tests is that `GET /api/keys` answers 200.

## 4. KeeperHub key

`app.keeperhub.com` → Settings → Developer. Put it in `.env`:

```
KEEPERHUB_API_KEY=kh_…
```

This is the only credential the settle path needs. `scripts/settle-live.ts` checks it before
`REQUEST_ID`, so a bare `cp .env.example .env` fails on the key first, not on the invoice.

The wallet that pays is KeeperHub's, bound to that key. The execute request carries no `from`
(`src/keeperhub.ts:105-115`), so you do not choose the payer: KeeperHub does. Find your
wallet's address in the KeeperHub dashboard before step 5, because step 5 is about that
address and no other.

## 5. FAU balance and the allowance

**This is the step that is documented nowhere else, and it is the one a first-timer will get
stuck on.** `README.md:199` says only "The token allowance was granted out of band."

The payment is `ERC20FeeProxy.transferFromWithReferenceAndFee`, which calls `transferFrom` on
FAU. So the payer wallet must have:

1. an FAU balance at least equal to the invoice amount, and
2. an ERC-20 allowance to the fee proxy at least equal to the invoice amount.

The addresses, in full:

| | Address |
|---|---|
| FAU token (18 decimals) | `0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C` |
| ERC20FeeProxy (the spender) | `0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE` |
| The payer | your KeeperHub wallet, from the dashboard |

Both are `src/calldata-gate.ts:21-22`, and `npm run verify:onchain` re-reads the deployed code
and `decimals()` for both from a public RPC.

### There is no tool in this repository that grants it

`.claude/agents/builder-reliability.md:16` records the intent to add `npm run fund` "that
documents and performs the approve". It was never added: there is no `fund` script in
`package.json`, and no script under `scripts/` or `tools/` calls `approve` or `mint` on FAU.
`grep -rni allowance` across the tree returns design notes and one README sentence, and no
procedure.

The settlement path structurally cannot do it either, and that is deliberate rather than an
oversight:

- `approve(address,uint256)` **is** on the calldata allowlist, bound to the FAU token only
  (`src/calldata-gate.ts:36-40`).
- But `settleOrRefuse` dispatches `steps[steps.length - 1]` and nothing else
  (`src/settle.ts:604`), and `calldataDisagreesWithFacts` refuses any plan whose last step is
  not the payment (`src/settle.ts:131-134`), with the reason stated in the refusal: "only the
  last step is dispatched; the payment would never be sent".
- `mint` is deliberately absent from the allowlist (`src/calldata-gate.ts:24-30`): "a payment
  gate that allowlists a mint function is indefensible: setup happens out of band, not through
  the settlement path."

So the allowance is granted out of band, by hand, by making your KeeperHub wallet call FAU's
`approve`. `src/keeperhub.ts:223-227` records that `mint` and `approve` were both executed
against Sepolia through KeeperHub's own REST route on 2026-09-09, which is how it was done
here. Concretely, that is one `POST https://app.keeperhub.com/api/execute/contract-call` with
`Authorization: Bearer $KEEPERHUB_API_KEY` and a body shaped like the one
`KeeperHubProvider.#body` builds:

```jsonc
{
  "chainId": 11155111,
  "contractAddress": "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C",  // FAU
  "functionName": "approve",
  // a JSON *string*, not an array. KeeperHub requires it that way.
  "functionArgs": "[\"0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE\",\"<base units>\"]",
  "value": "0"
}
```

and the same shape with `"functionName": "mint"` and
`"functionArgs": "[\"<your wallet>\",\"<base units>\"]"` to fund it. Both can also be done from
the KeeperHub dashboard. Neither is issued by any code in this repository, and this runbook is
not going to pretend otherwise.

### Reading the current state

To check a wallet's balance and allowance without any credential, `eth_call` FAU directly.
Read from this tree on 2026-09-13, for the payer the recorded evidence names:

```
payer      0x027d54a692e0e80173141777bdb847c1726fa1f3
allowance  54000000000000000000 base units (54.0000 FAU)
balance    54000000000000000000 base units (54.0000 FAU)
```

(`allowance(address,address)` is `0xdd62ed3e`, `balanceOf(address)` is `0x70a08231`; both
selectors are computed and checked by `npm run verify:onchain`.) Note that
`create-batch.mjs:42` still says "the payer holds 98 FAU" in its argument-range message. That
was true when it was written; the chain says 54 today. The message caps the batch at 90
invoices on the strength of a number that is now stale.

## 6. policy.json will refuse your invoice

`policy.json` is the operator's standing policy, and it ships with

```json
"allowedPayees": ["0xc43d766CB7c48B9B198db87441b97c09e81717A1"]
```

which is the burner that received the 38 recorded settlements. Your `pnpm create` generated a
*different* burner. Every path that builds its policy through `buildPolicy`
(`src/plan.ts:86-105`) therefore refuses your invoice with `PAYEE_NOT_ALLOWED`: the MCP
`settle_obligation` tool (`src/mcp.ts:476`), `npm run approve` (`scripts/approve.ts:61`),
`npm run watch` (`src/watch.ts:261`), the race and crash harnesses. Its own `_comment` says so:
"Change it before settling anything of your own: an allowlist naming somebody else's address is
worse than none, because it reads as a control."

Put your burner address (`PAYEE_BURNER` in `.env`) in `allowedPayees`, or set
`REQKEEPER_ALLOWED_PAYEES` in the environment, which wins over the file.

**`npm run settle:live` is the exception, and you should know why.** It does not call
`buildPolicy`. It builds its own `Policy` inline from the invoice it just read, with
`allowedPayees: [PAYEE]` and a 2 FAU ceiling on the total debit. So `policy.json` does not
constrain the live settlement script at all. That makes the script work out of the box, and it
means the standing policy is a control on the agent surface and the approval CLI, not on this
one.

## 7. Settle

```bash
npm run settle:live
```

What it does, in order: reads the invoice from Request's public gateway and refuses before any
write if anything in `.env` disagrees with it; builds the payment calldata locally; opens
`.data/live.sqlite`; and calls `settleObligation` with an inline approval
(`approver: "owner@reqkeeper.local"`). It is one process doing propose, approve and settle,
not three commands. For the three-actor flow (an agent proposes, a human approves at a CLI,
the agent settles) use the MCP server and `npm run approve`; `npm run watch` prints a
ready-to-run approve command for every invoice waiting on one.

`KEEPERHUB_TRANSPORT=mcp npm run settle:live` dispatches through KeeperHub's own MCP server
instead of its REST API. Nothing else changes. An unrecognised value is refused rather than
silently defaulted, so a typo cannot put the wrong transport in the evidence.

A first run that works usually ends in `RECONCILIATION_PENDING`, not `SETTLED`. That is
correct: settlement requires a minimum confirmation depth (`REQKEEPER_MIN_CONFIRMATIONS`,
default 2) and a fresh receipt is one block deep. The payment is on chain; the system is
declining to call it settled yet.

### Run it twice

```bash
npm run settle:live     # again, same invoice
```

The second run must refuse with `ALREADY_DISPATCHED` (or `ALREADY_SETTLED`) and leave
`providerWrite` false. That pair is the whole thesis, and the durable store under `.data/` is
what makes the refusal survive a process restart, a rotated key, and KeeperHub's 24-hour
idempotency window expiring.

## 8. Resolve

```bash
npm run resolve
```

Drains the outbox: reads receipts and the fee-proxy event log from a public RPC and advances
state. It has no provider write path at all, so the worst a bug in it can do is fail to
advance an obligation. Run it until `RECONCILIATION_PENDING` becomes `SETTLED`, which needs
the transaction to reach depth 2.

Flags: `--passes=N` (default 5), `--db=.data/live.sqlite`.

## 9. Confirm it independently

```bash
node tools/invoice/check-paid.mjs     # Request's own SDK verdict, no credential
npm run verify:all                    # re-derives every recorded claim from the chain
```

`settle:live` already prints the Etherscan link and the fee-proxy log it found. The point of
these two is that neither reads back the file that reported the payment.

---

## REQKEEPER_PAYER_ADDRESS, and why an unset one costs you liveness

Optional, and everything works without it — but a dry run that never comes back will then wait for
you instead of recovering on its own.

`?simulate=true` is not a safety boundary on KeeperHub's transfer routes (issues #1959 / #1929):
the call can really execute. When the reply is also lost, one question decides whether the debt may
be proposed again: is there a transaction out there that will pay this invoice? A log scan cannot
answer it, because `eth_getLogs` reads blocks and a pending transaction is not in one. Elapsed time
cannot answer it either — there is no number of blocks after which a pending transaction becomes
unmineable.

What answers it is a nonce. A transaction is bound to one, a nonce is spent once, and the moment
another transaction is mined at the nonce the leak would have used, the leak can never be included
by any node. So ReqKeeper records the broadcasting account's mined nonce before the dry run and
releases the obligation only once that nonce has moved. With no account configured there is no
nonce to read, the obligation stays in `PAYMENT_PREFLIGHT`, and the resolver reports
`LEAK_NOT_EXCLUDED:NO_PAYER_CONFIGURED`.

### When it is not set, and an obligation is waiting

`npm run resolve` says so on every run, and there is a door:

```bash
npm run resolve -- --release-preflight <obligationId> --operator alice@finance
```

It names one obligation, it demands a human's name for the audit trail, and it reads the chain
before it agrees to anything. Three refusals are built into it, and all three are cases where
"release it" would mean paying twice:

- the invoice **is** paid — the obligation is moved to `EVIDENCE_CONFLICT` and the transaction is
  named, because a payment with no attempt row behind it is an incident, not a settlement;
- the scan could not reach the invoice's anchor, so it cannot say the invoice is unpaid;
- the scan did not state whether it was truncated at all — a reader that did not say is not a
  reader that said no.

The release lands in the audit trail as `PREFLIGHT_RELEASED_BY_OPERATOR` with the block range the
decision was made over. Nothing about this is a switch: it is a human taking responsibility, with
the chain checked first.

### Which account

It is the account that **broadcasts**, which is KeeperHub's relayer — not your funding account.
The payment is a `transferFrom`, so the funding account's tokens move while the relayer's nonce is
the one spent. Discover it from any settled transaction:

```bash
curl -s https://ethereum-sepolia-rpc.publicnode.com -H 'content-type: application/json'   -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionByHash","params":["0xe02fd64ced29c8e147817077c66eeac6b71b23a629dac6a3f33d73fcd8959119"]}'   | grep -o '"from":"0x[0-9a-f]*"'
```

For this deployment that is `0x809d8252aa4f9b8f7d9be7213855b289fe7d0444`. Confirm it is the
broadcaster and not a contract — `eth_getCode` must return `0x`:

```bash
export REQKEEPER_PAYER_ADDRESS=0x809d8252aa4f9b8f7d9be7213855b289fe7d0444
```

Verify it against your own settlement before trusting it. A relayer can rotate accounts, and
excluding a leak against the wrong account's nonce would be worse than not excluding it at all —
which is why an unreadable or unconfigured nonce refuses rather than assuming. If KeeperHub moves
to a relayer fleet, this needs the set of accounts, not one.

## Failure modes, and what each one means

| What you see | What it means |
|---|---|
| `missing KEEPERHUB_API_KEY in .env — run the invoice creation step first.` | The message names the wrong step. It is `need()` in `scripts/settle-live.ts` reporting whichever variable is absent, and the key is checked first. Set the key. |
| `missing REQUEST_ID in .env — run the invoice creation step first.` | This one is accurate. Do step 2. |
| `REFUSED before any write (BAD_IDENTIFIER)` | `REQUEST_ID` is `0x`-prefixed. Request channel ids are bare hex starting `01…`, and the payment reference is derived from that recorded spelling, so a `0x` prefix hashes to a different reference. `assertBareHex` (`src/request.ts:359`) refuses it rather than quietly stripping it, and the error says "drop the 0x: it is part of the preimage". |
| `REFUSED before any write (REFERENCE_MISMATCH)` | The `PAYMENT_REFERENCE` in `.env` is not the one this invoice derives. They are different debts. Nothing downstream re-derives the reference, so this is refused rather than preferred either way. |
| `REFUSED before any write (FACT_MISMATCH)` | A payee, fee, fee recipient or amount in `.env` disagrees with what Request states. Amounts compare as exact strings on purpose: `1000000000000000000` and `01000000000000000000` differ because one of them was typed by something other than Request. |
| `REFUSED before any write (GATEWAY_UNAVAILABLE)` | Request's gateway did not answer. An unreadable gateway is not permission to proceed on the caller's word, so this fails closed. |
| `POLICY_DENIED` / `PAYEE_NOT_ALLOWED` | Step 6. `policy.json` names somebody else's payee. |
| `POLICY_DENIED` / `LIMIT_EXCEEDED` | The invoice's total debit exceeds a ceiling. `settle:live`'s inline cap is 2 FAU; `policy.json`'s is 5 FAU; the lower of the standing and the caller's always wins. |
| `SIMULATION_BLOCKED` / "payment would revert" | Almost always step 5: no FAU balance, or no allowance to the fee proxy. Zero sends, zero gas. |
| `EXECUTION_OUTCOME_UNKNOWN` with "preflight did not answer" | The dry run did not come back (rate limit, timeout). A timed-out dry run can still have executed, so nothing here guesses: the reservation is held, an `OBSERVE_PREFLIGHT` job is already queued, and `npm run resolve` settles the question from the chain. Do not re-propose the obligation until it has. |
| `ALREADY_DISPATCHED` | Correct on a second run. Step 8 of the protocol is a compare-and-set on `first_send_at` (`markSent` in `src/store.ts`); losing it means writing nothing and being told so. |
| `REFERENCE_ALREADY_CLAIMED` | Another obligation already owns this payment reference. Same debt, different request id. |
| `OBLIGATION_ID_MISMATCH` | The supplied obligation id does not derive from the namespace and request id it came with. One invoice is one obligation and the id is a function of the invoice, never an argument. |
| `EVIDENCE_CONFLICT` with "the receipt carries no ERC20FeeProxy event" | The transaction succeeded and the payment did not. The real shape is a meta-transaction, and a forwarder that does not bubble an inner revert returns `status: 0x1` regardless. |
| `no settlement database at .data/live.sqlite` from `npm run resolve` | Nothing has been settled from this checkout. Exit 1. |
| `npm run gate-a` exits non-zero with `0 failed` | It does not, and has not since the BLOCKED steps stopped being treated as failures. Blocked is "I could not check this", and a clean clone exits 0. See step 3. |
| pnpm install fails with an `ssh://git@github.com` URL | You used npm. See step 2. |
| `Cannot read properties of undefined (reading 'getAddress')` | ethers v6 got installed next to the Request packages. Pin 5.7.2. |
| `eth_getLogs` "exceed maximum block range: 50000" | A reference scan asked for too wide a window. `MAX_RANGE` in `src/chain.ts` caps ranges at 45,000 blocks; a caller bypassing `findPaymentByReference` will hit this. |
| A receipt read returns `not_found` for a transaction Etherscan shows | Public endpoints prune receipts. `NULLABLE_IS_UNKNOWN` in `src/chain.ts` treats a null as "this endpoint does not know" and asks another before believing it. If you wrote your own reader, this is why it lied. |

---

## What a stranger cannot reproduce, stated plainly

**Reproducible by anyone, with no credential:** steps 0, 1, 2, 3, 9, and every refusal in
`docs/refusals.json`. You can create a real Request invoice on Sepolia, read it back out of
Request's node unauthenticated, re-derive its payment reference, and re-derive every recorded
settlement from the chain. `npm run verify:all` is the whole of that and it needs nothing.

**Needs your own KeeperHub account:** the live settlement. There is no shared key, and there
should not be. You will need to:

1. create a KeeperHub account and generate an API key;
2. find your KeeperHub wallet address in their dashboard;
3. mint FAU to that wallet and approve the fee proxy from it, by hand, through KeeperHub's
   execute route or their UI, because **this repository ships no command that does it**;
4. put your own burner in `policy.json` (or accept that only `settle:live`, which bypasses the
   standing policy, will run).

Steps 3 and 4 are the honest gap. Everything else in this file is a command you can run.

**Not reproducible at all, by anyone including us:** the 38 recorded settlements and the
3 MCP settlements are history. They re-verify from the chain; they do not re-run. The 24-hour
KeeperHub key expiry is covered by a fixture test, not observed live. `npm run race -- --live`
has been run once, with three workers; the 50-worker race is a fixture run, not live money.
And nothing re-checks a settlement after it is recorded, so the honest phrase is "confirmed at
a stated depth", never "final".

Everything still open is in [`hackathon/audit/STATUS.md`](../hackathon/audit/STATUS.md).
