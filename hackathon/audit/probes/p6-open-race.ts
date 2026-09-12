/**
 * Why a second settler crashes on `new Store(path)`.
 * SCHEMA runs `PRAGMA journal_mode = WAL` BEFORE `PRAGMA busy_timeout = 5000`
 * (src/store.ts:48-51). Setting the journal mode needs an exclusive lock, and the busy
 * timeout that is meant to survive exactly this contention is not armed yet.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "rk-p6-"));
const TRIALS = 25;

function child(path: string, order: string, startAt: number): Promise<string> {
  return new Promise((res) => {
    const p = spawn(process.execPath,
      ["--experimental-strip-types", join(import.meta.dirname, "p6-open-race-child.ts"), path, order, String(startAt)],
      { stdio: ["ignore", "pipe", "pipe"] });
    let b = ""; p.stdout.on("data", (d) => (b += d));
    p.on("close", () => res(b.trim().split("\n").pop() ?? "(silent)"));
  });
}

for (const order of ["shipped", "swapped", "shipped-warm"]) {
  let failures = 0; let sample = "";
  for (let i = 0; i < TRIALS; i++) {
    const path = join(dir, `${order}-${i}.sqlite`);
    if (order === "shipped-warm") {
      // Create the file first, so the race is over an EXISTING database.
      const { DatabaseSync } = await import("node:sqlite");
      const d = new DatabaseSync(path);
      d.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS t (a INTEGER PRIMARY KEY);");
      d.close();
    }
    const startAt = Date.now() + 250;
    const outs = await Promise.all([child(path, order === "shipped-warm" ? "shipped" : order, startAt), child(path, order === "shipped-warm" ? "shipped" : order, startAt)]);
    for (const o of outs) if (o.startsWith("FAIL")) { failures++; sample ||= o; }
  }
  const label = order === "shipped" ? "fresh db, as shipped" : order === "swapped" ? "fresh db, busy_timeout first" : "EXISTING db, as shipped";
  console.log(`${label.padEnd(34)} concurrent opens that failed: ${failures}/${TRIALS * 2}  ${sample}`);
}
rmSync(dir, { recursive: true, force: true });
