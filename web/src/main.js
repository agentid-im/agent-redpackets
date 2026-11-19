import "./style.css";
import { BrowserProvider, Contract, Interface, JsonRpcProvider, ZeroAddress, formatUnits, getAddress, parseUnits } from "ethers";
import abi from "../../lib/AgentHongbao.abi.json";
import { claimKey, handleHash, newCode, normalizeHandle } from "../../lib/claim.mjs";
import { formatShare, inviteText } from "../../lib/share.mjs";
import { INTRO_MAX, ProfileError, isEmptyProfile, normalizeProfile, profileMessage, tgUrl, xUrl } from "../../lib/profile.mjs";
import { explain } from "../../lib/errors.mjs";
import { displaySymbol, fetchTokenMeta, tokenAddress } from "../../lib/token.mjs";
import { I } from "./icons.js";
import { DICT } from "./i18n.js";

const CFG = __HONGBAO_CONFIG__;
const iface = new Interface(abi);
const ERC20 = ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"];
const REGISTRY = ["function handleOf(address) view returns (string)", "function ownerOfHandle(string) view returns (address)"];
const STORE = `agenthongbao:${CFG.network}:${CFG.contract}`;
const SKILL_URL = "https://www.agentid.im/skill/agent-redpackets.zip";
const WALLET_SKILL = "binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet";
const TYPES = ["direct", "code", "public"]; // index = on-chain kind

const reader = new JsonRpcProvider(CFG.rpc, CFG.chainId, { staticNetwork: true, batchMaxCount: 1 });
const hbRead = CFG.contract ? new Contract(CFG.contract, abi, reader) : null;
const logsReader = CFG.logsRpc === CFG.rpc ? reader : new JsonRpcProvider(CFG.logsRpc, CFG.chainId, { staticNetwork: true, batchMaxCount: 1 });
const hbLogs = CFG.contract ? new Contract(CFG.contract, abi, logsReader) : null;
let registryRead = null;
const handleCache = new Map();

const state = { signer: null, address: null, via: null };
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $("#app");

// ------------------------------------------------------------ language/theme

const pref = (key, fallback) => {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
};
let lang = pref("ahb:lang", "en"); // default English; the header toggle switches and remembers
if (!DICT[lang]) lang = "en";

/** Translated string; {name} placeholders filled from vars. */
const t = (key, vars = {}) => (DICT[lang][key] ?? DICT.zh[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
const locale = () => (lang === "zh" ? "zh-CN" : "en-US");

function setLang(next) {
  lang = next;
  try { localStorage.setItem("ahb:lang", next); } catch {}
  document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  applyChrome();
  renderWallet();
  route(true);
}

function setTheme(next) {
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("ahb:theme", next); } catch {}
  applyChrome();
}

function applyChrome() {
  document.title = t("meta.title");
  $(".nav").setAttribute("aria-label", lang === "zh" ? "主导航" : "Main");
  $(".header .brand").setAttribute("aria-label", lang === "zh" ? "Agent ID 红包 首页" : "Agent ID Red Packets home");
  for (const el of $$("[data-i18n]")) el.innerHTML = t(el.dataset.i18n);
  // Phones get the main navigation as a bottom tab bar.
  $("#tabbar").innerHTML = [["home", "#/", I.home], ["create", "#/create", I.packet], ["how", "#/how", I.terminal], ["mine", "#/mine", I.box]]
    .map(([k, href, ico]) => `<a href="${href}" data-nav="${k}">${ico}<span>${t(`nav.${k}`)}</span></a>`)
    .join("");
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const lt = $("#lang-toggle");
  lt.innerHTML = `${I.lang}<span>${lang === "zh" ? "EN" : "中"}</span>`;
  lt.title = t("toggle.lang");
  lt.setAttribute("aria-label", t("toggle.lang"));
  const tt = $("#theme-toggle");
  tt.innerHTML = theme === "light" ? I.moon : I.sun;
  tt.title = t("toggle.theme");
  tt.setAttribute("aria-label", t("toggle.theme"));
  if (CFG.contract && CFG.explorer) {
    $("#contract-link").innerHTML = `${t("foot.contract")} ${extLink(`${CFG.explorer}/address/${CFG.contract}#code`, short(CFG.contract))}`;
  } else if (CFG.contract) {
    $("#contract-link").textContent = `${t("foot.contract")} ${short(CFG.contract)}`;
  }
}

// ------------------------------------------------------------------ helpers

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Listed tokens come from the build config; any other token is "custom": its symbol is untrusted
// text, so it is always shown with the custom tag and its address.
const tokenCache = new Map(); // lowercase address -> custom token
const listedOf = (address) => CFG.tokens.find((tk) => tk.address.toLowerCase() === String(address).toLowerCase());
function tokenOf(address) {
  const l = listedOf(address);
  if (l) return { ...l, custom: false, min: BigInt(l.minShare ?? 1000) };
  return tokenCache.get(String(address).toLowerCase()) ?? { address, symbol: "?", name: "", decimals: null, custom: true, min: 1000n };
}
/** A token's metadata, read from the chain once per page load for custom tokens. */
async function loadToken(address) {
  const key = String(address).toLowerCase();
  if (listedOf(key) || tokenCache.has(key)) return tokenOf(key);
  const meta = await fetchTokenMeta((to, data) => reader.call({ to, data }), key);
  const tk = { address: meta.address, symbol: displaySymbol(meta.symbol, false), name: meta.name, decimals: meta.decimals, custom: true, min: 1000n };
  tokenCache.set(key, tk);
  return tk;
}
/** Custom-token metadata the index already holds (rows of /api/packets and /api/recent). */
function seedToken(address, symbol, decimals) {
  const key = String(address).toLowerCase();
  if (listedOf(key) || tokenCache.has(key) || decimals == null) return;
  tokenCache.set(key, { address, symbol: displaySymbol(symbol, false), name: "", decimals: Number(decimals), custom: true, min: 1000n });
}
const decOf = (token) => token.decimals ?? 0;
const fmt = (amount, token) => `${round(formatUnits(amount, decOf(token)))} ${token.symbol}`;
const fmtNum = (amount, token) => round(formatUnits(amount, decOf(token)));
/** Symbol for HTML: a custom token carries its tag and short address. */
const symHtml = (tk) => (tk.custom ? `${esc(tk.symbol)} <span class="tag tag-red" title="${esc(tk.address)}">${t("tok.custom")} ${esc(tokenAddress(tk.address))}</span>` : esc(tk.symbol));
/** At most 6 decimals for display; exact values stay on chain. */
const round = (s) => {
  const [i, d = ""] = s.split(".");
  const cut = d.slice(0, 6).replace(/0+$/, "");
  if (cut) return `${i}.${cut}`;
  return i === "0" && /[1-9]/.test(d) ? "<0.000001" : i;
};
const when = (sec) => new Date(Number(sec) * 1000).toLocaleString(locale(), { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const saved = () => JSON.parse(pref(STORE, "[]"));
const save = (entry) => localStorage.setItem(STORE, JSON.stringify([entry, ...saved().filter((e) => e.id !== entry.id)].slice(0, 200)));
const tokenIcon = (tk) => `<span class="token-ico ${tk.custom ? "custom" : tk.symbol.toLowerCase()}">${esc(Array.from(tk.symbol)[0] ?? "?")}</span>`;
const notice = (html, danger) => `<div class="notice${danger ? " danger" : ""}">${danger ? I.warning : I.info}<div>${html}</div></div>`;
const extLink = (href, text) => `<a class="ext" href="${href}" target="_blank" rel="noreferrer">${text}${I.external}</a>`;
/** Shareable packet link: a path (crawlers never see #fragments) with the language for previews. */
const packetUrl = (id) => `${location.origin}/p/${id}?lang=${lang}`;
const HASHTAGS = "#BinanceWalletHackathon #AgenticWallet";
const shareTexts = {};
/** Group message with a first-timer guide, in the current language. */
function invite(id, share, intro) {
  return inviteText({ share, intro, lead: t("share.linkText", { id }), url: packetUrl(id), skillUrl: SKILL_URL, lang });
}
/** X, Telegram and copy buttons. share is the packet's share line, if the viewer has it. */
function shareButtons(id, share, intro) {
  const url = packetUrl(id);
  const full = invite(id, share, intro);
  shareTexts[id] = full;
  const x = `https://x.com/intent/post?text=${encodeURIComponent(`${share || t("share.linkText", { id })}\n${t("share.xGuide")} ${url}\n${HASHTAGS}`)}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(full)}`;
  return `<a class="btn btn-sm" href="${x}" target="_blank" rel="noreferrer">${I.xLogo}${t("share.x")}</a><a class="btn btn-sm" href="${tg}" target="_blank" rel="noreferrer">${I.plane}${t("share.tg")}</a><button type="button" class="btn-sm" data-copy-invite="${id}">${I.chat}${t("share.copyInvite")}</button><button type="button" class="btn-sm" data-copy-link="${id}">${I.copy}${t("share.link")}</button>`;
}
function bindShare(root = document) {
  for (const b of $$("[data-copy-link]", root)) b.onclick = () => copy(packetUrl(b.dataset.copyLink));
  for (const b of $$("[data-copy-invite]", root)) b.onclick = () => copy(shareTexts[b.dataset.copyInvite]);
}
/** Sender profile block (X, Telegram, intro); empty string when there is nothing to show. */
function profileBlock(profile) {
  if (isEmptyProfile(profile)) return "";
  const links = [
    profile.x ? `<a class="ext" href="${xUrl(profile.x)}" target="_blank" rel="noreferrer nofollow">${I.xLogo}@${esc(profile.x)}</a>` : "",
    profile.telegram ? `<a class="ext" href="${tgUrl(profile.telegram)}" target="_blank" rel="noreferrer nofollow">${I.plane}${esc(profile.telegram.startsWith("+") ? "Telegram" : `t.me/${profile.telegram}`)}</a>` : "",
  ].filter(Boolean);
  return `<div class="profile">${profile.intro ? `<p class="intro">“${esc(profile.intro)}”</p>` : ""}${links.length ? `<div class="profile-links">${links.join("")}</div>` : ""}</div>`;
}
const ago = (blocks) => {
  const sec = Math.max(0, Number(blocks)) * 0.45; // BNB Chain block time
  if (sec < 60) return t("ago.now");
  if (sec < 3600) return t("ago.min", { n: Math.floor(sec / 60) });
  if (sec < 86400) return t("ago.hour", { n: Math.floor(sec / 3600) });
  return t("ago.day", { n: Math.floor(sec / 86400) });
};
const splitName = (p) => (Number(p.kind) === 0 ? t("split.fixed") : p.lucky ? t("split.lucky") : t("split.equal"));

function statusOf(p) {
  const now = Math.floor(Date.now() / 1000);
  if (p.grabbed >= p.shares) return { text: t("status.full"), cls: "" };
  if (now >= Number(p.expiry)) return { text: t("status.expired"), cls: "tag-red" };
  return { text: t("status.live"), cls: "tag-green" };
}

/** Read API served by the site's Worker (worker/index.js); throws when it is not available. */
async function api(path) {
  const res = await fetch(`/api${path}`, { headers: { accept: "application/json" } });
  if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) throw new Error(`api ${res.status}`);
  return res.json();
}

async function registry() {
  if (!registryRead) registryRead = new Contract(await hbRead.registry(), REGISTRY, reader);
  return registryRead;
}

async function handleOf(address) {
  if (!handleCache.has(address)) handleCache.set(address, (await registry()).handleOf(address).catch(() => ""));
  return handleCache.get(address);
}

function reason(err) {
  const x = explain(iface, err, lang);
  if (x) return x.reason;
  if (err?.code === "ACTION_REJECTED" || err?.info?.error?.code === 4001) return t("wallet.rejected");
  return err?.shortMessage || err?.message || String(err);
}

function toast(msg, kind = "info") {
  $$(".toast").forEach((el) => el.remove());
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3000);
}

async function copy(text) {
  await navigator.clipboard.writeText(text);
  toast(t("copied"), "ok");
}

// ------------------------------------------------------------------- wallet

function renderWallet() {
  const el = $("#wallet");
  if (state.address) {
    el.innerHTML = `<span class="addr" title="${esc(state.address)}"><i></i>${esc(short(state.address))}</span><button class="btn-sm" id="disconnect">${t("wallet.disconnect")}</button>`;
    $("#disconnect").onclick = () => {
      Object.assign(state, { signer: null, address: null, via: null });
      renderWallet();
      route(true);
    };
    return;
  }
  const tests = Object.entries(CFG.testAccounts);
  el.innerHTML = `${
    tests.length
      ? `<select id="test-account" aria-label="${t("wallet.test")}"><option value="">${t("wallet.test")}</option>${tests
          .map(([name, a]) => `<option value="${esc(a)}">${esc(name)}</option>`)
          .join("")}</select>`
      : ""
  }<button id="connect" class="primary btn-sm">${I.wallet}<span class="hide-xs">${t("wallet.connect")}</span></button>`;
  $("#connect").onclick = connectInjected;
  if (tests.length) $("#test-account").onchange = (e) => e.target.value && connectTest(e.target.value);
}

async function connectInjected() {
  if (!window.ethereum) return toast(t("wallet.none"), "error");
  try {
    const provider = new BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    const net = await provider.getNetwork();
    if (net.chainId !== BigInt(CFG.chainId)) {
      await provider.send("wallet_switchEthereumChain", [{ chainId: `0x${CFG.chainId.toString(16)}` }]);
    }
    const p = new BrowserProvider(window.ethereum);
    state.signer = await p.getSigner();
    state.address = await state.signer.getAddress();
    state.via = "injected";
    window.ethereum.on?.("accountsChanged", () => location.reload());
    window.ethereum.on?.("chainChanged", () => location.reload());
  } catch (e) {
    return toast(reason(e), "error");
  }
  renderWallet();
  route(true);
}

async function connectTest(address) {
  state.signer = await reader.getSigner(getAddress(address));
  state.address = getAddress(address);
  state.via = "test";
  renderWallet();
  route(true);
}

function requireWallet() {
  if (state.signer) return true;
  toast(t("wallet.need"), "error");
  return false;
}

async function send(contract, method, args, overrides = {}) {
  const c = contract.connect(state.signer);
  try {
    await c[method].staticCall(...args, overrides); // surface the contract's reason before signing
  } catch (e) {
    throw new Error(reason(e));
  }
  const tx = await c[method](...args, overrides);
  toast(t("tx.sent"));
  return tx.wait();
}

// ------------------------------------------------------------------- router

let currentPage = null;

/** keepScroll: re-render the current page in place (language or wallet change). */
function route(keepScroll = false) {
  const hash = location.hash || "#/";
  const m = hash.match(/^#\/p\/(\d+)/);
  const page = m ? "packet" : hash.startsWith("#/mine") ? "mine" : hash.startsWith("#/how") ? "how" : hash.startsWith("#/create") ? "create" : "home";
  for (const a of $$(".nav a, .tabbar a")) a.classList.toggle("on", a.dataset.nav === page);

  if (!CFG.contract) {
    app.innerHTML = `<div class="container page"><div class="card">${t("noContract")}</div></div>`;
    return;
  }
  if (page === "how" && currentPage === "home" && keepScroll !== true) {
    $("#how")?.scrollIntoView({ behavior: "smooth" });
    return;
  }
  const y = window.scrollY;
  currentPage = page === "how" ? "home" : page;
  if (page === "packet") pagePacket(BigInt(m[1]));
  else if (page === "mine") pageMine();
  else if (page === "create") pageCreate();
  else pageHome();
  if (keepScroll === true) window.scrollTo(0, y);
  else if (page === "how") requestAnimationFrame(() => $("#how")?.scrollIntoView());
  else window.scrollTo(0, 0);
}

// --------------------------------------------------------------- home page

function pageHome() {
  const prompt = t("prompt.text", { walletSkill: WALLET_SKILL, skillUrl: SKILL_URL });
  const steps = [["idCard", "s1"], ["toggle", "s2"], ["terminal", "s3"], ["chat", "s4"]];
  const types = [["lock", "code"], ["globe", "public"], ["at", "direct"]];
  app.innerHTML = `
  <section class="hero container">
    <div class="hero-grid">
      <div>
        <h1>${t("hero.title")}</h1>
        <p class="sub">${t("hero.sub")}</p>
        <div class="cta">
          <a class="btn btn-primary btn-lg" href="#/create">${I.packet}${t("nav.create")}</a>
          <a class="btn btn-lg" href="#/how">${t("hero.how")}${I.arrowRight}</a>
        </div>
        <div class="hero-stats">
          <div><div class="v" id="st-packets"><span class="skeleton"></span></div><div class="k">${t("stats.packets")}</div></div>
          <div><div class="v" id="st-agents"><span class="skeleton"></span></div><div class="k">${t("stats.agents")}</div></div>
          <div><div class="v">0%</div><div class="k">${t("stats.fee")}</div></div>
        </div>
      </div>
      <div class="preview-card" aria-hidden="true">
        <div class="packet-face">
          <div class="face-top"><span>AgentHongbao #12</span><span>${t("demo.top")}</span></div>
          <div class="seal">福</div>
          <div class="face-bottom"><div><div class="face-memo">${t("demo.memo")}</div><div class="amount">0.1 BNB</div></div><span class="face-memo">${t("demo.shares")}</span></div>
        </div>
        <div class="chat">
          <div class="bubble me">${t("demo.me1")}</div>
          <div class="bubble agent">${t("demo.agent1", { contract: CFG.contract ? short(CFG.contract) : "0x…" })}</div>
          <div class="bubble me">${t("demo.me2")}</div>
          <div class="bubble agent">${t("demo.agent2")}</div>
        </div>
      </div>
    </div>
  </section>

  <section class="section container">
    <div class="section-head">
      <div><h2>${t("latest.title")}</h2><p>${t("latest.sub")}</p></div>
      <a class="btn" href="#/create">${I.plus}${t("nav.create")}</a>
    </div>
    <div class="card table-card">
      <div class="tabs pad-x" role="tablist">
        <button type="button" class="on" data-feed="packets" role="tab">${t("tab.packets")}</button>
        <button type="button" data-feed="claims" role="tab">${t("tab.claims")}</button>
      </div>
      <div class="table-wrap" data-panel="packets">
        <table class="table feed feed-packets">
          <thead><tr><th>${t("th.packet")}</th><th>${t("th.token")}</th><th class="right">${t("th.total")}</th><th>${t("th.progress")}</th><th>${t("th.status")}</th><th class="hide-sm">${t("th.expiry")}</th><th class="right">${t("th.action")}</th></tr></thead>
          <tbody id="latest"><tr class="empty-row"><td colspan="7"><span class="skeleton" style="width:200px"></span></td></tr></tbody>
        </table>
      </div>
      <div class="table-wrap" data-panel="claims" hidden>
        <table class="table feed feed-claims">
          <thead><tr><th>${t("th.agent")}</th><th>${t("th.packet")}</th><th class="right">${t("th.amount")}</th><th class="right">${t("th.when")}</th></tr></thead>
          <tbody id="recent"><tr class="empty-row"><td colspan="4"><span class="skeleton" style="width:200px"></span></td></tr></tbody>
        </table>
      </div>
    </div>
  </section>

  <section class="section container">
    <div class="section-head"><div><h2>${t("types.title")}</h2><p>${t("types.sub")}</p></div></div>
    <div class="features">
      ${types
        .map(([ico, k]) => `<div class="feature"><div class="feature-ico">${I[ico]}</div><h3>${t(`type.${k}.title`)}</h3><p>${t(`type.${k}.body`)}</p><div class="foot"><span class="tag tag-yellow">${t(`type.${k}.tag`)}</span></div></div>`)
        .join("")}
    </div>
  </section>

  <section class="section container" id="how">
    <div class="section-head"><div><h2>${t("how.title")}</h2><p>${t("how.sub")}</p></div></div>
    <div class="steps">
      ${steps
        .map(([ico, k], i) => `<div class="step"><div class="step-ico">${I[ico]}</div><span class="step-no">${t("how.step", { n: i + 1 })}</span><h3>${t(`how.${k}.t`)}</h3><p>${t(`how.${k}.b`)}</p></div>`)
        .join("")}
    </div>
    <div class="install">
      <div class="card">
        <h3 class="h-ico">${I.terminal}${t("install.title")}</h3>
        <p class="t3">${t("install.sub")}</p>
        <pre class="code">npx skills add ${esc(WALLET_SKILL)}
npx skills add ${esc(SKILL_URL)}</pre>
        <div class="copy-row"><button class="btn-sm" id="copy-install">${I.copy}${t("install.copy")}</button><a class="btn btn-sm" href="/skill/SKILL.md" target="_blank" rel="noreferrer">${I.doc}${t("install.skill")}</a><a class="btn btn-sm" href="/skill/SHA256SUMS" target="_blank" rel="noreferrer">${I.shield}${t("install.sums")}</a></div>
      </div>
      <div class="card">
        <h3 class="h-ico">${I.chat}${t("prompt.title")}</h3>
        <p class="t3">${t("prompt.sub")}</p>
        <pre class="code prompt-box">${esc(prompt)}</pre>
        <div class="copy-row"><button class="primary btn-sm" id="copy-prompt">${I.copy}${t("prompt.copy")}</button></div>
      </div>
    </div>
  </section>

  <section class="section container">
    <div class="section-head"><div><h2>${t("faq.title")}</h2></div></div>
    <div class="faq">${[1, 2, 3, 4, 5, 6].map((n) => `<details${n === 1 ? " open" : ""}><summary>${t(`faq.q${n}`)}</summary><div class="answer">${t(`faq.a${n}`)}</div></details>`).join("")}</div>
  </section>

  <div class="container">
    <div class="cta-band">
      <div><h2>${t("cta.title")}</h2><p>${t("cta.sub")}</p></div>
      <a class="btn btn-primary btn-lg" href="#/create">${I.packet}${t("nav.create")}</a>
    </div>
  </div>`;

  $("#copy-install").onclick = () => copy(`npx skills add ${WALLET_SKILL}\nnpx skills add ${SKILL_URL}`);
  $("#copy-prompt").onclick = () => copy(prompt);
  for (const b of $$("[data-feed]")) {
    b.onclick = () => {
      for (const x of $$("[data-feed]")) x.classList.toggle("on", x === b);
      for (const p of $$("[data-panel]")) p.hidden = p.dataset.panel !== b.dataset.feed;
    };
  }
  loadStats();
  loadLatest();
  loadRecent();
}

async function loadRecent() {
  const body = $("#recent");
  try {
    const { claims, indexedBlock } = await api("/recent?limit=10");
    if (!body.isConnected) return;
    body.innerHTML = claims.length
      ? claims
          .map((c) => {
            seedToken(c.token, c.token_symbol, c.token_decimals);
            const tk = tokenOf(c.token);
            const amount = c.amount === null ? `<span class="t3">${t("packet.pending")}</span>` : esc(fmt(BigInt(c.amount), tk));
            return `<tr class="row-link" data-href="#/p/${c.packet_id}">
              <td class="c-who"><div class="cell-main"><span class="avatar">${esc((c.handle || "?").slice(0, 1).toUpperCase())}</span><b>${esc(c.handle ? `${c.handle}.ai` : short(c.who))}</b></div></td>
              <td class="c-id"><div class="cell-main"><b>#${c.packet_id}</b><span class="tag">${t(`kind.${c.kind}`)}</span></div></td>
              <td class="right c-total">${amount}</td>
              <td class="right t3 c-when">${ago(indexedBlock - c.block)}</td>
            </tr>`;
          })
          .join("")
      : `<tr class="empty-row"><td colspan="4">${t("recent.empty")}</td></tr>`;
    for (const tr of $$("tr[data-href]", body)) tr.onclick = () => (location.hash = tr.dataset.href);
  } catch {
    if (body.isConnected) body.innerHTML = `<tr class="empty-row"><td colspan="4">${t("recent.empty")}</td></tr>`;
  }
}

async function loadStats() {
  try {
    const s = await api("/stats");
    if ($("#st-packets")) $("#st-packets").textContent = Number(s.packets).toLocaleString();
    if ($("#st-agents")) $("#st-agents").textContent = Number(s.claimers).toLocaleString();
    return;
  } catch {
    /* no index: read the chain below */
  }
  try {
    const n = Number(await hbRead.packetCount());
    if ($("#st-packets")) $("#st-packets").textContent = n.toLocaleString();
  } catch {
    if ($("#st-packets")) $("#st-packets").textContent = "–";
  }
  try {
    const [g, d] = await Promise.all([
      scanLogs(hbLogs.filters.Grabbed(), Number(CFG.deployBlock), 20),
      scanLogs(hbLogs.filters.DirectClaimed(), Number(CFG.deployBlock), 20),
    ]);
    const n = new Set([...g, ...d].map((l) => l.args.who)).size;
    if ($("#st-agents")) $("#st-agents").textContent = n.toLocaleString();
  } catch {
    if ($("#st-agents")) $("#st-agents").textContent = "–";
  }
}

async function loadLatest() {
  const body = $("#latest");
  let indexed = null;
  try {
    const { packets: rows } = await api("/packets?limit=10");
    for (const r of rows) seedToken(r.token, r.token_symbol, r.token_decimals);
    indexed = rows.map((r) => [
      BigInt(r.id),
      { kind: BigInt(r.kind), lucky: Boolean(r.lucky), token: r.token, total: BigInt(r.total), shares: BigInt(r.shares), grabbed: BigInt(r.claimed), expiry: BigInt(r.expiry) },
    ]);
  } catch {
    /* no index: read the chain below */
  }
  if (indexed) {
    if (!body.isConnected) return;
    body.innerHTML = indexed.length ? indexed.map(([id, p]) => packetRow(id, p)).join("") : `<tr class="empty-row"><td colspan="7">${t("latest.empty")}</td></tr>`;
    for (const tr of $$("tr[data-href]", body)) tr.onclick = () => (location.hash = tr.dataset.href);
    return;
  }
  try {
    const count = Number(await hbRead.packetCount());
    const ids = [];
    for (let i = count; i >= 1 && ids.length < 10; i--) ids.push(BigInt(i));
    const packets = await Promise.all(ids.map((id) => hbRead.getPacket(id).then((p) => [id, p])));
    const shown = packets.filter(([, p]) => !tokenOf(p.token).custom);
    if (!body.isConnected) return;
    body.innerHTML = shown.length ? shown.map(([id, p]) => packetRow(id, p)).join("") : `<tr class="empty-row"><td colspan="7">${t("latest.empty")}</td></tr>`;
    for (const tr of $$("tr[data-href]", body)) tr.onclick = () => (location.hash = tr.dataset.href);
  } catch (e) {
    if (body.isConnected) body.innerHTML = `<tr class="empty-row"><td colspan="7">${esc(t("loadFailed", { reason: reason(e) }))}</td></tr>`;
  }
}

function packetRow(id, p) {
  const tk = tokenOf(p.token);
  const kind = Number(p.kind);
  const st = statusOf(p);
  const pct = Number((p.grabbed * 100n) / (p.shares || 1n));
  const split = kind === 0 ? t("split.fixedShort") : splitName(p);
  return `<tr class="row-link" data-href="#/p/${id}">
    <td class="c-id"><div class="cell-main"><b>#${id}</b><span class="tag">${t(`kind.${kind}`)}</span><span class="tag">${split}</span></div></td>
    <td class="c-token"><div class="cell-main">${tokenIcon(tk)}${symHtml(tk)}</div></td>
    <td class="right c-total">${esc(fmtNum(p.total, tk))}</td>
    <td class="c-progress"><div class="bar"><div class="progress"><i style="width:${pct}%"></i></div><span class="t3">${p.grabbed}/${p.shares}</span></div></td>
    <td class="c-status"><span class="tag ${st.cls}">${st.text}</span></td>
    <td class="hide-sm t3">${esc(when(p.expiry))}</td>
    <td class="right c-view"><a href="#/p/${id}">${t("view")}</a></td>
  </tr>`;
}

// ------------------------------------------------------------- create page

function pageCreate() {
  const tokenOptions = CFG.tokens.map((tk) => `<option value="${esc(tk.address)}">${esc(tk.symbol)}</option>`).join("") + `<option value="custom">${t("tok.other")}</option>`;
  app.innerHTML = `
  <div class="container page">
    <div class="page-title"><h1>${t("create.title")}</h1></div>
    <div class="two-col">
      <div class="card">
        <div class="tabs" role="tablist">
          ${["code", "public", "direct"].map((ty) => `<button type="button" data-type="${ty}" role="tab">${t(`kindFull.${TYPES.indexOf(ty)}`)}</button>`).join("")}
        </div>
        <form id="create-form" class="form">
          <div id="type-hint"></div>
          <label class="field split-only">
            <div class="field-head"><b>${t("f.total")}</b><span id="min-hint"></span></div>
            <div class="input-group">
              <input name="total" inputmode="decimal" placeholder="0.00" autocomplete="off" required />
              <div class="suffix"><select name="token" aria-label="${t("f.token")}">${tokenOptions}</select></div>
            </div>
          </label>
          <div class="row2 split-only">
            <label class="field"><div class="field-head"><b>${t("f.shares")}</b><span>${t("f.sharesRange")}</span></div>
              <div class="input-group"><input name="shares" inputmode="numeric" value="5" required /><span class="unit">${t("f.sharesUnit")}</span></div></label>
            <div class="field"><div class="field-head"><b>${t("f.split")}</b></div>
              <div class="chips" role="radiogroup" aria-label="${t("f.split")}">
                <label class="chip-radio"><input type="radio" name="lucky" value="1" checked /><span>${t("split.lucky")}</span></label>
                <label class="chip-radio"><input type="radio" name="lucky" value="0" /><span>${t("split.equal")}</span></label>
              </div></div>
          </div>
          <label class="field direct-only"><div class="field-head"><b>${t("f.token")}</b></div><select name="tokenDirect">${tokenOptions}</select></label>
          <div class="field custom-only" hidden>
            <label class="field"><div class="field-head"><b>${t("tok.addr")}</b></div>
            <input name="customToken" placeholder="0x…" autocomplete="off" spellcheck="false" /></label>
            <div id="custom-info" class="form-hint"></div>
            ${notice(t("tok.warn"), true)}
          </div>
          <label class="field direct-only">
            <div class="field-head"><b>${t("f.to")}</b><span>${t("f.toHint")}</span></div>
            <textarea name="to" rows="5" placeholder="alice.ai 0.01&#10;bob.ai 0.02"></textarea>
            <span class="form-hint">${t("f.toWarn")}</span>
          </label>
          <div class="field">
            <div class="field-head"><b>${t("f.ttl")}</b></div>
            <div class="chips">${["3600", "86400", "259200", "604800", "2592000"]
              .map((v) => `<label class="chip-radio"><input type="radio" name="ttl" value="${v}"${v === "86400" ? " checked" : ""} /><span>${t(`ttl.${v}`)}</span></label>`)
              .join("")}</div>
          </div>
          <div class="field pass-only">
            <label class="field"><div class="field-head"><b>${t("f.pass")}</b><span class="code-only">${t("f.required")}</span><span class="public-only">${t("f.optional")}</span></div>
            <input name="pass" placeholder="${esc(t("f.passPh"))}" autocomplete="off" /></label>
            <div class="chips presets">${PRESETS().map((p) => `<button type="button" class="chip-btn" data-fill="pass" data-value="${esc(p)}">${esc(p)}</button>`).join("")}</div>
            <span class="form-hint public-only">${t("f.passHintPublic")}</span>
          </div>
          <label class="check code-only"><input type="checkbox" name="hidePass" />${t("f.hidePass")}</label>
          <label class="field public-only">
            <div class="field-head"><b>${t("f.heat")}</b><span>${t("f.heatUnit")}</span></div>
            <div class="input-group"><input name="heatStep" inputmode="numeric" value="120" /><span class="unit">${t("f.sec")}</span></div>
            <span class="form-hint">${t("f.heatHint")}</span>
          </label>
          <div class="field">
            <label class="field"><div class="field-head"><b>${t("f.memo")}</b></div>
            <input name="memo" maxlength="80" value="${esc(t("f.memoDefault"))}" /></label>
            <div class="chips presets">${PRESETS().map((p) => `<button type="button" class="chip-btn" data-fill="memo" data-value="${esc(p)}">${esc(p)}</button>`).join("")}</div>
          </div>
          <details class="profile-form" id="profile-form">
            <summary><b>${t("prof.title")}</b><span>${t("prof.optional")}</span></summary>
            <p class="form-hint">${t("prof.sub")}</p>
            <div class="row2">
              <label class="field"><div class="field-head"><b>${t("prof.x")}</b></div><input name="px" placeholder="@yourname" autocomplete="off" /></label>
              <label class="field"><div class="field-head"><b>${t("prof.tg")}</b></div><input name="ptg" placeholder="t.me/yourgroup" autocomplete="off" /></label>
            </div>
            <label class="field"><div class="field-head"><b>${t("prof.intro")}</b><span id="intro-count">0 / ${INTRO_MAX}</span></div><input name="pintro" maxlength="${INTRO_MAX}" placeholder="${esc(t("prof.introPh"))}" autocomplete="off" /></label>
          </details>
          <div class="summary">
            <div class="kv-row split-only"><span>${t("sum.avg")}</span><span id="sum-value">–</span></div>
            <div class="kv-row split-only"><span id="sum-low-label"></span><span id="sum-low">–</span></div>
            <div class="kv-row"><span>${t("sum.gas")}</span><span id="sum-gas">–</span></div>
            <div class="kv-row"><span>${t("sum.expiry")}</span><span id="sum-expiry">–</span></div>
            <div class="kv-row"><span>${t("sum.fee")}</span><span>0</span></div>
          </div>
          <div id="low-warn"></div>
          <button type="submit" class="primary btn-lg btn-block">${I.packet}${t("f.submit")}</button>
        </form>
      </div>
      <aside class="side">
        <div id="created"></div>
        <div class="card">
          <h3>${t("side.title")}</h3>
          <ul class="ticks">${[1, 2, 3, 4, 5].map((n) => `<li>${I.check}<span>${t(`side.${n}`)}</span></li>`).join("")}</ul>
        </div>
        ${notice(t("side.risk"))}
      </aside>
    </div>
  </div>`;
  setupCreateForm();
}

function setupCreateForm() {
  let type = "code";
  const form = $("#create-form");
  let custom = null; // the custom token looked up from the address field, once valid
  const picked = () => (type === "direct" ? form.tokenDirect.value : form.token.value);
  const current = () => (picked() === "custom" ? custom : tokenOf(picked()));
  let lookup = 0;
  const lookUpCustom = async () => {
    const n = ++lookup;
    const info = $("#custom-info");
    custom = null;
    const raw = form.customToken.value.trim();
    if (!raw) return (info.textContent = "");
    let address;
    try {
      address = getAddress(raw.toLowerCase());
    } catch {
      return (info.innerHTML = `<span class="red">${t("tok.bad")}</span>`);
    }
    if (listedOf(address)) return (info.innerHTML = `<span class="red">${t("tok.isListed", { sym: esc(listedOf(address).symbol) })}</span>`);
    info.textContent = t("tok.loading");
    try {
      if ((await reader.getCode(address)) === "0x") throw new Error(t("tok.noCode"));
      const tk = await loadToken(address);
      if (tk.decimals === null) throw new Error(t("tok.noDecimals"));
      let bal = "";
      if (state.address) {
        const b = await new Contract(address, ERC20, reader).balanceOf(state.address);
        bal = ` · ${t("tok.balance")} ${esc(fmtNum(b, tk))}`;
      }
      if (n !== lookup) return;
      custom = tk;
      info.innerHTML = `<b>${esc(tk.symbol)}</b>${tk.name ? ` · ${esc(tk.name)}` : ""} · ${t("tok.decimals", { n: tk.decimals })}${bal} · ${CFG.explorer ? extLink(`${CFG.explorer}/token/${address}`, esc(tokenAddress(address))) : esc(tokenAddress(address))}`;
    } catch (e) {
      if (n === lookup) info.innerHTML = `<span class="red">${esc(e.message || reason(e))}</span>`;
    }
    updateSummary();
  };
  form.customToken.addEventListener("input", () => {
    clearTimeout(lookUpCustom.timer);
    lookUpCustom.timer = setTimeout(lookUpCustom, 400);
  });
  const updateSummary = () => {
    for (const el of $$(".custom-only", form)) el.hidden = picked() !== "custom";
    const tk = current() ?? { symbol: "", decimals: 18, custom: true, min: 1000n, address: ZeroAddress };
    const lucky = form.lucky.value === "1";
    const shares = Number(form.shares.value);
    const plan = splitPlan(tk, form.total.value, shares, lucky);
    $("#sum-value").textContent = plan.avg === null ? "–" : `${fmtUnits(plan.avg, tk)} ${tk.symbol}`;
    $("#sum-low-label").textContent = lucky ? t("sum.lowLucky") : t("sum.lowEqual");
    $("#sum-low").textContent = plan.low === null ? "–" : `${fmtUnits(plan.low, tk)} ${tk.symbol}`;
    $("#sum-low").className = plan.tooLow ? "red" : "";
    $("#sum-gas").textContent = gasText();
    $("#sum-expiry").textContent = when(Math.floor(Date.now() / 1000) + Number(form.ttl.value));
    $("#min-hint").textContent = shares > 0 && !tk.custom ? t("f.suggest", { amount: `${fmtUnits(plan.needTotal, tk)} ${tk.symbol}`, n: shares }) : "";
    $("#low-warn").innerHTML = type !== "direct" && plan.tooLow ? notice(esc(t("f.tooLow", { low: `${fmtUnits(plan.low, tk)} ${tk.symbol}`, need: `${fmtUnits(plan.needTotal, tk)} ${tk.symbol}` })), true) : tk.custom && current() ? notice(t("tok.noGasCheck")) : "";
  };
  form.addEventListener("click", (e) => {
    const b = e.target.closest("[data-fill]");
    if (!b) return;
    form[b.dataset.fill].value = b.dataset.value;
    updateSummary();
  });
  loadFees().then(updateSummary);
  const apply = () => {
    for (const b of $$(".tabs button")) {
      b.classList.toggle("on", b.dataset.type === type);
      b.setAttribute("aria-selected", b.dataset.type === type);
    }
    $("#type-hint").innerHTML = notice(t(`create.hint.${type}`));
    for (const el of $$(".split-only", form)) el.hidden = type === "direct";
    for (const el of $$(".direct-only", form)) el.hidden = type !== "direct";
    for (const el of $$(".pass-only", form)) el.hidden = type === "direct";
    for (const el of $$(".code-only", form)) el.hidden = type !== "code";
    for (const el of $$(".public-only", form)) el.hidden = type !== "public";
    form.total.required = form.shares.required = type !== "direct";
    form.pass.required = type === "code";
    // Public packets take listed tokens only.
    const other = form.token.querySelector('option[value="custom"]');
    other.hidden = other.disabled = type === "public";
    if (type === "public" && form.token.value === "custom") form.token.value = CFG.tokens[0].address;
    updateSummary();
  };
  for (const b of $$(".tabs button")) b.onclick = () => ((type = b.dataset.type), apply());
  form.addEventListener("input", updateSummary);
  form.addEventListener("change", updateSummary);
  apply();
  form.pintro.addEventListener("input", () => ($("#intro-count").textContent = `${[...form.pintro.value].length} / ${INTRO_MAX}`));
  loadProfileInto(form);

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!requireWallet()) return;
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = t("f.busy");
    try {
      const f = new FormData(form);
      if (type === "direct") f.set("token", f.get("tokenDirect"));
      if (f.get("token") === "custom") {
        if (!custom) throw new Error(t("tok.pick"));
        f.set("token", custom.address);
      }
      await createPacket(type, f);
    } catch (err) {
      toast(reason(err), "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${I.packet}${t("f.submit")}`;
    }
  };
}

const PRESETS = () => t("presets").split("|");

// ------------------------------------------------------------ claim cost
// Each claimer pays gas for one grab (about 100k gas, 120k with margin). The smallest share must be
// worth at least twice that, or claiming loses money.
const CLAIM_GAS = 120000n;
const SAFETY = 2n;
let fees = null; // { gasPrice: bigint, bnbUsd: number | null }

async function loadFees() {
  if (fees && Date.now() - fees.at < 60_000) return fees;
  try {
    const r = await api("/fees");
    fees = { gasPrice: BigInt(r.gasPrice), bnbUsd: r.bnbUsd, at: Date.now() };
  } catch {
    let gasPrice = 10n ** 8n; // 0.1 gwei if even the node is unreachable
    try {
      gasPrice = (await reader.getFeeData()).gasPrice ?? gasPrice;
    } catch {}
    fees = { gasPrice, bnbUsd: null, at: Date.now() };
  }
  return fees;
}

const claimCostWei = () => CLAIM_GAS * (fees?.gasPrice ?? 10n ** 8n);
/** Smallest amount one claimer should receive, in the token's base units. */
function minReceive(token) {
  if (token.custom) return 0n; // no price for a custom token: the sender is warned instead
  const wei = claimCostWei() * SAFETY;
  if (token.address === ZeroAddress) return wei;
  const usd = fees?.bnbUsd ?? 1000; // stablecoins: convert with BNB's price, high if unknown
  const cents = Math.ceil(Number(formatUnits(wei, 18)) * usd * 1e6); // micro-dollars
  return BigInt(cents) * 10n ** BigInt(token.decimals - 6);
}
const fmtUnits = (v, token) => round(formatUnits(v, decOf(token)));
function gasText() {
  if (!fees) return "–";
  const bnb = Number(formatUnits(claimCostWei(), 18));
  return fees.bnbUsd ? `≈ ${round(bnb.toFixed(8))} BNB (≈ $${(bnb * fees.bnbUsd).toFixed(4)})` : `≈ ${round(bnb.toFixed(8))} BNB`;
}
/** Average and smallest share for a split, and the total that keeps the smallest share worth claiming. */
function splitPlan(token, totalText, shares, lucky) {
  const contractMin = token.min; // the contract's own minimum per share
  const least = minReceive(token);
  const avgNeeded = lucky ? least * 10n : least; // a lucky share's floor is 10% of the average
  const perShare = avgNeeded > contractMin ? avgNeeded : contractMin;
  const needTotal = shares > 0 ? perShare * BigInt(shares) : 0n;
  let total = null;
  try {
    total = totalText ? parseUnits(String(totalText), decOf(token)) : null;
  } catch {
    total = null;
  }
  if (!total || !(shares > 0)) return { avg: null, low: null, needTotal, tooLow: false };
  const avg = total / BigInt(shares);
  const low = lucky ? avg / 10n : avg;
  return { avg, low, needTotal, tooLow: low < least || avg < contractMin };
}

let savedProfile = null; // what the server holds for the connected sender

async function loadProfileInto(form) {
  if (!state.address) return;
  try {
    const { profile } = await api(`/profiles/${state.address}`);
    savedProfile = profile ? normalizeProfile(profile) : null;
  } catch {
    savedProfile = null;
  }
  if (!savedProfile || !form.isConnected) return;
  form.px.value = savedProfile.x;
  form.ptg.value = savedProfile.telegram;
  form.pintro.value = savedProfile.intro;
  $("#intro-count").textContent = `${[...savedProfile.intro].length} / ${INTRO_MAX}`;
  if (!isEmptyProfile(savedProfile)) $("#profile-form").open = true;
}

/** Checks the profile fields before sending money, so a typo cannot surface after the transaction. */
function readProfile(f) {
  try {
    return normalizeProfile({ x: f.get("px"), telegram: f.get("ptg"), intro: f.get("pintro") });
  } catch (e) {
    if (e instanceof ProfileError) throw new Error(t(`prof.bad.${e.field}`));
    throw e;
  }
}

/** Signs and stores the sender profile when it changed; the packet is already sent either way. */
async function publishProfile(profile, packetId) {
  const same = savedProfile && profile.x === savedProfile.x && profile.telegram === savedProfile.telegram && profile.intro === savedProfile.intro;
  if (same || (isEmptyProfile(profile) && !savedProfile)) return;
  try {
    toast(t("prof.saving"));
    const issued = Math.floor(Date.now() / 1000);
    const signature = await state.signer.signMessage(profileMessage(state.address, profile, issued));
    const res = await fetch("/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: state.address, ...profile, issued, signature, packetId: packetId.toString() }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    savedProfile = profile;
    toast(t("prof.saved"), "ok");
  } catch (e) {
    toast(t("prof.failed", { reason: reason(e) }), "error");
  }
}

async function createPacket(type, f) {
  const profile = readProfile(f);
  const token = await loadToken(f.get("token"));
  if (token.decimals === null) throw new Error(t("tok.noDecimals"));
  const expiry = BigInt(Math.floor(Date.now() / 1000) + Number(f.get("ttl")));
  const memo = String(f.get("memo") || "").trim();
  const passphrase = String(f.get("pass") || "").trim();
  if (type === "code" && !passphrase) throw new Error(t("err.noPass"));
  await loadFees();
  const hb = new Contract(CFG.contract, abi, reader);
  let total;
  let args;
  let method;
  let code = null;

  if (type === "direct") {
    const lines = String(f.get("to")).split(/\n|,|，/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error(t("err.noRecipients"));
    const pairs = lines.map((l) => {
      const [name, amount] = l.split(/[\s=：:]+/);
      if (!amount) throw new Error(t("err.noAmount", { line: l }));
      return [normalizeHandle(name), parseUnits(amount, token.decimals)];
    });
    const least = minReceive(token);
    const small = pairs.filter(([, a]) => a < least);
    if (small.length) throw new Error(t("err.directLow", { names: small.map(([h]) => `${h}.ai`).join(lang === "zh" ? "、" : ", "), need: `${fmtUnits(least, token)} ${token.symbol}` }));
    total = pairs.reduce((s, [, a]) => s + a, 0n);
    const unregistered = [];
    for (const [h] of pairs) if ((await (await registry()).ownerOfHandle(h)) === ZeroAddress) unregistered.push(`${h}.ai`);
    if (unregistered.length && !confirm(t("confirm.unregistered", { names: unregistered.join(lang === "zh" ? "、" : ", ") }))) return;
    method = "createDirect";
    args = [token.address, pairs.map(([h]) => handleHash(h)), pairs.map(([, a]) => a), expiry, memo];
  } else {
    total = parseUnits(String(f.get("total")), token.decimals);
    const shares = Number(f.get("shares"));
    const plan = splitPlan(token, String(f.get("total")), shares, f.get("lucky") === "1");
    if (plan.tooLow) throw new Error(t("f.tooLow", { low: `${fmtUnits(plan.low, token)} ${token.symbol}`, need: `${fmtUnits(plan.needTotal, token)} ${token.symbol}` }));
    let signer = ZeroAddress;
    if (type === "code") {
      code = newCode();
      signer = claimKey(code, passphrase).address;
    } else if (passphrase) {
      signer = claimKey(null, passphrase).address;
    }
    method = "createSplit";
    args = [token.address, total, shares, expiry, type === "public", signer, type === "public" ? Number(f.get("heatStep") || 0) : 0, f.get("lucky") === "1", memo];
  }

  const value = token.address === ZeroAddress ? total : 0n;
  if (token.address !== ZeroAddress) {
    const erc20 = new Contract(token.address, ERC20, state.signer);
    if ((await erc20.balanceOf(state.address)) < total) throw new Error(t("tok.short", { amount: fmt(total, token) }));
    if ((await erc20.allowance(state.address, CFG.contract)) < total) {
      toast(t("approve", { amount: fmt(total, token) }));
      await (await erc20.approve(CFG.contract, total)).wait();
    }
  }
  const receipt = await send(hb, method, args, { value });
  const ev = receipt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((x) => x?.name === "PacketCreated");
  const id = ev.args.id;
  const share = type === "direct" ? null : formatShare({ id, code, passphrase, memo, includePassphrase: !f.get("hidePass"), lang });
  save({ id: id.toString(), type, share, code, passphrase, memo, createdAt: Date.now() });
  toast(t("created.toast", { id }), "ok");
  showCreated(id, type, share, code, passphrase, Boolean(f.get("hidePass")), profile.intro);
  await publishProfile(profile, id);
}

function showCreated(id, type, share, code, passphrase, hidePass, intro) {
  const box = $("#created");
  box.innerHTML = `
    <div class="card result">
      <h3 class="ok-title">${I.checkCircle}${t("created.title", { id })}</h3>
      ${share ? `<p>${t("created.share")}</p><pre class="code">${esc(invite(id, share, intro))}</pre>` : `<p>${t("created.direct")}</p>`}
      ${code ? `<div style="margin-top:12px">${notice(`${t("created.codeWarn")}${hidePass && passphrase ? t("created.passWarn", { pass: esc(passphrase) }) : ""}`, true)}</div>` : ""}
      ${type === "public" && !code ? `<p class="t3">${t("created.public", { id })}</p>` : ""}
      <div class="copy-row">
        ${share ? `<button id="copy-share" class="primary btn-sm">${I.copy}${t("created.copy")}</button>` : ""}
        <a class="btn btn-sm" href="#/p/${id}">${t("created.view")}${I.arrowRight}</a>
      </div>
      <div class="divider"></div>
      <div class="share-row">${shareButtons(id, share, intro)}</div>
      ${code ? `<p class="form-hint share-warn">${t("share.publicWarn")}</p>` : ""}
    </div>`;
  if (share) $("#copy-share").onclick = () => copy(invite(id, share, intro));
  bindShare(box);
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ------------------------------------------------------------- packet page

async function pagePacket(id) {
  app.innerHTML = `<div class="loading"><div><div class="spinner"></div>${t("packet.loading", { id })}</div></div>`;
  let p;
  try {
    p = await hbRead.getPacket(id);
  } catch (e) {
    app.innerHTML = `<div class="container page"><div class="card empty">${I.box}<p>${esc(t("packet.title", { id }))}: ${esc(reason(e))}</p><a class="btn" href="#/">${t("packet.home")}</a></div></div>`;
    return;
  }
  const token = await loadToken(p.token).catch(() => tokenOf(p.token));
  const kind = Number(p.kind);
  const now = Math.floor(Date.now() / 1000);
  const expired = now >= Number(p.expiry);
  const mine = saved().find((e) => e.id === id.toString());
  const isCreator = state.address && state.address === p.creator;
  const pct = Number((p.grabbed * 100n) / (p.shares || 1n));
  const back = p.remaining + p.forfeited;
  const canRefund = isCreator && back > 0n && (kind === 0 ? expired : (expired || p.grabbed >= p.shares) && p.opened === p.grabbed);
  const st = statusOf(p);
  const canOpen = kind !== 0 && p.opened < p.grabbed;

  app.innerHTML = `
  <div class="container page">
    <div class="breadcrumb"><a href="#/">${t("nav.home")}</a> / ${t("packet.title", { id })}</div>
    <div class="page-title">
      <h1>${t("packet.title", { id })}</h1>
      <span class="tag">${t(`kindFull.${kind}`)}</span><span class="tag">${splitName(p)}</span><span class="tag ${st.cls}">${st.text}</span>
      ${kind === 2 && Number(p.heatStep) ? `<span class="tag">${t("packet.heat", { n: p.heatStep })}</span>` : ""}
    </div>
    <div class="two-col packet-layout">
      <div class="stack">
        ${mine?.share ? `<div class="card"><div class="card-title"><h3 class="h-ico">${I.share}${t("packet.share")}</h3><button class="primary btn-sm" id="copy-share">${I.copy}${t("packet.copy")}</button></div><pre class="code">${esc(mine.share)}</pre></div>` : ""}
        <div class="card table-card">
          <div class="card-title pad"><h3 class="h-ico">${I.users}${t("packet.claims")}</h3><span class="t3">${t("packet.claimed", { n: p.grabbed })}</span></div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>#</th><th>${t("th.agent")}</th><th class="hide-sm">${t("th.address")}</th><th class="right">${t("th.amount")}</th></tr></thead>
              <tbody id="claims"><tr class="empty-row"><td colspan="4"><span class="skeleton" style="width:160px"></span></td></tr></tbody>
            </table>
          </div>
        </div>
        ${token.custom ? notice(t("tok.packetWarn", { address: esc(token.address) }), true) : ""}
        ${notice(t("packet.grabHint"))}
      </div>
      <aside class="side">
        <div class="card packet-summary">
          <div class="t3">${t("packet.total")}</div>
          <div class="big">${esc(fmtNum(p.total, token))}<small>${esc(token.symbol)}</small></div>
          ${token.custom ? `<div class="kv-row token-row"><span class="tag tag-red">${t("tok.custom")}</span><span>${CFG.explorer ? extLink(`${CFG.explorer}/token/${token.address}`, esc(tokenAddress(token.address))) : `<span class="mono">${esc(tokenAddress(token.address))}</span>`}</span></div>` : ""}
          <div class="progress-row"><span>${t("packet.progress", { a: p.grabbed, b: p.shares })}</span><span>${pct}%</span></div>
          <div class="progress"><i style="width:${pct}%"></i></div>
          <div class="divider"></div>
          <div class="kv">
            <div class="kv-row"><span>${t("packet.remaining")}</span><span>${esc(fmt(p.remaining, token))}</span></div>
            ${p.forfeited > 0n ? `<div class="kv-row"><span>${t("packet.forfeited")}</span><span>${esc(fmt(p.forfeited, token))}</span></div>` : ""}
            ${p.lucky ? `<div class="kv-row"><span>${t("packet.floor")}</span><span>${esc(fmt(p.unit, token))}</span></div>` : ""}
            <div class="kv-row"><span>${t("packet.creator")}</span><span id="creator-name">${esc(short(p.creator))}</span></div>
            <div id="creator-profile"></div>
            <div class="kv-row"><span>${expired ? t("packet.expiredAt") : t("packet.expiry")}</span><span>${esc(when(p.expiry))}</span></div>
            <div class="kv-row"><span>${t("packet.contract")}</span><span>${CFG.explorer ? extLink(`${CFG.explorer}/address/${CFG.contract}`, short(CFG.contract)) : short(CFG.contract)}</span></div>
          </div>
          <div class="divider"></div>
          <div class="share-row" id="share-row">${shareButtons(id, mine?.share)}</div>
          ${mine?.share && mine.code ? `<p class="form-hint share-warn">${t("share.publicWarn")}</p>` : ""}
          ${canOpen || canRefund ? `<div class="actions">
            ${canOpen ? `<button id="open" class="btn-block">${I.spark}${t("packet.open", { n: p.grabbed - p.opened })}</button>` : ""}
            ${canRefund ? `<button id="refund" class="primary btn-block">${I.refund}${t("packet.refund", { amount: esc(fmt(back, token)) })}</button>` : ""}
          </div>` : ""}
        </div>
      </aside>
    </div>
  </div>`;

  handleOf(p.creator).then((h) => h && $("#creator-name") && ($("#creator-name").textContent = `${h}.ai`));
  bindShare(app);
  api(`/profiles/${p.creator}`)
    .then(({ profile }) => {
      if (!profile || !$("#creator-profile")) return;
      $("#creator-profile").innerHTML = profileBlock(profile);
      $("#share-row").innerHTML = shareButtons(id, mine?.share, profile.intro);
      bindShare($("#share-row"));
    })
    .catch(() => {});
  if (mine?.share) $("#copy-share").onclick = () => copy(mine.share);
  const act = (sel, fn) => {
    const b = $(sel);
    if (b) b.onclick = async () => {
      if (!requireWallet()) return;
      b.disabled = true;
      try {
        await fn();
        toast(t("tx.done"), "ok");
        pagePacket(id);
      } catch (e) {
        toast(reason(e), "error");
        b.disabled = false;
      }
    };
  };
  act("#open", () => send(hbRead, "open", [id, 20n]));
  act("#refund", () => send(hbRead, "refund", [id]));
  renderClaims(id, p, token).catch((e) => {
    if ($("#claims")) $("#claims").innerHTML = `<tr class="empty-row"><td colspan="4">${esc(t("packet.claimsFailed", { reason: reason(e) }))}</td></tr>`;
  });
}

async function renderClaims(id, p, token) {
  const list = $("#claims");
  const rows = [];
  const kind = Number(p.kind);
  let indexed = null;
  try {
    indexed = await api(`/packets/${id}`);
    // The index trails the chain by up to a minute; when it is behind, read the chain instead.
    if (indexed.claims.length < Number(p.grabbed)) indexed = null;
  } catch {
    indexed = null;
  }
  if (indexed) {
    for (const c of indexed.claims) {
      const pending = c.amount === null;
      const amount = pending ? t("packet.pending") : fmt(BigInt(c.amount), token) + (c.floored ? t("packet.floored") : "");
      rows.push({ who: c.who, amount, best: pending ? undefined : BigInt(c.amount), pending, handle: c.handle || "" });
    }
  } else if (kind === 0) {
    const logs = await scanLogs(hbLogs.filters.DirectClaimed(id), Number(CFG.deployBlock));
    for (const l of logs) rows.push({ who: l.args.who, amount: fmt(l.args.amount, token), best: l.args.amount });
  } else {
    const amounts = new Map();
    if (p.lucky && p.opened > 0n) {
      const [, firstBlock] = await hbRead.getSlot(id, 0);
      for (const l of await scanLogs(hbLogs.filters.Opened(id), Number(firstBlock))) {
        amounts.set(Number(l.args.slot), { amount: l.args.amount, floored: l.args.floored });
      }
    }
    // Equal packets pay at grab and keep no slot record: their claimers come from Grabbed events.
    const grabbers = new Map();
    if (!p.lucky) for (const l of await scanLogs(hbLogs.filters.Grabbed(id), Number(CFG.deployBlock))) grabbers.set(Number(l.args.slot), l.args.who);
    for (let i = 0; i < Number(p.grabbed); i++) {
      const who = p.lucky ? (await hbRead.getSlot(id, i))[0] : grabbers.get(i) ?? ZeroAddress;
      const o = amounts.get(i);
      const pending = p.lucky && i >= Number(p.opened);
      const amount = !p.lucky ? fmt(p.unit, token) : pending ? t("packet.pending") : o ? fmt(o.amount, token) + (o.floored ? t("packet.floored") : "") : t("packet.opened");
      rows.push({ who, amount, best: o?.amount, pending });
    }
  }
  if (!list.isConnected) return;
  if (!rows.length) {
    list.innerHTML = `<tr class="empty-row"><td colspan="4">${t("packet.none")}</td></tr>`;
    return;
  }
  const best = p.lucky || kind === 0 ? rows.reduce((m, r) => (r.best !== undefined && (m === null || r.best > m) ? r.best : m), null) : null;
  const names = await Promise.all(rows.map((r) => ("handle" in r ? r.handle : handleOf(r.who))));
  if (!list.isConnected) return;
  list.innerHTML = rows
    .map((r, i) => {
      const isBest = best !== null && r.best === best && rows.length > 1;
      return `<tr>
        <td class="t3">${i + 1}</td>
        <td><div class="cell-main"><span class="avatar">${esc((names[i] || "?").slice(0, 1).toUpperCase())}</span><b>${esc(names[i] ? `${names[i]}.ai` : "—")}</b>${isBest ? `<span class="best">${I.trophy}${t("packet.best")}</span>` : ""}</div></td>
        <td class="hide-sm t3 mono">${esc(short(r.who))}</td>
        <td class="right ${r.pending ? "t3" : ""}">${esc(r.amount)}</td>
      </tr>`;
    })
    .join("");
}

/** Public nodes cap log ranges, so search in chunks from a known starting block. */
async function scanLogs(filter, fromBlock, maxChunks = 40) {
  const head = Number(await logsReader.send("eth_blockNumber", [])); // uncached: the newest block matters
  const out = [];
  let a = Math.max(0, fromBlock);
  for (let i = 0; a <= head && i < maxChunks; i++, a += 5000) {
    const b = a + 4999 >= head ? "latest" : a + 4999;
    out.push(...(await hbLogs.queryFilter(filter, a, b)));
  }
  return out;
}

// ---------------------------------------------------------------- mine page

function pageMine() {
  const list = saved();
  app.innerHTML = `
  <div class="container page">
    <div class="page-title"><h1>${t("mine.title")}</h1></div>
    <div class="card table-card">
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>${t("th.packet")}</th><th>${t("th.memo")}</th><th class="hide-sm">${t("th.sentAt")}</th><th class="right">${t("th.action")}</th></tr></thead>
          <tbody>${
            list.length
              ? list
                  .map(
                    (e) => `<tr class="row-link" data-href="#/p/${esc(e.id)}">
                      <td><div class="cell-main"><b>#${esc(e.id)}</b><span class="tag">${t(`kind.${TYPES.indexOf(e.type)}`)}</span></div></td>
                      <td>${esc(e.memo || "—")}</td>
                      <td class="hide-sm t3">${esc(new Date(e.createdAt).toLocaleString(locale(), { hour12: false }))}</td>
                      <td class="right"><a href="#/p/${esc(e.id)}">${t("view")}</a></td>
                    </tr>`
                  )
                  .join("")
              : `<tr class="empty-row"><td colspan="4"><div class="empty">${I.box}<p>${t("mine.empty")}</p><a class="btn btn-primary" href="#/create">${I.packet}${t("nav.create")}</a></div></td></tr>`
          }</tbody>
        </table>
      </div>
    </div>
    <p class="t3 mine-note">${t("mine.note")}</p>
    <form id="goto" class="goto"><input name="id" inputmode="numeric" placeholder="${t("mine.ph")}" aria-label="${t("mine.ph")}" /><button class="primary">${I.search}${t("view")}</button></form>
  </div>`;
  for (const tr of $$("tr[data-href]")) tr.onclick = () => (location.hash = tr.dataset.href);
  $("#goto").onsubmit = (e) => {
    e.preventDefault();
    const v = new FormData(e.target).get("id");
    if (/^\d+$/.test(v)) location.hash = `#/p/${v}`;
  };
}

// --------------------------------------------------------------------- boot

if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = "light";
{
  // Shared links look like /p/12?lang=zh: adopt the language, then continue on the hash route.
  const qs = new URLSearchParams(location.search);
  const wanted = qs.get("lang");
  if (wanted === "zh" || wanted === "en") {
    lang = wanted;
    try { localStorage.setItem("ahb:lang", wanted); } catch {}
    document.documentElement.lang = wanted === "zh" ? "zh-CN" : "en";
  }
  const shared = location.pathname.match(/^\/p\/(\d+)\/?$/);
  if (shared || wanted) history.replaceState(null, "", `/${shared ? `#/p/${shared[1]}` : location.hash}`);
}
$("#lang-toggle").onclick = () => setLang(lang === "zh" ? "en" : "zh");
$("#theme-toggle").onclick = () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
applyChrome();
window.addEventListener("hashchange", () => route());
renderWallet();
route();
