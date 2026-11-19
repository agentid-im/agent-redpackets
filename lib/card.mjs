// The link-preview card of one red packet (1200x630), as SVG. The Worker renders it to PNG with
// resvg and the subset Noto Sans SC fonts in web/public/fonts; every text drawn here must use
// characters those fonts cover (lib/card-chars.mjs), so untrusted text is filtered first.
import { CARD_CHARS } from "./card-chars.mjs";

const COVERED = new Set(Array.from(CARD_CHARS));
const FONT = "Noto Sans SC";

const T = {
  zh: {
    brand: "Agent ID 红包",
    sub: "BNB Chain 链上红包",
    kind: ["定向红包", "口令红包", "公开红包"],
    split: (p) => `${p.kind === 0 ? "固定金额" : p.lucky ? "拼手气" : "均分"} · ${p.shares} 份`,
    custom: "自定义代币",
    only: "只有 name.ai 持有者能领",
    memo: "恭喜发财",
  },
  en: {
    brand: "Agent ID Red Packets",
    sub: "On-chain on BNB Chain",
    kind: ["Direct packet", "Code packet", "Public packet"],
    split: (p) => `${p.kind === 0 ? "Fixed amounts" : p.lucky ? "Lucky split" : "Equal split"} · ${p.shares} ${p.shares === 1 ? "share" : "shares"}`,
    custom: "Custom token",
    only: "Only name.ai holders can claim",
    memo: "Wishing you prosperity",
  },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Rough advance width of `text` in ems, for fitting lines (CJK 1, digits and Latin about 0.6). */
function ems(text) {
  let w = 0;
  for (const c of text) {
    if (/[⺀-鿿＀-￯]/.test(c)) w += 1;
    else if (/[.,:;'!|il1·]/.test(c)) w += 0.3;
    else if (c === " ") w += 0.28;
    else if (/[A-Z0-9#$%&@MW]/.test(c)) w += 0.66;
    else w += 0.56;
  }
  return w;
}

/**
 * Drawable form of untrusted text: symbols the fonts lack (emoji and the like) are dropped; if a
 * letter or digit is missing the text would read wrong, so null is returned instead.
 */
function drawable(text) {
  let out = "";
  for (const c of String(text ?? "").replace(/\s+/g, " ")) {
    if (COVERED.has(c)) out += c;
    else if (/[\p{L}\p{N}]/u.test(c)) return null;
  }
  out = out.replace(/ +/g, " ").trim();
  return out || null;
}

/** Cuts `text` to at most `maxEms` wide, adding an ellipsis. */
function fit(text, maxEms) {
  if (ems(text) <= maxEms) return text;
  let out = "";
  for (const c of text) {
    if (ems(out + c + "…") > maxEms) break;
    out += c;
  }
  return `${out}…`;
}

/**
 * @param {object} p  { id, kind (0 direct, 1 code, 2 public), lucky, shares, amount (formatted),
 *                     symbol (display-safe), custom (bool), tokenAddress (short form), memo }
 * @param {"zh"|"en"} lang
 */
export function cardSvg(p, lang = "zh") {
  const L = T[lang] ?? T.zh;
  const symbol = drawable(p.symbol) || "?";
  const memo = drawable(p.memo) || L.memo;
  const amount = String(p.amount);
  // Amount line: shrink until amount + symbol fit in 600px.
  let big = 104;
  while (big > 56 && ems(amount) * big + 18 + ems(symbol) * big * 0.46 > 600) big -= 4;
  const small = Math.round(big * 0.46);
  const memoLine = fit(memo, 600 / 34);
  const seal = ems(memo) <= 6 ? memo : lang === "zh" ? "恭喜发财" : "";
  const kind = L.kind[p.kind] ?? L.kind[1];
  const kindW = Math.round(ems(kind) * 22 + 28);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="d" x1="0.15" y1="0" x2="0.85" y2="1"><stop offset="0" stop-color="#FFE45C"/><stop offset="0.55" stop-color="#F8C50F"/><stop offset="1" stop-color="#F59E0B"/></linearGradient>
    <linearGradient id="r" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="#FF6B7E"/><stop offset="1" stop-color="#E02443"/></linearGradient>
    <linearGradient id="env" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#F0475E"/><stop offset="1" stop-color="#C81E3A"/></linearGradient>
    <radialGradient id="g" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#E02443" stop-opacity="0.32"/><stop offset="1" stop-color="#E02443" stop-opacity="0"/></radialGradient>
    <radialGradient id="gold" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="#FFF3B0"/><stop offset="1" stop-color="#F0B90B"/></radialGradient>
  </defs>
  <rect width="1200" height="630" fill="#17181D"/>
  <circle cx="955" cy="315" r="330" fill="url(#g)"/>

  <g transform="translate(78 58) scale(1.45)">
    <rect x="13" y="13" width="38" height="38" rx="11" transform="rotate(45 32 32)" fill="url(#d)"/>
    <rect x="24.6" y="25.5" width="3" height="6.5" rx="1.5" fill="#202630"/>
    <rect x="36.4" y="25.5" width="3" height="6.5" rx="1.5" fill="#202630"/>
    <path d="M25.5 36.5 Q32 41.5 38.5 36.5" fill="none" stroke="#202630" stroke-width="2.6" stroke-linecap="round"/>
    <rect x="41" y="38" width="17" height="23" rx="3.2" fill="url(#r)"/>
    <path d="M41 41.2 Q41 38 44.2 38 H54.8 Q58 38 58 41.2 V45 Q49.5 51 41 45 Z" fill="#B8243A"/>
    <circle cx="49.5" cy="46.6" r="3.4" fill="url(#gold)" stroke="#B8243A" stroke-width="0.8"/>
  </g>
  <text x="190" y="104" font-family="${FONT}" font-weight="700" font-size="38" fill="#EAECEF">${esc(L.brand)}</text>
  <text x="190" y="142" font-family="${FONT}" font-weight="500" font-size="22" fill="#848E9C">${esc(L.sub)}</text>

  <rect x="80" y="196" width="${kindW}" height="40" rx="8" fill="#F0B90B" fill-opacity="0.14"/>
  <text x="${80 + kindW / 2}" y="224" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="22" fill="#F0B90B">${esc(kind)}</text>
  <text x="${100 + kindW}" y="224" font-family="${FONT}" font-weight="500" font-size="22" fill="#848E9C">AgentHongbao #${esc(p.id)}</text>

  <text x="80" y="${236 + big}" font-family="${FONT}" font-weight="700" fill="#FFFFFF"><tspan font-size="${big}">${esc(amount)}</tspan><tspan font-size="${small}" fill="#EAECEF" dx="18">${esc(symbol)}</tspan></text>
  <text x="80" y="${296 + big}" font-family="${FONT}" font-weight="500" font-size="30" fill="#B7BDC6">${esc(L.split(p))}</text>
  <text x="80" y="${356 + big}" font-family="${FONT}" font-weight="700" font-size="34" fill="#F0B90B">${esc(memoLine)}</text>
  ${p.custom ? `<text x="80" y="${402 + big}" font-family="${FONT}" font-weight="500" font-size="22" fill="#F6465D">${esc(L.custom)} ${esc(p.tokenAddress ?? "")}</text>` : ""}

  <rect x="80" y="538" width="262" height="52" rx="12" fill="#FCD535"/>
  <text x="211" y="573" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="24" fill="#181A20">www.agentid.im</text>
  <text x="364" y="573" font-family="${FONT}" font-weight="500" font-size="22" fill="#848E9C">${esc(L.only)}</text>

  <g transform="translate(958 318) rotate(8)">
    <rect x="-150" y="-208" width="300" height="416" rx="30" fill="url(#env)"/>
    <path d="M-150 -178 Q-150 -208 -120 -208 H120 Q150 -208 150 -178 V-70 Q0 30 -150 -70 Z" fill="#B8243A"/>
    <circle cx="0" cy="-34" r="56" fill="url(#gold)" stroke="#B8243A" stroke-width="3"/>
    <text x="0" y="-14" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="56" fill="#8A1C12">福</text>
    ${seal ? `<text x="0" y="150" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="30" letter-spacing="6" fill="#FFD86B">${esc(seal)}</text>` : ""}
  </g>
</svg>`;
}
