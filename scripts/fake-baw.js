#!/usr/bin/env node
// Stand-in for `baw contract-call preview|execute` on a local Hardhat node, so the skill flow can
// be rehearsed without a real Agentic Wallet. Local chain only: it refuses any other chain id.
//   node scripts/fake-baw.js contract-call preview --binanceChainId 31337 --from 0x.. --to 0x.. --value 0 --inputData 0x.. --json
//   node scripts/fake-baw.js contract-call execute --requestId <id> --json
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");

const RPC = process.env.FAKE_BAW_RPC || "http://127.0.0.1:8545";
const STORE = path.join(os.tmpdir(), "fake-baw-requests.json");

const args = process.argv.slice(2);
const opt = {};
for (let i = 2; i < args.length; i++) if (args[i].startsWith("--")) opt[args[i].slice(2)] = args[i + 1]?.startsWith("--") ? true : args[++i];
const print = (o) => console.log(JSON.stringify(o, null, 2));

async function main() {
  if (args[0] !== "contract-call") throw new Error("only contract-call is simulated");
  const provider = new ethers.JsonRpcProvider(RPC);
  const { chainId } = await provider.getNetwork();
  if (chainId !== 31337n) throw new Error(`refusing to run against chain ${chainId}`);
  const store = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};

  if (args[1] === "preview") {
    const tx = { from: ethers.getAddress(opt.from), to: ethers.getAddress(opt.to), value: BigInt(opt.value || 0), data: opt.inputData || "0x" };
    try {
      await provider.call(tx);
      tx.gasLimit = await provider.estimateGas(tx);
    } catch (e) {
      return print({ success: false, error: { code: 351805, message: `simulation failed: ${e.shortMessage || e.message}` } });
    }
    const requestId = crypto.randomBytes(8).toString("hex");
    store[requestId] = { ...tx, value: tx.value.toString(), gasLimit: tx.gasLimit.toString() };
    fs.writeFileSync(STORE, JSON.stringify(store));
    return print({ success: true, data: { requestId, parsedTx: { contractAddress: tx.to, amount: tx.value.toString() }, simulationResult: { simulationCode: "000000000" }, risks: { riskDetails: [] }, requireConfirmation: false } });
  }
  if (args[1] === "execute") {
    const tx = store[opt.requestId];
    if (!tx) return print({ success: false, error: { code: 351800, message: "unknown or expired requestId" } });
    delete store[opt.requestId];
    fs.writeFileSync(STORE, JSON.stringify(store));
    const signer = await provider.getSigner(tx.from);
    const sent = await signer.sendTransaction({ to: tx.to, value: BigInt(tx.value), data: tx.data, gasLimit: BigInt(tx.gasLimit) * 12n / 10n });
    const r = await sent.wait();
    return print({ success: true, data: { status: r.status === 1 ? "BROADCASTED" : "FAILED", txHash: sent.hash } });
  }
  throw new Error("use preview or execute");
}

main().catch((e) => {
  print({ success: false, error: { message: e.message } });
  process.exit(1);
});
