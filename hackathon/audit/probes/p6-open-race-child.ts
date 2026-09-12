/** Opens a database with the pragmas in one of two orders and reports success. */
import { DatabaseSync } from "node:sqlite";
const [path, order, startAtRaw] = process.argv.slice(2);
const SHIPPED = `PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS t (a INTEGER PRIMARY KEY);`;
const SWAPPED = `PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS t (a INTEGER PRIMARY KEY);`;
while (Date.now() < Number(startAtRaw)) { /* barrier */ }
try {
  const db = new DatabaseSync(path);
  db.exec(order === "shipped" ? SHIPPED : SWAPPED);
  db.close();
  console.log("OK");
} catch (e) {
  console.log("FAIL:" + (e as Error).message);
}
