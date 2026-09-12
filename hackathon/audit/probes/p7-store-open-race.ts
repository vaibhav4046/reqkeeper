/**
 * P7 — does `new Store(path)` survive two processes opening it at once?
 *
 * p6-open-race.ts measures the PHENOMENON with a bare `DatabaseSync`: 22-29 of 50 concurrent
 * opens of a fresh file die on "database is locked", and arming `PRAGMA busy_timeout` before
 * `PRAGMA journal_mode = WAL` roughly halves it without removing it. That probe deliberately
 * does not import `Store`, so it cannot say anything about the fix — it keeps reporting the raw
 * numbers, which is what it is for.
 *
 * This one drives the real constructor. `REQKEEPER_NO_OPEN_RETRY=1` in the child disables the
 * retry, so the number below is a measured difference rather than an unfalsifiable claim.
 *
 * Both children are started first and only then let past a timestamp barrier: they really do
 * open the same fresh file at the same millisecond. Running them one after another — which is
 * what `spawnSync` does — measures nothing, and an earlier cut of this probe did exactly that
 * and reported a confident 0/50 for both arms.
 *
 *   node --experimental-strip-types hackathon/audit/probes/p7-store-open-race.ts [trials]
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TRIALS = Number(process.argv[2] ?? 25);
const CHILD = new URL("p7-store-open-child.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Run one child to completion, returning whatever it printed. */
function run(db: string, startAt: number, env: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const kid = spawn(process.execPath, ["--experimental-strip-types", CHILD, db, String(startAt)], {
      env: { ...process.env, ...env },
    });
    // stdout only. node prints an ExperimentalWarning about node:sqlite on stderr, and folding
    // that into the verdict makes every child look like a failure.
    let out = "";
    kid.stdout.on("data", (b) => (out += b));
    kid.on("close", () => resolve(out.trim()));
  });
}

async function race(label: string, env: Record<string, string>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rk-p7-"));
  let failed = 0;
  let sampleError = "";

  for (let t = 0; t < TRIALS; t++) {
    // A fresh file per trial: the contended case is the one that creates the schema.
    const db = join(dir, `t${t}.sqlite`);
    const startAt = Date.now() + 300;
    const said = await Promise.all([run(db, startAt, env), run(db, startAt, env)]);
    for (const line of said) {
      if (!line.startsWith("OK")) {
        failed++;
        if (!sampleError) sampleError = line.split("\n")[0];
      }
    }
  }

  const total = TRIALS * 2;
  console.log(
    `${label.padEnd(30)} concurrent opens that failed: ${String(failed).padStart(2)}/${total}` +
      (sampleError ? `   ${sampleError.slice(0, 55)}` : ""),
  );
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nnew Store(path), two processes at one barrier, ${TRIALS} trials each\n`);
await race("Store, retry disabled", { REQKEEPER_NO_OPEN_RETRY: "1" });
await race("Store, as shipped", {});
console.log("");
