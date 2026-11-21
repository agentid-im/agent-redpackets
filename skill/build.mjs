// Bundles the helper CLI with the deployment's settings built in, writes config.json, and for
// mainnet also writes the installable archive the website serves:
//   web/public/skill/agent-redpackets.zip   (SKILL.md + hongbao.mjs)  -> npx skills add <url>
//   node skill/build.mjs [network]     (default: bsc)
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "skill", "agent-redpackets");
const network = process.argv[2] || "bsc";

const dep = path.join(root, "deployments", `${network}.json`);
const params = (await import(path.join(root, "scripts", "params.js"))).default;
const d = fs.existsSync(dep) ? JSON.parse(fs.readFileSync(dep, "utf8")) : null;
const config = {
  chainId: d?.chainId ?? 56,
  contract: d?.address ?? null,
  deployBlock: d?.block ?? 0,
  rpc: d?.rpc ?? (network === "bsc" ? "https://bsc-dataseed.binance.org" : "http://127.0.0.1:8545"),
  // must serve eth_getLogs; Binance's dataseed nodes do not
  logsRpc: d?.rpc ?? (network === "bsc" ? "https://bsc-rpc.publicnode.com" : "http://127.0.0.1:8545"),
  // The website's index, used to find direct packets by name; everything it lists is checked on chain.
  api: network === "bsc" ? "https://www.agentid.im" : "http://127.0.0.1:8787",
  tokens: d?.token
    ? [{ symbol: "mUSD", address: d.token }]
    : params.tokens.filter((t) => t.address !== "0x0000000000000000000000000000000000000000").map(({ symbol, address }) => ({ symbol, address })),
};

// The contract address quoted in SKILL.md and README.md follows the deployment.
if (network === "bsc" && config.contract) {
  for (const f of [path.join(out, "SKILL.md"), path.join(root, "README.md")]) {
    const text = fs.readFileSync(f, "utf8");
    const next = text
      .replace(/(contract \(`)0x[0-9a-fA-F]{40}(`)/g, (_, a, b) => a + config.contract + b)
      .replace(/(- Contract: \[`)0x[0-9a-fA-F]{40}(`\]\(https:\/\/bscscan\.com\/address\/)0x[0-9a-fA-F]{40}/g, (_, a, b) => a + config.contract + b + config.contract);
    if (next !== text) fs.writeFileSync(f, next);
  }
}

await build({
  entryPoints: [path.join(root, "skill", "src", "cli.mjs")],
  outfile: path.join(out, "hongbao.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  legalComments: "none",
  define: { __HONGBAO_DEFAULTS__: JSON.stringify(config) },
  banner: { js: "// Built from skill/src/cli.mjs. Holds no key and sends no transaction." },
});
fs.writeFileSync(path.join(out, "config.json"), JSON.stringify(config, null, 2) + "\n");

if (network === "bsc" && config.contract) {
  const pub = path.join(root, "web", "public", "skill");
  fs.mkdirSync(pub, { recursive: true });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "hongbao-skill-"));
  const dir = path.join(stage, "agent-redpackets");
  fs.mkdirSync(dir);
  // Fixed timestamps keep the archive byte-identical while its contents are unchanged.
  const fixed = new Date("2026-01-01T00:00:00Z");
  for (const f of ["SKILL.md", "hongbao.mjs"]) {
    fs.copyFileSync(path.join(out, f), path.join(dir, f));
    fs.utimesSync(path.join(dir, f), fixed, fixed);
  }
  fs.utimesSync(dir, fixed, fixed);
  const zip = path.join(pub, "agent-redpackets.zip");
  fs.rmSync(zip, { force: true });
  execFileSync("zip", ["-X", "-q", "-r", zip, "agent-redpackets"], { cwd: stage });
  fs.rmSync(stage, { recursive: true, force: true });
  const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  fs.copyFileSync(path.join(out, "SKILL.md"), path.join(pub, "SKILL.md"));
  fs.writeFileSync(
    path.join(pub, "SHA256SUMS"),
    `${sha(zip)}  agent-redpackets.zip\n${sha(path.join(out, "hongbao.mjs"))}  hongbao.mjs\n${sha(path.join(out, "SKILL.md"))}  SKILL.md\n`
  );
  console.log(`wrote web/public/skill/agent-redpackets.zip (${(fs.statSync(zip).size / 1024).toFixed(0)} KiB)`);
}
console.log(`built skill/agent-redpackets (network ${network}, contract ${config.contract ?? "not deployed yet"})`);
