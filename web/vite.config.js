import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";

// VITE_NETWORK=localhost uses deployments/localhost.json and offers the local test accounts.
const network = process.env.VITE_NETWORK || "bsc";
const depFile = path.resolve(__dirname, "..", "deployments", `${network}.json`);
const dep = fs.existsSync(depFile) ? JSON.parse(fs.readFileSync(depFile, "utf8")) : {};
const params = require("../scripts/params.js");

const config = {
  network,
  chainId: dep.chainId ?? 56,
  contract: process.env.VITE_CONTRACT || dep.address || null,
  deployBlock: dep.block ?? 0,
  rpc: process.env.VITE_RPC || dep.rpc || "https://bsc-dataseed.binance.org",
  // must serve eth_getLogs; Binance's dataseed nodes do not
  logsRpc: process.env.VITE_LOGS_RPC || dep.rpc || "https://bsc-rpc.publicnode.com",
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
  server: { port: 5178, fs: { allow: [path.resolve(__dirname, "..")] }, proxy: network === "bsc" ? { "/api": "http://127.0.0.1:8787" } : undefined },
  build: { outDir: path.resolve(__dirname, "..", "dist", network), emptyOutDir: true },
});
