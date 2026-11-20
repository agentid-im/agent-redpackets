// Generates the narration takes with the Fish Audio API (model s2.1-pro-free) from video/narration.json
// into video/voice/vo-N.mp3 (git-ignored). The key and voice id are read from the environment or from
// the file named by FISH_ENV (default /Volumes/D/fish.env), never from the repository.
//   node video/voice.mjs [segment ...]      e.g. node video/voice.mjs 1 3
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.FISH_ENV ?? "/Volumes/D/fish.env";
const fileEnv = fs.existsSync(envFile)
  ? Object.fromEntries(fs.readFileSync(envFile, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]))
  : {};
const KEY = process.env.FISH_API_KEY ?? fileEnv.FISH_API_KEY;
const VOICE = process.env.FISH_VOICE_ID ?? fileEnv.FISH_VOICE_ID;
if (!KEY || !VOICE) throw new Error(`need FISH_API_KEY and FISH_VOICE_ID (in the environment or ${envFile})`);

const load = async (name, fallback) => (await import(process.env[`${name.toUpperCase().replace(/-/g, "_")}_PATH`] ?? name).catch(() => import(fallback)));
const ffmpeg = (await load("ffmpeg-static", "/tmp/ahb-pp/node_modules/ffmpeg-static/index.js")).default;

const plan = JSON.parse(fs.readFileSync(path.join(here, "narration.json"), "utf8"));
const outDir = path.join(here, "voice");
fs.mkdirSync(outDir, { recursive: true });

function lengthOf(file) {
  try {
    execFileSync(ffmpeg, ["-i", file], { stdio: "pipe" });
  } catch (e) {
    const m = String(e.stderr).match(/Duration: (\d+):(\d+):([\d.]+)/);
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  }
  return 0;
}

async function tts(text, speed) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", model: plan.model },
      body: JSON.stringify({
        text,
        reference_id: VOICE,
        format: "mp3",
        sample_rate: 44100,
        mp3_bitrate: 192,
        temperature: plan.temperature ?? 0.7,
        top_p: plan.top_p ?? 0.7,
        latency: "normal",
        normalize: true,
        prosody: { speed, volume: 0, normalize_loudness: true },
      }),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const body = (await res.text()).slice(0, 200);
    if (res.status === 401 || res.status === 402) throw new Error(`Fish API ${res.status}: ${body}`);
    console.log(`  attempt ${attempt}: HTTP ${res.status} ${body}`);
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  throw new Error("Fish API kept failing");
}

// Takes vary from run to run, so each part is generated a few times. A take is judged by its length
// after trimming silence, and by words per second: much above ~3.4 means words were skipped.
const TAKES = 3;
const MAX_WPS = 3.4;
const trim = (src, dst) =>
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", src, "-af", "silenceremove=start_periods=1:start_threshold=-48dB:start_silence=0.06,areverse,silenceremove=start_periods=1:start_threshold=-48dB:start_silence=0.12,areverse", "-c:a", "libmp3lame", "-b:a", "192k", dst]);

const only = process.argv.slice(2).map(Number);
const manifest = [];
for (const seg of plan.segments) {
  const parts = seg.parts;
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    manifest.push({ n: seg.n, k: k + 1, at: part.at, file: `vo-${seg.n}-${k + 1}.mp3` });
    if (only.length && !only.includes(seg.n)) continue;
    // A part must end before the next one starts (or the scene ends), with a short breath.
    const room = (parts[k + 1]?.at ?? seg.scene) - part.at - 0.35;
    const words = part.text.replace(/\[[^\]]*\]/g, "").trim().split(/\s+/).length;
    const file = path.join(outDir, `vo-${seg.n}-${k + 1}.mp3`);
    const tmp = path.join(outDir, "_take.mp3");
    const takes = [];
    for (let i = 0; i < TAKES; i++) {
      fs.writeFileSync(tmp, await tts(part.text, plan.speed ?? 1));
      const cand = path.join(outDir, `_cand${i}.mp3`);
      trim(tmp, cand);
      const len = lengthOf(cand);
      takes.push({ cand, len, wps: words / len });
    }
    const sane = takes.filter((t) => t.wps <= MAX_WPS);
    const fit = sane.filter((t) => t.len <= room);
    // Among takes that fit, the longest is the least rushed; if none fits, the shortest sane one; if
    // all are rushed, the slowest.
    const pick = fit.length ? [...fit].sort((x, y) => y.len - x.len)[0] : sane.length ? [...sane].sort((x, y) => x.len - y.len)[0] : [...takes].sort((x, y) => y.len - x.len)[0];
    fs.copyFileSync(pick.cand, file);
    console.log(`segment ${seg.n}.${k + 1}: takes ${takes.map((t) => t.len.toFixed(1)).join("/")}s -> ${pick.len.toFixed(1)}s (room ${room.toFixed(1)}s, ${pick.wps.toFixed(1)} words/s)`);
    for (const t of takes) fs.rmSync(t.cand, { force: true });
    fs.rmSync(tmp, { force: true });
  }
}
for (const m of manifest) {
  const f = path.join(outDir, m.file);
  if (fs.existsSync(f)) m.len = +lengthOf(f).toFixed(2);
}
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));
