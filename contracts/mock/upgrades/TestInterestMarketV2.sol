//SPDX-License-Identifier: MIT
pragma solidity 0.8.12;

import "../../dinero-markets/InterestMarketV1.sol";

contract TestInterestMarketV2 is InterestMarketV1 {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
