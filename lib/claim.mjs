// Off-chain half of code packets: the share code, the claim key derived from it, and the
// signature a holder presents to `grab`. Runs in Node and in browsers; no network access.
import { AbiCoder, Wallet, getBytes, keccak256, toUtf8Bytes } from "ethers";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U
const CODE_LENGTH = 16; // 16 * 5 = 80 bits
export const CODE_PATTERN = /\b([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\b/i;

/** A fresh random share code, e.g. "K7Q2-9FMX-3HTB-W0RD". */
export function newCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 31];
  return out.match(/.{4}/g).join("-");
}

export function normalizeCode(code) {
  const c = String(code).toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (c.length !== CODE_LENGTH || [...c].some((ch) => !ALPHABET.includes(ch))) {
    throw new Error("share code must be 16 characters of 0-9 A-Z (without I, L, O, U)");
  }
  return c;
}

export function normalizePassphrase(passphrase) {
  return String(passphrase ?? "").normalize("NFKC").trim();
}

/**
 * The claim key. The share code carries the security (80 random bits); the passphrase is the
 * greeting people type and may be as common as they like. A packet made with a passphrase only
 * (code = null) is guessable by anyone and must be created as a public packet.
 */
export function claimKey(code, passphrase = "") {
  const c = code ? normalizeCode(code) : "";
  const p = normalizePassphrase(passphrase);
  if (!c && !p) throw new Error("need a share code or a passphrase");
  return new Wallet(keccak256(toUtf8Bytes(`AgentHongbao claim key v1\n${c}\n${p}`)));
}

/** Must equal AgentHongbao.claimDigest(id, who). */
export function claimDigest(chainId, contract, id, who) {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256", "address", "uint256", "address"],
      ["AgentHongbao.grab", chainId, contract, id, who]
    )
  );
}

/** Signature that lets `who`, and only `who`, grab packet `id`. */
export function signGrab(key, chainId, contract, id, who) {
  return key.signMessage(getBytes(claimDigest(chainId, contract, id, who)));
}

export function normalizeHandle(handle) {
  const h = String(handle).trim().toLowerCase().replace(/\.ai$/, "");
  if (!/^[a-z0-9]{1,64}$/.test(h)) throw new Error(`not a valid Agent ID: ${handle}`);
  return h;
}

export const handleHash = (handle) => keccak256(toUtf8Bytes(normalizeHandle(handle)));
