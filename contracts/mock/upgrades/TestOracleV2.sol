//SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "../../Oracle.sol";

contract TestOracleV2 is Oracle {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
