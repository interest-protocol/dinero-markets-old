// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

contract MockOracle {
    uint256 public bnbUSDPrice;

    mapping(address => uint256) public prices;

    function getBNBUSDPrice(uint256 amount) external view returns (uint256) {
        return (bnbUSDPrice * amount) / 1 ether;
    }

    function getTokenUSDPrice(address erc20, uint256 amount)
        external
        view
        returns (uint256)
    {
        return (prices[erc20] * amount) / 1 ether;
    }

    function getUSDPrice(address erc20, uint256 amount)
        external
        view
        returns (uint256)
    {
        return (prices[erc20] * amount) / 1 ether;
    }

    function __setBNBUSDPrice(uint256 amount) external {
        bnbUSDPrice = amount;
    }

    function __setERC20Price(address erc20, uint256 price) external {
        prices[erc20] = price;
    }
}
