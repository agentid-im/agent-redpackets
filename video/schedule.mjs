// When each narration part is spoken, and how long each scene must be. Parts start at their planned
// time, or right after the previous part when that one is still speaking; a scene lasts until its last
// part ends plus a breath (and at least as long as planned). Lengths come from video/voice/manifest.json
// (written by voice.mjs); without it, a part's length is estimated from its text.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GAP = 0.3;
export const TAIL = 0.6;

export function loadPlan() {
  return JSON.parse(fs.readFileSync(path.join(here, "narration.json"), "utf8"));
}

function lengths() {
  const f = path.join(here, "voice", "manifest.json");
  if (!fs.existsSync(f)) return {};
  return Object.fromEntries(JSON.parse(fs.readFileSync(f, "utf8")).filter((m) => m.len).map((m) => [`${m.n}-${m.k}`, m.len]));
}

export function schedule(plan = loadPlan()) {
  const len = lengths();
  return plan.segments.map((seg) => {
    let prevEnd = 0;
    const parts = seg.parts.map((p, i) => {
      const known = len[`${seg.n}-${i + 1}`];
      const length = known ?? Math.max(1, p.text.replace(/\[[^\]]*\]/g, "").length * 0.075);
      const start = Math.max(p.at, prevEnd + (i ? GAP : 0));
      prevEnd = start + length;
      return { k: i + 1, start, end: prevEnd, length, en: p.en, zh: p.zh, spoken: Boolean(known) };
    });
    const seconds = Math.max(seg.scene, Math.ceil((prevEnd + TAIL) * 10) / 10);
    return { n: seg.n, planned: seg.scene, seconds, parts };
  });
}
