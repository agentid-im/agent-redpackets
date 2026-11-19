// Read-only checks against BNB Chain mainnet. Sends no transaction and needs no key.
//   node scripts/check-mainnet.js [rpcUrl]
const { ethers } = require("ethers");
const params = require("./params");
const probeArtifact = require("../artifacts/contracts/mocks/MainnetProbe.sol/MainnetProbe.json");

const HANDLES = ["alice", "bob", "agent"];
const PROBE_AT = "0x00000000000000000000000000000000000bea75";

async function main() {
  const provider = new ethers.JsonRpcProvider(process.argv[2] || "https://bsc-dataseed.binance.org", params.chainId, {
    staticNetwork: true,
  });
  let failed = 0;
  const check = (ok, label, detail = "") => {
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
  };

  const registry = new ethers.Contract(
    params.registry,
    [
      "function symbol() view returns (string)",
      "function ownerOfHandle(string) view returns (address)",
      "function ownerOf(uint256) view returns (address)",
      "function handleOf(address) view returns (string)",
      "function balanceOf(address) view returns (uint256)",
    ],
    provider
  );
  check((await registry.symbol()) === "AI", "registry symbol is AI");

  const probe = new ethers.Interface(probeArtifact.abi);
  const head = await provider.getBlockNumber();
  const runProbe = async (holder, n) => {
    const raw = await provider.send("eth_call", [
      { to: PROBE_AT, data: probe.encodeFunctionData("probe", [params.registry, holder, n]) },
      "latest",
      { [PROBE_AT]: { code: probeArtifact.deployedBytecode } },
    ]);
    return probe.decodeFunctionResult("probe", raw);
  };

  let holder;
  for (const handle of HANDLES) {
    const owner = await registry.ownerOfHandle(handle);
    if (owner === ethers.ZeroAddress) {
      console.log(`skip ${handle}.ai is not registered`);
      continue;
    }
    holder = owner;
    const label = ethers.keccak256(ethers.toUtf8Bytes(handle));
    check((await registry.handleOf(owner)) === handle, `handleOf(owner of ${handle}.ai) has no suffix`);
    check((await registry.ownerOf(BigInt(label))) === owner, `tokenId of ${handle}.ai is keccak256(handle)`);
    check((await registry.balanceOf(owner)) === 1n, `owner of ${handle}.ai has balance 1`);
    const r = await runProbe(owner, head - 10);
    check(r.balance === 1n && r.handleHash === label, `in-EVM handle hash matches for ${handle}.ai`);
    check((await provider.getCode(owner)) === "0x", `owner of ${handle}.ai is a plain account`);
  }
  check((await registry.balanceOf(PROBE_AT)) === 0n, "a non-holder has balance 0");
  check((await registry.handleOf(PROBE_AT)) === "", "a non-holder has an empty handle");

  if (holder) {
    for (const back of [10, 200, 300, 4000, 8000]) {
      const r = await runProbe(holder, head - back);
      const n = head - back;
      const real = (await provider.getBlock(n)).hash;
      const distance = Number(r.blockNumber) - n;
      check(r.historyHash === real, `history contract serves the real hash ${distance} blocks back`);
      if (distance <= 256) check(r.opcodeHash === real, `opcode serves the real hash ${distance} blocks back`);
      else check(r.opcodeHash === ethers.ZeroHash, `opcode returns zero ${distance} blocks back`);
    }
  }

  const erc20 = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];
  for (const t of params.tokens) {
    if (t.address === ethers.ZeroAddress) continue;
    const c = new ethers.Contract(t.address, erc20, provider);
    const [symbol, decimals] = [await c.symbol(), Number(await c.decimals())];
    check(symbol === t.symbol && decimals === t.decimals, `token ${t.address}`, `${symbol}, ${decimals} decimals`);
  }

  const a = await provider.getBlock(head);
  const b = await provider.getBlock(head - 2000);
  const blockTime = (a.timestamp - b.timestamp) / 2000;
  console.log(`info block time ${blockTime}s, so the 8191-block window is about ${Math.round((8191 * blockTime) / 60)} minutes`);

  if (failed) throw new Error(`${failed} check(s) failed`);
  console.log("all checks passed");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
