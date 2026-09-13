/**
 * One sighting, three consumers, one reading.
 *
 * `PaymentSighting` carries `found`, `truncated`, `corroborated`, `conflicts`, `conflictingLogs`
 * and `negativeCorroborations`. Three places decide money from it: the already-paid gate that
 * decides whether an invoice may be proposed at all, the worker that decides whether an
 * obligation whose dry run never came back may be released and paid again, and the operator
 * escape a human types when the automatic release cannot prove itself.
 *
 * Each of them read those fields itself, in its own order, and `verdictFor` -- the function that
 * exists so they would not -- read them a fourth way. They disagreed, and the disagreement ran
 * in the dangerous direction: a scan that never said what conflicting logs it saw, and a negative
 * no second endpoint would confirm, came back NOT_PAID from `verdictFor` while both release paths
 * refused those same sightings outright. The weakest of the four readings was the one guarding
 * the gate, and that gate is the only thing standing between an invoice somebody else already
 * paid and a human being shown a plan to pay it again.
 *
 * So this is not another instance test. It is the property: over a matrix of sightings, no
 * consumer takes its permissive branch unless `verdictFor` says NOT_PAID, and every consumer
 * takes it when it does. A fifth reading added anywhere, or a field quietly dropped from one of
 * them, breaks this file — which is what none of the individual tests could do.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { verdictFor, type PaymentSighting } from "../src/chain.ts";
import { operatorReleaseDecision } from "../src/exclusion.ts";
import { obligationId } from "../src/identity.ts";
import { handleRequest, type McpContext } from "../src/mcp.ts";
import { toBaseUnits } from "../src/money.ts";
import { NAMESPACE } from "../src/plan.ts";
import { FixtureProvider, type Receipt } from "../src/provider.ts";
import { Store } from "../src/store.ts";
import { drainUntilQuiet } from "../src/worker.ts";

const FAU = "0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C";
const PAYEE = "0xc43d766CB7c48B9B198db87441b97c09e81717A1";
const FEE_ADDR = `0x${"0".repeat(40)}`;
const REQUEST_ID = "01b7cd715cfe60ac07f637ed0eb62bf5d1c00c56e3599b8ce6b0a962e8b7f49914";
const REFERENCE = "0x7a3496f145f70a31";
const AMOUNT = toBaseUnits("1", 18).toString();
const OID = obligationId(NAMESPACE, REQUEST_ID);
const PAYER = "0x00000000000000000000000000000000000ce111";
const PREFLIGHT_NONCE = 42;
const PREFLIGHT_BLOCK = 11_000_000;
const CEILING = PREFLIGHT_BLOCK + 10;
const TX = `0x${"ab".repeat(32)}`;

/**
 * Every interesting shape a reader can hand back, including the ones a reader produces by
 * FORGETTING a field. Absent is the case that has cost this project the most, so it is not an
 * edge here: it is half the matrix.
 */
const MATRIX: ReadonlyArray<{ name: string; conclusive: boolean; sighting: PaymentSighting }> = [
  {
    name: "covered, corroborated, nothing in it",
    conclusive: true,
    sighting: { found: false, truncated: false, conflictingLogs: [], negativeCorroborations: 2, scannedTo: CEILING },
  },
  {
    name: "covered and corroborated, with a log that paid somebody else",
    conclusive: true,
    sighting: {
      found: false,
      truncated: false,
      conflicts: ["0xdead: pays 0xdeadbeef, not our payee"],
      conflictingLogs: [["to"]],
      negativeCorroborations: 1,
      scannedTo: CEILING,
    },
  },
  {
    name: "covered, but a log paid OUR payee for the wrong fee",
    conclusive: false,
    sighting: {
      found: false,
      truncated: false,
      conflicts: ["0xdead: pays a fee of 1, the plan fee is 0"],
      conflictingLogs: [["fee"]],
      negativeCorroborations: 2,
      scannedTo: CEILING,
    },
  },
  {
    name: "covered, but nobody else answered the negative",
    conclusive: false,
    sighting: { found: false, truncated: false, conflictingLogs: [], scannedTo: CEILING },
  },
  {
    name: "covered, corroborated, but it never said what conflicting logs it saw",
    conclusive: false,
    sighting: { found: false, truncated: false, negativeCorroborations: 2, scannedTo: CEILING },
  },
  {
    name: "the window stopped short",
    conclusive: false,
    sighting: { found: false, truncated: true, conflictingLogs: [], negativeCorroborations: 2, scannedTo: CEILING },
  },
  {
    name: "it never said whether the window stopped short",
    conclusive: false,
    sighting: { found: false, conflictingLogs: [], negativeCorroborations: 2, scannedTo: CEILING },
  },
  {
    name: "a payment, corroborated",
    conclusive: false,
    sighting: { found: true, txHash: TX, corroborated: true, amount: AMOUNT, to: PAYEE, tokenAddress: FAU, scannedTo: CEILING },
  },
  {
    name: "a payment only one endpoint could see",
    conclusive: false,
    sighting: { found: true, txHash: TX, corroborated: false, amount: AMOUNT, to: PAYEE, tokenAddress: FAU, scannedTo: CEILING },
  },
];

/** What a caller may do only when the chain has actually said "nothing paid this invoice". */
function isConclusiveNegative(s: PaymentSighting): boolean {
  return verdictFor(s).kind === "NOT_PAID";
}

// --- consumer 1: the gate that decides whether an invoice may be proposed at all -------------

const invoice = {
  requestId: REQUEST_ID,
  chainId: 11155111,
  tokenAddress: FAU,
  payee: PAYEE,
  payeeOfRecord: PAYEE,
  invoiceBaseUnits: AMOUNT,
  feeBaseUnits: "0",
  feeRecipient: FEE_ADDR,
  salt: "0123456789abcdef",
  paymentReference: REFERENCE,
};

async function proposesAnything(sighting: PaymentSighting): Promise<boolean> {
  const store = new Store();
  try {
    const ctx = {
      store,
      provider: new FixtureProvider(),
      findPayment: async () => sighting,
      fetchInvoice: async () => invoice,
    } as unknown as McpContext;
    const reply = await handleRequest(ctx, {
      id: 1,
      method: "tools/call",
      params: {
        name: "propose_payment",
        arguments: {
          requestId: REQUEST_ID,
          paymentReference: REFERENCE,
          payee: PAYEE,
          amountBaseUnits: AMOUNT,
          maxTotalDebitBaseUnits: AMOUNT,
          feeAmount: "0",
          feeAddress: FEE_ADDR,
          tokenAddress: FAU,
        },
      },
    });
    const body = JSON.parse((reply?.result as { content: Array<{ text: string }> }).content[0].text) as {
      state?: string;
      refusal?: string | null;
    };
    // A proposal is a plan put in front of a human with "pay this" on it. Anything else — a
    // refusal, or the policy stopping it as already paid — is the gate holding.
    return body.state === "AWAITING_APPROVAL" && !body.refusal;
  } finally {
    store.close();
  }
}

// --- consumer 2: the worker that releases an obligation whose dry run never came back ---------

/** An obligation parked in PAYMENT_PREFLIGHT, with a nonce reading that proves the leak is dead. */
function releasesAutomatically(sighting: PaymentSighting): Promise<string> {
  const store = new Store();
  store.importObligation({
    obligationId: OID,
    namespace: NAMESPACE,
    requestId: REQUEST_ID,
    sourceFactsJson: JSON.stringify({ anchorBlock: PREFLIGHT_BLOCK - 1000 }),
    sourceFactsHash: "h",
    paymentReference: REFERENCE,
    now: 1,
  });
  store.setState(OID, "VALIDATING", 1);
  store.setState(OID, "AWAITING_APPROVAL", 1);
  store.setState(OID, "APPROVED", 1);
  store.beginPreflight(OID, "f".repeat(64), 1, PREFLIGHT_BLOCK, PREFLIGHT_NONCE);

  return drainUntilQuiet(
    {
      store,
      provider: { receipt: async () => null as unknown as Receipt },
      sourceSaysPaid: async () => false,
      sightPayment: async () => sighting,
      payer: PAYER,
      payerIsDedicated: true,
      // The nonce the dry run would have used is spent, proven as of a block this scan reached.
      // So leak exclusion is never what decides the cases below: the sighting is.
      readPayerNonce: async () => ({
        payer: PAYER,
        nonce: PREFLIGHT_NONCE + 1,
        pending: PREFLIGHT_NONCE + 1,
        head: sighting.scannedTo ?? CEILING,
      }),
    },
    { now: 1_000_000, maxPasses: 3, lookaheadMs: 120_000 },
  ).then(() => {
    const state = store.getObligation(OID)?.state ?? "GONE";
    store.close();
    return state;
  });
}

describe("no consumer of a sighting is more willing than the verdict", () => {
  for (const { name, conclusive, sighting } of MATRIX) {
    test(name, async () => {
      // Written by hand, not read off `verdictFor`. The three consumers below are checked
      // against the verdict, so a verdict that got LOOSER would carry every consumer with it and
      // the agreement would still hold -- a matrix that only checks agreement cannot see the
      // whole system drifting in one direction, which is exactly how this drifted.
      assert.equal(
        isConclusiveNegative(sighting),
        conclusive,
        `verdictFor no longer reads "${name}" the way this file says it must`,
      );

      // 1. The gate. A proposal is the step that puts "pay this" in front of a human, and the
      //    only thing protecting that human from an invoice somebody else already settled is
      //    this read.
      assert.equal(
        await proposesAnything(sighting),
        conclusive,
        `the already-paid gate and verdictFor disagree about "${name}"`,
      );

      // 2. The worker. Releasing here makes the obligation payable again, so a permissive
      //    reading costs a second physical send on one human approval.
      const state = await releasesAutomatically(sighting);
      assert.equal(
        state === "PREFLIGHT_UNAVAILABLE",
        conclusive,
        `the worker and verdictFor disagree about "${name}" (it reached ${state})`,
      );

      // 3. The operator escape. A human typing this is signing "no payment for this reference on
      //    chain" into the audit trail, so it may not be easier to satisfy than the automatic
      //    path it exists to substitute for.
      // The leak is proven dead in every case here, so the SIGHTING is what decides -- which is
      // what this file is about. The proof itself is the subject of test/operator-release.test.ts.
      const decision = operatorReleaseDecision({
        state: "PAYMENT_PREFLIGHT",
        exclusion: {
          kind: "NONCE_CONSUMED",
          payer: PAYER,
          preflightNonce: PREFLIGHT_NONCE,
          observedNonce: PREFLIGHT_NONCE + 1,
          provenThroughBlock: CEILING,
        },
        sighting,
      });
      assert.equal(
        decision.kind === "RELEASE",
        conclusive,
        `the operator escape and verdictFor disagree about "${name}" (it answered ${decision.kind})`,
      );
    });
  }

  test("the matrix actually contains both answers, or the property above is vacuous", () => {
    const conclusive = MATRIX.filter((m) => m.conclusive);
    assert.ok(conclusive.length >= 2, "no sighting in the matrix reads as conclusively unpaid");
    assert.ok(conclusive.length < MATRIX.length, "every sighting reads as conclusively unpaid");
  });
});
