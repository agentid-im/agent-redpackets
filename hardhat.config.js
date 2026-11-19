require("@nomicfoundation/hardhat-toolbox");

const { BSC_RPC_URL, DEPLOYER_KEY, BSCSCAN_API_KEY } = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      viaIR: true,
    },
  },
  networks: {
    hardhat: { hardfork: "cancun" },
    localhost: { url: "http://127.0.0.1:8545" },
    bsc: {
      url: BSC_RPC_URL || "https://bsc-dataseed.binance.org",
      chainId: 56,
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
    },
  },
  etherscan: { apiKey: BSCSCAN_API_KEY || "" },
  sourcify: { enabled: false }, // the bundled plugin still calls the retired Sourcify v1 API
};
