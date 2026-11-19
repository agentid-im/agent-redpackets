// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IRegistryProbe {
    function balanceOf(address owner) external view returns (uint256);
    function handleOf(address owner) external view returns (string memory);
}

/// @dev Never deployed. scripts/check-mainnet.js runs it through eth_call with a state override to
///      confirm, from inside the EVM, the two chain facts AgentHongbao relies on.
contract MainnetProbe {
    address private constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;

    function probe(address registry, address holder, uint256 n)
        external
        view
        returns (uint256 balance, bytes32 handleHash, bytes32 opcodeHash, bytes32 historyHash, uint256 blockNumber)
    {
        balance = IRegistryProbe(registry).balanceOf(holder);
        handleHash = keccak256(bytes(IRegistryProbe(registry).handleOf(holder)));
        opcodeHash = blockhash(n);
        (bool ok, bytes memory ret) = HISTORY.staticcall{gas: 100_000}(abi.encode(n));
        if (ok && ret.length == 32) historyHash = abi.decode(ret, (bytes32));
        blockNumber = block.number;
    }
}
