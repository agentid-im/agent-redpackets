// hongbao: helper CLI for the agent-redpackets skill.
// Reads BNB Chain, checks a red packet, simulates the call and prints the exact arguments for
// `baw contract-call preview`. It holds no wallet key and sends no transaction.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, Interface, JsonRpcProvider, ZeroAddress, formatUnits, getAddress, parseUnits } from "ethers";
import abi from "../../lib/AgentHongbao.abi.json" with { type: "json" };
import { claimKey, handleHash, newCode, normalizeHandle, signGrab } from "../../lib/claim.mjs";
import { formatShare, parseShare } from "../../lib/share.mjs";
import { explain } from "../../lib/errors.mjs";
import { displaySymbol, fetchTokenMeta } from "../../lib/token.mjs";

const KINDS = ["定向", "口令", "公开"];
const REGISTRY_ABI = ["function handleOf(address) view returns (string)", "function ownerOfHandle(string) view returns (address)"];
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const iface = new Interface(abi);

// ------------------------------------------------------------------ setup

/** Built-in settings for the network this file was built for; a config.json next to it overrides them. */
// eslint-disable-next-line no-undef
const DEFAULTS = typeof __HONGBAO_DEFAULTS__ === "undefined" ? {} : __HONGBAO_DEFAULTS__;

function loadConfig() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const dir of [here, path.join(here, "..", "agent-redpackets")]) {
    const f = path.join(dir, "config.json");
    if (fs.existsSync(f)) return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(f, "utf8")) };
  }
  return { ...DEFAULTS };
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      opt[k] = argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? true : argv[++i];
    } else pos.push(a);
  }
  return { cmd: pos.shift(), pos, opt };
}

class UserError extends Error {}
const fail = (msg) => {
  throw new UserError(msg);
};
const str = (opt, k) => (opt[k] === undefined || opt[k] === true ? undefined : String(opt[k]));
const need = (opt, k) => str(opt, k) ?? fail(`缺少参数 --${k}`);

async function context(opt) {
  const cfg = loadConfig();
  const rpc = str(opt, "rpc") ?? process.env.HONGBAO_RPC ?? cfg.rpc ?? "https://bsc-dataseed.binance.org";
  const address = str(opt, "contract") ?? process.env.HONGBAO_CONTRACT ?? cfg.contract;
  if (!address) fail("还没有配置红包合约地址：传 --contract 0x... 或在 config.json 里填 contract");
  const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const { chainId } = await provider.getNetwork();
  const hb = new Contract(getAddress(address), abi, provider);
  // Binance's public dataseed nodes refuse eth_getLogs entirely, so event searches use their own node.
  const logsRpc = str(opt, "logs-rpc") ?? process.env.HONGBAO_LOGS_RPC ?? cfg.logsRpc ?? (cfg.rpc && !cfg.rpc.includes("bsc-dataseed") ? cfg.rpc : "https://bsc-rpc.publicnode.com");
  const logsProvider = logsRpc === rpc ? provider : new JsonRpcProvider(logsRpc, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const logs = new Contract(hb.target, abi, logsProvider);
  const registry = new Contract(await hb.registry(), REGISTRY_ABI, provider);
  return { cfg, provider, logsProvider, logs, chainId, hb, registry, binanceChainId: String(chainId), deployBlock: cfg.deployBlock ?? 0 };
}

// Listed tokens (BNB plus config.tokens) are known; any other token is "custom": its name is
// untrusted text, so it is always reported with its address and a warning.
const tokenCache = new Map();
async function tokenInfo(ctx, address) {
  if (address === ZeroAddress) return { address, symbol: "BNB", decimals: 18, custom: false };
  const key = getAddress(address);
  if (!tokenCache.has(key)) {
    const meta = await fetchTokenMeta((to, data) => ctx.provider.call({ to, data }), key);
    const listed = isListed(ctx, key);
    tokenCache.set(key, { address: key, symbol: displaySymbol(meta.symbol, listed), name: meta.name, decimals: meta.decimals, custom: !listed });
  }
  return tokenCache.get(key);
}
const isListed = (ctx, address) => address === ZeroAddress || (ctx.cfg.tokens ?? []).some((t) => t.address.toLowerCase() === String(address).toLowerCase());
const customNote = (t) => `自定义代币 ${t.symbol}（合约 ${t.address}）：代币名称谁都能起，不代表它就是同名的知名代币`;

async function tokenBySymbol(ctx, symbol) {
  const s = String(symbol || "BNB").toUpperCase();
  if (s === "BNB") return tokenInfo(ctx, ZeroAddress);
  const known = (ctx.cfg.tokens ?? []).find((t) => t.symbol.toUpperCase() === s);
  const address = known?.address ?? (s.startsWith("0X") ? getAddress(symbol) : fail(`不认识的代币 ${symbol}`));
  if (!(await ctx.hb.tokenAllowed(address))) fail(`${symbol} 不是代币合约地址`);
  const t = await tokenInfo(ctx, address);
  if (t.decimals === null) fail(`${address} 没有提供小数位（decimals），不能用来发红包`);
  return t;
}

const fmt = (amount, t) => {
  const text = t.decimals === null ? `${amount} 个最小单位的 ${t.symbol}` : `${formatUnits(amount, t.decimals)} ${t.symbol}`;
  return t.custom ? `${text}［自定义代币 ${t.address}，不是同名知名代币］` : text;
};
const when = (sec) => new Date(Number(sec) * 1000).toLocaleString("zh-CN", { hour12: false });

// -------------------------------------------------------------- packet view

async function describe(ctx, id, from) {
  let p;
  try {
    p = await ctx.hb.getPacket(id);
  } catch (e) {
    fail(explain(iface, e)?.reason ?? `读取红包 #${id} 失败：${e.shortMessage ?? e.message}`);
  }
  const t = await tokenInfo(ctx, p.token);
  const now = Math.floor(Date.now() / 1000);
  const kind = Number(p.kind);
  const out = {
    id: id.toString(),
    kind: KINDS[kind],
    split: kind === 0 ? "固定金额" : p.lucky ? "拼手气" : "均分",
    token: t.symbol,
    ...(t.custom ? { customToken: true, tokenAddress: t.address, tokenWarning: customNote(t) } : {}),
    total: fmt(p.total, t),
    remaining: fmt(p.remaining, t),
    ...(p.forfeited > 0n ? { returningToCreator: fmt(p.forfeited, t) } : {}),
    shares: Number(p.shares),
    taken: Number(p.grabbed),
    opened: Number(p.opened),
    expiresAt: when(p.expiry),
    expired: now >= Number(p.expiry),
    needsCode: kind === 1 || (kind === 2 && p.signer !== ZeroAddress),
    creator: p.creator,
  };
  if (kind === 2 && Number(p.heatStep) > 0) out.heatStepSeconds = Number(p.heatStep);
  if (p.lucky) out.floorPerShare = fmt(p.unit, t);

  if (from) {
    const handle = await ctx.registry.handleOf(from);
    const me = { address: from, agentId: handle ? `${handle}.ai` : null };
    if (kind === 0) {
      me.claimable = handle ? fmt(await ctx.hb.directAmount(id, handleHash(handle)), t) : fmt(0n, t);
    } else {
      const slot = Number(await ctx.hb.slotOf(id, from));
      me.grabbed = slot > 0;
      if (slot > 0) Object.assign(me, await slotResult(ctx, id, slot - 1, p, t));
      if (kind === 2) {
        me.heat = Number(await ctx.hb.heatOf(from));
        const at = Number(await ctx.hb.eligibleAt(id, from));
        if (at > now) me.eligibleAt = when(at);
      }
    }
    const owed = await ctx.hb.owed(from, p.token);
    if (owed > 0n) {
      me.owed = fmt(owed, t);
      me.owedHint = `有一笔到账没推送成功、记在合约账上：运行 hongbao withdraw --from ${from} --token ${p.token === ZeroAddress ? "BNB" : p.token} 提取`;
    }
    out.you = me;
  }
  return { packet: p, token: t, view: out };
}

async function slotResult(ctx, id, index, p, t) {
  const [, blockNum] = await ctx.hb.getSlot(id, index);
  const r = { slot: index + 1 };
  if (!p.lucky) return { ...r, status: "已到账", amount: fmt(p.unit, t) };
  if (index >= Number(p.opened)) {
    const head = Number(await ctx.provider.send("eth_blockNumber", []));
    return { ...r, status: BigInt(head) > blockNum ? "等待开奖（可以执行 open）" : "等待下一个区块" };
  }
  const logs = await findLogs(ctx, ctx.hb.filters.Opened(id, index), Number(blockNum));
  if (!logs.length) return { ...r, status: "已开奖", amount: "（未查到开奖记录，可在区块浏览器查看）" };
  const e = logs[0].args;
  return { ...r, status: e.floored ? "已开奖（超时，仅保底）" : "已开奖", amount: fmt(e.amount, t), txHash: logs[0].transactionHash };
}

/** Event search from `fromBlock` in small chunks, since public nodes cap log ranges. */
async function findLogs(ctx, filter, fromBlock, maxBlocks = 20_000) {
  const head = Number(await ctx.logsProvider.send("eth_blockNumber", []));
  const end = Math.min(head, fromBlock + maxBlocks);
  const found = [];
  for (let a = fromBlock; a <= end; a += 2000) {
    const b = Math.min(end, a + 1999);
    found.push(...(await ctx.logs.queryFilter(filter, a, b)));
    if (found.length) break;
  }
  return found;
}

// -------------------------------------------------------------- call output

async function simulate(ctx, from, call) {
  try {
    await ctx.provider.call({ from, to: call.to, value: call.value, data: call.inputData });
    return { ok: true };
  } catch (e) {
    const x = explain(iface, e);
    return { ok: false, error: x?.name ?? "Reverted", reason: x?.reason ?? (e.shortMessage || e.message) };
  }
}

function bawArgs(ctx, from, call) {
  return `baw contract-call preview --binanceChainId ${ctx.binanceChainId} --from ${from} --to ${call.to} --value ${call.value} --inputData ${call.inputData} --json`;
}

function call(ctx, fn, args, value = 0n, description) {
  return { to: ctx.hb.target, value: value.toString(), inputData: iface.encodeFunctionData(fn, args), description };
}

async function emit(ctx, from, calls, extra = {}, { simulateFirst = true } = {}) {
  let simulation;
  if (simulateFirst && from) {
    simulation = await simulate(ctx, from, calls[0]);
    if (!simulation.ok) {
      const { next, ...rest } = extra; // a next step makes no sense when the call would fail
      print({ ok: false, ...rest, error: simulation.error, reason: simulation.reason });
      process.exitCode = 2;
      return;
    }
  }
  print({
    ok: true,
    ...extra,
    calls: calls.map((c) => ({ ...c, ...(from ? { baw: bawArgs(ctx, from, c) } : {}) })),
    ...(simulation ? { simulated: true } : {}),
  });
}

function print(o) {
  process.stdout.write(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
}

// ----------------------------------------------------------------- commands

async function cmdInspect(ctx, pos, opt) {
  const share = parseShare(pos.join(" ") || str(opt, "id"), str(opt, "pass"));
  if (share.id === null) fail("没找到红包编号（形如 AgentHongbao #12）");
  const from = str(opt, "from") && getAddress(opt.from);
  const { view } = await describe(ctx, share.id, from);
  print({ ok: true, packet: view, shareHasCode: Boolean(share.code), shareHasPassphrase: Boolean(share.passphrase) });
}

async function cmdGrab(ctx, pos, opt) {
  const from = getAddress(need(opt, "from"));
  const share = parseShare(pos.join(" ") || str(opt, "id"), str(opt, "pass"));
  if (share.id === null) fail("没找到红包编号（形如 AgentHongbao #12）");
  const { packet: p, view } = await describe(ctx, share.id, from);

  if (view.kind === "定向") {
    return emit(ctx, from, [call(ctx, "claimDirect", [share.id], 0n, `领取定向红包 #${share.id}`)], { packet: view });
  }
  if (view.you?.grabbed) {
    const r = view.you;
    fail(`你已经抢过这个红包了（第 ${r.slot} 个名额，${r.status}${r.amount ? "，" + r.amount : ""}）`);
  }
  let sig = "0x";
  if (p.signer !== ZeroAddress) {
    // The passphrase the user said or the line names; else the greeting, which a sender's line
    // leaves out as the passphrase when the two are the same; else none.
    const tries = [...new Set([share.passphrase, share.memo, ""])];
    const key = tries
      .map((pass) => {
        try {
          return claimKey(share.code, pass);
        } catch {
          return null; // neither a code nor a passphrase
        }
      })
      .find((k) => k && k.address === p.signer);
    if (!key) {
      fail(share.code || share.passphrase ? "红包码或口令不对：如果口令另外公布了，问用户口令是什么，再加 --pass <口令> 运行" : "这个红包需要红包码或口令，请把完整的分享文字发给我");
    }
    sig = await signGrab(key, ctx.chainId, ctx.hb.target, share.id, from);
  }
  const lucky = view.split === "拼手气";
  await emit(ctx, from, [call(ctx, "grab", [share.id, sig], 0n, `抢红包 #${share.id}`)], {
    packet: view,
    next: lucky
      ? `拼手气红包：交易上链后，金额由该区块哈希决定，下一个区块即可开奖。之后运行 hongbao result ${share.id} --from ${from} 查看金额`
      : "均分红包：交易上链即到账",
  });
}

async function cmdClaim(ctx, pos, opt) {
  const from = getAddress(need(opt, "from"));
  const ids = pos.flatMap((x) => x.split(",")).filter(Boolean).map(BigInt);
  if (!ids.length) fail("请给出定向红包编号，例如 hongbao claim 3 7");
  if (!opt["allow-custom"]) {
    for (const id of ids) {
      const p = await ctx.hb.getPacket(id).catch(() => null);
      if (p && !isListed(ctx, p.token)) {
        fail(`#${id} 是${customNote(await tokenInfo(ctx, p.token))}。领取要付 gas，收到的也可能是骗局代币：先问用户要不要；用户明确同意后加 --allow-custom 再运行`);
      }
    }
  }
  const c =
    ids.length === 1
      ? call(ctx, "claimDirect", [ids[0]], 0n, `领取定向红包 #${ids[0]}`)
      : call(ctx, "claimDirectMany", [ids], 0n, `一次领取定向红包 #${ids.join(", #")}`);
  await emit(ctx, from, [c]);
}

const INBOX_MAX = 50;

async function cmdInbox(ctx, pos, opt) {
  const from = getAddress(need(opt, "from"));
  const handle = await ctx.registry.handleOf(from);
  if (!handle) fail("这个钱包没有 Agent ID");
  const h = handleHash(handle);
  // The website's index lists the packets addressed to this name up to some block; the chain is read
  // after it (or, without the index, from the contract's first block). The index only suggests
  // packets: each one is checked on chain below.
  const byId = new Map(); // id -> { id, token, block }
  let start = str(opt, "since-block") === undefined ? null : Number(opt["since-block"]);
  let source = "chain";
  if (start === null) {
    const listed = await indexedInbox(ctx, h);
    if (listed) {
      for (const d of listed.directs) byId.set(String(d.id), { id: BigInt(d.id), token: d.token, block: Number(d.block) });
      start = listed.indexedBlock + 1;
      source = "index+chain";
    } else {
      start = Number(ctx.deployBlock);
    }
  }
  try {
    for (const l of await scanLogs(ctx, ctx.logs.filters.DirectAdded(null, h), start)) {
      byId.set(l.args.id.toString(), { id: l.args.id, token: l.args.token, block: l.blockNumber });
    }
  } catch (e) {
    fail(`节点拒绝查询历史日志（${e.shortMessage ?? e.message}）：换一个支持日志的 RPC，传 --rpc`);
  }
  const found = [...byId.values()].sort((a, b) => a.block - b.block || (a.id < b.id ? -1 : 1));
  // Anyone can address a direct packet to any name, so the inbox may hold junk tokens: those are
  // left out unless --all, and at most INBOX_MAX recent entries are read.
  const all = Boolean(opt.all);
  const custom = found.filter((l) => !isListed(ctx, l.token));
  const wanted = (all ? found : found.filter((l) => isListed(ctx, l.token))).slice(-INBOX_MAX).reverse();
  const open = [];
  for (const log of wanted) {
    const id = log.id;
    const amount = await ctx.hb.directAmount(id, h);
    if (amount === 0n) continue;
    const p = await ctx.hb.getPacket(id);
    if (Math.floor(Date.now() / 1000) >= Number(p.expiry)) continue;
    const t = await tokenInfo(ctx, p.token);
    open.push({ id: id.toString(), amount: fmt(amount, t), expiresAt: when(p.expiry), ...(t.custom ? { customToken: true, tokenAddress: t.address } : {}) });
  }
  print({
    ok: true,
    agentId: `${handle}.ai`,
    claimable: open,
    ...(!all && custom.length ? { hiddenCustomTokenPackets: custom.length, note: "另有自定义代币的定向红包没列出：任何人都能给任意名字发，可能是垃圾或诈骗代币。用户明确要看时再加 --all" } : {}),
    scannedFromBlock: start,
    source,
  });
}

/** The website index's direct packets for a name hash, or null when it cannot be reached. */
async function indexedInbox(ctx, h) {
  const base = process.env.HONGBAO_API ?? ctx.cfg.api;
  if (!base || process.env.HONGBAO_API === "") return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/inbox/${h}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const body = await res.json();
    if (!Array.isArray(body.directs) || !Number.isInteger(body.indexedBlock)) return null;
    return body;
  } catch {
    return null;
  }
}

/** Event search from `fromBlock` to the newest block in 5000-block chunks (public nodes cap ranges), four at a time. */
async function scanLogs(ctx, filter, fromBlock) {
  const head = Number(await ctx.logsProvider.send("eth_blockNumber", []));
  const ranges = [];
  for (let a = Math.max(0, fromBlock); a <= head; a += 5000) ranges.push([a, Math.min(head, a + 4999)]);
  const out = new Array(ranges.length);
  let next = 0;
  const worker = async () => {
    while (next < ranges.length) {
      const k = next++;
      out[k] = await ctx.logs.queryFilter(filter, ...ranges[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, ranges.length) }, worker));
  return out.flat();
}

async function cmdResult(ctx, pos, opt) {
  const from = getAddress(need(opt, "from"));
  const share = parseShare(pos.join(" ") || str(opt, "id"));
  if (share.id === null) fail("请给出红包编号");
  const { view } = await describe(ctx, share.id, from);
  print({ ok: true, packet: view });
}

async function cmdOpen(ctx, pos, opt) {
  const id = BigInt(pos[0] ?? need(opt, "id"));
  const n = await ctx.hb.openable(id);
  if (n === 0n) fail("现在没有可以开奖的名额（已全部开奖，或还要等下一个区块）");
  const from = str(opt, "from") && getAddress(opt.from);
  await emit(ctx, from, [call(ctx, "open", [id, BigInt(str(opt, "max") ?? 10)], 0n, `为红包 #${id} 开奖（${n} 个名额可开）`)]);
}

async function cmdRefund(ctx, pos, opt) {
  const from = getAddress(need(opt, "from"));
  const id = BigInt(pos[0] ?? need(opt, "id"));
  await emit(ctx, from, [call(ctx, "refund", [id], 0n, `退回红包 #${id} 未领完的部分`)]);
}

async function cmdWithdraw(ctx, pos, opt) {
  const from = getAddress(need(opt, "from"));
  const t = await tokenBySymbol(ctx, str(opt, "token") ?? "BNB");
  const owed = await ctx.hb.owed(from, t.address);
  if (owed === 0n) fail("没有待提取的金额");
  const to = getAddress(str(opt, "to") ?? from);
  await emit(ctx, from, [call(ctx, "withdraw", [t.address, to], 0n, `提取 ${fmt(owed, t)} 到 ${to}`)]);
}

async function cmdCreate(ctx, pos, opt) {
  const from = str(opt, "from") && getAddress(opt.from);
  const type = need(opt, "type");
  const t = await tokenBySymbol(ctx, str(opt, "token"));
  const ttl = Number(str(opt, "ttl") ?? 24 * 3600);
  const expiry = BigInt(Math.floor(Date.now() / 1000) + ttl);
  const memo = str(opt, "memo") ?? "恭喜发财";
  const passphrase = str(opt, "pass") ?? "";
  if (type === "code" && !passphrase.trim()) fail("口令红包要设一个口令：加 --pass <口令>");
  if (type === "public" && t.custom) fail("公开红包只能用 BNB、USDT、USDC；其他代币请发口令红包（--type code）或定向红包");
  let total;
  let c;
  let share = null;
  let code = null;

  if (type === "direct") {
    const pairs = need(opt, "to").split(",").map((x) => x.split("="));
    const hashes = pairs.map(([h]) => handleHash(h));
    const amounts = pairs.map(([, a]) => parseUnits(a ?? fail("格式：--to alice=0.01,bob=0.02"), t.decimals));
    total = amounts.reduce((a, b) => a + b, 0n);
    const unregistered = [];
    for (const [h] of pairs) if ((await ctx.registry.ownerOfHandle(normalizeHandle(h))) === ZeroAddress) unregistered.push(`${normalizeHandle(h)}.ai`);
    c = call(ctx, "createDirect", [t.address, hashes, amounts, expiry, memo], t.address === ZeroAddress ? total : 0n,
      `发定向红包给 ${pairs.map(([h]) => normalizeHandle(h) + ".ai").join("、")}，共 ${fmt(total, t)}`);
    if (unregistered.length) c.warning = `${unregistered.join("、")} 还没被注册：谁先注册这个名字谁就能领走，建议只发小额`;
  } else if (type === "code" || type === "public") {
    total = parseUnits(need(opt, "total"), t.decimals);
    const shares = Number(need(opt, "shares"));
    const lucky = !opt.equal;
    let signer = ZeroAddress;
    if (type === "code") {
      code = str(opt, "code") ?? newCode();
      signer = claimKey(code, passphrase).address;
    } else if (passphrase) {
      signer = claimKey(null, passphrase).address;
    }
    const heatStep = type === "public" ? Number(str(opt, "heat-step") ?? 120) : 0;
    c = call(ctx, "createSplit", [t.address, total, shares, expiry, type === "public", signer, heatStep, lucky, memo],
      t.address === ZeroAddress ? total : 0n,
      `发${type === "code" ? "口令" : "公开"}${lucky ? "拼手气" : "均分"}红包，${shares} 份共 ${fmt(total, t)}`);
  } else fail("--type 只能是 direct、code 或 public");

  const calls = [c];
  if (t.address !== ZeroAddress) {
    const erc20 = new Contract(t.address, ERC20_ABI, ctx.provider);
    const have = from ? await erc20.allowance(from, ctx.hb.target) : 0n;
    if (have < total) {
      calls.unshift({
        to: t.address,
        value: "0",
        inputData: erc20.interface.encodeFunctionData("approve", [ctx.hb.target, total]),
        description: `授权红包合约使用恰好 ${fmt(total, t)}（不是无限授权）`,
      });
    }
  }
  const id = (await ctx.hb.packetCount()) + 1n;
  const after = {
    expectedId: id.toString(),
    note: "编号以交易上链后 PacketCreated 事件里的 id 为准；如果同时有别人发红包，编号会变，用 hongbao share 重新生成分享文字",
    ...(t.custom ? { tokenWarning: `${customNote(t)}。请和用户确认这就是要发的代币；转账收手续费的代币会被合约拒绝` } : {}),
  };
  if (type !== "direct") {
    share = formatShare({ id, code, passphrase, memo, includePassphrase: !opt["hide-pass"] });
    after.share = share;
    if (code) after.code = code;
  }
  await emit(ctx, from, calls, after, { simulateFirst: calls.length === 1 });
}

async function cmdShare(ctx, pos, opt) {
  const id = BigInt(pos[0] ?? need(opt, "id"));
  const p = await ctx.hb.getPacket(id);
  const code = str(opt, "code") ?? null;
  const passphrase = str(opt, "pass") ?? "";
  if (p.signer !== ZeroAddress && claimKey(code, passphrase).address !== p.signer) fail("红包码或口令与这个红包不符");
  print({ ok: true, share: formatShare({ id, code, passphrase, memo: str(opt, "memo"), includePassphrase: !opt["hide-pass"] }) });
}

async function cmdHeat(ctx, pos, opt) {
  const from = getAddress(need(opt, "from"));
  const heat = await ctx.hb.heatOf(from);
  const until = await ctx.hb.heatUntil(from);
  print({ ok: true, heat: Number(heat), coolsDownAt: heat > 0n ? when(until) : null, periodSeconds: Number(await ctx.hb.heatPeriod()) });
}

const HELP = `hongbao <command> [options]     (all output is JSON; nothing is ever sent)

  inspect <share text>  [--from 0x..]            红包详情；带 --from 时附上你的资格和结果
  grab <share text> --from 0x.. [--pass 口令]     生成抢/领红包的调用
  result <id> --from 0x..                        查看你在某个红包里的名额和金额
  open <id> [--from 0x..]                        生成开奖调用（任何人都可以开）
  claim <id> [<id>...] --from 0x..               领取定向红包
  inbox --from 0x..                              查找发给你的 Agent ID 的定向红包
  create --type code|public|direct ...           生成发红包的调用
         --total 0.01 --shares 5 [--token BNB|USDT|USDC|0x代币地址] [--ttl 秒] [--memo 祝福] [--pass 口令]
         [--equal] [--heat-step 秒] [--hide-pass]  |  --type direct --to alice=0.01,bob=0.02
  share <id> [--code ..] [--pass ..]             重新生成分享文字
  refund <id> --from 0x..                        发红包的人退回未领完部分
  withdraw --from 0x.. [--token BNB] [--to 0x..] 提取推送失败、记在账上的金额
  heat --from 0x..                               查看公开红包热度

  global: --rpc <url>  --logs-rpc <url, must serve eth_getLogs>  --contract <address>`;

const COMMANDS = {
  inspect: cmdInspect, grab: cmdGrab, result: cmdResult, open: cmdOpen, claim: cmdClaim, inbox: cmdInbox,
  create: cmdCreate, share: cmdShare, refund: cmdRefund, withdraw: cmdWithdraw, heat: cmdHeat,
};

async function main() {
  const { cmd, pos, opt } = parseArgs(process.argv.slice(2));
  if (!cmd || cmd === "help" || opt.help) return console.log(HELP);
  const fn = COMMANDS[cmd] ?? fail(`未知命令 ${cmd}\n${HELP}`);
  await fn(await context(opt), pos, opt);
}

main().catch((e) => {
  print({ ok: false, reason: e instanceof UserError ? e.message : `出错了：${e.shortMessage ?? e.message}` });
  process.exitCode = 1;
});
