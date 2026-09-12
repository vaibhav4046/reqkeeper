# Protocol audit — the Request Network side

Scope: obligation identity, payment reference, calldata, amounts, receipt semantics, invoice
provenance, and relayer conflation. Read-only against the working tree of 2026-09-12
(`src/chain.ts` and `scripts/gate-a.ts` carry uncommitted RPC-fallback changes; those are what
was audited). KeeperHub's own behaviour is out of scope except where it touches these seven.

Every classification below names the command or the `file:line` that produced it. Where a claim
could not be reproduced from this session it is marked UNPROVEN rather than assumed.

## Classification table

| # | Item | Verdict | Proof |
|---|------|---------|-------|
| 1 | Obligation identity | **PARTIAL** | `src/identity.ts:86-96`, `src/settle.ts:177-189` |
| 1a | — domain separation | **VERIFIED** | `src/identity.ts:95,100,105,110,134` |
| 1b | — canonical serialization | **PARTIAL** | `src/identity.ts:39-72`; `steps[].data` not case-folded |
| 1c | — mismatches rejected before broadcast | **VERIFIED** | `src/settle.ts:200-471` vs send at `:505`; 45/83 live rows |
| 2 | Payment reference scheme | **VERIFIED** | reproduced off-chain and matched against a real log |
| 2a | — indexed-bytes topic | **VERIFIED** | `src/chain.ts:42-48`, esp. **line 47** |
| 2b | — amount word offset | **VERIFIED** | `src/chain.ts:179` (comment at `:174` is wrong) |
| 2c | — reference-only "already paid" precheck | **PARTIAL** | `src/mcp.ts:262` |
| 3 | Calldata decode/re-encode | **VERIFIED** | `src/abi.ts:181-191`, `src/calldata-gate.ts:112` |
| 3a | — semantic bind to invoice facts | **VERIFIED** | `src/settle.ts:106-116, 272-288` |
| 3b | — bind to what the executor really runs | **PARTIAL** | `src/abi.ts:5-13`; seam is a separate script |
| 4 | Amount and decimals | **PARTIAL** | `src/plan.ts:67,84` — `?? 18`, not a token read |
| 4a | — `TOKEN_DECIMALS_MISMATCH` reachable in production | **BROKEN** | `src/plan.ts:67` and `:84` derive from the same `f` |
| 5 | Receipt / finality | **PARTIAL** | two-signal settlement, but zero confirmation depth |
| 6 | Invoice is real Request protocol data | **VERIFIED** | `tools/invoice/create-batch.mjs:50-96`, `scripts/gate-a.ts:157-186` |
| 6a | — runtime re-derives the reference | **UNPROVEN** | nothing in `src/` recomputes it from `(requestId, salt, payee)` |
| 7 | Relayer/forwarder conflation | **PARTIAL** | primary paths bind the tx hash |
| 7a | — `scripts/settle-live.ts` | **BROKEN** | `scripts/settle-live.ts:147` |

Supporting runs, this session:

```
npm test          -> tests 239   pass 239   fail 0    (duration_ms 1198.0497)
npm run typecheck -> tsc --noEmit, clean

docs/refusals-live.json -> 83 rows; SETTLED 38, ALREADY_SETTLED 38, 7 distinct refusals
                           refused_before_provider_write: 45   total physical_sends: 38
```

38 settlements, 38 physical sends. The 1:1 is the exactly-once claim and it holds in the
recorded evidence.

---

## 1. Obligation identity

`obligationId(namespace, requestId)` — `src/identity.ts:86-96`:

```
sha256("reqkeeper.obligation.v1:" + ns.length + ":" + ns + ":" + id.length + ":" + id)
```

**What it binds: namespace and request id, and nothing else.** The network rides inside the
namespace string (`"request-network:sepolia"`, `src/plan.ts:14`), so a chain change does change
the id. Token, decimals, payee, amount, fee ceiling, selector, calldata hash and protocol
version are **not** in the obligation id. There is no org or tenant concept anywhere in the
codebase — it is single-tenant SQLite.

That is a deliberate layering rather than an omission: those fields bind one level up, into the
plan (`src/settle.ts:177-189`):

```
planBody = { obligationId, chainId, token, decimals, payee, invoiceBaseUnits,
             feeBaseUnits, totalDebitBaseUnits, steps, sourceFactsHash, policyHash }
```

`steps` carries the calldata verbatim, so the selector and the argument bytes are committed.
`policyHash` (`src/identity.ts:104-106`) covers the fee ceiling, the total-debit ceiling and both
allowlists (`src/policy.ts:23-42`). So every field the question asks about is committed
*somewhere* — just to two different hashes. The obligation id is the duplicate key; the plan
hash is the content address of the approved bytes. Both are correct for their jobs.

**Domain separation: VERIFIED.** Five distinct prefixes, one per hash family —
`reqkeeper.obligation.v1`, `.plan.v1`, `.policy.v1`, `.source.v1`, `.step.v1`
(`src/identity.ts:95,100,105,110,134`). The obligation id additionally length-prefixes both
components, with the reasoning spelled out at `src/identity.ts:91-94`: a plain `ns:id` preimage
lets `("a","b:c")` and `("a:b","c")` collide, and banning `:` is not an option because the real
namespace contains one. That is the right call.

**Canonical serialization: PARTIAL.** `canonicalJson` (`src/identity.ts:39-72`) sorts keys, drops
`undefined`, and refuses non-finite numbers, fractional numbers, bigint, functions and symbols.
JSON is self-delimiting, so the absence of length-prefixing there is fine. The gap is that
`steps[].data` is embedded as a raw string (`src/identity.ts:69`) with no case folding, while the
payment reference *is* folded (`src/identity.ts:147-153`, `canonicalReference`). Two plans whose
calldata differs only in hex case therefore produce two different plan hashes for one identical
on-chain effect — and therefore two different provider idempotency keys
(`src/identity.ts:120-135`).

This is **not** exploitable for a double payment. A second plan hash while the obligation is
reserved is refused by `reserveObligation` (`src/store.ts:521-534`), and once money has moved
`canReplan` (`src/machine.ts:172`) short-circuits the whole pipeline at `src/settle.ts:228-238`.
But it does mean `planHash` is not a canonical address of the effect, only of one spelling of it.

**Rejection before broadcast: VERIFIED.** The order in `settleObligation` is the safety property
and it is correct. Everything that can refuse, refuses before the send at `src/settle.ts:505`:

| § | Check | Line |
|---|-------|------|
| 0 | reference already claimed by another obligation | `settle.ts:200-219` |
| 0b | re-entry on an obligation past the point of no return | `settle.ts:228-238` |
| 1 | policy gate | `settle.ts:258-264` |
| 1b | calldata vs the facts policy just cleared | `settle.ts:272-288` |
| 3 | obligation reservation | `settle.ts:313-326` |
| 4/5 | recorded human decision + distinct-approver quorum | `settle.ts:334-393` |
| 6 | plan expiry, then `factsAtDispatch` re-hashed against the approved facts | `settle.ts:396-410` |
| — | preflight simulation | `settle.ts:414-458` |
| 7 | durable attempt row written **before** the call | `settle.ts:461-471` |
| 8 | resend guard on `firstSendAt` | `settle.ts:478-501` |

Every pre-send return carries `providerWriteIssued: false`, and the live evidence file records
45 rows with `refused_before_provider_write: true`.

## 2. Payment reference

This is the strongest item in the audit, and the part most implementations get wrong.

**The scheme matches Request's real one.** The reference is not computed by this repo's runtime;
it comes from `docs/live-invoices.json`, written by `tools/invoice/create-batch.mjs:92-96` using
the official `@requestnetwork/payment-detection` `PaymentReferenceCalculator`. I re-derived it
independently with this repo's own keccak and it matched exactly:

```
recorded reference                              : 0x050562a52ec69fa2
keccak(utf8(requestId+salt+payee)) last 8 bytes : 0x050562a52ec69fa2
```

**The indexed-bytes topic is right — `src/chain.ts:47`.** `TransferWithReferenceAndFee`'s
`paymentReference` is an indexed `bytes`, so `topics[1]` is the keccak of the reference *bytes*,
not of the hex string and not the bytes themselves. `referenceTopic` (`src/chain.ts:42-48`)
parses the hex into a `Uint8Array` and hashes that, on line 47. Getting this wrong returns zero
logs and reads downstream as "not paid yet", which is the dangerous direction.

Checked against a real log — tx `0xb90a0771858581547abeb9310777f4430f892be130765eda1096202b9dd9f7f6`,
read from `https://sepolia.gateway.tenderly.co`, log emitted by `0x399f5ee127ce7432e4921a61b8cf52b0af52cbfe`:

```
on-chain topics[0]        0x9f16cbcc523c67a60c450e5ffe4f3b7b6dbe772e7abcadb2686ce029a9a0a2b6
computed (chain.ts:38-40) 0x9f16cbcc523c67a60c450e5ffe4f3b7b6dbe772e7abcadb2686ce029a9a0a2b6

on-chain topics[1]        0xeea8cc789ef59241406757e750ecc36c4eed8ba49faf1edb5e9fcb19342c58c8
computed (chain.ts:42-48, for 0x050562a52ec69fa2)
                          0xeea8cc789ef59241406757e750ecc36c4eed8ba49faf1edb5e9fcb19342c58c8
```

Both identical. VERIFIED.

**Amount offset is right; the comment above it is wrong.** The on-chain `data` is five words —
`tokenAddress, to, amount, feeAmount, feeAddress` — because an indexed dynamic parameter is
removed from `data` entirely, not replaced by an offset placeholder. `src/chain.ts:179` reads
`d.slice(128,192)`, which is word 2, which is `amount`:

```
data 0x …370de27f… (token) …c43d766c… (to) 0de0b6b3a7640000 (amount = 1e18) 0000… 0000…
```

Correct. But the comment at `src/chain.ts:174` lists `<bytes offset>` as a data word. It does not
exist. The slice index happens to be right either way, so this is cosmetic — but it is exactly
the kind of comment that gets a future editor to "fix" a correct offset.

**Gap (MEDIUM), `src/chain.ts:160-182`.** `scanForReference` filters on `(proxy address, event
topic, reference topic)` and returns the *first* hit without checking the log's payee, token or
amount. Anyone can emit a fee-proxy event carrying someone else's reference for 1 wei to their
own address. Consumers that compare the amount are safe — `scripts/resolve.ts:85`,
`src/mcp.ts:229-233`, `src/mcp.ts:294-298` all require `seen.amount === invoiceBaseUnits`. The
pre-check at `src/mcp.ts:262` does not: it takes `sighting?.found === true` alone. A griefer can
therefore force `SOURCE_ALREADY_PAID` on an invoice that was never paid. That is
denial-of-settlement, not theft, and it fails in the safe direction — but it is a real
availability hole and should be stated as one rather than claimed away.

## 3. Calldata

Built once, in `src/plan.ts:97-109`, through `encodeCall` (`src/abi.ts:98-125`): a single `PAY`
step to `ERC20_FEE_PROXY` with `value: "0"`.

**Decode/re-encode: VERIFIED.** `decodeAndVerify` (`src/abi.ts:181-191`) decodes the calldata,
re-encodes the arguments, and requires byte equality. `src/calldata-gate.ts:112` is where the
settlement path calls it. Measured behaviour against the real 260-byte payment calldata:

```
trailing bytes appended             : rejected (BAD_CALLDATA) re-encoding did not reproduce the original
altered selector (0xdeadbeef)       : rejected (SELECTOR_MISMATCH) … is not 0xc219a14d
dirty high bytes in an address word : rejected (BAD_CALLDATA)      [abi.ts:151]
bytes offset bumped by 32           : rejected (BAD_CALLDATA)      [abi.ts:161]
changed payee / amount / token      : ACCEPTED by decodeAndVerify
```

That last line is **correct**, not a hole: `decodeAndVerify` only proves the arguments faithfully
mean the bytes. The semantic question — do those bytes mean *this invoice* — is a separate layer
at `src/settle.ts:106-116`, which compares token, payee, amount, fee, fee recipient and reference
against the facts and returns `CALLDATA_MISMATCH` before anything is dispatched
(`src/settle.ts:272-288`). Both layers exist and both are needed. Live evidence carries a
`calldata_mismatch` row and a `selector_not_allowed` row, both refused before provider write.

Target and shape are bound too: the fee-proxy selector may only be sent to `ERC20_FEE_PROXY` and
`approve` only to the FAU token (`src/calldata-gate.ts:92-98`), with the validated target handed
back so a provider cannot forward `step.to`. Plan shape is guarded at `src/settle.ts:91-93`
(empty plan), `:131-134` (only the last step is dispatched, so it must be the payment),
`:135-137` (one obligation, one payment) and `:121-124` (`approve` spender must be the proxy and
its amount must not exceed the plan's total debit).

**Where it stops short (PARTIAL).** This is not a comparison against what the executor will
actually run. `src/abi.ts:5-13` says so plainly: KeeperHub has no route that accepts finished
calldata, so it re-encodes from `(contractAddress, functionName, functionArgs)` against an ABI it
resolves itself. The repo's answer is `npm run verify:seam`, a separate script. So the byte-level
guarantee is airtight up to the moment KeeperHub is handed arguments, and after that it rests on
that script having been run — not on an inline gate. Claim it that way.

## 4. Amount and decimals

`src/money.ts` is exact throughout: no floats, `PRECISION_LOSS` thrown rather than truncating
(`money.ts:51-71`), `MAX_UINT256` guarded before the ceiling comparison (`money.ts:103-109`,
`policy.ts:169-171`), base units crossing every boundary as decimal strings.

**Decimals are assumed, not read.** `src/plan.ts:67` and `src/plan.ts:84`:

```ts
decimals: f.tokenDecimals ?? 18,        // buildPolicy
tokenDecimals: f.tokenDecimals ?? 18,   // buildSourceFacts
```

Both branches read the same `f`. So on the composed entry points the `Policy` and the
`SourceFacts` always agree by construction, and `TOKEN_DECIMALS_MISMATCH`
(`src/policy.ts:125-130`) compares 18 to 18. **The refusal is structurally unreachable in
production.** Marked BROKEN above in that specific sense — the gate cannot fire on the real
path, not that it computes a wrong answer.

The one live `TOKEN_DECIMALS_MISMATCH` row comes from the harness deliberately splitting the two:
`scripts/live-harness.ts:356` builds the policy from the *unmutated* invoice while
`scripts/live-harness.ts:302` mutates the facts to 6 decimals. That is a legitimate test of
"facts drifted after approval". It is not evidence of a live decimals read.

`docs/live-invoices.json` carries no `tokenDecimals` field at all, so all 38 live settlements ran
on the `?? 18` default.

The mitigation that does exist is real but out of band: `scripts/verify-onchain.ts:107-114` calls
`decimals()` on the token over `eth_call` and asserts 18. It is a pre-flight script, not part of
`settle`. So the honest statement is: the 18 is correct for FAU and independently proven by a
script that has to be run, but the settlement path assumes it.

## 5. Receipt and finality semantics

**"Settled" requires two independent signals, and the code matches the claim.**
`src/machine.ts:5-7` states `CHAIN_CONFIRMED` is not `SETTLED`, and `src/settle.ts:552-575`
enforces it: a receipt with `receiptStatus === "success"` and `verified` moves the obligation to
`CHAIN_CONFIRMED` only; `SETTLED` additionally needs `sourceSaysPaid` to confirm the fee-proxy log
for **this** transaction hash and **this** amount (`settle.ts:568`; implementations at
`scripts/resolve.ts:77-87`, `src/mcp.ts:221-234` and `:288-299`, `src/worker.ts:203`). Anything
short of both leaves the obligation in `RECONCILIATION_PENDING` or `EVIDENCE_CONFLICT`.

**There is no finality concept. None.** Grepping `confirmation|finality|reorg|blockNumber` across
`src/` and `scripts/` returns prose comments and one `eth_blockNumber` call used to pick a log
scan window (`src/chain.ts:190`). The receipt's block number is never compared to head. A receipt
at depth 1 is accepted exactly as a receipt at depth 100.

`src/worker.ts:188-199` re-reads the receipt on the `RECONCILE_SOURCE` pass precisely so a reorg
between passes is caught, with the reasoning in the comment. That is real, but it is opportunistic
— it depends on a job being scheduled between the two reads — not a depth rule. Once `SETTLED`,
nothing re-checks.

**What can honestly be claimed:** "confirmed by an independently read receipt plus the
ERC20FeeProxy event for the same transaction and the same amount." **What cannot:** "final",
"irreversible", or "N confirmations".

One more finality-adjacent fact, empirically confirmed this session. The uncommitted RPC fallback
in `src/chain.ts:21-31, 67-89, 142-151` is justified by real behaviour, not theory. For the
settled transaction above:

```
publicnode  eth_getTransactionReceipt -> null
drpc        eth_getTransactionReceipt -> null
tenderly    eth_getTransactionReceipt -> status 0x1, block 11665983, 3 logs
```

Two of three public endpoints disclaim a receipt that demonstrably exists. Treating `null` as
"this endpoint does not know" rather than "absent" is correct. Note the asymmetry it creates: the
fallback returns the first non-null answer, so a positive rests on a single endpoint with no
cross-check. Right polarity for this system — a false negative authorises a second payment, a
false positive only blocks one — but worth saying out loud.

## 6. Is the invoice real Request protocol data?

**VERIFIED.** `tools/invoice/create-batch.mjs` drives the official SDK:

- `:50-56` — `new RequestNetwork({ nodeConnectionConfig: { baseURL: "https://sepolia.gateway.request.network/" }})` with an ECDSA signature provider.
- `:68-87` — `createRequest` with `PAYMENT_NETWORK_ID.ERC20_FEE_PROXY_CONTRACT`, ERC20 currency FAU on sepolia, then `waitForConfirmation()`.
- `:90-96` — reads `salt` and `paymentAddress` back out of the signed extension and derives the reference with `PaymentReferenceCalculator`.

The request ids in `docs/live-invoices.json` are genuine `0x01`-prefixed Request channel ids, not
form fields. `scripts/gate-a.ts:157-186` closes the loop from the other side: it reads one of
those channel ids back out of the gateway **unauthenticated** and requires
`meta.storageMeta[0].ethereum.blockNumber` to be present, so the invoice has to be anchored on
Sepolia at a block anyone can go and look at. Nothing here is constructed from arbitrary input.

**The gap (6a, UNPROVEN).** The settlement runtime never re-derives the reference from
`(requestId, salt, payee)`. It trusts `docs/live-invoices.json`. I re-derived it and it matched —
but that check lives in an audit scratchpad, not in `src/`. A corrupted or swapped invoices file
would carry a bogus reference through the approval sentence and into a send, and every downstream
guard would faithfully protect the wrong debt. Three lines of keccak at import would close it.

## 7. Relayer / forwarder conflation

The real execution shape, from the settled transaction:

```
to   0x5af5194b4b0909eb978e3cf1e25333852277f07d   <- forwarder, not the fee proxy
from 0x809d8252aa4f9b8f7d9be7213855b289fe7d0444   <- relayer, not the payer
allowance spent by 0x027d54a692e0e80173141777bdb847c1726fa1f3
      (= KEEPERHUB_PAYER, tools/invoice/create-batch.mjs:26)
fee-proxy event emitted by 0x399f5ee127ce7432e4921a61b8cf52b0af52cbfe, inside the meta-tx
```

So the named contract appears only as a log emitter nested inside someone else's transaction.
That is the exact shape in which "the transaction succeeded" and "the payment happened" come
apart: a forwarder that does not bubble an inner revert returns `status: 0x1` regardless.

**The primary paths do not conflate them.** `SETTLED` requires the fee-proxy event bound to the
same tx hash and the same amount (`src/settle.ts:568`, `scripts/resolve.ts:82-86`,
`src/mcp.ts:229-233` and `:294-298`, `src/worker.ts:203`). A successful forwarder receipt whose
inner call did nothing cannot reach `SETTLED` on any of them. This is the right design and it is
implemented.

**BROKEN — `scripts/settle-live.ts:147`:**

```ts
sourceSaysPaid: async () => (await proxySawPayment(startBlock)).found,
```

Both parameters are dropped. It answers "is there *any* payment carrying this reference in the
last 200 blocks", which is precisely the failure the interface documents at `src/settle.ts:55-58`:
*"a boolean over the payment reference alone accepts a different transaction's evidence, which is
how a duplicate obligation reported SETTLED using the first payment's log."* Every sibling caller
was fixed; this one was not. It is not the script behind the 38-payment evidence run — that is
`scripts/live-harness.ts:202-212`, which binds correctly — but it is a live-money script sitting
in the repo with the known-bad shape.

**Weak — `scripts/gate-a.ts:286-292`:** step 6, "land payment through KeeperHub", records `ok` for
any transaction that has a `to` at all. It does not check that the forwarder is a KeeperHub
address or that the payer is the expected account. Step 8 does bind the fee-proxy log to the same
hash, so the gate as a whole is sound; step 6 in isolation proves only that a transaction exists.

---

## What an adversary would attack here

Ordered by what actually pays.

**1. The invoices file, because nothing re-derives the reference (item 6a).** Every guard in this
system is downstream of `docs/live-invoices.json`. Swap one `paymentReference` for a reference the
attacker controls and the whole machine works perfectly — canonical id, policy gate, calldata
seam, human approval sentence, exactly-once — on the wrong debt. The payee check does not save
you: the payee field is in the same file. This is the cheapest attack in the audit and the
cheapest fix. Recompute `keccak(utf8(requestId + salt + payee)).slice(-16)` at import and refuse
on disagreement.

**2. `scripts/settle-live.ts` (item 7a).** Get the operator to run it on a second obligation for a
reference that already has a payment in the last 200 blocks, and it reports `SETTLED` off someone
else's log. The comment three files away describes this exact bug as already fixed. Delete the
script or give it the same three-question reconciliation the other four callers have.

**3. Reference squatting for denial (item 2c).** Emit a 1-wei `TransferWithReferenceAndFee` from
the fee proxy carrying a target reference. `src/mcp.ts:262` checks only `found`, so the invoice is
now permanently `SOURCE_ALREADY_PAID` and the real payee never gets paid. Cheap, public, and it
scales to every reference an attacker can read off-chain — which, since references derive from
data anchored publicly on Sepolia, is all of them. Fix by requiring the amount and payee to match
in the precheck, the way the reconciliation path already does.

**4. Reorg between `CHAIN_CONFIRMED` and a claim of settlement (item 5).** No depth rule exists,
so a receipt one block deep settles. On Sepolia this is not theoretical. The system's own
`RECONCILE_SOURCE` re-read is the only thing between it and a settled-then-vanished payment, and
that only runs if a job happens to be scheduled. An attacker does not cause this; they wait for it
and then dispute.

**5. Calldata case, to split the idempotency key (item 1b).** Propose steps whose hex differs only
in case: new `planHash`, new provider idempotency key, same on-chain effect. Blocked today by
`reserveObligation` and `canReplan`, so this is a second-order lever — it becomes live the moment
someone relaxes the obligation-level reservation, or adds a path that reaches `derivePlan` without
it. Fold the calldata to lowercase in `canonicalJson`'s input the way the reference already is.

**6. Decimals, if the token set ever widens (item 4).** Today `?? 18` is correct because the only
token is FAU and `scripts/verify-onchain.ts` proves FAU is 18dp. Add a 6-decimal token — the repo
already references a FakeUSDC — and `?? 18` silently becomes a 10^12 error, with the one refusal
that would catch it structurally unable to fire because both sides of the comparison read the same
field. The Lobstar failure class this project cites in `src/money.ts:4-8` re-enters through the one
door money.ts cannot see.

**Not worth attacking:** the ABI codec (four mutation classes, all rejected), the ordering of
pre-broadcast refusals (45 live rows, zero provider writes), the event topic derivation (matches a
real log exactly), and the resend guard (38 sends for 38 settlements).
