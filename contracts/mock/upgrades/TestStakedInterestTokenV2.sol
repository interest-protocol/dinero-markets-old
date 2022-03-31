//SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "../../tokens/StakedInterestToken.sol";

contract TestStakedInterestTokenV2 is StakedInterestToken {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
