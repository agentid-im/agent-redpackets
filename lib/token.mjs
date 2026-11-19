// Token helpers shared by the Worker, the site and the skill.
//
// Any BSC token can fund a packet, so a token's symbol and name are untrusted text written by
// whoever deployed it. They are cleaned here before being stored or shown, and an unlisted token
// is always shown with its address so a fake "USDT" cannot pass for the real one.
import { AbiCoder, getAddress, getBytes, toUtf8String } from "ethers";

export const NATIVE = "0x0000000000000000000000000000000000000000";
export const SYMBOL_MAX = 12;
export const NAME_MAX = 32;

// Only letters, digits, punctuation, symbols and plain spaces are kept: this drops control and
// format characters (bidi, zero-width, Unicode tags), combining marks and variation selectors.
// Hangul fillers are letters that render as nothing, so they go too.
const NOT_VISIBLE = /[^\p{L}\p{N}\p{P}\p{S} ]|[\u115f\u1160\u3164\uffa0]/gu;

/** Untrusted token text made safe to show: visible characters only, one line, at most `max`. */
export function cleanText(s, max) {
  const one = String(s ?? "").normalize("NFKC").replace(/\s+/g, " ").replace(NOT_VISIBLE, "").replace(/ +/g, " ").trim();
  return Array.from(one).slice(0, max).join("");
}

// Look-alike letters (Cyrillic, Greek) folded to Latin before comparing symbols.
const FOLD = { А: "A", В: "B", С: "C", Е: "E", Н: "H", К: "K", М: "M", О: "O", Р: "P", Т: "T", Х: "X", У: "Y", Ѕ: "S", І: "I", Ј: "J", Α: "A", Β: "B", Ε: "E", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Χ: "X", Υ: "Y", Ζ: "Z" };
const RESERVED = new Set(["BNB", "USDT", "USDC", "BUSD", "BSCUSD", "FDUSD"]);

/**
 * The symbol to show for a token. An unlisted token whose symbol looks like BNB, USDT, USDC or
 * another well-known stablecoin is shown as "UNKNOWN": it can only be an imitation.
 */
export function displaySymbol(symbol, listed) {
  const s = cleanText(symbol, SYMBOL_MAX);
  if (listed) return s;
  const folded = Array.from(s.toUpperCase()).map((c) => FOLD[c] ?? c).join("").replace(/[^A-Z0-9]/g, "");
  return !s || RESERVED.has(folded) ? "UNKNOWN" : s;
}

/** Decodes the return data of `symbol()` / `name()`: an ABI string, or a bytes32 (old tokens). */
export function decodeText(ret) {
  if (typeof ret !== "string" || !ret.startsWith("0x") || ret.length < 66) return "";
  try {
    if (ret.length === 66) {
      const bytes = getBytes(ret);
      let end = bytes.length;
      while (end > 0 && bytes[end - 1] === 0) end--;
      return toUtf8String(bytes.subarray(0, end));
    }
    return AbiCoder.defaultAbiCoder().decode(["string"], ret)[0];
  } catch {
    return "";
  }
}

/** Decodes `decimals()`; null when missing or not a sensible number. */
export function decodeDecimals(ret) {
  try {
    const n = Number(AbiCoder.defaultAbiCoder().decode(["uint256"], ret)[0]);
    return Number.isInteger(n) && n >= 0 && n <= 36 ? n : null;
  } catch {
    return null;
  }
}

export const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** A token address shortened only so far that no vanity address can imitate it cheaply. */
export const tokenAddress = (a) => `${a.slice(0, 10)}…${a.slice(-8)}`;

/**
 * Looks up an ERC-20's metadata through `call(to, data) -> hex`, whatever transport the caller
 * uses (fetch JSON-RPC, an ethers provider). Missing pieces come back empty / null.
 */
export async function fetchTokenMeta(call, address) {
  const to = getAddress(address);
  const tryCall = async (data) => {
    try {
      return await call(to, data);
    } catch {
      return null;
    }
  };
  const [sym, name, dec] = await Promise.all([
    tryCall("0x95d89b41"), // symbol()
    tryCall("0x06fdde03"), // name()
    tryCall("0x313ce567"), // decimals()
  ]);
  return {
    address: to,
    symbol: cleanText(decodeText(sym), SYMBOL_MAX),
    name: cleanText(decodeText(name), NAME_MAX),
    decimals: decodeDecimals(dec),
  };
}
