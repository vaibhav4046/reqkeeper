/**
 * The documented operator escape, run the way the documentation prints it.
 *
 * `docs/RUNBOOK.md` prints this line as the way out of an obligation whose dry run never came
 * back:
 *
 *     npm run resolve -- --release-preflight <obligationId> --operator alice@finance
 *
 * It never worked. The flag parser was `/^--([a-zA-Z]+)(?:=(.*))?$/` — no hyphen in the character
 * class, and no support for a space-separated value — so `--release-preflight` did not parse at
 * all. The command took the normal path, printed "nothing moved", and exited 0 while the
 * obligation stayed in PAYMENT_PREFLIGHT. A reviewer ran the documented line and watched it report
 * success.
 *
 * That is worse than having no escape. The automatic release needs a payer account nothing else
 * broadcasts from, which this deployment does not have, so the operator path is the only exit —
 * and an exit that reports success without opening is the permanent wedge this project keeps
 * fixing, wearing a green tick.
 *
 * No test had ever spawned this CLI. The unit tests covered `operatorReleaseDecision`, which was
 * correct the whole time; nothing connected it to argv. So this spawns the real process with the
 * real arguments, because that is the only thing that would have caught it.
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

const REQUEST_ID = "01req-cli-escape";
const OID = obligationId(NAMESPACE, REQUEST_ID);
const REFERENCE = "0x0056a1b2c3d4e5f6";

/** An obligation parked in PAYMENT_PREFLIGHT, which is the state the escape exists for. */
function wedged(file: string): void {
  const store = new Store(file);
  store.importObligation({
    obligationId: OID,
    namespace: NAMESPACE,
    requestId: REQUEST_ID,
    sourceFactsJson: JSON.stringify({ anchorBlock: 11_690_000 }),
    sourceFactsHash: "h",
    paymentReference: REFERENCE,
    now: 1,
  });
  store.setState(OID, "VALIDATING", 1);
  store.setState(OID, "AWAITING_APPROVAL", 1);
  store.setState(OID, "APPROVED", 1);
  store.beginPreflight(OID, "f".repeat(64), 1, 11_691_000, undefined);
  store.close();
}

function runResolve(file: string, extra: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/resolve.ts", `--db=${file}`, ...extra],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          REQKEEPER_PAYER_ADDRESS: "",
          // Unroutable on purpose. What is under test is whether the flag and its value are
          // PARSED, and a test whose answer depends on how a public endpoint happens to be
          // feeling is a test that fails for reasons it is not about — this one did, passing
          // alone and failing under the full suite. With no chain the escape has exactly one
          // honest answer, and it has to name the obligation while giving it.
          SEPOLIA_RPC: "http://127.0.0.1:1",
          REQKEEPER_RPC_ENDPOINTS: "http://127.0.0.1:1",
        },
      },
    );
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: `${err.stdout ?? ""}${err.stderr ?? ""}`, status: err.status ?? 1 };
  }
}

describe("the operator escape works when typed the way the docs print it", () => {
  test("--release-preflight <id> --operator <who> is parsed, not ignored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reqkeeper-cli-"));
    const file = join(dir, "live.sqlite");
    try {
      wedged(file);

      // Space-separated, hyphenated — exactly as docs/RUNBOOK.md prints it.
      const out = runResolve(file, ["--release-preflight", OID, "--operator", "alice@finance"]);

      // It must ENGAGE. What it then decides depends on the chain, and this environment has no
      // reachable one — so it may refuse. What it must never do is silently fall through to the
      // ordinary drain and report "nothing moved", which is what it used to do.
      assert.ok(
        !/nothing moved/.test(out.stdout),
        `the escape was ignored and the command took the normal path instead:\n${out.stdout.slice(0, 400)}`,
      );
      assert.match(
        out.stdout,
        /released|REFUSED|not PAYMENT_PREFLIGHT|payment reference|could not reach/i,
        `expected the escape to reach a decision, got:${out.stdout.slice(0, 400)}`,
      );
      // And it must have parsed the VALUE, not just the flag. A parser that handles `--key=value`
      // but not `--key value` sets this to the string "true", and the command then politely
      // reports that no obligation "true" exists — engaging, deciding, and still doing nothing.
      assert.ok(
        !/no obligation true/.test(out.stdout),
        `the flag parsed but its value did not:${out.stdout.slice(0, 400)}`,
      );
      assert.ok(
        out.stdout.includes(OID.slice(0, 14)),
        `the escape never named the obligation it was given:${out.stdout.slice(0, 400)}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("it demands a human's name, because the release goes in the audit trail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reqkeeper-cli2-"));
    const file = join(dir, "live.sqlite");
    try {
      wedged(file);
      const out = runResolve(file, ["--release-preflight", OID]);
      assert.notEqual(out.status, 0, "releasing without naming an operator must not succeed");
      assert.match(out.stdout, /--operator/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an ordinary run still drains, and says so", async () => {
    // The control: fixing the parser must not turn every run into the escape path.
    const dir = await mkdtemp(join(tmpdir(), "reqkeeper-cli3-"));
    const file = join(dir, "live.sqlite");
    try {
      wedged(file);
      const out = runResolve(file, ["--passes=1"]);
      assert.match(out.stdout, /resolve: \d+ jobs claimed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
