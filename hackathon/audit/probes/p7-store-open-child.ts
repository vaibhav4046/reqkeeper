/** Opens the real Store, at a barrier, and reports whether the constructor survived. */
import { Store } from "../../../src/store.ts";

const [path, startAtRaw] = process.argv.slice(2);
while (Date.now() < Number(startAtRaw)) { /* barrier: both children open at the same millisecond */ }
try {
  const s = new Store(path);
  s.close();
  console.log("OK");
} catch (e) {
  console.log("FAIL:" + (e as Error).message);
}
