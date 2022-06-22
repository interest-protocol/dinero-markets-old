//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

interface IOracle {
    function getTokenUSDPrice(address, uint256) external view returns (uint256);
}
