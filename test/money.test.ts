import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  MoneyError,
  MAX_UINT256,
  assertFitsUint256,
  baseUnitsFromString,
  baseUnitsToString,
  toBaseUnits,
  toHuman,
} from "../src/money.ts";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof MoneyError, `expected MoneyError, got ${e}`);
    return e.code;
  }
  assert.fail("expected a throw, got none");
}

describe("toBaseUnits", () => {
  test("converts whole and fractional amounts exactly", () => {
    assert.equal(toBaseUnits("100", 18), 100_000_000_000_000_000_000n);
    assert.equal(toBaseUnits("0.5", 6), 500_000n);
    assert.equal(toBaseUnits("0", 18), 0n);
    assert.equal(toBaseUnits("1", 0), 1n);
    assert.equal(toBaseUnits("0.000001", 6), 1n);
  });

  test("the same human amount means different base units per token", () => {
    // FAU is 18dp, FakeUSDC is 6dp, both on Sepolia. Reading the wrong decimals is a
    // 10^12 error, which is the shape of the $441k Lobstar transfer.
    const fau = toBaseUnits("100", 18);
    const usdc = toBaseUnits("100", 6);
    assert.equal(fau, 100_000_000_000_000_000_000n);
    assert.equal(usdc, 100_000_000n);
    assert.equal(fau / usdc, 1_000_000_000_000n);
  });

  test("refuses to truncate rather than silently losing value", () => {
    assert.equal(code(() => toBaseUnits("1.005", 2)), "PRECISION_LOSS");
    assert.equal(code(() => toBaseUnits("0.0000001", 6)), "PRECISION_LOSS");
    // and does NOT round to 1.00 or 1.01
  });

  test("rejects every ambiguous or lossy spelling", () => {
    for (const bad of ["", ".", "1.", ".5", "-1", "+1", "1e5", "1E5", "1_0", "1 0", "abc", "NaN", "Infinity", "0x01"]) {
      assert.equal(code(() => toBaseUnits(bad, 18)), "NOT_DECIMAL", `should reject ${JSON.stringify(bad)}`);
    }
  });

  test("rejects non-string input, because a JS number is already lossy", () => {
    assert.equal(code(() => toBaseUnits(100 as unknown as string, 18)), "NOT_A_STRING");
    assert.equal(code(() => toBaseUnits(0.1 as unknown as string, 18)), "NOT_A_STRING");
  });

  test("validates decimals", () => {
    assert.equal(code(() => toBaseUnits("1", -1)), "BAD_DECIMALS");
    assert.equal(code(() => toBaseUnits("1", 1.5)), "BAD_DECIMALS");
    assert.equal(code(() => toBaseUnits("1", 37)), "BAD_DECIMALS");
  });

  test("tolerates surrounding whitespace only", () => {
    assert.equal(toBaseUnits("  100  ", 2), 10_000n);
  });
});

describe("toHuman", () => {
  test("is exact and trims only trailing fractional zeros", () => {
    assert.equal(toHuman(100_000_000_000_000_000_000n, 18), "100");
    assert.equal(toHuman(500_000n, 6), "0.5");
    assert.equal(toHuman(1n, 6), "0.000001");
    assert.equal(toHuman(0n, 18), "0");
    assert.equal(toHuman(1_050n, 2), "10.5");
    assert.equal(toHuman(42n, 0), "42");
  });

  test("rejects negative base units", () => {
    assert.equal(code(() => toHuman(-1n, 18)), "NEGATIVE");
  });
});

describe("round trip", () => {
  test("human -> base -> human is identity for canonical inputs", () => {
    const cases: Array<[string, number]> = [
      ["0", 18], ["1", 18], ["100", 18], ["0.5", 6], ["0.000001", 6],
      ["123456789.987654321", 18], ["1", 0], ["999999999999", 8],
    ];
    for (const [human, decimals] of cases) {
      assert.equal(toHuman(toBaseUnits(human, decimals), decimals), human);
    }
  });

  test("a one-base-unit mutation is always visible after conversion", () => {
    const base = toBaseUnits("100", 18);
    assert.notEqual(toHuman(base + 1n, 18), toHuman(base, 18));
  });
});

describe("uint256 boundary", () => {
  test("accepts the maximum and rejects one above it", () => {
    assertFitsUint256(MAX_UINT256);
    assert.equal(code(() => assertFitsUint256(MAX_UINT256 + 1n)), "PRECISION_LOSS");
    assert.equal(code(() => assertFitsUint256(-1n)), "NEGATIVE");
  });

  test("survives a value beyond Number.MAX_SAFE_INTEGER without precision loss", () => {
    // The reason base units never cross a boundary as a JS number.
    const huge = toBaseUnits("115792089237316195423570985008687907853269984665640564039457.584007913129639935", 18);
    assert.equal(huge, MAX_UINT256);
    assert.ok(huge > BigInt(Number.MAX_SAFE_INTEGER));
    assert.equal(baseUnitsToString(huge), MAX_UINT256.toString());
    assert.equal(baseUnitsFromString(baseUnitsToString(huge)), huge);
  });
});

describe("base unit strings", () => {
  test("round trip through the JSON/DB representation", () => {
    assert.equal(baseUnitsFromString("0"), 0n);
    assert.equal(baseUnitsToString(0n), "0");
    for (const bad of ["", "-1", "1.0", "1e5", " 1", "abc"]) {
      assert.equal(code(() => baseUnitsFromString(bad)), "NOT_DECIMAL", `should reject ${JSON.stringify(bad)}`);
    }
  });
});
