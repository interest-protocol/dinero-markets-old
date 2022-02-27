//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "../../NFTMarket.sol";

contract TestNFTMarketV2 is NFTMarket {
    function version() external pure returns (string memory) {
        return "V2";
    }
}