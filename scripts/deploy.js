// Deploys AgentHongbao. On BNB Chain mainnet it uses scripts/params.js; on any other network it
// deploys test stand-ins first so the flow can be rehearsed.
//   DEPLOYER_KEY=0x... npx hardhat run scripts/deploy.js --network bsc
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const params = require("./params");

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("no deployer account: set DEPLOYER_KEY");
  const { chainId } = await ethers.provider.getNetwork();

  let registry = params.registry;
  let tokens = params.tokens.map((t) => t.address);
  const minShares = params.tokens.map((t) => t.minShare);
  const mins = params.tokens.map((t) => t.heatMinShare);
  if (chainId !== BigInt(params.chainId)) {
    console.log(`chain ${chainId} is not BNB Chain mainnet: deploying test stand-ins`);
    registry = (await (await ethers.getContractFactory("MockRegistry")).deploy()).target;
    const mock = (await (await ethers.getContractFactory("MockToken")).deploy()).target;
    tokens = [ethers.ZeroAddress, mock];
    minShares.length = 2;
    mins.length = 2;
  }

  const args = [registry, params.heatPeriod, tokens, minShares, mins];
  console.log(`deployer ${deployer.address}, balance ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))}`);
  const hb = await (await ethers.getContractFactory("AgentHongbao")).deploy(...args);
  const receipt = await hb.deploymentTransaction().wait();
  console.log(`AgentHongbao deployed at ${hb.target} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
  // The site and the skill treat params.tokens as listed: the contract must agree.
  for (const t of tokens) if (!(await hb.tokenListed(t))) throw new Error(`${t} is not listed on the deployed contract`);

  if (network.name !== "hardhat") {
    const dir = path.join(__dirname, "..", "deployments");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${network.name}.json`),
      JSON.stringify({ chainId: Number(chainId), address: hb.target, block: receipt.blockNumber, registry, tokens }, null, 2) + "\n"
    );
    fs.writeFileSync(
      path.join(dir, `${network.name}-args.js`),
      `module.exports = ${JSON.stringify(args, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)};\n`
    );
    console.log(`verify with: npx hardhat verify --network ${network.name} --constructor-args deployments/${network.name}-args.js ${hb.target}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
