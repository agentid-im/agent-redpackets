// Joins the scenes (video/out/scene-N.mp4) into the demo video: subtitles in English with Chinese below,
// each shown while its narration part is spoken, and the narration takes (video/voice/vo-N-K.mp3, made
// by voice.mjs) laid at their scheduled times. A scene is held on its last frame when its narration runs
// longer than the picture. See schedule.mjs for the timing.
//   node video/compose.mjs            -> video/out/agent-id-red-packets.mp4
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { schedule } from "./schedule.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
const load = async (name, fallback) => (await import(process.env[`${name.toUpperCase().replace(/-/g, "_")}_PATH`] ?? name).catch(() => import(fallback)));
const puppeteer = (await load("puppeteer-core", "/tmp/ahb-pp/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js")).default;
const ffmpeg = (await load("ffmpeg-static", "/tmp/ahb-pp/node_modules/ffmpeg-static/index.js")).default;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FADE = 0.3;

const SCENES = schedule();

/** Length of a scene's video, in seconds. */
function videoLength(file) {
  try {
    execFileSync(ffmpeg, ["-i", file], { stdio: "pipe" });
  } catch (e) {
    const m = String(e.stderr).match(/Duration: (\d+):(\d+):([\d.]+)/);
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  }
  return 0;
}

/** Subtitle images: one transparent 1920x1080 PNG per narration part. */
async function subtitlePngs() {
  const dir = path.join(out, "subs");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  const items = [];
  let offset = 0;
  for (const sc of SCENES) {
    for (const p of sc.parts) {
      const file = path.join(dir, `${items.length}.png`);
      await page.setContent(`<html><body style="margin:0;width:1920px;height:1080px;background:transparent">
        <div style="position:absolute;left:0;right:0;margin:0 auto;width:fit-content;bottom:54px;max-width:1640px;padding:18px 34px 20px;border-radius:18px;background:rgba(11,14,17,.78);text-align:center;font-family:'IBM Plex Sans','Helvetica Neue',sans-serif">
          <div style="font-size:38px;font-weight:600;color:#fff;line-height:1.3">${p.en}</div>
          <div style="font-size:31px;color:#D7DBE0;line-height:1.4;margin-top:6px;font-family:'PingFang SC',sans-serif">${p.zh}</div>
        </div></body></html>`);
      await page.screenshot({ path: file, omitBackground: true });
      // Shown from just before the words begin to a moment after they end.
      items.push({ file, from: offset + Math.max(0, p.start - 0.1), to: offset + Math.min(sc.seconds - FADE, p.end + 0.35) });
    }
    offset += sc.seconds;
  }
  await browser.close();
  return items;
}

const subs = await subtitlePngs();
const inputs = [];
const filters = [];
SCENES.forEach((sc, i) => {
  const file = path.join(out, `scene-${sc.n}.mp4`);
  inputs.push("-i", file);
  const have = videoLength(file);
  const hold = Math.max(0, sc.seconds - have);
  filters.push(`[${i}:v]trim=duration=${Math.min(have, sc.seconds).toFixed(2)},setpts=PTS-STARTPTS,fps=30,tpad=stop_mode=clone:stop_duration=${hold.toFixed(2)},format=yuv420p,${i ? `fade=t=in:st=0:d=${FADE},` : ""}fade=t=out:st=${(sc.seconds - FADE).toFixed(2)}:d=${FADE}[v${i}]`);
});
filters.push(`${SCENES.map((_, i) => `[v${i}]`).join("")}concat=n=${SCENES.length}:v=1:a=0[base]`);
let last = "base";
subs.forEach((s, k) => {
  inputs.push("-i", s.file);
  const idx = SCENES.length + k;
  filters.push(`[${last}][${idx}:v]overlay=0:0:enable='between(t,${s.from.toFixed(2)},${s.to.toFixed(2)})'[o${k}]`);
  last = `o${k}`;
});

// Narration: each part at its scheduled time.
const placed = [];
let at = 0;
for (const sc of SCENES) {
  for (const p of sc.parts) {
    const f = path.join(here, "voice", `vo-${sc.n}-${p.k}.mp3`);
    if (p.spoken && fs.existsSync(f)) placed.push({ f, at: at + p.start });
  }
  at += sc.seconds;
}
let audio = null;
if (placed.length) {
  const base = inputs.length / 2;
  placed.forEach((tk, k) => {
    inputs.push("-i", tk.f);
    filters.push(`[${base + k}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(tk.at * 1000)}|${Math.round(tk.at * 1000)}[a${k}]`);
  });
  filters.push(`${placed.map((_, k) => `[a${k}]`).join("")}amix=inputs=${placed.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`);
  audio = "[aout]";
}

// Cover: the title card at t=0 (also the video's first frame), embedded as the file's cover picture.
const cover = path.join(out, "cover.png");
const coverArgs = fs.existsSync(cover) ? (inputs.push("-i", cover), ["-map", `${inputs.length / 2 - 1}:v`, "-c:v:1", "mjpeg", "-disposition:v:1", "attached_pic"]) : [];

const total = SCENES.reduce((s, sc) => s + sc.seconds, 0);
const file = path.join(out, "agent-id-red-packets.mp4");
execFileSync(ffmpeg, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filters.join(";"), "-map", `[${last}]`, ...(audio ? ["-map", audio, "-c:a", "aac", "-ar", "48000", "-b:a", "192k"] : []), ...coverArgs, "-t", total.toFixed(2), "-c:v:0", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
console.log(`${file} (${total.toFixed(1)}s${audio ? `, ${placed.length} narration parts` : ", no narration yet"})`);
for (const sc of SCENES) console.log(`  scene ${sc.n}: ${sc.planned}s planned -> ${sc.seconds}s`);
