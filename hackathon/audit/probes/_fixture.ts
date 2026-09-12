/** Red-team scratch fixtures. Nothing in src/ imports this. */
import { buildPolicy, buildSourceFacts, buildSteps, NAMESPACE, type InvoiceFacts } from "../../../src/plan.ts";
import { NO_STANDING_POLICY } from "../../../src/standing-policy.ts";
import { obligationId } from "../../../src/identity.ts";
import type { SettleInput } from "../../../src/settle.ts";

export const PAYEE = "0x0e2bb1c8d52315cad63f341424c5a7dd81a50f53";

export function invoice(over: Partial<InvoiceFacts> = {}): InvoiceFacts {
  return {
    requestId: "01req-red-team-0001",
    paymentReference: "0x0102030405060708",
    payee: PAYEE,
    amountBaseUnits: "1000000000000000000",
    feeAmount: "0",
    feeAddress: PAYEE,
    maxTotalDebitBaseUnits: "5000000000000000000",
    hasBeenPaid: false,
    ...over,
  };
}

export function policyFor(f: InvoiceFacts) {
  return buildPolicy(f, NO_STANDING_POLICY);
}

export function inputFor(f: InvoiceFacts, over: Partial<SettleInput> = {}): SettleInput {
  return {
    namespace: NAMESPACE,
    requestId: f.requestId,
    paymentReference: f.paymentReference,
    obligationId: obligationId(NAMESPACE, f.requestId),
    facts: buildSourceFacts(f),
    steps: buildSteps(f),
    approval: { approver: "red@team", decision: "APPROVED" },
    now: Date.now(),
    ...over,
  };
}

export const alwaysPaid = async () => true;
export const neverPaid = async () => false;
