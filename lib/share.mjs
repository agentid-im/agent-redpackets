// The text a creator posts in a group chat, and the parser a holder's agent runs on it.
//   🧧 恭喜发财 · AgentHongbao #12 · 码 K7Q2-9FMX-3HTB-W0RD · 口令 恭喜发财
//   🧧 Happy New Year · AgentHongbao #12 · code K7Q2-9FMX-3HTB-W0RD · passphrase 恭喜发财
import { CODE_PATTERN, normalizeCode, normalizePassphrase } from "./claim.mjs";

const LABELS = {
  zh: { packet: "红包", code: "码", pass: "口令" },
  en: { packet: "Red packet", code: "code", pass: "passphrase" },
};

export function formatShare({ id, code, passphrase, memo, includePassphrase = true, lang = "zh" }) {
  const L = LABELS[lang] ?? LABELS.zh;
  const parts = [`🧧 ${memo || L.packet}`, `AgentHongbao #${id}`];
  if (code) parts.push(`${L.code} ${normalizeCode(code).match(/.{4}/g).join("-")}`);
  const p = normalizePassphrase(passphrase);
  if (p && includePassphrase) parts.push(`${L.pass} ${p}`);
  return parts.join(" · ");
}

/**
 * Finds the packet id, share code and passphrase in pasted text, with Chinese or English labels.
 * An explicit passphrase (what the user says) wins over one found in the text.
 */
export function parseShare(text, passphrase) {
  const s = String(text ?? "");
  const id = s.match(/AgentHongbao\s*#\s*(\d+)/i)?.[1] ?? s.match(/#\s*(\d+)/)?.[1] ?? s.match(/^\s*(\d+)\s*$/)?.[1];
  // Code and passphrase are read from the share line itself (the one naming AgentHongbao #id), so
  // a sender's note such as "口令在我的 X 上" or a heading such as "口令是：" is never taken for them.
  const line = s.split(/\r?\n/).find((l) => /AgentHongbao\s*#\s*\d+/i.test(l));
  const code = (line ?? s).match(CODE_PATTERN)?.[1] ?? null;
  let inText;
  if (line) {
    for (const part of line.split(/[·|]/)) {
      const m = part.match(/^\s*(?:口令|passphrase)\s*[:：]?\s*(.+?)\s*$/i);
      if (m) {
        inText = m[1];
        break;
      }
    }
  } else {
    inText = s.match(/(?:口令|\bpassphrase\b)\s*[:：]?\s*([^·|\n]+)/i)?.[1];
  }
  const p = normalizePassphrase(passphrase ?? inText ?? "");
  return { id: id === undefined ? null : BigInt(id), code: code && normalizeCode(code), passphrase: p };
}

const GUIDE = {
  zh: (skillUrl, url) => [
    "👉 第一次抢？只有 Agent ID（name.ai）持有者能领：",
    "1. Binance App → 钱包 → 领取 Agent ID",
    "2. Agentic Wallet → 设置 → 打开开发者模式",
    "3. 把这整段发给你的 AI Agent，说“帮我抢这个红包”",
    `Agent 还没装红包 skill 的话：npx skills add ${skillUrl}`,
    `详情和教程：${url}`,
  ],
  en: (skillUrl, url) => [
    "👉 First time? Only Agent ID (name.ai) holders can claim:",
    "1. Binance App → Wallet → claim your Agent ID",
    "2. Agentic Wallet → Settings → turn on Developer Mode",
    "3. Send this whole message to your AI agent: “grab this red packet for me”",
    `If your agent lacks the red packet skill: npx skills add ${skillUrl}`,
    `Details and guide: ${url}`,
  ],
};

/**
 * The message to post in a group: a heading and the share line (or a lead line for packets without one), the
 * sender's note, and a short guide for first-timers. Agents parse it with parseShare: the guide
 * deliberately contains no packet number, code or passphrase label.
 */
export function inviteText({ share, head, intro, lead, url, skillUrl, lang = "zh" }) {
  const lines = share ? [head, share].filter(Boolean) : [lead];
  if (intro) lines.push(`💬 ${intro}`);
  lines.push("", ...(GUIDE[lang] ?? GUIDE.zh)(skillUrl, url));
  return lines.join("\n");
}
