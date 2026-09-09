# Invoice tools

The product in `src/` has **zero dependencies**. This directory does not, and is separate for
exactly that reason: it is a one-time setup step, not part of the settlement path.

## Why this exists

Request's v2 REST API needs a Client ID, and a Client ID is only obtainable by signing into
`dashboard.request.network` with a wallet and generating one inside a payment destination's
settings. That is a human step that cannot be automated or scripted.

The Request **protocol** has no such requirement. `https://sepolia.gateway.request.network/`
is a public node that accepts `persistTransaction` with no credential at all. So this creates
the invoice through the official protocol client pointed at that gateway, signing with a
burner keypair generated locally — 32 random bytes, not an account anywhere.

Net effect: the entire demo runs with **one** credential (the KeeperHub API key) instead of two.

## Install

`npm install` fails here. A transitive dependency resolves to an `ssh://git@github.com/...`
URL, and npm's Windows submodule clone breaks on it even with the URL rewritten. pnpm handles
it:

```bash
cd tools/invoice
pnpm install
pnpm create      # writes REQUEST_ID / PAYMENT_REFERENCE / PAYEE_BURNER to ../../.env
pnpm check       # asks Request whether it considers the invoice paid
```

Note `ethers` is pinned to **5.7.2**. The Request packages call `ethers.utils.getAddress`,
which is v5 API; installing v6 alongside them fails at construction with
`Cannot read properties of undefined (reading 'getAddress')`.

## The one detail worth copying

The payment reference is `keccak256(toUtf8Bytes(requestId + salt + paymentAddress))`, sliced to
its last 8 bytes — a hash of the **text** of those concatenated hex strings, not of their
decoded bytes. Hashing the bytes produces a plausible-looking reference that Request's
detection will never match. `create-invoice.mjs` derives it both ways and asserts they agree.
