//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "../../InterestBNBMarket.sol";

contract TestInterestBNBMarketV2 is InterestBNBMarketV1 {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
