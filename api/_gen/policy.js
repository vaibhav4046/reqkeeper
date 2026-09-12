/**
 * Deterministic policy. No LLM runs here, and nothing in this file reads the clock except
 * where a caller passes the time in explicitly.
 *
 * Every refusal returns a stable code plus a detail string safe to show a human. The codes
 * are the rows of the refusal table that the submission is scored on, so they are part of
 * the contract, not debug output.
 */
import { assertFitsUint256, baseUnitsFromString, MAX_UINT256 } from "./money.js";
/**
 * Networks where a mistake costs real money. Refused outright, whatever the policy says.
 *
 * Ethereum, Optimism, BNB, Polygon, Base, Arbitrum, Avalanche. Not exhaustive, and not meant
 * to be: it is a floor, not a firewall. Adding a chain here is a one-line change; removing
 * the check is a decision someone has to make deliberately.
 */
const MAINNET_CHAIN_IDS = new Set([1, 10, 56, 137, 8453, 42161, 43114]);
/**
 * EVM addresses are case-insensitive on chain; the mixed case in a checksummed address is a
 * checksum, not an identity. Comparing them raw is how an allowlist silently fails open or
 * closed depending on who formatted the string.
 */
export function normaliseAddress(address) {
    const a = address.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) {
        throw new Error(`not an EVM address: ${JSON.stringify(address)}`);
    }
    return a;
}
function refuse(code, detail) {
    return { ok: false, code, detail };
}
/**
 * The whole gate. Ordered cheapest-and-most-fundamental first so the refusal a human sees
 * names the root problem rather than a downstream symptom.
 */
export function checkPolicy(policy, facts) {
    if (facts.hasBeenPaid) {
        return refuse("SOURCE_ALREADY_PAID", "the invoice facts say this obligation is already paid");
    }
    // The README says mainnet is disabled in code, and this is the code. It used to be a single
    // equality check against whatever the policy happened to name, so a caller constructing a
    // Policy with chainId 1 passed straight through and the claim was prose, not a guard.
    if (MAINNET_CHAIN_IDS.has(facts.chainId) || MAINNET_CHAIN_IDS.has(policy.chainId)) {
        return refuse("UNSUPPORTED_CHAIN", `chain ${MAINNET_CHAIN_IDS.has(facts.chainId) ? facts.chainId : policy.chainId} is a ` +
            "production network. This project is testnet-only by construction: it has never been " +
            "run where a mistake costs anything, so it must not be the thing that finds out.");
    }
    if (facts.chainId !== policy.chainId) {
        return refuse("UNSUPPORTED_CHAIN", `obligation is on chain ${facts.chainId}, policy allows only ${policy.chainId}`);
    }
    const policyToken = normaliseAddress(policy.token.address);
    const factsToken = normaliseAddress(facts.tokenAddress);
    if (policyToken !== factsToken) {
        return refuse("UNSUPPORTED_TOKEN", `obligation pays in ${factsToken}, policy allows only ${policyToken}`);
    }
    // A token symbol is a display label. Decimals are load-bearing: the same "100" is a
    // 10^12 difference between an 18dp and a 6dp token on this very chain.
    if (facts.tokenDecimals !== policy.token.decimals) {
        return refuse("TOKEN_DECIMALS_MISMATCH", `token reports ${facts.tokenDecimals} decimals, policy pinned ${policy.token.decimals}`);
    }
    let payee;
    try {
        payee = normaliseAddress(facts.payee);
    }
    catch {
        return refuse("PAYEE_NOT_ALLOWED", `payee ${facts.payee} is not a valid EVM address`);
    }
    const allowed = policy.allowedPayees.map(normaliseAddress);
    if (!allowed.includes(payee)) {
        return refuse("PAYEE_NOT_ALLOWED", `${payee} is not an allowlisted recipient`);
    }
    const invoice = baseUnitsFromString(facts.invoiceBaseUnits);
    if (invoice <= 0n) {
        return refuse("AMOUNT_NOT_POSITIVE", `invoice amount must be positive, got ${invoice}`);
    }
    const fee = baseUnitsFromString(facts.feeBaseUnits);
    const maxFee = baseUnitsFromString(policy.maxFeeBaseUnits);
    if (fee > 0n) {
        let feeRecipient;
        try {
            feeRecipient = normaliseAddress(facts.feeRecipient);
        }
        catch {
            return refuse("FEE_RECIPIENT_UNKNOWN", `fee recipient ${facts.feeRecipient} is not a valid EVM address`);
        }
        const allowedFees = policy.allowedFeeRecipients.map(normaliseAddress);
        if (!allowedFees.includes(feeRecipient)) {
            return refuse("FEE_RECIPIENT_UNKNOWN", `fee recipient ${feeRecipient} is not recognised`);
        }
        if (fee > maxFee) {
            return refuse("FEE_EXCEEDS_CEILING", `fee ${fee} exceeds ceiling ${maxFee}`);
        }
    }
    // The cap applies to what actually leaves the wallet. Checking the invoice alone lets a
    // quoted fee push the real debit over the ceiling the human thought they were setting.
    const total = invoice + fee;
    if (total > MAX_UINT256) {
        return refuse("LIMIT_EXCEEDED", `total debit exceeds uint256 maximum`);
    }
    const cap = baseUnitsFromString(policy.maxTotalDebitBaseUnits);
    if (total > cap) {
        return refuse("LIMIT_EXCEEDED", `total debit ${total} (invoice ${invoice} + fee ${fee}) exceeds cap ${cap}`);
    }
    return { ok: true, totalDebitBaseUnits: total.toString() };
}
