// Deployment parameters for BNB Chain mainnet. Everything here is fixed forever once deployed:
// the contract has no owner and no setter.
const { parseEther } = require("ethers");

module.exports = {
  chainId: 56,
  // SPACE ID Agent ID (soulbound ERC-721 "AI").
  registry: "0x60b9262456de011f7d15a54cdd8c48baaa8b022f",
  // One point of heat wears off every 2 hours.
  heatPeriod: 2 * 60 * 60,
  // Listed tokens. Any other BSC token is accepted too, with the absolute minimum and no heat.
  //   minShare:     smallest direct amount and smallest average share of a split packet (anti-dust).
  //   heatMinShare: smallest average share for a public packet to move heat (below it, a packet
  //                 neither heats its grabbers nor cools its creator).
  tokens: [
    { symbol: "BNB", address: "0x0000000000000000000000000000000000000000", decimals: 18, minShare: parseEther("0.00001"), heatMinShare: parseEther("0.0002") },
    { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, minShare: parseEther("0.01"), heatMinShare: parseEther("0.1") },
    { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, minShare: parseEther("0.01"), heatMinShare: parseEther("0.1") },
  ],
};
