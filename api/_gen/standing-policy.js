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
export const NO_STANDING_POLICY = {
    allowedPayees: [],
    allowedFeeRecipients: [],
    maxTotalDebitBaseUnits: null,
    maxFeeBaseUnits: null,
    source: "none",
    gaps: [],
};
/** Addresses, and whatever was there instead. A dropped entry is not an entry never written. */
function list(raw) {
    if (!raw)
        return { ok: [], rejected: [] };
    const entries = raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
    return {
        ok: entries.filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
        rejected: entries.filter((s) => !/^0x[0-9a-f]{40}$/.test(s)),
    };
}
function baseUnits(raw) {
    if (raw === undefined || raw === null)
        return { value: null, rejected: false };
    if (typeof raw !== "string")
        return { value: null, rejected: true };
    const t = raw.trim();
    if (t.length === 0)
        return { value: null, rejected: false };
    return /^\d+$/.test(t) ? { value: t, rejected: false } : { value: null, rejected: true };
}
/**
 * Read the standing policy.
 *
 * Environment first, then `policy.json` beside the database, because an operator running one
 * process wants an env var and an operator running many wants a file. Anything malformed is
 * treated as unset rather than as zero: a ceiling that silently became "0" would refuse every
 * payment, and an allowlist that silently became empty would look like a working gate.
 */
export function loadStandingPolicy(env = process.env, filePath = "policy.json") {
    const gaps = [];
    const envPayees = list(env.REQKEEPER_ALLOWED_PAYEES);
    const envFees = list(env.REQKEEPER_ALLOWED_FEE_RECIPIENTS);
    const envDebit = baseUnits(env.REQKEEPER_MAX_DEBIT);
    const envFee = baseUnits(env.REQKEEPER_MAX_FEE);
    if (envPayees.rejected.length > 0) {
        gaps.push({ field: "allowedPayees", detail: `REQKEEPER_ALLOWED_PAYEES: ${envPayees.rejected.join(", ")}` });
    }
    if (envFees.rejected.length > 0) {
        gaps.push({ field: "allowedFeeRecipients", detail: `REQKEEPER_ALLOWED_FEE_RECIPIENTS: ${envFees.rejected.join(", ")}` });
    }
    if (envDebit.rejected)
        gaps.push({ field: "maxTotalDebitBaseUnits", detail: "REQKEEPER_MAX_DEBIT is not a decimal string" });
    if (envFee.rejected)
        gaps.push({ field: "maxFeeBaseUnits", detail: "REQKEEPER_MAX_FEE is not a decimal string" });
    const fromEnv = {
        allowedPayees: envPayees.ok,
        allowedFeeRecipients: envFees.ok,
        maxTotalDebitBaseUnits: envDebit.value,
        maxFeeBaseUnits: envFee.value,
    };
    let fromFile = {
        allowedPayees: [],
        allowedFeeRecipients: [],
        maxTotalDebitBaseUnits: null,
        maxFeeBaseUnits: null,
    };
    if (existsSync(filePath)) {
        try {
            const raw = JSON.parse(readFileSync(filePath, "utf8"));
            const filePayees = list(Array.isArray(raw.allowedPayees) ? raw.allowedPayees.join(",") : undefined);
            const fileFees = list(Array.isArray(raw.allowedFeeRecipients) ? raw.allowedFeeRecipients.join(",") : undefined);
            const fileDebit = baseUnits(raw.maxTotalDebitBaseUnits);
            const fileFee = baseUnits(raw.maxFeeBaseUnits);
            // A key that is present and the wrong SHAPE is a gap too: `allowedPayees` written as a
            // string rather than an array reaches `list(undefined)` and vanishes without a trace.
            if (raw.allowedPayees !== undefined && !Array.isArray(raw.allowedPayees)) {
                gaps.push({ field: "allowedPayees", detail: `${filePath}: allowedPayees is not an array` });
            }
            if (raw.allowedFeeRecipients !== undefined && !Array.isArray(raw.allowedFeeRecipients)) {
                gaps.push({ field: "allowedFeeRecipients", detail: `${filePath}: allowedFeeRecipients is not an array` });
            }
            if (filePayees.rejected.length > 0) {
                gaps.push({ field: "allowedPayees", detail: `${filePath}: ${filePayees.rejected.join(", ")}` });
            }
            if (fileFees.rejected.length > 0) {
                gaps.push({ field: "allowedFeeRecipients", detail: `${filePath}: ${fileFees.rejected.join(", ")}` });
            }
            if (fileDebit.rejected) {
                gaps.push({ field: "maxTotalDebitBaseUnits", detail: `${filePath}: maxTotalDebitBaseUnits must be a decimal STRING` });
            }
            if (fileFee.rejected) {
                gaps.push({ field: "maxFeeBaseUnits", detail: `${filePath}: maxFeeBaseUnits must be a decimal STRING` });
            }
            fromFile = {
                allowedPayees: filePayees.ok,
                allowedFeeRecipients: fileFees.ok,
                maxTotalDebitBaseUnits: fileDebit.value,
                maxFeeBaseUnits: fileFee.value,
            };
        }
        catch (e) {
            // A malformed policy file is not "no policy". It is an operator who meant something this
            // process could not read, and the difference decides whether the payee allowlist exists.
            gaps.push({ field: "file", detail: `${filePath} did not parse: ${e.message.slice(0, 120)}` });
            fromFile = { allowedPayees: [], allowedFeeRecipients: [], maxTotalDebitBaseUnits: null, maxFeeBaseUnits: null };
        }
    }
    const merged = {
        allowedPayees: fromEnv.allowedPayees.length > 0 ? fromEnv.allowedPayees : fromFile.allowedPayees,
        allowedFeeRecipients: fromEnv.allowedFeeRecipients.length > 0 ? fromEnv.allowedFeeRecipients : fromFile.allowedFeeRecipients,
        maxTotalDebitBaseUnits: fromEnv.maxTotalDebitBaseUnits ?? fromFile.maxTotalDebitBaseUnits,
        maxFeeBaseUnits: fromEnv.maxFeeBaseUnits ?? fromFile.maxFeeBaseUnits,
    };
    const usedEnv = fromEnv.allowedPayees.length > 0 ||
        fromEnv.allowedFeeRecipients.length > 0 ||
        fromEnv.maxTotalDebitBaseUnits !== null ||
        fromEnv.maxFeeBaseUnits !== null;
    const usedFile = fromFile.allowedPayees.length > 0 ||
        fromFile.allowedFeeRecipients.length > 0 ||
        fromFile.maxTotalDebitBaseUnits !== null ||
        fromFile.maxFeeBaseUnits !== null;
    const source = gaps.length > 0 && !usedEnv && !usedFile
        ? "unreadable"
        : usedEnv && usedFile
            ? "mixed"
            : usedEnv
                ? "environment"
                : usedFile
                    ? "file"
                    : "none";
    return { ...merged, source, gaps };
}
/** Human-readable statement of what is actually enforced. Used by the CLI and the docs. */
export function describeStandingPolicy(p) {
    if (p.gaps.length > 0) {
        // Named first, and never folded into the "none" sentence. An operator who wrote a policy and
        // is told "no standing policy set" reads it as their choice rather than their typo.
        return (`standing policy PARTIALLY UNREADABLE (${p.gaps.map((g) => g.detail).join("; ")}). ` +
            "What could not be read is NOT in force. Fix it before approving anything: an allowlist " +
            "that silently became empty looks exactly like a working gate.");
    }
    if (p.source === "none") {
        return ("no standing policy set — every ceiling and allowlist in this plan comes from the " +
            "invoice itself, so the policy gate can only catch facts that CHANGE after approval. " +
            "Set REQKEEPER_ALLOWED_PAYEES and REQKEEPER_MAX_DEBIT to make it a real gate.");
    }
    const parts = [];
    if (p.allowedPayees.length > 0)
        parts.push(`${p.allowedPayees.length} allowed payee(s)`);
    if (p.allowedFeeRecipients.length > 0)
        parts.push(`${p.allowedFeeRecipients.length} allowed fee recipient(s)`);
    if (p.maxTotalDebitBaseUnits)
        parts.push(`max total debit ${p.maxTotalDebitBaseUnits}`);
    if (p.maxFeeBaseUnits)
        parts.push(`max fee ${p.maxFeeBaseUnits}`);
    return `standing policy from ${p.source}: ${parts.join(", ")}`;
}
