// Renders the demo video's drawn scenes (video/scenes.html) frame by frame, and the packet card the
// group-chat scene shows. Tools are not project dependencies:
//   npm i --no-save puppeteer-core ffmpeg-static
//   node video/render.mjs [scene ...] [--still]     (default: all drawn scenes)
// Output: video/out/scene-N.mp4 (1920x1080, 30 fps); --still writes one PNG per scene instead.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const load = async (name, fallback) => (await import(process.env[`${name.toUpperCase().replace(/-/g, "_")}_PATH`] ?? name).catch(() => import(fallback)));
const puppeteer = (await load("puppeteer-core", "/tmp/ahb-pp/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js")).default;
const ffmpeg = (await load("ffmpeg-static", "/tmp/ahb-pp/node_modules/ffmpeg-static/index.js")).default;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Scene lengths follow the narration (schedule.mjs); 3 and 6 are site recordings (record.mjs).
import { schedule } from "./schedule.mjs";
const LENGTHS = Object.fromEntries(schedule().map((s) => [s.n, s.seconds]));
export const SCENES = Object.fromEntries([1, 2, 4, 5, 7, 8].map((n) => [n, LENGTHS[n]]));
const FPS = 30;

async function packetCard() {
  const { Resvg, initWasm } = await import(path.join(root, "node_modules/@resvg/resvg-wasm/index.mjs"));
  const { cardSvg } = await import(path.join(root, "lib/card.mjs"));
  await initWasm(fs.readFileSync(path.join(root, "node_modules/@resvg/resvg-wasm/index_bg.wasm")));
  const fontBuffers = ["card-bold.otf", "card-medium.otf"].map((f) => new Uint8Array(fs.readFileSync(path.join(root, "web/public/fonts", f))));
  const svg = cardSvg({ id: recorded?.id ?? 12, kind: 1, lucky: true, shares: 5, amount: "0.1", symbol: "BNB", memo: "Wishing you prosperity" }, "en");
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 }, font: { fontBuffers, defaultFontFamily: "Noto Sans SC", loadSystemFonts: false } }).render().asPng();
  fs.mkdirSync(path.join(here, "assets"), { recursive: true });
  fs.writeFileSync(path.join(here, "assets/card-en.png"), png);
}

// The packet recorded by video/record.mjs, so the drawn scenes show the same number and code.
const sharePath = path.join(here, "out/share.json");
const recorded = fs.existsSync(sharePath)
  ? (({ share, link }) => ({ id: share.match(/#(\d+)/)[1], code: share.match(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/)[0], slug: link.replace("#/r/", "") }))(JSON.parse(fs.readFileSync(sharePath, "utf8")))
  : null;

async function main() {
  const args = process.argv.slice(2);
  const still = args.includes("--still");
  const which = args.filter((a) => !a.startsWith("--")).map(Number);
  const scenes = which.length ? which : Object.keys(SCENES).map(Number);
  await packetCard();
  const out = path.join(here, "out");
  fs.mkdirSync(out, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--allow-file-access-from-files", "--force-color-profile=srgb"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  for (const s of scenes) {
    await page.goto(`file://${path.join(here, "scenes.html")}?s=${s}`, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.fonts.ready);
    if (recorded) {
      await page.evaluate(({ id, code, slug }) => {
        const walk = (n) => {
          if (n.nodeType === 3) n.data = n.data.replace(/#12\b/g, `#${id}`).replace(/K7Q2-9FMX-3HTB-W0RD/g, code).replace(/7KfQ2xZp9a/g, slug);
          else n.childNodes.forEach(walk);
        };
        walk(document.body);
      }, recorded);
    }
    if (still) {
      const atArg = args.find((x) => x.startsWith("--at="));
      await page.evaluate((ms) => window.seek(ms), atArg ? Number(atArg.slice(5)) * 1000 : SCENES[s] * 1000 - 200);
      await page.screenshot({ path: path.join(out, atArg ? `still-${s}-at-${atArg.slice(5)}.png` : `still-${s}.png`) });
      console.log(`still ${s}`);
      continue;
    }
    const dir = fs.mkdtempSync(path.join(out, `frames-${s}-`));
    const total = Math.round(SCENES[s] * FPS);
    for (let f = 0; f < total; f++) {
      await page.evaluate((ms) => window.seek(ms), (f * 1000) / FPS);
      await page.screenshot({ path: path.join(dir, `${String(f).padStart(5, "0")}.png`) });
    }
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(dir, "%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", path.join(out, `scene-${s}.mp4`)]);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`scene ${s}: ${SCENES[s]}s`);
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
