import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  IdentityError,
  canonicalJson,
  idempotencyKey,
  obligationId,
  planHash,
  policyHash,
} from "../src/identity.ts";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof IdentityError, `expected IdentityError, got ${e}`);
    return e.code;
  }
  assert.fail("expected a throw, got none");
}

const HEX64 = /^[0-9a-f]{64}$/;

describe("canonicalJson", () => {
  test("orders object keys so serialisation does not depend on construction order", () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(canonicalJson({ a: 2, b: 1 }), canonicalJson({ b: 1, a: 2 }));
  });

  test("orders nested keys too", () => {
    const x = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const y = { outer: { a: { b: 3, y: 2 }, z: 1 } };
    assert.equal(canonicalJson(x), canonicalJson(y));
  });

  test("preserves array order, because step order is meaningful", () => {
    assert.equal(canonicalJson([1, 2, 3]), "[1,2,3]");
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  test("drops undefined members rather than emitting an ambiguous hole", () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  });

  test("refuses representations that would make a hash unstable or lossy", () => {
    assert.equal(code(() => canonicalJson(Number.NaN)), "NOT_CANONICAL");
    assert.equal(code(() => canonicalJson(Number.POSITIVE_INFINITY)), "NOT_CANONICAL");
    assert.equal(code(() => canonicalJson(0.1)), "NOT_CANONICAL");
    assert.equal(code(() => canonicalJson(1n)), "NOT_CANONICAL");
    assert.equal(code(() => canonicalJson(() => 1)), "NOT_CANONICAL");
    assert.equal(code(() => canonicalJson(Symbol("s"))), "NOT_CANONICAL");
  });

  test("handles the primitives a plan actually contains", () => {
    assert.equal(canonicalJson(null), "null");
    assert.equal(canonicalJson(true), "true");
    assert.equal(canonicalJson("0x00"), '"0x00"');
    assert.equal(canonicalJson(0), "0");
    assert.equal(canonicalJson({ amount: "100000000000000000000" }), '{"amount":"100000000000000000000"}');
  });
});

describe("obligationId", () => {
  const NS = "request-network:sepolia";
  const ID = "01e273ecc29d4b526df3a0f1f05ffc59aa";

  test("is a stable 64-char hex digest", () => {
    const a = obligationId(NS, ID);
    assert.match(a, HEX64);
    assert.equal(a, obligationId(NS, ID));
  });

  test("is unchanged by whitespace, so a pasted id does not fork the identity", () => {
    assert.equal(obligationId(NS, `  ${ID}\n`), obligationId(NS, ID));
  });

  test("separates namespaces and request ids", () => {
    assert.notEqual(obligationId(NS, ID), obligationId("request-network:mainnet", ID));
    assert.notEqual(obligationId(NS, ID), obligationId(NS, `${ID}b`));
  });

  test("does not case-normalise, and that is deliberate", () => {
    // Guessing a foreign system's canonicalisation is how one debt becomes two. If Request
    // ever documents case-insensitivity, this test is the place that has to change.
    assert.notEqual(obligationId(NS, ID), obligationId(NS, ID.toUpperCase()));
  });

  test("accepts a colon in the namespace, because the real one has one", () => {
    assert.match(obligationId("request-network:sepolia", ID), HEX64);
  });

  test("rejects empty parts", () => {
    assert.equal(code(() => obligationId("", ID)), "EMPTY");
    assert.equal(code(() => obligationId(NS, "   ")), "EMPTY");
  });

  test("cannot be forged by shifting the delimiter between the two fields", () => {
    // Length-prefix framing is what stops ("a","b:c") and ("a:b","c") colliding.
    assert.notEqual(obligationId("a", "b:c"), obligationId("a:b", "c"));
    assert.notEqual(obligationId("ab", "c"), obligationId("a", "bc"));
    assert.notEqual(obligationId("a:1", "b"), obligationId("a", "1:b"));
  });
});

describe("planHash", () => {
  const plan = {
    obligationId: "a".repeat(64),
    chainId: 11155111,
    token: "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C",
    payee: "0x0e2bB000000000000000000000000000000050F53",
    invoiceBaseUnits: "100000000000000000000",
    steps: [
      { kind: "ALLOWANCE_GRANT", to: "0xTok", data: "0x095ea7b3", value: "0" },
      { kind: "REQUEST_PAYMENT", to: "0xProxy", data: "0xb868a20b", value: "0" },
    ],
  };

  test("is stable across key reordering but not across content change", () => {
    const reordered = {
      steps: plan.steps,
      payee: plan.payee,
      token: plan.token,
      obligationId: plan.obligationId,
      invoiceBaseUnits: plan.invoiceBaseUnits,
      chainId: plan.chainId,
    };
    assert.equal(planHash(plan), planHash(reordered));
  });

  test("a one-base-unit amount change produces a different plan", () => {
    const mutated = { ...plan, invoiceBaseUnits: "100000000000000000001" };
    assert.notEqual(planHash(plan), planHash(mutated));
  });

  test("a single calldata byte change produces a different plan", () => {
    const mutated = {
      ...plan,
      steps: [plan.steps[0], { ...plan.steps[1], data: "0xb868a20c" }],
    };
    assert.notEqual(planHash(plan), planHash(mutated));
  });

  test("reordering the steps produces a different plan", () => {
    const swapped = { ...plan, steps: [plan.steps[1], plan.steps[0]] };
    assert.notEqual(planHash(plan), planHash(swapped));
  });

  test("changing the payee produces a different plan", () => {
    const mutated = { ...plan, payee: "0xdeadbeef00000000000000000000000000000000" };
    assert.notEqual(planHash(plan), planHash(mutated));
  });

  test("is namespaced apart from policyHash so the two cannot be confused", () => {
    assert.notEqual(planHash(plan), policyHash(plan));
  });
});

describe("idempotencyKey", () => {
  const oid = "a".repeat(64);
  const phash = "b".repeat(64);

  test("is deterministic, so a retry reproduces it exactly", () => {
    assert.equal(idempotencyKey(oid, phash, 0), idempotencyKey(oid, phash, 0));
    assert.match(idempotencyKey(oid, phash, 0), HEX64);
  });

  test("separates steps, plans and obligations", () => {
    assert.notEqual(idempotencyKey(oid, phash, 0), idempotencyKey(oid, phash, 1));
    assert.notEqual(idempotencyKey(oid, phash, 0), idempotencyKey(oid, "c".repeat(64), 0));
    assert.notEqual(idempotencyKey(oid, phash, 0), idempotencyKey("d".repeat(64), phash, 0));
  });

  test("rejects inputs that are not already content addresses", () => {
    assert.equal(code(() => idempotencyKey("short", phash, 0)), "NOT_CANONICAL");
    assert.equal(code(() => idempotencyKey(oid.toUpperCase(), phash, 0)), "NOT_CANONICAL");
    assert.equal(code(() => idempotencyKey(oid, "nothex".padEnd(64, "z"), 0)), "NOT_CANONICAL");
  });

  test("rejects an out-of-range step index", () => {
    assert.equal(code(() => idempotencyKey(oid, phash, -1)), "BAD_INDEX");
    assert.equal(code(() => idempotencyKey(oid, phash, 1.5)), "BAD_INDEX");
    assert.equal(code(() => idempotencyKey(oid, phash, 256)), "BAD_INDEX");
  });

  test("contains no time or randomness — 50 calls agree", () => {
    const keys = new Set(Array.from({ length: 50 }, () => idempotencyKey(oid, phash, 2)));
    assert.equal(keys.size, 1);
  });
});
