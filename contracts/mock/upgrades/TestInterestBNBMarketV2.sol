//SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "../../dinero-markets/InterestBNBMarket.sol";

contract TestInterestBNBMarketV2 is InterestBNBMarket {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
