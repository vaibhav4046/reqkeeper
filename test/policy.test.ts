import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { checkPolicy, normaliseAddress, type Policy, type SourceFacts } from "../src/policy.ts";
import { toBaseUnits } from "../src/money.ts";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const FAKE_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const PAYEE = "0x0e2bB0000000000000000000000000000000F531";
const STRANGER = "0xdEAdBeef00000000000000000000000000000001";
const FEE_ADDR = "0xAaAa000000000000000000000000000000000001";

const policy: Policy = {
  version: 1,
  chainId: 11155111,
  token: { address: FAU, decimals: 18, symbol: "FAU" },
  allowedPayees: [PAYEE],
  maxTotalDebitBaseUnits: toBaseUnits("100", 18).toString(),
  allowedFeeRecipients: [FEE_ADDR],
  maxFeeBaseUnits: toBaseUnits("1", 18).toString(),
  planTtlSeconds: 900,
};

function facts(over: Partial<SourceFacts> = {}): SourceFacts {
  return {
    chainId: 11155111,
    tokenAddress: FAU,
    tokenDecimals: 18,
    payee: PAYEE,
    invoiceBaseUnits: toBaseUnits("50", 18).toString(),
    feeBaseUnits: "0",
    feeRecipient: FEE_ADDR,
    hasBeenPaid: false,
    ...over,
  };
}

function refusal(f: SourceFacts): string {
  const d = checkPolicy(policy, f);
  assert.equal(d.ok, false, "expected a refusal");
  return d.ok ? "" : d.code;
}

describe("checkPolicy — accepts", () => {
  test("a clean obligation, reporting the total debit", () => {
    const d = checkPolicy(policy, facts());
    assert.equal(d.ok, true);
    assert.equal(d.ok && d.totalDebitBaseUnits, toBaseUnits("50", 18).toString());
  });

  test("a fee, folded into the reported total", () => {
    const d = checkPolicy(
      policy,
      facts({ invoiceBaseUnits: toBaseUnits("50", 18).toString(), feeBaseUnits: toBaseUnits("0.25", 18).toString() }),
    );
    assert.equal(d.ok, true);
    assert.equal(d.ok && d.totalDebitBaseUnits, toBaseUnits("50.25", 18).toString());
  });

  test("a payee whose case differs from the allowlist entry", () => {
    // Mixed case in an EVM address is a checksum, not an identity.
    assert.equal(checkPolicy(policy, facts({ payee: PAYEE.toLowerCase() })).ok, true);
    assert.equal(checkPolicy(policy, facts({ payee: PAYEE.toUpperCase().replace("0X", "0x") })).ok, true);
  });

  test("a total debit exactly at the cap", () => {
    assert.equal(checkPolicy(policy, facts({ invoiceBaseUnits: toBaseUnits("100", 18).toString() })).ok, true);
  });
});

describe("checkPolicy — refuses", () => {
  test("an obligation Request already reports paid, before anything else", () => {
    // Checked first, so a paid-and-also-over-cap invoice names the real reason.
    assert.equal(
      refusal(facts({ hasBeenPaid: true, invoiceBaseUnits: toBaseUnits("9999", 18).toString() })),
      "SOURCE_ALREADY_PAID",
    );
  });

  test("the wrong chain", () => {
    assert.equal(refusal(facts({ chainId: 1 })), "UNSUPPORTED_CHAIN");
    assert.equal(refusal(facts({ chainId: 84532 })), "UNSUPPORTED_CHAIN");
  });

  test("the wrong token, even on the right chain", () => {
    assert.equal(refusal(facts({ tokenAddress: FAKE_USDC })), "UNSUPPORTED_TOKEN");
  });

  test("a token whose decimals do not match what policy pinned", () => {
    // FakeUSDC is 6dp and FAU is 18dp on this same chain: a 10^12 error if confused.
    assert.equal(refusal(facts({ tokenDecimals: 6 })), "TOKEN_DECIMALS_MISMATCH");
  });

  test("a recipient not on the allowlist", () => {
    assert.equal(refusal(facts({ payee: STRANGER })), "PAYEE_NOT_ALLOWED");
  });

  test("a zero amount", () => {
    assert.equal(refusal(facts({ invoiceBaseUnits: "0" })), "AMOUNT_NOT_POSITIVE");
  });

  test("an unrecognised fee recipient", () => {
    assert.equal(
      refusal(facts({ feeBaseUnits: toBaseUnits("0.1", 18).toString(), feeRecipient: STRANGER })),
      "FEE_RECIPIENT_UNKNOWN",
    );
  });

  test("a fee above the ceiling", () => {
    assert.equal(refusal(facts({ feeBaseUnits: toBaseUnits("2", 18).toString() })), "FEE_EXCEEDS_CEILING");
  });

  test("a total debit one base unit over the cap", () => {
    const over = (toBaseUnits("100", 18) + 1n).toString();
    assert.equal(refusal(facts({ invoiceBaseUnits: over })), "LIMIT_EXCEEDED");
  });

  test("an invoice UNDER the cap that a fee pushes over it", () => {
    // The reason the ceiling is on total debit, not on the invoice. Capping the invoice
    // alone lets a quoted fee spend more than the human agreed to.
    const d = checkPolicy(
      policy,
      facts({
        invoiceBaseUnits: toBaseUnits("100", 18).toString(),
        feeBaseUnits: toBaseUnits("0.5", 18).toString(),
      }),
    );
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.code, "LIMIT_EXCEEDED");
    assert.match(d.ok === false ? d.detail : "", /invoice .* \+ fee/);
  });
});

describe("checkPolicy — fee checks are skipped only when there is no fee", () => {
  test("a zero fee does not require a recognised fee recipient", () => {
    assert.equal(checkPolicy(policy, facts({ feeBaseUnits: "0", feeRecipient: STRANGER })).ok, true);
  });

  test("any non-zero fee does require one", () => {
    assert.equal(refusal(facts({ feeBaseUnits: "1", feeRecipient: STRANGER })), "FEE_RECIPIENT_UNKNOWN");
  });
});

describe("normaliseAddress", () => {
  test("lowercases a valid address", () => {
    assert.equal(normaliseAddress(FAU), FAU.toLowerCase());
    assert.equal(normaliseAddress(`  ${FAU}  `), FAU.toLowerCase());
  });

  test("throws on anything that is not a 20-byte hex address", () => {
    for (const bad of ["", "0x", "0x123", FAU.slice(0, -1), `${FAU}00`, "not-an-address", FAU.replace("0x", "")]) {
      assert.throws(() => normaliseAddress(bad), /not an EVM address/, `should reject ${JSON.stringify(bad)}`);
    }
  });
});
