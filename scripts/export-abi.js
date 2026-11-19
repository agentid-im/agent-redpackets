// Copies the compiled ABI into lib/ so the web page and the skill build without Hardhat artifacts.
const fs = require("fs");
const path = require("path");
const { abi } = require("../artifacts/contracts/AgentHongbao.sol/AgentHongbao.json");
fs.writeFileSync(path.join(__dirname, "..", "lib", "AgentHongbao.abi.json"), JSON.stringify(abi, null, 2) + "\n");
console.log(`wrote lib/AgentHongbao.abi.json (${abi.length} entries)`);
