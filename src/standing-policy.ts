/**
 * The policy the operator owns, not the one the agent hands over.
 *
 * `buildPolicy` used to derive every constraint from the same invoice it would then check —
 * `allowedPayees: [f.payee]`, `maxFeeBaseUnits: f.feeAmount` — so `checkPolicy` compared the
 * invoice to itself. Five of the nine refusal codes could not fire on either real entry
 * point: an agent proposing an attacker payee with a 500 FAU fee to an attacker fee address
 * got a clean approval sentence. The refusal table demonstrated a gate against a standing
 * policy that existed only inside the harness.
 *
 * A standing policy is a thing a human writes down once, out of band, and the agent cannot
 * reach. It lives in the environment or a JSON file next to the database — never in the
 * proposal. Where the operator has set nothing, the invoice-derived value is used and the
 * fact is reported, so a bare clone still runs but nobody is told it is protected when it
 * is not.
 */

import { existsSync, readFileSync } from "node:fs";

export interface StandingPolicy {
  /** Recipients this workspace will pay at all. Empty means the operator set none. */
  readonly allowedPayees: readonly string[];
  readonly allowedFeeRecipients: readonly string[];
  /** Ceiling on the TOTAL debit. An agent's own cap is clamped to this, never above it. */
  readonly maxTotalDebitBaseUnits: string | null;
  readonly maxFeeBaseUnits: string | null;
  /** Which of the above the operator actually set. The UI and the docs must not overstate. */
  readonly source: "environment" | "file" | "none" | "mixed";
}

export const NO_STANDING_POLICY: StandingPolicy = {
  allowedPayees: [],
  allowedFeeRecipients: [],
  maxTotalDebitBaseUnits: null,
  maxFeeBaseUnits: null,
  source: "none",
};

function list(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
}

function baseUnits(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  return /^\d+$/.test(t) ? t : null;
}

/**
 * Read the standing policy.
 *
 * Environment first, then `policy.json` beside the database, because an operator running one
 * process wants an env var and an operator running many wants a file. Anything malformed is
 * treated as unset rather than as zero: a ceiling that silently became "0" would refuse every
 * payment, and an allowlist that silently became empty would look like a working gate.
 */
export function loadStandingPolicy(
  env: Record<string, string | undefined> = process.env,
  filePath = "policy.json",
): StandingPolicy {
  const fromEnv = {
    allowedPayees: list(env.REQKEEPER_ALLOWED_PAYEES),
    allowedFeeRecipients: list(env.REQKEEPER_ALLOWED_FEE_RECIPIENTS),
    maxTotalDebitBaseUnits: baseUnits(env.REQKEEPER_MAX_DEBIT),
    maxFeeBaseUnits: baseUnits(env.REQKEEPER_MAX_FEE),
  };

  let fromFile = {
    allowedPayees: [] as string[],
    allowedFeeRecipients: [] as string[],
    maxTotalDebitBaseUnits: null as string | null,
    maxFeeBaseUnits: null as string | null,
  };
  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
      fromFile = {
        allowedPayees: list(Array.isArray(raw.allowedPayees) ? raw.allowedPayees.join(",") : undefined),
        allowedFeeRecipients: list(
          Array.isArray(raw.allowedFeeRecipients) ? raw.allowedFeeRecipients.join(",") : undefined,
        ),
        maxTotalDebitBaseUnits: baseUnits(typeof raw.maxTotalDebitBaseUnits === "string" ? raw.maxTotalDebitBaseUnits : undefined),
        maxFeeBaseUnits: baseUnits(typeof raw.maxFeeBaseUnits === "string" ? raw.maxFeeBaseUnits : undefined),
      };
    } catch {
      // A malformed policy file is not a reason to fall back to "no limits" quietly, but it
      // is also not this module's job to crash a process. The caller reports `source`.
      fromFile = { allowedPayees: [], allowedFeeRecipients: [], maxTotalDebitBaseUnits: null, maxFeeBaseUnits: null };
    }
  }

  const merged = {
    allowedPayees: fromEnv.allowedPayees.length > 0 ? fromEnv.allowedPayees : fromFile.allowedPayees,
    allowedFeeRecipients:
      fromEnv.allowedFeeRecipients.length > 0 ? fromEnv.allowedFeeRecipients : fromFile.allowedFeeRecipients,
    maxTotalDebitBaseUnits: fromEnv.maxTotalDebitBaseUnits ?? fromFile.maxTotalDebitBaseUnits,
    maxFeeBaseUnits: fromEnv.maxFeeBaseUnits ?? fromFile.maxFeeBaseUnits,
  };

  const usedEnv =
    fromEnv.allowedPayees.length > 0 ||
    fromEnv.allowedFeeRecipients.length > 0 ||
    fromEnv.maxTotalDebitBaseUnits !== null ||
    fromEnv.maxFeeBaseUnits !== null;
  const usedFile =
    fromFile.allowedPayees.length > 0 ||
    fromFile.allowedFeeRecipients.length > 0 ||
    fromFile.maxTotalDebitBaseUnits !== null ||
    fromFile.maxFeeBaseUnits !== null;

  const source: StandingPolicy["source"] =
    usedEnv && usedFile ? "mixed" : usedEnv ? "environment" : usedFile ? "file" : "none";

  return { ...merged, source };
}

/** Human-readable statement of what is actually enforced. Used by the CLI and the docs. */
export function describeStandingPolicy(p: StandingPolicy): string {
  if (p.source === "none") {
    return (
      "no standing policy set — every ceiling and allowlist in this plan comes from the " +
      "invoice itself, so the policy gate can only catch facts that CHANGE after approval. " +
      "Set REQKEEPER_ALLOWED_PAYEES and REQKEEPER_MAX_DEBIT to make it a real gate."
    );
  }
  const parts: string[] = [];
  if (p.allowedPayees.length > 0) parts.push(`${p.allowedPayees.length} allowed payee(s)`);
  if (p.allowedFeeRecipients.length > 0) parts.push(`${p.allowedFeeRecipients.length} allowed fee recipient(s)`);
  if (p.maxTotalDebitBaseUnits) parts.push(`max total debit ${p.maxTotalDebitBaseUnits}`);
  if (p.maxFeeBaseUnits) parts.push(`max fee ${p.maxFeeBaseUnits}`);
  return `standing policy from ${p.source}: ${parts.join(", ")}`;
}
