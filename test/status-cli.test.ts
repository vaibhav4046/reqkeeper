/**
 * The question every recovery starts with, which had no answer.
 *
 * `docs/RUNBOOK.md` named nine machine states and never showed an operator how to observe one.
 * `npm run resolve` printed the transitions it had just made and nothing about an obligation that
 * did not move. Every command in the recovery section takes an `<obligationId>` whose source was
 * documented nowhere — so the real first step was opening `.data/live.sqlite` with a SQLite
 * client, which is not a recovery procedure.
 *
 * This spawns the real CLI, because the last command documented-but-never-run was
 * `--release-preflight`, which never parsed and reported success for months.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { obligationId } from "../src/identity.ts";
import { NAMESPACE } from "../src/plan.ts";
import { Store } from "../src/store.ts";

const REQUEST_ID = "01status-cli-probe";
const OID = obligationId(NAMESPACE, REQUEST_ID);
const REFERENCE = "0x0056a1b2c3d4e5f6";

function seed(file: string, state: "AWAITING_APPROVAL" | "PAYMENT_PREFLIGHT"): void {
  const store = new Store(file);
  store.importObligation({
    obligationId: OID,
    namespace: NAMESPACE,
    requestId: REQUEST_ID,
    sourceFactsJson: "{}",
    sourceFactsHash: "h",
    paymentReference: REFERENCE,
    now: 1,
  });
  store.setState(OID, "VALIDATING", 1);
  store.setState(OID, "AWAITING_APPROVAL", 1);
  if (state === "PAYMENT_PREFLIGHT") {
    store.setState(OID, "APPROVED", 1);
    store.beginPreflight(OID, "f".repeat(64), 1, 11_691_000, undefined);
  }
  store.close();
}

function run(file: string, extra: string[]): string {
  try {
    return execFileSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/resolve.ts", `--db=${file}`, ...extra],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        // No chain, on purpose: asking what state something is in must not depend on an endpoint.
        env: { ...process.env, SEPOLIA_RPC: "http://127.0.0.1:1", REQKEEPER_RPC_ENDPOINTS: "http://127.0.0.1:1" },
      },
    );
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
}

describe("an operator can ask what state an obligation is in", () => {
  test("--status names the state and what to do about it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reqkeeper-status-"));
    const file = join(dir, "live.sqlite");
    try {
      seed(file, "AWAITING_APPROVAL");
      const out = run(file, ["--status"]);
      assert.match(out, new RegExp(OID.slice(0, 16)), out.slice(0, 400));
      assert.match(out, /AWAITING_APPROVAL/, out.slice(0, 400));
      assert.match(out, new RegExp(REFERENCE), out.slice(0, 400));
      // The sentence is the point. A state name with no next step is the RUNBOOK's problem, moved.
      assert.match(out, /npm run approve/, out.slice(0, 600));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("it answers without a chain, because a stuck operator may not have one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reqkeeper-status2-"));
    const file = join(dir, "live.sqlite");
    try {
      seed(file, "PAYMENT_PREFLIGHT");
      const out = run(file, ["--status", OID.slice(0, 12)]);
      assert.match(out, /PAYMENT_PREFLIGHT/, out.slice(0, 400));
      // And the state whose exit is hardest to find is the one that names it.
      assert.match(out, /release-preflight/, out.slice(0, 600));
      assert.doesNotMatch(out, /could not be read|ECONNREFUSED/, "asking a question must not need an endpoint");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a prefix of the request id finds it too", async () => {
    // Because the id an operator has to hand is whichever one they were given.
    const dir = await mkdtemp(join(tmpdir(), "reqkeeper-status3-"));
    const file = join(dir, "live.sqlite");
    try {
      seed(file, "AWAITING_APPROVAL");
      assert.match(run(file, ["--status", REQUEST_ID.slice(0, 10)]), new RegExp(REQUEST_ID));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an absent or empty database says so rather than printing nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reqkeeper-status4-"));
    const file = join(dir, "empty.sqlite");
    try {
      // No file at all: the resolver already refuses before this branch, and says where it looked.
      assert.match(run(file, ["--status"]), /no settlement database at/i);
      // A file with no obligations in it is the other empty, and reaches the status branch.
      new Store(file).close();
      assert.match(run(file, ["--status"]), /no obligations/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("it moves nothing: the state is the same afterwards", async () => {
    // Read-only is a claim, so it is checked. A diagnostic that changes what it reports on is
    // worse than none.
    const dir = await mkdtemp(join(tmpdir(), "reqkeeper-status5-"));
    const file = join(dir, "live.sqlite");
    try {
      seed(file, "PAYMENT_PREFLIGHT");
      run(file, ["--status"]);
      const store = new Store(file);
      assert.equal(store.getObligation(OID)?.state, "PAYMENT_PREFLIGHT");
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
