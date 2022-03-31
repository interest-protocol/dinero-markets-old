//SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "../../dinero-markets/InterestERC20BearingMarket.sol";

contract TestInterestERC20BearingMarketV2 is InterestERC20BearingMarket {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
