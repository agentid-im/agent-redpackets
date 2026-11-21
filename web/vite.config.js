import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";

// VITE_NETWORK=localhost uses deployments/localhost.json and offers the local test accounts.
const network = process.env.VITE_NETWORK || "bsc";
const depFile = path.resolve(__dirname, "..", "deployments", `${network}.json`);
const dep = fs.existsSync(depFile) ? JSON.parse(fs.readFileSync(depFile, "utf8")) : {};
const params = require("../scripts/params.js");
const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null);

const config = {
  network,
  chainId: dep.chainId ?? 56,
  contract: process.env.VITE_CONTRACT || dep.address || null,
  deployBlock: dep.block ?? 0,
  // Public nodes the page reads from, taking turns (comma-separated lists override them). Keyless only:
  // this list ships in the page.
  rpcs: list(process.env.VITE_RPC) ?? (dep.rpc ? [dep.rpc] : [
    "https://bsc-dataseed.bnbchain.org",
    "https://bsc-dataseed1.bnbchain.org",
    "https://bsc-dataseed2.bnbchain.org",
    "https://bsc-dataseed.binance.org",
    "https://bsc-dataseed1.defibit.io",
    "https://bsc-rpc.publicnode.com",
  ]),
  // Nodes for eth_getLogs over 5000 blocks, in order of preference (the dataseed nodes refuse it).
  logsRpcs: list(process.env.VITE_LOGS_RPC) ?? (dep.rpc ? [dep.rpc] : ["https://bsc-rpc.publicnode.com", "https://bsc.rpc.blxrbdn.com"]),
  explorer: network === "bsc" ? "https://bscscan.com" : null,
  tokens: dep.token
    ? [{ symbol: "BNB", address: "0x0000000000000000000000000000000000000000", decimals: 18, minShare: "10000000000000" }, { symbol: "mUSD", address: dep.token, decimals: 18, minShare: "10000000000000000" }]
    : params.tokens.map(({ symbol, address, decimals, minShare }) => ({ symbol, address, decimals, minShare: minShare.toString() })),
  testAccounts: network === "localhost" ? dep.accounts ?? {} : {},
};

export default defineConfig({
  root: __dirname,
  base: "/", // absolute: the page is also served at /p/:id
  define: { __HONGBAO_CONFIG__: JSON.stringify(config) },
  // In dev, /api goes to a local `wrangler dev` (port 8787) when one runs; otherwise the page reads the chain.
  server: { port: 5178, fs: { allow: [path.resolve(__dirname, "..")] }, proxy: { "/api": "http://127.0.0.1:8787" } },
  build: { outDir: path.resolve(__dirname, "..", "dist", network), emptyOutDir: true },
});
