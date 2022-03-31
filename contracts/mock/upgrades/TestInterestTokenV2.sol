//SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "../../tokens/InterestToken.sol";

contract TestInterestTokenV2 is InterestToken {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
