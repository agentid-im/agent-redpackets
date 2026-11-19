// Renders a packet's link-preview card (lib/card.mjs) to PNG with resvg. The fonts are static
// assets (web/public/fonts), loaded once per isolate.
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import { cardSvg } from "../lib/card.mjs";

let ready = null;
let fonts = null;

async function setup(env, origin) {
  ready ??= initWasm(wasm);
  fonts ??= Promise.all(
    ["card-bold.otf", "card-medium.otf"].map(async (f) => {
      const res = await env.ASSETS.fetch(new Request(`${origin}/fonts/${f}`));
      if (!res.ok) throw new Error(`font ${f}: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    })
  ).catch((e) => {
    fonts = null; // try again on the next request
    throw e;
  });
  await ready;
  return fonts;
}

export async function renderCard(env, origin, packet, lang) {
  const fontBuffers = await setup(env, origin);
  const resvg = new Resvg(cardSvg(packet, lang), {
    fitTo: { mode: "width", value: 1200 },
    font: { fontBuffers, defaultFontFamily: "Noto Sans SC", loadSystemFonts: false },
  });
  const png = resvg.render().asPng();
  resvg.free();
  return png;
}
