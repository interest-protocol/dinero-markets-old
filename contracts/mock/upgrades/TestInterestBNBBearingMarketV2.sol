//SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "../../dinero-markets/InterestBNBBearingMarket.sol";

contract TestInterestBNBBearingMarketV2 is InterestBNBBearingMarket {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
