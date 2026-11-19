// A red packet sender's public profile: X account, Telegram group or channel, and a one-line intro.
// Saved by the Worker only with a signature from the sender's wallet; links are always built here
// from handles, never taken as free URLs, so a profile cannot point at an arbitrary site.

export const INTRO_MAX = 80;
// Control characters and the Unicode line/paragraph separators, written as escapes on purpose.
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]", "g");

export class ProfileError extends Error {
  constructor(field) {
    super(`invalid ${field}`);
    this.field = field;
  }
}

export function normalizeProfile({ x, telegram, intro } = {}) {
  const xh = String(x ?? "")
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?(x|twitter)\.com\//i, "")
    .replace(/^@/, "")
    .replace(/[/?#].*$/, "");
  if (xh && !/^[A-Za-z0-9_]{1,15}$/.test(xh)) throw new ProfileError("x");

  const tg = String(telegram ?? "")
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?(t|telegram)\.me\//i, "")
    .replace(/^@/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  if (tg && !/^(\+[A-Za-z0-9_-]{6,40}|[A-Za-z][A-Za-z0-9_]{3,31})$/.test(tg)) throw new ProfileError("telegram");

  const text = [...String(intro ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim()];
  if (text.length > INTRO_MAX) throw new ProfileError("intro");
  return { x: xh, telegram: tg, intro: text.join("") };
}

export const isEmptyProfile = (p) => !p || (!p.x && !p.telegram && !p.intro);

/** The exact text the sender signs (EIP-191 personal message). */
export function profileMessage(address, profile, issued) {
  return [
    "AgentHongbao sender profile",
    `address: ${String(address).toLowerCase()}`,
    `x: ${profile.x}`,
    `telegram: ${profile.telegram}`,
    `intro: ${profile.intro}`,
    `issued: ${issued}`,
  ].join("\n");
}

export const xUrl = (handle) => `https://x.com/${handle}`;
export const tgUrl = (handle) => `https://t.me/${handle}`;
