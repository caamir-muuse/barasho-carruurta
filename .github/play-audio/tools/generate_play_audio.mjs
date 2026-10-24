// Records the play lessons' lines in both Somali neural voices (Ubax and
// Muuse), from tools/play_lines.json (written by the app's play lesson test):
//   - "shared" lines ship inside the app:
//       mobile_flutter/mobile_flutter/assets/play/voice/<voice>/<key>.mp3
//   - "lesson" lines are published and downloaded per lesson:
//       <out>/<voice>/<key>.mp3   (default out: media/play)
// Files that already exist are kept. The silence the voice leaves after a
// line is trimmed (with ffmpeg) so the guide does not pause between lines.
//
// Usage: node tools/generate_play_audio.mjs [out-dir]
// Env:   MSEDGE_TTS  path to msedge-tts's dist/index.js, when the installed
//                    one is too old (2.0.x is refused with 403; 2.1.0 works)
//        FFMPEG      ffmpeg binary (default: ffmpeg on PATH)
//        ONLY        "shared" or "lesson" to record just those lines
import { execFileSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(root, "media", "play"));
const shared = join(root, "mobile_flutter", "mobile_flutter", "assets", "play", "voice");
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
const edge = await import(
  process.env.MSEDGE_TTS ? pathToFileURL(process.env.MSEDGE_TTS).href : "msedge-tts");
const { MsEdgeTTS, OUTPUT_FORMAT } = edge.MsEdgeTTS ? edge : edge.default;

const lines = JSON.parse(readFileSync(join(root, "tools", "play_lines.json"), "utf8"));
const voices = { ubax: "so-SO-UbaxNeural", muuse: "so-SO-MuuseNeural" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One connection per voice, kept open for every line: the service refuses
// most new connections (429) but answers many lines on one it has accepted.
const clients = new Map();
async function client(voice) {
  let tts = clients.get(voice);
  if (!tts) clients.set(voice, (tts = new MsEdgeTTS()));
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  return tts;
}
function drop(voice) {
  try { clients.get(voice)?.close(); } catch {}
  clients.delete(voice);
}

async function synth(voice, text, file) {
  for (let attempt = 1; attempt <= 12; attempt++) {
    const work = mkdtempSync(join(tmpdir(), "play_tts_"));
    try {
      const tts = await client(voice);
      // A request the service drops halfway never settles: give up on it.
      const res = await Promise.race([
        tts.toFile(work, text, { rate: "-10%" }),
        sleep(30000).then(() => { throw new Error("timed out"); }),
      ]);
      const raw = res?.audioFilePath && existsSync(res.audioFilePath)
        ? res.audioFilePath : join(work, "audio.mp3");
      if (!existsSync(raw) || statSync(raw).size < 500) throw new Error("no audio");
      const trimmed = join(work, "trimmed.mp3");
      try {
        execFileSync(ffmpeg, ["-v", "error", "-y", "-i", raw, "-af",
          "areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,apad=pad_dur=0.15",
          "-ac", "1", "-ar", "24000", "-b:a", "48k", trimmed]);
      } catch {
        // No ffmpeg: keep the line as recorded.
      }
      copyFileSync(existsSync(trimmed) && statSync(trimmed).size > 500 ? trimmed : raw, file);
      return true;
    } catch (e) {
      // A new connection is often refused with 429: wait and ask again.
      drop(voice);
      const busy = /429/.test(e.message);
      if (!busy || attempt % 4 === 0) console.log(`  retry ${attempt} ${file}: ${e.message}`);
      await sleep(busy ? 8000 + Math.random() * 4000 : 3000 * attempt);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return false;
}

// The app's own lines first, then Ubax's lesson lines (two of the three
// guides speak with her voice), then Muuse's.
const jobs = [];
const sets = [[shared, lines.shared, "shared"], [out, lines.lesson, "lesson"]]
  .filter(([, , name]) => !process.env.ONLY || process.env.ONLY === name);
for (const [base, set] of sets) {
  for (const [name, voice] of Object.entries(voices)) {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    for (const [key, speech] of Object.entries(set)) {
      const file = join(dir, `${key}.mp3`);
      if (!existsSync(file)) jobs.push({ voice, speech, file });
    }
  }
}
console.log(`${jobs.length} lines to record`);

// One line at a time.
let made = 0;
const failed = [];
for (const job of jobs) {
  if (await synth(job.voice, job.speech, job.file)) made++;
  else failed.push(job.file);
  if ((made + failed.length) % 25 === 0) console.log(`  ${made + failed.length}/${jobs.length}`);
  await sleep(300);
}
for (const voice of clients.keys()) drop(voice);
console.log(`made ${made} lines`);
if (failed.length) {
  console.log(`failed ${failed.length} (run again to retry):`);
  for (const file of failed) console.log(`  ${file}`);
  process.exitCode = 1;
}
