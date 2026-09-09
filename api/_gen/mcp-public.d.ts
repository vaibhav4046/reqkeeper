/**
 * The hosted agent surface. Read-only, and unable to move money by construction.
 *
 * The stdio server in `src/mcp.ts` can propose and settle, because it runs beside a durable
 * store and beside the human who approves. This one runs on someone else's machine, reachable
 * by anyone with the URL, and the correct number of payment tools for that situation is zero.
 * `propose_payment` and `settle_obligation` are not disabled here or permission-flagged: they
 * are absent, the same way `approve` is absent from the local server.
 *
 * What it does serve is the evidence — the live rows, the refusal vocabulary, and a chain read
 * anyone can reproduce without a credential. That is the half of the system a stranger has any
 * business calling.
 */
import { findPaymentByReference } from "./chain.ts";
export declare const PUBLIC_SERVER_INFO: {
    name: string;
    version: string;
};
export declare const PUBLIC_TOOLS: readonly [{
    readonly name: "settlement_evidence";
    readonly description: string;
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly outcome: {
                readonly type: "string";
                readonly description: "e.g. SETTLED, ALREADY_SETTLED, PAYEE_NOT_ALLOWED";
            };
            readonly limit: {
                readonly type: "number";
            };
        };
    };
}, {
    readonly name: "verify_payment";
    readonly description: string;
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly paymentReference: {
                readonly type: "string";
            };
        };
        readonly required: readonly ["paymentReference"];
    };
}, {
    readonly name: "refusal_codes";
    readonly description: string;
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {};
    };
}, {
    readonly name: "how_it_works";
    readonly description: string;
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {};
    };
}];
export interface PublicDeps {
    readonly findPayment?: typeof findPaymentByReference;
    readonly rpcUrl?: string;
}
/** One JSON-RPC request in, one response out. `null` means it was a notification. */
export declare function handlePublic(req: {
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
} | unknown, deps?: PublicDeps): Promise<unknown | null>;
