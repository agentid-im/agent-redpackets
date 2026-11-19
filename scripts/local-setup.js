// Local rehearsal: deploys a stand-in Agent ID registry, a listed token, an unlisted token whose
// symbol spoofs "USDT", and AgentHongbao on a local Hardhat node, and gives the first test
// accounts Agent IDs.
//   npx hardhat node            (another terminal)
//   npx hardhat run scripts/local-setup.js --network localhost
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const HANDLES = ["alice", "bob", "carol", "dave", "erin", "frank"];

async function main() {
  const signers = await ethers.getSigners();
  const registry = await (await ethers.getContractFactory("MockRegistry")).deploy();
  const token = await (await ethers.getContractFactory("MockToken")).deploy();
  await Promise.all([registry.waitForDeployment(), token.waitForDeployment()]);
  const custom = await (await ethers.getContractFactory("HostileToken")).deploy();
  await custom.waitForDeployment();
  const hb = await (await ethers.getContractFactory("AgentHongbao")).deploy(
    registry.target, 2 * 60 * 60, [ethers.ZeroAddress, token.target], [ethers.parseEther("0.00001"), ethers.parseEther("0.01")], [ethers.parseEther("0.0002"), ethers.parseEther("0.1")]
  );
  const receipt = await hb.deploymentTransaction().wait();
  const accounts = {};
  for (let i = 0; i < HANDLES.length; i++) {
    const s = signers[i + 1];
    await (await registry.register(HANDLES[i], s.address)).wait();
    await (await token.mint(s.address, ethers.parseEther("1000"))).wait();
    await (await custom.mint(s.address, 1_000_000_000n)).wait(); // 1000 "USDT" at 6 decimals
    accounts[`${HANDLES[i]}.ai`] = s.address;
  }
  await (await token.mint(signers[0].address, ethers.parseEther("1000"))).wait();
  accounts["(no Agent ID)"] = signers[7].address;

  const out = {
    chainId: 31337, address: hb.target, block: receipt.blockNumber, rpc: "http://127.0.0.1:8545",
    registry: registry.target, token: token.target, customToken: custom.target, accounts,
  };
  fs.mkdirSync(path.join(__dirname, "..", "deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "deployments", "localhost.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
