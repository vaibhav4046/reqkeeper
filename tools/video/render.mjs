/**
 * Render the demo transcript to the submission video.
 *
 * The input is the transcript `scripts/demo.ts` produces by executing the real code, so the
 * video cannot drift from what the software does — there is no separate script to fall out
 * of date, and nothing here invents a line of output.
 *
 * Needs ImageMagick (`magick`) and ffmpeg on PATH.
 *
 *   node --experimental-strip-types scripts/demo.ts   # writes the transcript
 *   node tools/video/render.mjs <transcript> <out.mp4>
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const [transcriptPath, outPath = "docs/demo.mp4"] = process.argv.slice(2);
if (!transcriptPath) {
  console.error("usage: node tools/video/render.mjs <transcript.txt> [out.mp4]");
  process.exit(2);
}

const WIDTH = 1920;
const HEIGHT = 1080;
const ROWS = 23; // visible terminal rows; 164 + ROWS*(PT+LEADING) must stay under HEIGHT
// Whichever of these the machine actually has. The hardcoded Windows path made
// `npm run demo:video` a Windows-only command in a repository that otherwise runs anywhere
// Node 24 does.
const FONT =
  [
    "C:/Windows/Fonts/consola.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/System/Library/Fonts/Menlo.ttc",
  ].find((f) => existsSync(f)) ??
  (() => {
    throw new Error("no monospace font found; name one in tools/video/render.mjs");
  })();
const PT = 24;
const LEADING = 8;

// The palette is the landing page's, measured for AA contrast on #040806.
const CANVAS = "#040806";
const TEXT = "#E6F7E8";
const SIGNAL = "#3BFF6C";
const MUTED = "#879C8B";

const WORK = "tools/video/.frames";
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const lines = readFileSync(transcriptPath, "utf8").replace(/\r/g, "").split("\n");

/** How long a given line should sit on screen. Structure gets room; body reads fast. */
// A single multiplier over every hold, so the cut can be tightened without
// re-tuning the per-line rules that decide what deserves a longer beat. The
// default is the pace docs/demo.mp4 was cut at -- `npm run demo:video` has to
// reproduce the file that shipped, so the number lives here and not in a shell
// that ran once. DEMO_PACE=1 is the unscaled read, about 128s.
const PACE = Number(process.env.DEMO_PACE ?? "0.72") || 0.72;

function holdFor(line) {
  const t = line.trim();
  if (t === "") return 0.16;
  if (/^─+$/.test(t)) return 0.1;
  if (/^\d\./.test(t) || /\[(FIXTURE|LIVE)\]/.test(line)) return 0.85;
  if (/^(Zero|Still one|This is|An approval|It stops)/.test(t)) return 1.0;
  if (/0x[0-9a-f]{16,}/i.test(t)) return 0.9;
  return Math.min(1.0, 0.3 + t.length / 130);
}

const holdScaled = (line) => holdFor(line) * PACE;

function magick(args) {
  execFileSync("magick", args, { stdio: ["ignore", "ignore", "pipe"] });
}

const frames = [];

for (let i = 0; i < lines.length; i++) {
  // A scrolling window, so long transcripts stay legible instead of shrinking.
  const start = Math.max(0, i - ROWS + 1);
  const window = lines.slice(start, i + 1);
  while (window.length < ROWS) window.push("");

  const bodyFile = `${WORK}/body-${i}.txt`;
  writeFileSync(bodyFile, window.join("\n"), "utf8");

  const frame = `${WORK}/f-${String(i).padStart(4, "0")}.png`;
  magick([
    "-size", `${WIDTH}x${HEIGHT}`, `xc:${CANVAS}`,
    // header
    "(", "-background", "none", "-fill", SIGNAL, "-font", FONT, "-pointsize", "26",
    "label:reqkeeper", ")", "-gravity", "NorthWest", "-geometry", "+72+48", "-composite",
    "(", "-background", "none", "-fill", MUTED, "-font", FONT, "-pointsize", "18",
    "label:exactly-once settlement of Request Network obligations through KeeperHub", ")",
    "-gravity", "NorthWest", "-geometry", "+72+92", "-composite",
    // hairline
    "-fill", "#283C2B", "-draw", `rectangle 72,126 ${WIDTH - 72},127`,
    // body
    "(", "-background", "none", "-fill", TEXT, "-font", FONT, "-pointsize", String(PT),
    "-interline-spacing", String(LEADING), `label:@${bodyFile}`, ")",
    "-gravity", "NorthWest", "-geometry", "+72+164", "-composite",
    frame,
  ]);

  frames.push({ file: `f-${String(i).padStart(4, "0")}.png`, hold: holdScaled(lines[i]) });
  if (i % 20 === 0) process.stderr.write(`  rendered ${i}/${lines.length}\n`);
}

// Hold the closing frame so the final numbers are readable, and can be paused on.
frames[frames.length - 1].hold = 4.0;

// ffmpeg's concat demuxer needs the last entry's file repeated for its duration to apply.
const list = frames.map((f) => `file '${f.file}'\nduration ${f.hold.toFixed(2)}`).join("\n");
writeFileSync(`${WORK}/list.txt`, `${list}\nfile '${frames[frames.length - 1].file}'\n`, "utf8");

const total = frames.reduce((a, f) => a + f.hold, 0);
process.stderr.write(`\n  ${frames.length} frames, ${total.toFixed(1)}s\n  encoding...\n`);

execFileSync(
  "ffmpeg",
  [
    "-y", "-f", "concat", "-safe", "0", "-i", "list.txt",
    "-vf", "fps=30,format=yuv420p",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-movflags", "+faststart",
    // Absolute: the concat demuxer needs cwd inside the frame directory, and a relative
    // output path there is easy to get wrong by exactly one level.
    resolve(outPath),
  ],
  { cwd: WORK, stdio: ["ignore", "ignore", "inherit"] },
);

rmSync(WORK, { recursive: true, force: true });
process.stderr.write(`  wrote ${outPath}\n`);
