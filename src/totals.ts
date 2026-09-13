/**
 * How an artifact says a total is derived, when its name does not already say it.
 *
 * `verify:all` recomputes every summary number it can name-match against a row field, an array
 * length, or a row count. That covers the easy half. It cannot cover `settledAfterRecovery` or
 * `maxBroadcastsForOneObligation`, and those were reported as "not recomputed" and left alone --
 * 27 of 42 numbers in this repository, including every figure the crash matrix and the race
 * publish.
 *
 * Listing them inside the checker would put the checklist back in the checker, which is the
 * arrangement that let `docs/refusals.json` disagree with its own rows for weeks. So the artifact
 * carries the derivation instead: a generator that adds a total either names it after a row field
 * or says here how to compute it. Coverage becomes a property of the format rather than a
 * property of whoever last edited the verifier.
 *
 * Lives in `src/` rather than beside the script because a rule nothing can test is a rule that
 * rots; `test/evidence-derivable.test.ts` holds every committed artifact to it.
 */

export interface TotalPredicate {
  readonly field: string;
  readonly equals?: unknown;
  readonly notEquals?: unknown;
  /** Compare two fields of the same row, for totals like "rows where actual matched expected". */
  readonly equalsField?: string;
  readonly present?: boolean;
  readonly in?: readonly unknown[];
  readonly greaterThan?: number;
}

export interface TotalSpec {
  /** Array to read. Defaults to the artifact's rows. `waves[].workers` flattens one level. */
  readonly from?: string;
  /** Applied before the aggregation; an array is AND. Omit to aggregate over everything. */
  readonly where?: TotalPredicate | readonly TotalPredicate[];
  /** Exactly one aggregation. */
  readonly count?: true;
  readonly sum?: string;
  readonly max?: string;
  readonly distinct?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const at = (row: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (isRecord(v) ? v[k] : undefined), row);

/**
 * `rows` | `waves` | `waves[].workers` (every wave) | `waves[0].workers` (one wave).
 *
 * The index matters: a race's `settled` counts the FIRST wave's workers, because the second wave
 * exists to prove nothing happens in it. Flattening both waves made the spec count 64 where the
 * artifact said 1 — caught by this check on its first run, which is the argument for declaring
 * derivations in the artifact rather than trusting a name.
 */
function arrayFor(doc: Record<string, unknown>, from: string | undefined, fallback: Array<Record<string, unknown>>) {
  if (!from) return fallback;
  const m = /^([A-Za-z0-9_]+)(?:\[(\d*)\]\.(.+))?$/.exec(from);
  if (!m) return [];
  const base = doc[m[1]];
  if (!Array.isArray(base)) return [];
  const rows = base.filter(isRecord);
  if (!m[3]) return rows;
  const picked = m[2] === "" ? rows : rows.slice(Number(m[2]), Number(m[2]) + 1);
  return picked.flatMap((r) => (Array.isArray(r[m[3]]) ? (r[m[3]] as unknown[]).filter(isRecord) : []));
}

function matches(row: Record<string, unknown>, p: TotalPredicate): boolean {
  const v = at(row, p.field);
  if (p.present === true) return v !== undefined && v !== null && v !== "";
  if (p.equalsField !== undefined) return v === at(row, p.equalsField);
  if (p.in !== undefined) return p.in.includes(v);
  if (p.notEquals !== undefined) return v !== p.notEquals;
  if (p.greaterThan !== undefined) return typeof v === "number" && v > p.greaterThan;
  return v === p.equals;
}

function describe(p: TotalPredicate | undefined, from: string | undefined): string {
  const scope = from ? ` of ${from}` : "";
  if (!p) return `rows${scope}`;
  if (p.present === true) return `rows${scope} with ${p.field} present`;
  if (p.equalsField !== undefined) return `rows${scope} where ${p.field} equals ${p.equalsField}`;
  if (p.in !== undefined) return `rows${scope} whose ${p.field} is one of ${p.in.map(String).join("/")}`;
  if (p.notEquals !== undefined) return `rows${scope} whose ${p.field} is not ${JSON.stringify(p.notEquals)}`;
  if (p.greaterThan !== undefined) return `rows${scope} with ${p.field} > ${p.greaterThan}`;
  return `rows${scope} with ${p.field} = ${JSON.stringify(p.equals)}`;
}

/** `null` when the spec cannot be evaluated — never a zero, which would read as a real answer. */
export function evaluateSpec(
  spec: TotalSpec,
  doc: Record<string, unknown>,
  fallback: Array<Record<string, unknown>>,
): { value: number; how: string } | null {
  const preds = spec.where === undefined ? [] : Array.isArray(spec.where) ? spec.where : [spec.where];
  const rows = arrayFor(doc, spec.from, fallback).filter((r) => preds.every((p) => matches(r, p)));
  const scope = preds.length === 0 ? describe(undefined, spec.from) : preds.map((p) => describe(p, spec.from)).join(" and ");
  if (spec.count === true) return { value: rows.length, how: `a count of ${scope}` };
  const numbersAt = (path: string) =>
    rows.map((r) => at(r, path)).filter((v): v is number => typeof v === "number");
  if (spec.sum) return { value: numbersAt(spec.sum).reduce((n, v) => n + v, 0), how: `the sum of ${spec.sum} over ${scope}` };
  if (spec.max) {
    const nums = numbersAt(spec.max);
    if (nums.length === 0) return null;
    return { value: Math.max(...nums), how: `the largest ${spec.max} over ${scope}` };
  }
  if (spec.distinct) {
    const seen = new Set(rows.map((r) => at(r, spec.distinct as string)).filter((v) => v !== undefined && v !== null && v !== ""));
    return { value: seen.size, how: `distinct ${spec.distinct} over ${scope}` };
  }
  return null;
}

