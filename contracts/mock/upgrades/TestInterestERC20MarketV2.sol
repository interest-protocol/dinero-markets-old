//SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "../../dinero-markets/InterestERC20Market.sol";

contract TestInterestERC20MarketV2 is InterestERC20Market {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
