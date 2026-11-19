#!/usr/bin/env node
// Opens lucky slots as soon as their block hash exists, so a grabber never needs a second call.
// `open` is permissionless and cannot change any amount: the keeper only pays the gas.
//
//   KEEPER_KEY=0x... node scripts/keeper.js [network]          (default network: bsc)
//
// Options (env):
//   KEEPER_RPCS         comma-separated nodes, tried in order; when one fails the keeper moves to the
//                       next and returns to the first after 5 minutes. Every node must serve
//                       eth_getLogs (Binance's dataseed nodes do not). Default: bsc-rpc.publicnode.com.
//   HONGBAO_CONTRACT, KEEPER_POLL_MS (1000), KEEPER_LOOKBACK (9000 blocks, about the block-hash
//   window), KEEPER_MAX_GWEI (1), KEEPER_MIN_BALANCE (0.001 BNB; one open costs about 0.000003 BNB
//   at 0.05 gwei).
// Node URLs often embed an API key, so the keeper only ever prints their host names.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const abi = require("../lib/AgentHongbao.abi.json");

const network = process.argv[2] || "bsc";
const env = process.env;
const POLL_MS = Number(env.KEEPER_POLL_MS || 1000);
const LOOKBACK = Number(env.KEEPER_LOOKBACK || 9000);
const MAX_GAS_PRICE = ethers.parseUnits(env.KEEPER_MAX_GWEI || "1", "gwei");
const MIN_BALANCE = ethers.parseEther(env.KEEPER_MIN_BALANCE || "0.001");
const LOG_CHUNK = 2000;
const OPEN_MAX = 20n;
const BACK_TO_PRIMARY_MS = 5 * 60_000;

const log = (...a) => console.log(new Date().toISOString(), ...a);
/** The node's own words, not ethers' wrapper text. */
const why = (e) => e?.error?.message || e?.info?.error?.message || e?.shortMessage || e?.message || String(e);
const host = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "node";
  }
};

function load() {
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  const dep = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const address = env.HONGBAO_CONTRACT || dep.address;
  if (!address) throw new Error(`no contract: set HONGBAO_CONTRACT or deploy to ${network} first`);
  if (!env.KEEPER_KEY) throw new Error("set KEEPER_KEY (a wallet holding a little BNB for gas, nothing else)");
  const fallback = network === "bsc" ? "https://bsc-rpc.publicnode.com" : dep.rpc || "http://127.0.0.1:8545";
  const urls = (env.KEEPER_RPCS || fallback).split(",").map((s) => s.trim()).filter(Boolean);
  return { address, urls };
}

async function main() {
  const { address, urls } = load();
  const nodes = urls.map((url) => {
    const provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 1 });
    const wallet = new ethers.Wallet(env.KEEPER_KEY, provider);
    return { name: host(url), provider, wallet, hb: new ethers.Contract(address, abi, wallet) };
  });
  let cur = 0;
  let leftPrimaryAt = 0;

  /**
   * Runs fn on the current node; on a node failure moves to the next one and retries, at most once
   * per node. A contract revert is an answer, not a node failure, so it is passed straight back.
   */
  async function use(fn) {
    if (cur !== 0 && Date.now() - leftPrimaryAt > BACK_TO_PRIMARY_MS) {
      cur = 0;
      log(`back to ${nodes[0].name}`);
    }
    let last;
    for (let tries = 0; tries < nodes.length; tries++) {
      try {
        return await fn(nodes[cur]);
      } catch (e) {
        if (e?.code === "CALL_EXCEPTION") throw e;
        last = e;
        if (nodes.length === 1) break;
        const from = nodes[cur].name;
        cur = (cur + 1) % nodes.length;
        if (cur !== 0) leftPrimaryAt = Date.now();
        log(`${from} failed (${why(e)}), switching to ${nodes[cur].name}`);
      }
    }
    throw last;
  }

  const head = () => use(async (n) => Number(await n.provider.send("eth_blockNumber", []))); // uncached
  const { chainId } = await use((n) => n.provider.getNetwork());
  log(`keeper ${nodes[0].wallet.address} on chain ${chainId}, contract ${address}, nodes ${nodes.map((n) => n.name).join(" > ")}`);

  let cursor = Math.max(0, (await head()) - LOOKBACK);
  const pending = new Set(); // lucky packet ids that may have unopened slots
  const lucky = new Map(); // id -> bool
  let lastBalanceCheck = 0;
  let stopping = false;
  let overCap = false;
  process.on("SIGINT", () => {
    stopping = true;
    log("stopping after this round");
  });

  async function isLucky(id) {
    if (!lucky.has(id)) lucky.set(id, (await use((n) => n.hb.getPacket(id))).lucky);
    return lucky.get(id);
  }

  async function scan() {
    // Head and logs come from the same node: nodes lag each other by a block or so, and asking one
    // node for blocks only another has seen is an error, not a node failure.
    const events = await use(async (n) => {
      const top = Number(await n.provider.send("eth_blockNumber", []));
      const found = [];
      let from = cursor;
      while (from <= top) {
        const to = Math.min(top, from + LOG_CHUNK - 1);
        found.push(...(await n.hb.queryFilter(n.hb.filters.Grabbed(), from, to)));
        from = to + 1;
      }
      return { found, next: Math.max(cursor, top + 1) };
    });
    for (const e of events.found) {
      const id = e.args.id;
      if (await isLucky(id)) pending.add(id);
    }
    cursor = events.next;
  }

  async function openReady() {
    for (const id of [...pending]) {
      const p = await use((n) => n.hb.getPacket(id));
      if (p.opened >= p.grabbed) {
        pending.delete(id);
        continue;
      }
      const openable = await use((n) => n.hb.openable(id));
      if (openable === 0n) continue; // the slot's block is not finished yet
      // open() stops by itself below OPEN_GAS left, so a gas limit sized from the openable slots is
      // safe; an estimate would size it for a single slot.
      const want = 100_000n + (openable < OPEN_MAX ? openable : OPEN_MAX) * 180_000n;
      const gasLimit = want < 2_000_000n ? want : 2_000_000n;
      const fee = await use((n) => n.provider.getFeeData());
      const gasPrice = fee.gasPrice ?? MAX_GAS_PRICE;
      if (gasPrice > MAX_GAS_PRICE) {
        if (!overCap) log(`gas price ${ethers.formatUnits(gasPrice, "gwei")} gwei is above the cap, waiting`);
        overCap = true;
        return;
      }
      if (overCap) log("gas price back under the cap");
      overCap = false;
      try {
        await use((n) => n.hb.open.staticCall(id, OPEN_MAX, { gasLimit })); // someone else may have opened it already
        // Sending is not retried on another node: a resend could duplicate a transaction that went through.
        const n = nodes[cur];
        const tx = await n.hb.open(id, OPEN_MAX, { gasPrice, gasLimit });
        const r = await tx.wait();
        const opened = r.logs.map((l) => n.hb.interface.parseLog(l)).filter((e) => e?.name === "Opened");
        log(`#${id}: opened ${opened.length} slot(s) in ${tx.hash}, gas ${r.gasUsed}`);
      } catch (e) {
        log(`#${id}: open failed: ${why(e)}`);
      }
    }
  }

  async function checkBalance() {
    if (Date.now() - lastBalanceCheck < 60_000) return;
    lastBalanceCheck = Date.now();
    const bal = await use((n) => n.provider.getBalance(n.wallet.address));
    if (bal < MIN_BALANCE) log(`warning: keeper balance ${ethers.formatEther(bal)} BNB is low`);
  }

  while (!stopping) {
    try {
      await scan();
      await openReady();
      await checkBalance();
    } catch (e) {
      log(`round failed: ${why(e)}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(why(e));
  process.exit(1);
});
