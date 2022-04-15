// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

contract MockOracle {
    uint256 public bnbUSDPrice;

    function getBNBUSDPrice(uint256 amount) external view returns (uint256) {
        return (bnbUSDPrice * amount) / 1 ether;
    }

    function __setBNBUSDPrice(uint256 amount) external {
        bnbUSDPrice = amount;
    }
}
