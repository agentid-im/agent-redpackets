// Packet links use a random-looking code instead of the sequential packet id, so the site cannot be
// walked packet by packet and every packet gets a URL no link-preview cache has seen before.
//
// The code comes from the hash of the transaction that created the packet, so the Worker (which
// indexes that transaction) and the sender's browser (which sent it) derive the same code with no
// server round trip, and nobody can guess it without that transaction.
import { AbiCoder, keccak256 } from "ethers";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; // base58
export const SLUG_LENGTH = 10; // about 58 bits
export const SLUG_RE = new RegExp(`^[${ALPHABET}]{${SLUG_LENGTH}}$`);

/** The link code of packet `id`, created in transaction `txHash`. */
export function packetSlug(txHash, id) {
  let n = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [txHash, BigInt(id)])));
  let out = "";
  for (let i = 0; i < SLUG_LENGTH; i++) {
    out += ALPHABET[Number(n % 58n)];
    n /= 58n;
  }
  return out;
}

/** A link code from a pasted link (…/r/<code>…) or a bare code; null if there is none. */
export function slugFrom(text) {
  const s = String(text ?? "").trim();
  if (SLUG_RE.test(s)) return s;
  const m = s.match(new RegExp(`/r/([${ALPHABET}]{${SLUG_LENGTH}})(?![${ALPHABET}])`));
  return m ? m[1] : null;
}
