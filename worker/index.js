// Cloudflare Worker for www.agentid.im: serves the static site, a small read API backed by D1, and
// a cron that indexes AgentHongbao's events into D1 so visitors never scan the chain themselves.
//
// It also opens pending lucky slots ("keeper"), so a grabber needs only one transaction even when no
// later grab opens theirs. `open` is permissionless and cannot change any amount; the keeper wallet
// only pays gas and should hold nothing but a little BNB.
//
// Bindings (wrangler.jsonc): ASSETS (static site), DB (D1). Vars: CONTRACT, REGISTRY, DEPLOY_BLOCK,
// FALLBACK_RPC, KEEPER_MAX_GWEI. Secrets: RPC_URL (a node that serves eth_getLogs; may carry an API
// key), KEEPER_KEY (keeper wallet; the keeper is off without it).
import { Contract, Interface, JsonRpcProvider, NonceManager, Wallet, formatEther, formatUnits, getAddress, parseEther, parseUnits, verifyMessage } from "ethers";
import abi from "../lib/AgentHongbao.abi.json";
import { isEmptyProfile, normalizeProfile, profileMessage } from "../lib/profile.mjs";
import { NATIVE, displaySymbol, fetchTokenMeta, tokenAddress } from "../lib/token.mjs";
import { SLUG_RE, packetSlug } from "../lib/link.mjs";
import { renderCard } from "./card.js";

const hb = new Interface(abi);
const registry = new Interface(["function handleOf(address) view returns (string)"]);
const BATCH_BLOCKS = 5000; // log range per request
const MAX_BATCHES = 8; // per cron run; catches up 40k blocks (about 5 hours) a minute
const CONFIRMATIONS = 3;
const hex = (n) => `0x${n.toString(16)}`;

// ---------------------------------------------------------------------- rpc

async function rpc(env, method, params) {
  let last;
  for (const url of [env.RPC_URL, env.FALLBACK_RPC].filter(Boolean)) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = await res.json();
      if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
      return body.result;
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error("no RPC configured");
}

async function handleOf(env, who, cache) {
  if (!cache.has(who)) {
    try {
      const data = registry.encodeFunctionData("handleOf", [who]);
      const out = await rpc(env, "eth_call", [{ to: env.REGISTRY, data }, "latest"]);
      cache.set(who, registry.decodeFunctionResult("handleOf", out)[0] || null);
    } catch {
      return null; // not cached: filled in by a later run (fillMissing)
    }
  }
  return cache.get(who);
}

// ------------------------------------------------------------------- tokens

const NATIVE_META = { address: NATIVE, symbol: "BNB", name: "BNB", decimals: 18, listed: 1 };

const TOKEN_RETRY = 6 * 60 * 60; // seconds before a token with missing metadata is looked up again

/**
 * Metadata of a token that funds a packet, from D1, else looked up on chain and stored. Only
 * called for packet tokens, which the contract already accepted. The listed flag must come from
 * the contract; if that call fails nothing is stored, so a listed token is never cached as custom.
 * A token whose symbol or decimals did not come back is looked up again after TOKEN_RETRY.
 */
async function tokenMeta(env, address) {
  const key = String(address).toLowerCase();
  if (key === NATIVE) return NATIVE_META;
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare("SELECT * FROM tokens WHERE address = ?").bind(key).first();
  if (row && (row.listed || (row.decimals != null && row.symbol) || now - row.checked < TOKEN_RETRY)) return row;
  const call = (to, data) => rpc(env, "eth_call", [{ to, data }, "latest"]);
  const listed = hb.decodeFunctionResult("tokenListed", await call(env.CONTRACT, hb.encodeFunctionData("tokenListed", [key])))[0] ? 1 : 0;
  const meta = await fetchTokenMeta(call, key);
  const out = { address: key, symbol: meta.symbol, name: meta.name, decimals: meta.decimals, listed, checked: now };
  if (listed && meta.decimals == null) return out; // a listed token always has decimals: an RPC hiccup
  await env.DB.prepare("INSERT OR REPLACE INTO tokens (address, symbol, name, decimals, listed, checked) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(out.address, out.symbol, out.name, out.decimals, out.listed, out.checked)
    .run();
  return out;
}

/** Retries what an earlier run could not look up: claimers' names and packet tokens. */
async function fillMissing(env) {
  const db = env.DB;
  const { results: claims } = await db.prepare("SELECT DISTINCT who FROM claims WHERE handle IS NULL LIMIT 10").all();
  const cache = new Map();
  for (const { who } of claims) {
    const h = await handleOf(env, who, cache);
    if (h) await db.prepare("UPDATE claims SET handle = ? WHERE who = ? AND handle IS NULL").bind(h, who).run();
  }
  const { results: tokens } = await db
    .prepare(`SELECT DISTINCT p.token FROM packets p LEFT JOIN tokens t ON t.address = lower(p.token) WHERE lower(p.token) != '${NATIVE}' AND t.address IS NULL LIMIT 5`)
    .all();
  for (const { token } of tokens) await tokenMeta(env, token).catch(() => null);
}

// ------------------------------------------------------------------ indexer

export async function indexOnce(env) {
  const db = env.DB;
  const head = parseInt(await rpc(env, "eth_blockNumber", []), 16) - CONFIRMATIONS;
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'cursor'").first();
  let cursor = row ? Number(row.value) : Number(env.DEPLOY_BLOCK) - 1;
  const handles = new Map();
  let batches = 0;
  let events = 0;

  while (cursor < head && batches < MAX_BATCHES) {
    const from = cursor + 1;
    const to = Math.min(head, cursor + BATCH_BLOCKS);
    const logs = await rpc(env, "eth_getLogs", [{ address: env.CONTRACT, fromBlock: hex(from), toBlock: hex(to) }]);
    const stmts = [];
    for (const log of logs) {
      let ev;
      try {
        ev = hb.parseLog({ topics: log.topics, data: log.data });
      } catch {
        continue;
      }
      if (!ev) continue;
      const block = parseInt(log.blockNumber, 16);
      const a = ev.args;
      events++;
      switch (ev.name) {
        case "PacketCreated":
          try {
            await tokenMeta(env, a.token);
          } catch {
            /* looked up again by the API */
          }
          stmts.push(
            db
              .prepare(
                "INSERT OR REPLACE INTO packets (id, creator, kind, token, total, shares, expiry, lucky, heat_step, memo, block, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
              )
              .bind(Number(a.id), a.creator, Number(a.kind), a.token, a.total.toString(), Number(a.shares), Number(a.expiry), a.lucky ? 1 : 0, Number(a.heatStep), a.memo, block, packetSlug(log.transactionHash, a.id))
          );
          break;
        case "Grabbed":
          stmts.push(
            db
              .prepare("INSERT OR IGNORE INTO claims (packet_id, who, slot, handle, block) VALUES (?, ?, ?, ?, ?)")
              .bind(Number(a.id), a.who, Number(a.slot), await handleOf(env, a.who, handles), block)
          );
          break;
        case "Opened":
          stmts.push(
            db.prepare("UPDATE claims SET amount = ?, floored = ? WHERE packet_id = ? AND who = ?").bind(a.amount.toString(), a.floored ? 1 : 0, Number(a.id), a.who)
          );
          break;
        case "DirectClaimed":
          stmts.push(
            db
              .prepare("INSERT OR IGNORE INTO claims (packet_id, who, slot, handle, amount, floored, block) VALUES (?, ?, NULL, ?, ?, 0, ?)")
              .bind(Number(a.id), a.who, await handleOf(env, a.who, handles), a.amount.toString(), block)
          );
          break;
        case "Refunded":
          stmts.push(db.prepare("UPDATE packets SET refunded = ? WHERE id = ?").bind(a.amount.toString(), Number(a.id)));
          break;
        default:
          events--;
      }
    }
    stmts.push(db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('cursor', ?)").bind(String(to)));
    await db.batch(stmts); // in order, all or nothing: the cursor only moves with the rows
    cursor = to;
    batches++;
  }
  return { cursor, head, batches, events };
}

// ------------------------------------------------------------------- keeper

const KEEPER_MIN_BALANCE = parseEther("0.0003");
const OPEN_MAX = 20n;
// open() stops by itself when fewer than OPEN_GAS (170k) are left, so any gas limit is safe: the
// keeper sizes it from the openable slots, capped, and pays only for the gas actually used.
const OPEN_GAS_BASE = 100_000n;
const OPEN_GAS_PER_SLOT = 180_000n;
const OPEN_GAS_CAP = 2_000_000n;
const OPEN_PER_RUN = 5;

export async function openPending(env) {
  if (!env.KEEPER_KEY) return { keeper: "off" };
  const { results } = await env.DB.prepare(
    // Only packets in listed tokens: a custom token can burn gas on every payout, which would let
    // anyone drain the keeper. Their grabbers (or the next grab) open those slots.
    `SELECT DISTINCT c.packet_id AS id FROM claims c JOIN packets p ON p.id = c.packet_id LEFT JOIN tokens t ON t.address = lower(p.token) WHERE p.lucky = 1 AND c.amount IS NULL AND (lower(p.token) = '${NATIVE}' OR t.listed = 1) ORDER BY c.packet_id LIMIT ?`
  )
    .bind(OPEN_PER_RUN)
    .all();
  if (!results.length) return { keeper: "idle" };

  const provider = new JsonRpcProvider(env.RPC_URL || env.FALLBACK_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const wallet = new Wallet(env.KEEPER_KEY, provider);
  // Several opens per run: count nonces locally, since the provider briefly caches the lookup.
  const contract = new Contract(env.CONTRACT, abi, new NonceManager(wallet));
  const balance = await provider.getBalance(wallet.address);
  if (balance < KEEPER_MIN_BALANCE) return { keeper: "low balance", address: wallet.address, balance: formatEther(balance) };
  const cap = parseUnits(env.KEEPER_MAX_GWEI || "1", "gwei");
  const gasPrice = (await provider.getFeeData()).gasPrice ?? cap;
  if (gasPrice > cap) return { keeper: "gas above cap", gwei: Number(gasPrice) / 1e9 };

  const opened = [];
  for (const { id } of results) {
    try {
      const n = await contract.openable(id);
      if (n === 0n) continue; // already opened, or its block is not finished
      const max = OPEN_MAX;
      const slots = n < max ? n : max;
      const want = OPEN_GAS_BASE + slots * OPEN_GAS_PER_SLOT;
      const gasLimit = want < OPEN_GAS_CAP ? want : OPEN_GAS_CAP;
      await contract.open.staticCall(id, max, { gasLimit }); // only to catch a revert before paying
      const tx = await contract.open(id, max, { gasPrice, gasLimit });
      const receipt = await tx.wait(1, 30_000);
      opened.push({ id, tx: tx.hash, gas: Number(receipt.gasUsed) });
    } catch (e) {
      opened.push({ id, error: e?.shortMessage || e?.message || String(e) });
    }
  }
  return { keeper: "ran", opened };
}

// ---------------------------------------------------------------------- api

const json = (data, status = 200, maxAge = 10) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
      "access-control-allow-origin": "*",
    },
  });

const PROFILE_WINDOW = 15 * 60; // seconds a signed profile stays valid for submission

async function saveProfile(request, env) {
  const db = env.DB;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400, 0);
  }
  let address;
  let profile;
  try {
    address = getAddress(String(body.address));
    profile = normalizeProfile(body);
  } catch (e) {
    return json({ error: e?.field ? `invalid ${e.field}` : "invalid address" }, 400, 0);
  }
  const issued = Number(body.issued);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(issued) || Math.abs(now - issued) > PROFILE_WINDOW) return json({ error: "stale signature" }, 400, 0);
  let signer;
  try {
    signer = verifyMessage(profileMessage(address, profile, issued), String(body.signature));
  } catch {
    signer = null;
  }
  if (!signer || signer.toLowerCase() !== address.toLowerCase()) return json({ error: "bad signature" }, 401, 0);

  // Only someone who has sent a red packet may publish a profile.
  try {
    const out = await rpc(env, "eth_call", [{ to: env.CONTRACT, data: hb.encodeFunctionData("getPacket", [BigInt(body.packetId)]) }, "latest"]);
    const packet = hb.decodeFunctionResult("getPacket", out)[0];
    if (packet.creator.toLowerCase() !== address.toLowerCase()) return json({ error: "not the sender of that packet" }, 403, 0);
  } catch {
    return json({ error: "no such packet" }, 403, 0);
  }

  const key = address.toLowerCase();
  const prev = await db.prepare("SELECT issued FROM profiles WHERE address = ?").bind(key).first();
  if (prev && prev.issued >= issued) return json({ error: "older than the saved profile" }, 409, 0);
  if (isEmptyProfile(profile)) {
    await db.prepare("DELETE FROM profiles WHERE address = ?").bind(key).run();
  } else {
    await db
      .prepare("INSERT OR REPLACE INTO profiles (address, x, telegram, intro, issued, signature) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(key, profile.x, profile.telegram, profile.intro, issued, String(body.signature))
      .run();
  }
  return json({ ok: true, profile }, 200, 0);
}

const profileOf = (db, address) =>
  db.prepare("SELECT x, telegram, intro FROM profiles WHERE address = ?").bind(String(address).toLowerCase()).first();

const TOKEN_JOIN = "LEFT JOIN tokens t ON t.address = lower(p.token)";
const TOKEN_COLS = "t.symbol AS token_symbol, t.decimals AS token_decimals, t.listed AS token_listed";
const LISTED = `(lower(p.token) = '${NATIVE}' OR t.listed = 1)`;

async function api(request, url, env, ctx) {
  const db = env.DB;
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "/api/profile" && request.method === "POST") return saveProfile(request, env);
  if (path === "/api/fees") {
    // What one claim costs the claimer: gas price now, and BNB's USD price for stablecoin packets.
    // Kept for a minute at the edge, so the node is asked at most once a minute however many
    // people open the Send page.
    const cache = caches.default;
    const key = new Request(`${url.origin}/api/fees`);
    const hit = await cache.match(key);
    if (hit) return hit;
    const gasPrice = BigInt(await rpc(env, "eth_gasPrice", [])).toString();
    let bnbUsd = null;
    for (const u of ["https://data-api.binance.vision/api/v3/ticker/price?symbol=BNBUSDT", "https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT"]) {
      try {
        const r = await fetch(u, { cf: { cacheTtl: 60 } });
        const j = await r.json();
        if (Number(j.price) > 0) {
          bnbUsd = Number(j.price);
          break;
        }
      } catch {
        /* try the next source */
      }
    }
    if (bnbUsd === null) {
      // Binance's API can refuse Cloudflare's addresses: read PancakeSwap's USDT/WBNB pair instead.
      try {
        const out = await rpc(env, "eth_call", [{ to: "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE", data: "0x0902f1ac" }, "latest"]); // getReserves()
        const usdt = BigInt(out.slice(0, 66));
        const wbnb = BigInt("0x" + out.slice(66, 130));
        if (wbnb > 0n) bnbUsd = Number((usdt * 10000n) / wbnb) / 10000;
      } catch {
        /* unknown price: the site assumes a high one */
      }
    }
    const res = json({ gasPrice, bnbUsd, claimGas: 120000, at: Math.floor(Date.now() / 1000) }, 200, 60);
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  }
  const tm = path.match(/^\/api\/tokens\/(0x[0-9a-fA-F]{40})$/);
  if (tm) {
    // Only tokens already indexed: a lookup of any address would cost RPC calls per request.
    const token = await db.prepare("SELECT * FROM tokens WHERE address = ?").bind(tm[1].toLowerCase()).first();
    return json({ token: token ?? null }, token ? 200 : 404, 300);
  }
  const pm = path.match(/^\/api\/profiles\/(0x[0-9a-fA-F]{40})$/);
  if (pm) return json({ profile: (await profileOf(db, pm[1])) ?? null }, 200, 10);
  if (path === "/api/stats") {
    const s = await db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM packets) AS packets, (SELECT COUNT(DISTINCT who) FROM claims) AS claimers, (SELECT COUNT(*) FROM claims) AS claims, (SELECT value FROM meta WHERE key = 'cursor') AS indexed_block"
      )
      .first();
    return json({ packets: s.packets, claimers: s.claimers, claims: s.claims, indexedBlock: Number(s.indexed_block ?? 0) });
  }
  // Packets in unlisted tokens stay out of the public feeds (an easy channel for scam-token
  // airdrops); their own pages and share links still work.
  const listedOnly = url.searchParams.get("all") === "1" ? "" : `WHERE ${LISTED}`;
  if (path === "/api/packets") {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 10));
    const { results } = await db
      .prepare(`SELECT p.*, ${TOKEN_COLS}, (SELECT COUNT(*) FROM claims c WHERE c.packet_id = p.id) AS claimed FROM packets p ${TOKEN_JOIN} ${listedOnly} ORDER BY p.id DESC LIMIT ?`)
      .bind(limit)
      .all();
    return json({ packets: results });
  }
  if (path === "/api/recent") {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 10));
    const { results } = await db
      .prepare(
        `SELECT c.packet_id, p.slug, c.who, c.handle, c.amount, c.floored, c.block, p.token, p.kind, p.lucky, ${TOKEN_COLS} FROM claims c JOIN packets p ON p.id = c.packet_id ${TOKEN_JOIN} ${listedOnly} ORDER BY c.block DESC, c.slot DESC LIMIT ?`
      )
      .bind(limit)
      .all();
    const cursor = await db.prepare("SELECT value FROM meta WHERE key = 'cursor'").first();
    return json({ claims: results, indexedBlock: Number(cursor?.value ?? 0) });
  }
  const m = path.match(/^\/api\/r\/([^/]+)$/);
  if (m && SLUG_RE.test(m[1])) {
    const packet = await db.prepare("SELECT * FROM packets WHERE slug = ?").bind(m[1]).first();
    if (!packet) return json({ error: "not indexed" }, 404, 5);
    const id = packet.id;
    packet.tokenMeta = await tokenMeta(env, packet.token).catch(() => null);
    const { results } = await db
      .prepare("SELECT who, slot, handle, amount, floored, block FROM claims WHERE packet_id = ? ORDER BY slot IS NULL, slot, block")
      .bind(id)
      .all();
    return json({ packet, claims: results, profile: (await profileOf(db, packet.creator)) ?? null });
  }
  return json({ error: "not found" }, 404, 60);
}

// ------------------------------------------------------------ share pages

const SHARE_TEXT = {
  zh: {
    title: "Agent ID 红包 · 让你的 Agent 去抢红包",
    desc: "只有 Agent ID（name.ai）持有者能领的 BNB Chain 链上红包。把分享文字交给你的 AI Agent 就能抢。",
    custom: (sym, address) => `${sym || "代币"}（自定义代币 ${address}）`,
    packet: (p, amount, sym) => `🧧 红包 #${p.id} · ${amount} ${sym} · ${["定向", p.lucky ? "拼手气" : "均分", p.lucky ? "拼手气" : "均分"][p.kind]} · ${p.shares} 份`,
  },
  en: {
    title: "Agent ID Red Packets · let your Agent grab red packets",
    desc: "On-chain red packets on BNB Chain that only Agent ID (name.ai) holders can claim. Hand the share text to your AI agent to grab.",
    custom: (sym, address) => `${sym || "token"} (custom token ${address})`,
    packet: (p, amount, sym) => `🧧 Red packet #${p.id} · ${amount} ${sym} · ${["direct", p.lucky ? "lucky" : "equal", p.lucky ? "lucky" : "equal"][p.kind]} · ${p.shares} shares`,
  },
};

const CARD_VERSION = "1"; // bump when the card design changes, so caches fetch it again

/** What a share page and its card show about a packet; null if it is not indexed. */
async function packetSummary(env, slug) {
  const p = await env.DB.prepare("SELECT id, kind, lucky, token, total, shares, creator, memo FROM packets WHERE slug = ?").bind(slug).first();
  if (!p) return null;
  const t = await tokenMeta(env, p.token).catch(() => null);
  if (!t) return null;
  const amount = t.decimals == null ? String(p.total) : formatUnits(BigInt(p.total), t.decimals).replace(/\.0+$|(\.\d*?)0+$/, "$1");
  const custom = !t.listed;
  return { ...p, amount, custom, symbol: custom ? displaySymbol(t.symbol, false) : t.symbol, tokenAddress: tokenAddress(String(p.token)) };
}

/** PNG card of one packet, rendered once and then served from Cloudflare's cache. */
async function cardImage(request, env, ctx, url, slug) {
  const cache = caches.default;
  const key = new Request(url.toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const lang = url.searchParams.get("lang") === "zh" ? "zh" : "en";
  const p = await packetSummary(env, slug);
  if (!p) return Response.redirect(`${url.origin}/${lang === "zh" ? "og-zh.jpg" : "og.jpg"}`, 302);
  const png = await renderCard(env, url.origin, { ...p, kind: Number(p.kind), lucky: Boolean(p.lucky), shares: Number(p.shares) }, lang);
  const res = new Response(png, { headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" } });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/** index.html with title and link-preview tags in the visitor's language, for / and /r/:code links. */
async function sharePage(request, env, url, slug) {
  const lang = url.searchParams.get("lang") === "zh" ? "zh" : "en";
  const T = SHARE_TEXT[lang];
  let title = T.title;
  let desc = T.desc;
  let image = `${url.origin}/${lang === "zh" ? "og-zh.jpg" : "og.jpg"}`;
  let imageType = "image/jpeg";
  if (slug) {
    try {
      const p = await env.DB.prepare("SELECT id, kind, lucky, token, total, shares, creator FROM packets WHERE slug = ?").bind(slug).first();
      if (p) {
        image = `${url.origin}/og/${slug}.png?lang=${lang}&v=${CARD_VERSION}`;
        imageType = "image/png";
        const t = await tokenMeta(env, p.token).catch(() => null);
        if (!t) throw new Error("token unknown"); // fall back to the site texts rather than raw units
        const decimals = t?.decimals ?? 0;
        const amount = t?.decimals == null ? String(p.total) : formatUnits(BigInt(p.total), decimals).replace(/\.0+$|(\.\d*?)0+$/, "$1");
        const sym = t?.listed ? t.symbol : T.custom(displaySymbol(t?.symbol, false), tokenAddress(String(p.token)));
        title = T.packet(p, amount, sym);
        const profile = await profileOf(env.DB, p.creator);
        if (profile?.intro) desc = `💬 ${profile.intro} · ${desc}`;
      }
    } catch {
      /* fall back to the site texts */
    }
  }

  const page = `${url.origin}${url.pathname}?lang=${lang}`;
  const html = await env.ASSETS.fetch(new Request(new URL("/", url), request));
  const set = (selector, value) => ({ selector, value });
  const metas = [
    set('meta[name="description"]', desc),
    set('meta[property="og:title"]', title),
    set('meta[property="og:description"]', desc),
    set('meta[property="og:image"]', image),
    set('meta[property="og:image:type"]', imageType),
    set('meta[property="og:url"]', page),
    set('meta[name="twitter:title"]', title),
    set('meta[name="twitter:description"]', desc),
    set('meta[name="twitter:image"]', image),
  ];
  let rewriter = new HTMLRewriter()
    .on("html", { element: (el) => el.setAttribute("lang", lang === "zh" ? "zh-CN" : "en") })
    .on("title", { element: (el) => el.setInnerContent(title) });
  for (const m of metas) rewriter = rewriter.on(m.selector, { element: (el) => el.setAttribute("content", m.value) });
  const res = rewriter.transform(html);
  const headers = new Headers(res.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "public, max-age=60");
  return new Response(res.body, { status: 200, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // The bare domain only redirects; browsers keep the #fragment across the redirect.
    if (url.hostname === "agentid.im") {
      return Response.redirect(`https://www.agentid.im${url.pathname}${url.search}`, 301);
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(request, url, env, ctx);
      } catch (e) {
        return json({ error: String(e?.message || e) }, 500, 0);
      }
    }
    const og = url.pathname.match(/^\/og\/([^/]+)\.png$/);
    if (og && SLUG_RE.test(og[1]) && (request.method === "GET" || request.method === "HEAD")) {
      try {
        const res = await cardImage(request, env, ctx, url, og[1]);
        return request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
      } catch (e) {
        console.log(JSON.stringify({ card: "failed", error: String(e?.message || e) }));
        return Response.redirect(`${url.origin}/og.jpg`, 302);
      }
    }
    // Numbered packet paths are gone: packets are only reachable by their link code.
    if (/^\/p\/\d+\/?$/.test(url.pathname)) return Response.redirect(`${url.origin}/${url.search}`, 302);
    const share = url.pathname.match(/^\/r\/([^/]+)\/?$/);
    const page = (share && SLUG_RE.test(share[1])) || (url.pathname === "/" && url.searchParams.has("lang"));
    if (page && (request.method === "GET" || request.method === "HEAD")) {
      const res = await sharePage(new Request(request.url, { headers: request.headers }), env, url, share ? share[1] : null);
      return request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const index = await indexOnce(env);
        await fillMissing(env).catch(() => null);
        let keeper;
        try {
          keeper = await openPending(env);
        } catch (e) {
          keeper = { keeper: "error", error: e?.shortMessage || e?.message || String(e) };
        }
        console.log(JSON.stringify({ ...index, ...keeper }));
      })()
    );
  },
};
