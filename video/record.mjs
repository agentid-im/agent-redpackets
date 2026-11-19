// Records the two website scenes of the demo video against a local chain:
//   npx hardhat node                                  (terminal 1)
//   npx hardhat run scripts/local-setup.js --network localhost && node skill/build.mjs localhost
//   npm run web:local                                 (terminal 2)
//   node video/record.mjs
// Scene 3: Alice sends a code packet on the Send page. Then Bob, Carol and Dave grab it through the
// skill (the same calls an agent makes) and the slots are opened. Scene 6: the packet's page.
// Output: video/out/scene-3.mp4, video/out/scene-6.mp4 (1920x1080, 30 fps).
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
const SITE = process.env.SITE ?? "http://localhost:5178";
const dep = JSON.parse(fs.readFileSync(path.join(root, "deployments/localhost.json"), "utf8"));
const out = path.join(here, "out");
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the agent side, as in scripts/rehearse.js
const run = (file, args) => {
  try {
    return JSON.parse(execFileSync("node", [path.join(root, file), ...args], { encoding: "utf8" }));
  } catch (e) {
    return JSON.parse(e.stdout);
  }
};
const hongbao = (...a) => run("skill/agent-redpackets/hongbao.mjs", a);
function execute(o) {
  if (!o.ok) throw new Error(JSON.stringify(o));
  for (const c of o.calls) {
    const p = run("scripts/fake-baw.js", c.baw.split(" ").slice(1));
    run("scripts/fake-baw.js", ["contract-call", "execute", "--requestId", p.data.requestId, "--json"]);
  }
}
const mine = () => execFileSync("curl", ["-s", "-X", "POST", dep.rpc, "-H", "content-type: application/json", "-d", '{"jsonrpc":"2.0","id":1,"method":"evm_mine","params":[]}']);

// --- a visible cursor (headless recordings have none) that glides to what it clicks
const CURSOR = `(() => {
  if (document.getElementById("demo-cursor")) return;
  const c = document.createElement("div");
  c.id = "demo-cursor";
  c.innerHTML = '<svg width="34" height="34" viewBox="0 0 24 24"><path d="M4 2l15 9.5-6.6 1.3 3.9 7.4-2.9 1.5-3.9-7.4L4 19z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: "fixed", left: "960px", top: "620px", zIndex: 99999, pointerEvents: "none", transition: "left .55s cubic-bezier(.3,.7,.2,1), top .55s cubic-bezier(.3,.7,.2,1), transform .12s" });
  document.body.appendChild(c);
})()`;
async function point(page, selector, { click = true, settle = 650 } = {}) {
  const el = await page.waitForSelector(selector, { visible: true });
  await el.evaluate((n) => n.scrollIntoView({ block: "center", behavior: "smooth" }));
  await sleep(450);
  const box = await el.boundingBox();
  await page.evaluate(CURSOR);
  await page.evaluate(({ x, y }) => Object.assign(document.getElementById("demo-cursor").style, { left: `${x}px`, top: `${y}px` }), { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await sleep(settle);
  if (click) {
    await page.evaluate(() => (document.getElementById("demo-cursor").style.transform = "scale(.82)"));
    await el.click();
    await sleep(120);
    await page.evaluate(() => (document.getElementById("demo-cursor").style.transform = ""));
  }
  return el;
}

// Chrome's screencast sends a frame only when the page changes, so each frame keeps its timestamp
// and is shown until the next one: the video runs in real time, still stretches included.
async function record(page, name, seconds, body) {
  const cdp = await page.createCDPSession();
  const frames = [];
  cdp.on("Page.screencastFrame", (f) => {
    frames.push({ data: f.data, t: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  const t0 = Date.now() / 1000;
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080 });
  // at(s): wait until s seconds into the scene, to keep actions in step with the narration.
  await body((sec) => sleep(Math.max(0, (t0 + sec - Date.now() / 1000) * 1000)));
  const left = seconds - (Date.now() / 1000 - t0);
  if (left > 0) await sleep(left * 1000);
  await cdp.send("Page.stopScreencast");
  const dir = fs.mkdtempSync(path.join(out, `${name}-`));
  const list = [];
  frames.forEach((f, i) => {
    const file = path.join(dir, `${String(i).padStart(5, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    const start = i === 0 ? t0 : f.t;
    const end = i + 1 < frames.length ? frames[i + 1].t : t0 + seconds;
    list.push(`file '${file}'`, `duration ${Math.max(0.001, end - start).toFixed(4)}`);
  });
  list.push(`file '${path.join(dir, `${String(frames.length - 1).padStart(5, "0")}.jpg`)}'`);
  fs.writeFileSync(path.join(dir, "list.txt"), list.join("\n"));
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(dir, "list.txt"), "-t", String(seconds), "-vf", "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-crf", "18", path.join(out, `${name}.mp4`)]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${name}: ${seconds}s, ${frames.length} frames`);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--force-color-profile=srgb", "--hide-scrollbars"] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("ahb:theme", "dark");
  localStorage.setItem("ahb:lang", "en");
  // Links on screen show the public site, not the local dev server.
  const fix = (n) => {
    // …and the mainnet contract, not the local one.
    if (n.nodeType === 3 && (n.data.includes(location.origin) || /0xCf7E(…|\.\.\.)0Fc9/.test(n.data))) {
      n.data = n.data.split(location.origin).join("https://www.agentid.im").replace(/0xCf7E(…|\.\.\.)0Fc9/g, "0xA396$1b8CE");
    }
    else n.childNodes?.forEach(fix);
  };
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach(fix))).observe(document, { childList: true, subtree: true });
});
await page.goto(`${SITE}/?lang=en#/create`, { waitUntil: "networkidle0" });
await page.select("#test-account", dep.accounts["alice.ai"]);
await sleep(800);
await page.evaluate(() => scrollTo(0, 0));

// Scene 3: send a code packet
let share = "";
// Narration: amount and shares, passphrase (to ~10.9 s), "any BSC token" (~10.9-14.3 s), confirm.
await record(page, "scene-3", 17, async (at) => {
  await at(0.8);
  await point(page, 'input[name="total"]');
  await page.type('input[name="total"]', "0.1", { delay: 140 });
  await at(4.2);
  await point(page, 'input[name="pass"]');
  await page.type('input[name="pass"]', "Good luck", { delay: 110 });
  await at(10.3);
  await point(page, 'select[name="token"]', { click: false, settle: 500 });
  await page.select('select[name="token"]', "custom");
  await at(13.2);
  await page.select('select[name="token"]', "0x0000000000000000000000000000000000000000");
  await at(13.9);
  await point(page, '#create-form button[type="submit"]');
  await page.waitForSelector("#created .result", { visible: true, timeout: 20000 });
  await sleep(400);
  await page.evaluate(() => document.querySelector("#created").scrollIntoView({ block: "center", behavior: "smooth" }));
  share = await page.$eval("#created pre.code", (n) => n.textContent.split("\n").find((l) => l.includes("AgentHongbao #")));
});
const link = await page.$eval('#created a[href^="#/r/"]', (a) => a.getAttribute("href"));
console.log(`share line: ${share}\nlink: ${link}`);
fs.writeFileSync(path.join(out, "share.json"), JSON.stringify({ share, link }, null, 2));

// The agents of three Agent ID holders grab it; the slots are opened.
for (const who of ["bob.ai", "carol.ai", "dave.ai"]) execute(hongbao("grab", share, "--from", dep.accounts[who]));
mine();
mine();
// An open sized by gas estimation pays one slot at a time: repeat until all three are paid.
const id = share.match(/#(\d+)/)[1];
for (let i = 0; i < 3; i++) {
  const o = hongbao("open", id, "--from", dep.accounts["erin.ai"]);
  if (!o.ok) break;
  execute(o);
  mine();
}

// Scene 6: the packet page with its claims
await page.goto(`${SITE}/?lang=en${link}`, { waitUntil: "networkidle0" });
await page.select("#test-account", dep.accounts["alice.ai"]);
await sleep(1500);
await page.evaluate(() => scrollTo(0, 0));
await record(page, "scene-6", 10, async () => {
  await sleep(1800);
  await point(page, "#claims .best", { click: false, settle: 900 });
  await sleep(2500);
});

await browser.close();
