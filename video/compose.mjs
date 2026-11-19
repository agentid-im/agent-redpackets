// Joins the scenes (video/out/scene-N.mp4) into the demo video with English + Chinese subtitles,
// and, when video/voice/vo-N.(m4a|mp3|wav) exist, lays the narration over its scene.
//   node video/compose.mjs            -> video/out/agent-id-red-packets.mp4
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
const load = async (name, fallback) => (await import(process.env[`${name.toUpperCase().replace(/-/g, "_")}_PATH`] ?? name).catch(() => import(fallback)));
const puppeteer = (await load("puppeteer-core", "/tmp/ahb-pp/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js")).default;
const ffmpeg = (await load("ffmpeg-static", "/tmp/ahb-pp/node_modules/ffmpeg-static/index.js")).default;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Scene order, length (s) and subtitle lines [English, 中文] as in video/script.md.
const SCENES = [
  [1, 7, [["Agent ID Red Packets: red packets on BNB Chain that only Agent ID holders can claim,", "Agent ID 红包：BNB Chain 上只有 Agent ID 持有者能领的红包，"], ["grabbed by your own AI agent.", "由你自己的 AI Agent 来抢。"]]],
  [2, 9, [["Every person has one permanent Agent ID.", "每个人只有一个永久的 Agent ID。"], ["So one share per Agent ID really means one share per person,", "所以“每个 Agent ID 一份”就是“每人一份”，"], ["and new wallets don't help bots.", "机器人换再多钱包也没用。"]]],
  [3, 17, [["Sending one takes a minute.", "发一个红包只要一分钟。"], ["Choose a code packet, set the amount and the number of shares, pick a passphrase.", "选口令红包，填金额和份数，选一个口令。"], ["BNB, USDT, USDC or any BSC token.", "BNB、USDT、USDC 或 BSC 上任意代币都行。"], ["Confirm, and it's on chain.", "确认后，红包就上链了。"]]],
  [4, 10, [["Post the share text in your group.", "把分享文字发到群里。"], ["Every packet gets its own link and its own preview card.", "每个红包都有自己的链接和专属预览图。"]]],
  [5, 18, [["Holders hand the text to their AI agent.", "领红包的人把分享文字交给自己的 AI Agent。"], ["It checks their Agent ID and previews the transaction in Binance Agentic Wallet,", "它会核对 Agent ID，在 Binance Agentic Wallet 里预览交易，"], ["and claims only after they confirm.", "本人确认后才领取。"]]],
  [6, 10, [["Lucky amounts come from the hash of the block the grab lands in,", "拼手气金额由抢红包那个区块的哈希决定，"], ["so nobody can simulate a grab and cherry-pick.", "谁也没法先模拟、再挑金额。"]]],
  [7, 11, [["An 80-bit share code keeps chain bots out.", "80 位随机红包码挡住链上机器人；"], ["Heavy grabbers of public packets wait in line.", "公开红包抢得多的人往后排。"], ["No owner, no fees, no upgrades, and the contract is verified on BscScan.", "合约没有管理员、不收手续费、不可升级，并在 BscScan 开源验证。"]]],
  [8, 6, [["Try it at agentid.im, and let your agent grab red packets.", "来 agentid.im 试试，让你的 Agent 去抢红包。"]]],
];
const FADE = 0.3;

/** Subtitle images: one transparent 1920x1080 PNG per line. */
async function subtitlePngs() {
  const dir = path.join(out, "subs");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  const items = [];
  let start = 0;
  for (const [, seconds, lines] of SCENES) {
    // Each line gets time in proportion to its English length.
    const weight = lines.reduce((s, [en]) => s + en.length, 0);
    let t = start;
    for (const [en, zh] of lines) {
      const d = (seconds * en.length) / weight;
      const file = path.join(dir, `${items.length}.png`);
      await page.setContent(`<html><body style="margin:0;width:1920px;height:1080px;background:transparent">
        <div style="position:absolute;left:0;right:0;margin:0 auto;width:fit-content;bottom:54px;max-width:1640px;padding:18px 34px 20px;border-radius:18px;background:rgba(11,14,17,.78);text-align:center;font-family:'IBM Plex Sans','Helvetica Neue',sans-serif">
          <div style="font-size:38px;font-weight:600;color:#fff;line-height:1.3">${en}</div>
          <div style="font-size:31px;color:#D7DBE0;line-height:1.4;margin-top:6px;font-family:'PingFang SC',sans-serif">${zh}</div>
        </div></body></html>`);
      await page.screenshot({ path: file, omitBackground: true });
      items.push({ file, from: t, to: t + d });
      t += d;
    }
    start += seconds;
  }
  await browser.close();
  return items;
}

const subs = await subtitlePngs();
const inputs = [];
const filters = [];
SCENES.forEach(([n, seconds], i) => {
  inputs.push("-i", path.join(out, `scene-${n}.mp4`));
  filters.push(`[${i}:v]trim=duration=${seconds},setpts=PTS-STARTPTS,fps=30,format=yuv420p,fade=t=in:st=0:d=${FADE},fade=t=out:st=${seconds - FADE}:d=${FADE}[v${i}]`);
});
filters.push(`${SCENES.map((_, i) => `[v${i}]`).join("")}concat=n=${SCENES.length}:v=1:a=0[base]`);
let last = "base";
subs.forEach((s, k) => {
  inputs.push("-i", s.file);
  const idx = SCENES.length + k;
  filters.push(`[${last}][${idx}:v]overlay=0:0:enable='between(t,${s.from.toFixed(2)},${(s.to - 0.05).toFixed(2)})'[o${k}]`);
  last = `o${k}`;
});

// Narration, if recorded: each take starts with its scene.
const voice = path.join(here, "voice");
let audio = null;
const takes = [];
let at = 0;
for (const [n, seconds] of SCENES) {
  const f = ["m4a", "mp3", "wav"].map((x) => path.join(voice, `vo-${n}.${x}`)).find((p) => fs.existsSync(p));
  if (f) takes.push({ f, at });
  at += seconds;
}
if (takes.length) {
  const base = inputs.length / 2;
  takes.forEach((tk, k) => {
    inputs.push("-i", tk.f);
    filters.push(`[${base + k}:a]adelay=${Math.round(tk.at * 1000)}|${Math.round(tk.at * 1000)}[a${k}]`);
  });
  filters.push(`${takes.map((_, k) => `[a${k}]`).join("")}amix=inputs=${takes.length}:normalize=0[aout]`);
  audio = "[aout]";
}

const total = SCENES.reduce((s, [, d]) => s + d, 0);
const file = path.join(out, "agent-id-red-packets.mp4");
execFileSync(ffmpeg, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filters.join(";"), "-map", `[${last}]`, ...(audio ? ["-map", audio, "-c:a", "aac", "-b:a", "160k"] : []), "-t", String(total), "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
console.log(`${file} (${total}s${audio ? ", with narration" : ", no narration yet"})`);
