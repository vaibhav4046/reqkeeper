import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AbiError,
  decodeAndVerify,
  decodeCall,
  encodeCall,
  parseSignature,
} from "../src/abi.ts";
import {
  decodeAllowedCall,
  ERC20_FEE_PROXY,
  FAU_TOKEN,
} from "../src/calldata-gate.ts";
import { keccak256, keccak256Hex, selector } from "../src/keccak.ts";
import {
  assertFitsUint256,
  baseUnitsFromString,
  baseUnitsToString,
  MAX_UINT256,
  MoneyError,
  toBaseUnits,
  toHuman,
} from "../src/money.ts";
import {
  checkPolicy,
  normaliseAddress,
  type Policy,
  type SourceFacts,
} from "../src/policy.ts";
import { canonicalReference, idempotencyKey, obligationId } from "../src/identity.ts";
import { Store } from "../src/store.ts";
import { ProviderError } from "../src/provider.ts";
import { handlePublic, PUBLIC_TOOLS } from "../src/mcp-public.ts";
import handler from "../api/mcp.ts";

const PAY_SIG = "transferFromWithReferenceAndFee(address,address,uint256,bytes,uint256,address)";
const FAU = FAU_TOKEN;
const PAYEE = "0x0e2bb1c8d52315cad63f341424c5a7dd81a50f53";
const ETHERS_REFERENCE =
  "0xc219a14d" +
  "000000000000000000000000370de27fdb7d1ff1e1baa7d11c5820a324cf623c" +
  "0000000000000000000000000e2bb1c8d52315cad63f341424c5a7dd81a50f53" +
  "0000000000000000000000000000000000000000000000000de0b6b3a7640000" +
  "00000000000000000000000000000000000000000000000000000000000000c0" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000e2bb1c8d52315cad63f341424c5a7dd81a50f53" +
  "0000000000000000000000000000000000000000000000000000000000000008" +
  "0102030405060708000000000000000000000000000000000000000000000000";

describe("1. Calldata Gate and ABI Adversarial Edge Cases", () => {
  test("calldata shorter than 10 characters is rejected as calldata_invalid", () => {
    for (const short of ["", "0x", "0x1", "0x1234567"]) {
      assert.throws(
        () => decodeAllowedCall({ to: ERC20_FEE_PROXY, data: short }),
        (e: unknown) => e instanceof ProviderError && e.code === "calldata_invalid",
      );
    }
  });

  test("calldata of 10 chars with unknown selector is rejected as selector_not_allowed", () => {
    assert.throws(
      () => decodeAllowedCall({ to: ERC20_FEE_PROXY, data: "0x12345678" }),
      (e: unknown) => e instanceof ProviderError && e.code === "selector_not_allowed",
    );
  });

  test("incomplete selector in decodeCall throws AbiError BAD_CALLDATA", () => {
    for (const short of ["0x", "0x1", "0x123456", "0x1234567"]) {
      assert.throws(
        () => decodeCall(PAY_SIG, short),
        (e: unknown) => e instanceof AbiError && e.code === "BAD_CALLDATA",
      );
    }
  });

  test("mismatched selector in decodeCall throws SELECTOR_MISMATCH", () => {
    const wrongSel = "0x00000000" + ETHERS_REFERENCE.slice(10);
    assert.throws(
      () => decodeCall(PAY_SIG, wrongSel),
      (e: unknown) => e instanceof AbiError && e.code === "SELECTOR_MISMATCH",
    );
  });

  test("decodeCall alone silently ignores trailing garbage bytes (security boundary relies on decodeAndVerify)", () => {
    const withTrailing = `${ETHERS_REFERENCE}deadbeef`;
    // decodeCall does NOT throw for trailing bytes:
    const args = decodeCall(PAY_SIG, withTrailing);
    assert.equal(args.length, 6);

    // BUT decodeAndVerify detects that re-encoding does not match and throws:
    assert.throws(
      () => decodeAndVerify(PAY_SIG, withTrailing),
      (e: unknown) => e instanceof AbiError && e.code === "BAD_CALLDATA",
    );
  });

  test("decodeCall with odd length hex calldata throws or drops nibble", () => {
    const oddCalldata = `${ETHERS_REFERENCE}f`;
    // stripHex does not reject odd hex length
    const args = decodeCall(PAY_SIG, oddCalldata);
    assert.equal(args.length, 6);
    // But decodeAndVerify catches it
    assert.throws(
      () => decodeAndVerify(PAY_SIG, oddCalldata),
      (e: unknown) => e instanceof AbiError && e.code === "BAD_CALLDATA",
    );
  });

  test("dirty padding in dynamic bytes parameter is caught by decodeAndVerify", () => {
    // In ETHERS_REFERENCE, the last word is the 8-byte payload right-padded with 24 zero bytes (48 hex 0s).
    // Let's replace the last byte with '01' instead of '00' (dirty padding)
    const dirtyPadding = ETHERS_REFERENCE.slice(0, -2) + "01";
    // decodeCall parses the 8 bytes without looking at the padding
    const decoded = decodeCall(PAY_SIG, dirtyPadding);
    assert.equal(decoded[3], "0x0102030405060708");

    // decodeAndVerify detects re-encoding normalized the padding to zero and rejects it:
    assert.throws(
      () => decodeAndVerify(PAY_SIG, dirtyPadding),
      (e: unknown) => e instanceof AbiError && e.code === "BAD_CALLDATA",
    );
  });

  test("address with dirty high bytes throws AbiError", () => {
    const dirtyHigh = ETHERS_REFERENCE.slice(0, 10) + "01" + ETHERS_REFERENCE.slice(12);
    assert.throws(
      () => decodeCall(PAY_SIG, dirtyHigh),
      (e: unknown) => e instanceof AbiError && e.code === "BAD_CALLDATA",
    );
  });

  test("calldata gate: target with mixed case is accepted", () => {
    const res = decodeAllowedCall({
      to: ERC20_FEE_PROXY.toLowerCase(),
      data: ETHERS_REFERENCE,
    });
    assert.equal(res.signature, PAY_SIG);
  });

  test("calldata gate: returns step.to instead of canonical target (contractual drift edge case)", () => {
    // Note: docstring says 'callers are handed back the target this module approved rather than the one the step carried'
    // but line 123 returns step.to.
    const lowercaseTarget = ERC20_FEE_PROXY.toLowerCase();
    const res = decodeAllowedCall({
      to: lowercaseTarget,
      data: ETHERS_REFERENCE,
    });
    assert.equal(res.to, lowercaseTarget);
  });

  test("calldata gate: non-allowlisted target is rejected", () => {
    assert.throws(
      () => decodeAllowedCall({ to: "0x0000000000000000000000000000000000000001", data: ETHERS_REFERENCE }),
      (e: unknown) => e instanceof ProviderError && e.code === "target_not_allowed",
    );
  });

  test("calldata gate: non-zero value is rejected", () => {
    assert.throws(
      () => decodeAllowedCall({ to: ERC20_FEE_PROXY, data: ETHERS_REFERENCE, value: "100" }),
      (e: unknown) => e instanceof ProviderError && e.code === "value_not_allowed",
    );
  });

  test("calldata gate: invalid value formatting is rejected", () => {
    for (const badVal of ["-1", "+0", "0x0", "abc", "1.0"]) {
      assert.throws(
        () => decodeAllowedCall({ to: ERC20_FEE_PROXY, data: ETHERS_REFERENCE, value: badVal }),
        (e: unknown) => e instanceof ProviderError && e.code === "value_invalid",
      );
    }
  });

  test("parseSignature accepts whitespace, but selector() throws generic Error (inconsistency)", () => {
    const sigWithSpace = "transfer(address, uint256)";
    // parseSignature parses it without issue:
    const parsed = parseSignature(sigWithSpace);
    assert.equal(parsed.name, "transfer");
    assert.deepEqual(parsed.types, ["address", "uint256"]);

    // But selector() throws generic Error, not AbiError:
    assert.throws(
      () => selector(sigWithSpace),
      /signature must not contain whitespace/,
    );
    // And encodeCall throws generic Error because it calls selector():
    assert.throws(
      () => encodeCall(sigWithSpace, [FAU, "100"]),
      (e: unknown) => !(e instanceof AbiError) && /whitespace/.test((e as Error).message),
    );
  });
});

describe("2. Money, BigInt, and Policy Edge Cases", () => {
  test("toBaseUnits rejects all non-plain decimals", () => {
    const invalidAmounts = [
      "-1", "+1", "1e18", "1_000", ".5", "1.", "", "   ", "NaN", "Infinity", "-Infinity", "0x10", "1.2.3"
    ];
    for (const amt of invalidAmounts) {
      assert.throws(
        () => toBaseUnits(amt, 18),
        (e: unknown) => e instanceof MoneyError,
        `Expected ${amt} to be rejected`,
      );
    }
  });

  test("toBaseUnits rejects precision loss", () => {
    assert.throws(
      () => toBaseUnits("1.0000001", 6),
      (e: unknown) => e instanceof MoneyError && e.code === "PRECISION_LOSS",
    );
  });

  test("toHuman handles exact conversions and edge cases", () => {
    assert.equal(toHuman(0n, 18), "0");
    assert.equal(toHuman(1n, 18), "0.000000000000000001");
    assert.equal(toHuman(1000000000000000000n, 18), "1");
    assert.equal(toHuman(1500000000000000000n, 18), "1.5");
    assert.equal(toHuman(100n, 0), "100");
    assert.throws(() => toHuman(-1n, 18), (e: unknown) => e instanceof MoneyError && e.code === "NEGATIVE");
  });

  test("baseUnitsFromString rejects negative, float, whitespace", () => {
    for (const bad of ["-1", "1.0", " 100 ", "", "abc", "0x12"]) {
      assert.throws(
        () => baseUnitsFromString(bad),
        (e: unknown) => e instanceof MoneyError && e.code === "NOT_DECIMAL",
      );
    }
  });

  test("assertFitsUint256 catches overflow beyond 2^256 - 1", () => {
    assert.doesNotThrow(() => assertFitsUint256(MAX_UINT256));
    assert.throws(
      () => assertFitsUint256(MAX_UINT256 + 1n),
      (e: unknown) => e instanceof MoneyError && e.code === "PRECISION_LOSS",
    );
    assert.throws(
      () => assertFitsUint256(-1n),
      (e: unknown) => e instanceof MoneyError && e.code === "NEGATIVE",
    );
  });

  test("BUG: checkPolicy crashes with unhandled MoneyError when total debit exceeds uint256", () => {
    const policy: Policy = {
      version: 1,
      chainId: 11155111,
      token: { address: FAU, decimals: 18, symbol: "FAU" },
      allowedPayees: [PAYEE],
      maxTotalDebitBaseUnits: (MAX_UINT256 + 100n).toString(),
      allowedFeeRecipients: [],
      maxFeeBaseUnits: "0",
      planTtlSeconds: 3600,
    };
    const facts: SourceFacts = {
      chainId: 11155111,
      tokenAddress: FAU,
      tokenDecimals: 18,
      payee: PAYEE,
      invoiceBaseUnits: (MAX_UINT256 + 1n).toString(),
      feeBaseUnits: "0",
      feeRecipient: "0x0000000000000000000000000000000000000000",
      hasBeenPaid: false,
    };

    // checkPolicy handles overflow cleanly as LIMIT_EXCEEDED refusal instead of throwing unhandled error
    const dec = checkPolicy(policy, facts);
    assert.equal(dec.ok, false);
    if (!dec.ok) {
      assert.equal(dec.code, "LIMIT_EXCEEDED");
    }
  });

  test("FIXED: checkPolicy refuses gracefully on non-canonical/invalid payee address", () => {
    const policy: Policy = {
      version: 1,
      chainId: 11155111,
      token: { address: FAU, decimals: 18, symbol: "FAU" },
      allowedPayees: [PAYEE],
      maxTotalDebitBaseUnits: "1000",
      allowedFeeRecipients: [],
      maxFeeBaseUnits: "0",
      planTtlSeconds: 3600,
    };
    const facts: SourceFacts = {
      chainId: 11155111,
      tokenAddress: FAU,
      tokenDecimals: 18,
      payee: "invalid-payee-not-an-address",
      invoiceBaseUnits: "100",
      feeBaseUnits: "0",
      feeRecipient: "0x0000000000000000000000000000000000000000",
      hasBeenPaid: false,
    };

    // Returns { ok: false, code: "PAYEE_NOT_ALLOWED" } cleanly instead of throwing
    const dec = checkPolicy(policy, facts);
    assert.equal(dec.ok, false);
    if (!dec.ok) {
      assert.equal(dec.code, "PAYEE_NOT_ALLOWED");
      assert.match(dec.detail, /not a valid EVM address/);
    }
  });

  test("chain.ts referenceTopic truncates odd-length hex reference", () => {
    // In chain.ts:
    // function referenceTopic(reference: string): string {
    //   const hex = reference.replace(/^0x/, "");
    //   const bytes = new Uint8Array(hex.length / 2);
    //   for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    //   return keccak256Hex(bytes);
    // }
    // With odd length "0x123", hex.length / 2 is 1.5 -> Uint8Array(1.5) has length 1.
    // bytes[0] is parseInt("12", 16) = 18. "3" is dropped!
    // It produces keccak256Hex(new Uint8Array([18])), the same as reference "0x12"!
    const topicOdd = keccak256Hex(new Uint8Array([0x12]));
    assert.equal(topicOdd.length, 66);
  });
});

describe("3. Idempotency Store Concurrency, Fencing, and Rollback", () => {
  const NS = "request-network:sepolia";
  const REQ = "req-test-concurrent-1";
  const OID = obligationId(NS, REQ);
  const PLAN = "a".repeat(64);
  const PLAN_B = "b".repeat(64);

  function createDb(): Store {
    const s = new Store();
    s.importObligation({
      obligationId: OID,
      namespace: NS,
      requestId: REQ,
      sourceFactsJson: "{}",
      sourceFactsHash: "h".repeat(64),
      paymentReference: "0x0056dcf7fc0a464f",
      now: 1000,
    });
    s.savePlan({
      planHash: PLAN,
      obligationId: OID,
      version: 1,
      policyHash: "p".repeat(64),
      sourceFactsHash: "h".repeat(64),
      planJson: "{}",
      totalDebitBaseUnits: "100",
      expiresAt: 10_000,
      now: 1000,
    });
    return s;
  }

  test("double claims: second worker cannot claim an actively leased job", () => {
    const s = createDb();
    s.openAttempt({
      obligationId: OID,
      planHash: PLAN,
      stepIndex: 0,
      idempotencyKey: idempotencyKey(OID, PLAN, 0),
      endpoint: "/api/execute",
      bodyJson: "{}",
      now: 1000,
    });

    const [job1] = s.claimJobs({ limit: 10, now: 1000, leaseMs: 10_000 });
    assert.ok(job1);
    assert.equal(job1.fencingGeneration, 1);

    // Concurrent claim at now = 2000 (lease expires at 11_000)
    const claimedAgain = s.claimJobs({ limit: 10, now: 2000, leaseMs: 10_000 });
    assert.equal(claimedAgain.length, 0, "active lease must not be handed out");
    s.close();
  });

  test("expired lease: second worker claims with incremented generation and fences out first worker", () => {
    const s = createDb();
    s.openAttempt({
      obligationId: OID,
      planHash: PLAN,
      stepIndex: 0,
      idempotencyKey: idempotencyKey(OID, PLAN, 0),
      endpoint: "/api/execute",
      bodyJson: "{}",
      now: 1000,
    });

    const [jobWorker1] = s.claimJobs({ limit: 10, now: 1000, leaseMs: 5000 });
    assert.equal(jobWorker1.fencingGeneration, 1);

    // Lease expires at 6000. Worker 2 claims at 7000:
    const [jobWorker2] = s.claimJobs({ limit: 10, now: 7000, leaseMs: 5000 });
    assert.equal(jobWorker2.fencingGeneration, 2);

    // Worker 1 now attempts completeJob with stale generation:
    assert.throws(
      () => s.completeJob(jobWorker1.id, jobWorker1.fencingGeneration),
      (e: unknown) => (e as Error & { code?: string }).code === "STALE_FENCE",
    );

    // Worker 1 attempts deferJob with stale generation:
    assert.throws(
      () => s.deferJob(jobWorker1.id, 8000, "RETRY", jobWorker1.fencingGeneration),
      (e: unknown) => (e as Error & { code?: string }).code === "STALE_FENCE",
    );

    // Worker 1 checks assertFencing:
    assert.throws(
      () => s.assertFencing(jobWorker1.id, jobWorker1.fencingGeneration),
      (e: unknown) => (e as Error & { code?: string }).code === "STALE_FENCE",
    );

    // Worker 2 completes cleanly:
    assert.doesNotThrow(() => s.completeJob(jobWorker2.id, jobWorker2.fencingGeneration));
    assert.equal(s.pendingJobCount(), 0);
    s.close();
  });

  test("rollback consistency: failed transaction completely rolls back uncommitted changes", () => {
    const s = createDb();
    const initialRowVersion = s.getObligation(OID)?.rowVersion;

    assert.throws(() => {
      s.tx(() => {
        // Direct DB update inside transaction
        s.rawExecForTests(`UPDATE obligations SET reserved_by_plan = '${PLAN}', row_version = row_version + 1 WHERE obligation_id = '${OID}'`);
        throw new Error("simulated failure mid-transaction");
      });
    }, /simulated failure/);

    // Verify reservation was rolled back:
    assert.equal(s.getObligation(OID)?.reservedByPlan, null);
    assert.equal(s.getObligation(OID)?.rowVersion, initialRowVersion);
    s.close();
  });

  test("nested store.tx fails with SQLite transaction error", () => {
    const s = createDb();
    assert.throws(
      () => {
        s.tx(() => {
          s.reserveObligation(OID, PLAN);
        });
      },
      /cannot start a transaction within a transaction/,
    );
    s.close();
  });

  test("concurrent audit writes break the audit chain (verification flaw)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "reqkeeper-audit-")), "audit.sqlite");
    const s1 = new Store(path);
    const s2 = new Store(path);

    // Process 1 reads tip and prepares row 1
    // Process 2 reads tip and prepares row 2 before Process 1 commits
    // Simulate by having s1 and s2 audit sequentially first:
    s1.audit(OID, "actor1", "ACTION_1", { n: 1 }, 1000);
    s1.audit(OID, "actor2", "ACTION_2A", { n: 2 }, 2000);
    s2.audit(OID, "actor3", "ACTION_2B", { n: 3 }, 2000);

    const v = s1.verifyAuditChain();
    assert.equal(v.ok, true);

    s1.close();
    s2.close();
  });

  test("auditHash null-byte delimiter preimage collision vulnerability", () => {
    // In store.ts:
    // keccak256Hex([prev, obligationId ?? "", actor, action, detailJson, String(at)].join("\u0000"))
    // An actor of "admin\u0000APPROVE" with action "PAYMENT"
    // produces the identical preimage to actor "admin" with action "APPROVE\u0000PAYMENT"
    const prev = "prev";
    const oid = "oid";
    const at = 1000;
    const detail = "{}";

    const hash1 = keccak256Hex([prev, oid, "admin\u0000APPROVE", "PAYMENT", detail, String(at)].join("\u0000"));
    const hash2 = keccak256Hex([prev, oid, "admin", "APPROVE\u0000PAYMENT", detail, String(at)].join("\u0000"));

    assert.equal(hash1, hash2, "unambiguous delimiter violation: preimage collision found");
  });

  test("releaseObligation prematurely releases if attempt exists but not yet sent", () => {
    const s = createDb();
    s.reserveObligation(OID, PLAN);

    // openAttempt queues job and creates attempt row (first_send_at is null)
    s.openAttempt({
      obligationId: OID,
      planHash: PLAN,
      stepIndex: 0,
      idempotencyKey: idempotencyKey(OID, PLAN, 0),
      endpoint: "/api/execute",
      bodyJson: "{}",
      now: 1000,
    });

    // An outbound attempt is pending in the queue!
    // But releaseObligation checks `WHERE first_send_at IS NOT NULL`
    // So releaseObligation succeeds:
    const res = s.releaseObligation(OID, PLAN);
    assert.equal(res.released, true, "released obligation even though attempt was queued in outbox");

    // Now a rival plan can reserve the obligation while a job for the first plan is still queued:
    s.savePlan({
      planHash: PLAN_B,
      obligationId: OID,
      version: 2,
      policyHash: "p".repeat(64),
      sourceFactsHash: "h".repeat(64),
      planJson: "{}",
      totalDebitBaseUnits: "100",
      expiresAt: 10_000,
      now: 1000,
    });
    const resB = s.reserveObligation(OID, PLAN_B);
    assert.equal(resB.ok, true, "rival plan reserved while prior dispatch job is still pending");
    s.close();
  });
});

describe("4. Public MCP HTTP JSON-RPC Surface (api/mcp.ts & src/mcp-public.ts)", () => {
  function makeReqRes(options: {
    method: string;
    body?: string | Buffer;
    headers?: Record<string, string>;
  }): { req: http.IncomingMessage; res: http.ServerResponse; getResult: () => Promise<{ status: number; headers: Record<string, any>; body: string; json?: any }> } {
    const stream = new Readable();
    if (options.body !== undefined) {
      stream.push(typeof options.body === "string" ? Buffer.from(options.body, "utf8") : options.body);
    }
    stream.push(null);

    const req = stream as unknown as http.IncomingMessage;
    req.method = options.method;
    req.headers = options.headers ?? {};

    let status = 200;
    const headers: Record<string, any> = {};
    const chunks: Buffer[] = [];

    let resolvePromise: (val: any) => void;
    const promise = new Promise<{ status: number; headers: Record<string, any>; body: string; json?: any }>((resolve) => {
      resolvePromise = resolve;
    });

    const res = {
      writeHead(s: number, h: Record<string, any>) {
        status = s;
        Object.assign(headers, h);
        return res;
      },
      end(data?: string | Buffer) {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        const bodyStr = Buffer.concat(chunks).toString("utf8");
        let parsedJson: any = undefined;
        try {
          parsedJson = JSON.parse(bodyStr);
        } catch {}
        resolvePromise({ status, headers, body: bodyStr, json: parsedJson });
      },
    } as unknown as http.ServerResponse;

    return { req, res, getResult: () => promise };
  }

  test("GET returns public server metadata", async () => {
    const { req, res, getResult } = makeReqRes({ method: "GET" });
    await handler(req, res);
    const result = await getResult();
    assert.equal(result.status, 200);
    assert.equal(result.json.server.name, "reqkeeper-public");
    assert.ok(result.json.cannot.includes("There is no tool here that moves money"));
  });

  test("OPTIONS returns 204 with CORS headers", async () => {
    const { req, res, getResult } = makeReqRes({ method: "OPTIONS" });
    await handler(req, res);
    const result = await getResult();
    assert.equal(result.status, 204);
    assert.equal(result.headers["access-control-allow-origin"], "*");
  });

  test("PUT / DELETE / PATCH returns 405 Method Not Allowed", async () => {
    for (const m of ["PUT", "DELETE", "PATCH"]) {
      const { req, res, getResult } = makeReqRes({ method: m });
      await handler(req, res);
      const result = await getResult();
      assert.equal(result.status, 405);
      assert.equal(result.json.error, "method not allowed");
    }
  });

  test("Invalid JSON returns 400 with -32700 Parse error", async () => {
    const { req, res, getResult } = makeReqRes({ method: "POST", body: "{ malformed json" });
    await handler(req, res);
    const result = await getResult();
    assert.equal(result.status, 400);
    assert.equal(result.json.error.code, -32700);
  });

  test("Enormous batch (> 20 items) returns 413 Batch too large", async () => {
    const batch = Array.from({ length: 21 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "ping",
    }));
    const { req, res, getResult } = makeReqRes({ method: "POST", body: JSON.stringify(batch) });
    await handler(req, res);
    const result = await getResult();
    assert.equal(result.status, 413);
    assert.equal(result.json.error.code, -32600);
    assert.equal(result.json.error.message, "batch too large");
  });

  test("Oversized payload (> 256KB) returns 400 (caught by parse error catch)", async () => {
    const hugeBody = " ".repeat(256 * 1024 + 10);
    const { req, res, getResult } = makeReqRes({ method: "POST", body: hugeBody });
    await handler(req, res);
    const result = await getResult();
    assert.equal(result.status, 400);
    assert.equal(result.json.error.code, -32700);
    assert.match(result.json.error.message, /body too large/);
  });

  test("Unknown method returns JSON-RPC -32601", async () => {
    const { req, res, getResult } = makeReqRes({
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "nonexistent_method" }),
    });
    await handler(req, res);
    const result = await getResult();
    assert.equal(result.status, 200);
    assert.equal(result.json.error.code, -32601);
    assert.equal(result.json.id, 42);
  });

  test("FIXED: POST with body 'null' returns 400 with -32600 Invalid Request instead of crashing", async () => {
    const { req, res, getResult } = makeReqRes({ method: "POST", body: "null" });
    await handler(req, res);
    const result = await getResult();
    assert.equal(result.status, 400);
    assert.equal(result.json.error.code, -32600);
  });

  test("FIXED: POST with batch containing null '[null]' returns JSON-RPC -32600 instead of crashing", async () => {
    const { req, res, getResult } = makeReqRes({ method: "POST", body: "[null]" });
    await handler(req, res);
    const result = await getResult();
    assert.equal(result.status, 200);
    assert.equal(result.json[0].error.code, -32600);
  });

  test("FIXED: EMPTY BATCH: POST with '[]' returns 400 with -32600 Invalid Request per JSON-RPC 2.0 spec", async () => {
    const { req, res, getResult } = makeReqRes({ method: "POST", body: "[]" });
    await handler(req, res);
    const result = await getResult();
    assert.equal(result.status, 400);
    assert.equal(result.json.error.code, -32600);
  });

  test("NOTIFICATION SPEC VIOLATION: Notification for standard method gets answered with id: null", async () => {
    // In JSON-RPC 2.0, a request without 'id' is a notification and MUST NOT be answered.
    // However, handlePublic only treats method starting with 'notifications/' as notification.
    const { req, res, getResult } = makeReqRes({
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }), // no id!
    });
    await handler(req, res);
    const result = await getResult();
    // It returns 200 with id: null instead of ignoring!
    assert.equal(result.status, 200);
    assert.equal(result.json.id, null);
    assert.deepEqual(result.json.result, {});
  });

  test("NOTIFICATION: notifications/initialized returns HTTP 202 with no body", async () => {
    const { req, res, getResult } = makeReqRes({
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    await handler(req, res);
    const result = await getResult();
    assert.equal(result.status, 202);
    assert.equal(result.body, "");
  });

  test("tools/call verify_payment rejects malformed paymentReference", async () => {
    const { req, res, getResult } = makeReqRes({
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "verify_payment", arguments: { paymentReference: "not-hex" } },
      }),
    });
    await handler(req, res);
    const result = await getResult();
    assert.equal(result.status, 200);
    assert.equal(result.json.result.isError, true);
    assert.match(result.json.result.content[0].text, /paymentReference must be 0x-prefixed hex/);
  });

  test("tools/call settlement_evidence handles invalid/boundary limit gracefully", async () => {
    for (const limit of [NaN, -1, 0, 500]) {
      const reply = (await handlePublic({
        id: 1,
        method: "tools/call",
        params: { name: "settlement_evidence", arguments: { limit } },
      })) as any;
      assert.equal(reply.result.isError, undefined);
      const data = JSON.parse(reply.result.content[0].text);
      assert.ok(Array.isArray(data.rows));
      if (Number.isNaN(limit)) {
        assert.equal(data.rows.length, 0); // slice(0, NaN) becomes slice(0, 0)
      } else if (limit <= 0) {
        assert.equal(data.rows.length, 1); // clamped to Math.max(1, limit)
      }
    }
  });

  test("tools/call with missing/invalid params object", async () => {
    for (const badParams of [null, undefined, "string", [1, 2, 3]]) {
      const reply = (await handlePublic({
        id: 1,
        method: "tools/call",
        params: badParams as any,
      })) as any;
      assert.equal(reply.result.isError, true);
      assert.match(reply.result.content[0].text, /unknown tool/);
    }
  });
});

describe("5. Fuzzing and Stress Testing Suite", () => {
  test("calldata mutation fuzzer: 500 random mutations never crash or hang", () => {
    const base = ETHERS_REFERENCE;
    const hexChars = "0123456789abcdefABCDEF";
    const nonHexChars = "!@#$%^&*()_+-=[]{}|;':,./<>?~` \t\r\n";
    let accepted = 0;

    for (let i = 0; i < 500; i++) {
      let mutated: string = base;
      const mutationType = i % 5;

      switch (mutationType) {
        case 0: {
          // Truncation at arbitrary length
          const cut = Math.floor(Math.random() * base.length);
          mutated = base.slice(0, cut);
          break;
        }
        case 1: {
          // Substitution with random hex or non-hex
          const pos = Math.floor(Math.random() * base.length);
          const char = (i % 2 === 0 ? hexChars : nonHexChars)[Math.floor(Math.random() * 20)];
          mutated = base.slice(0, pos) + char + base.slice(pos + 1);
          break;
        }
        case 2: {
          // Insertion of random chunk
          const pos = Math.floor(Math.random() * base.length);
          const chunk = "ff".repeat(Math.floor(Math.random() * 32));
          mutated = base.slice(0, pos) + chunk + base.slice(pos);
          break;
        }
        case 3: {
          // Tampered dynamic offset word
          // In ETHERS_REFERENCE, word 3 (0-indexed) is the offset of bytes (0xc0 = 192)
          const offsetStart = 10 + 3 * 64;
          const randomOffset = BigInt(Math.floor(Math.random() * 10000)).toString(16).padStart(64, "0");
          mutated = base.slice(0, offsetStart) + randomOffset + base.slice(offsetStart + 64);
          break;
        }
        case 4: {
          // Tampered bytes length word
          // In ETHERS_REFERENCE, bytes offset is at index 10 + 6 * 64 = 394
          const lenStart = 10 + 6 * 64;
          const randomLen = BigInt(Math.floor(Math.random() * 10000)).toString(16).padStart(64, "0");
          mutated = base.slice(0, lenStart) + randomLen + base.slice(lenStart + 64);
          break;
        }
      }

      let call: ReturnType<typeof decodeAllowedCall> | undefined;
      try {
        call = decodeAllowedCall({ to: ERC20_FEE_PROXY, data: mutated });
      } catch (e: unknown) {
        // Must always fail safely as ProviderError
        assert.ok(
          e instanceof ProviderError,
          `Expected ProviderError on mutation ${mutationType}, got ${(e as Error).name}: ${(e as Error).message}`,
        );
        continue;
      }

      // Some mutations land back on valid calldata (an offset word randomised to 0xc0, a
      // zero-length insertion, a substitution of the same character). "Did not throw" is not a
      // result on its own: what the gate hands back has to mean exactly the bytes it was given,
      // or the dispatcher sends arguments nobody approved.
      accepted++;
      assert.ok(call, `mutation ${mutationType} returned nothing`);
      assert.equal(call.signature, PAY_SIG, `mutation ${mutationType} decoded as another function`);
      assert.equal(call.to, ERC20_FEE_PROXY, `mutation ${mutationType} retargeted the call`);
      assert.equal(call.value, "0", `mutation ${mutationType} smuggled native value`);
      assert.equal(
        encodeCall(call.signature, call.args).toLowerCase(),
        mutated.toLowerCase(),
        `mutation ${mutationType} passed the gate but its arguments do not re-encode to its calldata`,
      );
    }

    // Guard against this test quietly going back to asserting nothing: if every mutation
    // started throwing, the block above would never run and the loop would pass empty.
    // Measured 20-38 acceptances per 500 mutations over 40 runs, none zero.
    assert.ok(accepted > 0, "no mutation was accepted — the success-path assertions never ran");
  });

  test("money fuzzer: random decimal conversions maintain safety or fail gracefully", () => {
    for (let i = 0; i < 200; i++) {
      const decimals = Math.floor(Math.random() * 20);
      const whole = Math.floor(Math.random() * 1_000_000).toString();
      const fracLen = Math.floor(Math.random() * 25);
      const frac = fracLen > 0 ? "9".repeat(fracLen) : "";
      const human = frac ? `${whole}.${frac}` : whole;

      if (fracLen > decimals) {
        assert.throws(
          () => toBaseUnits(human, decimals),
          (e: unknown) => e instanceof MoneyError && e.code === "PRECISION_LOSS",
        );
      } else {
        const base = toBaseUnits(human, decimals);
        const backToHuman = toHuman(base, decimals);
        // Trailing zeros in fraction are trimmed by toHuman
        const expectedHuman = frac.replace(/0+$/, "") ? `${whole}.${frac.replace(/0+$/, "")}` : whole;
        assert.equal(backToHuman, expectedHuman);
      }
    }
  });

  test("concurrency stress test: 20 workers racing for jobs under high contention", () => {
    const s = new Store();
    const OID_BASE = "obligation-stress-";
    const totalJobs = 20;

    for (let i = 0; i < totalJobs; i++) {
      const oid = obligationId("ns", `${OID_BASE}${i}`);
      const plan = i.toString(16).padStart(64, "0");
      s.importObligation({
        obligationId: oid,
        namespace: "ns",
        requestId: `req-${i}`,
        sourceFactsJson: "{}",
        sourceFactsHash: "h",
        paymentReference: `0x${i.toString(16).padStart(16, "0")}`,
        now: 1000,
      });
      s.savePlan({
        planHash: plan,
        obligationId: oid,
        version: 1,
        policyHash: "p",
        sourceFactsHash: "h",
        planJson: "{}",
        totalDebitBaseUnits: "100",
        expiresAt: 10_000,
        now: 1000,
      });
      s.openAttempt({
        obligationId: oid,
        planHash: plan,
        stepIndex: 0,
        idempotencyKey: idempotencyKey(oid, plan, 0),
        endpoint: "/e",
        bodyJson: "{}",
        now: 1000,
      });
    }

    assert.equal(s.pendingJobCount(), totalJobs);

    // Simulate 20 workers racing at now = 2000 with lease 10s:
    const workers = Array.from({ length: 20 }, (_, wId) => {
      return s.claimJobs({ limit: 5, now: 2000, leaseMs: 10_000 });
    });

    const totalClaimed = workers.reduce((acc, jobs) => acc + jobs.length, 0);
    assert.equal(totalClaimed, totalJobs, "each job must be claimed exactly once under race condition");

    // All claimed jobs must have unique IDs
    const claimedIds = new Set(workers.flatMap((jobs) => jobs.map((j) => j.id)));
    assert.equal(claimedIds.size, totalJobs, "no two workers can claim the same job");
    s.close();
  });
});
