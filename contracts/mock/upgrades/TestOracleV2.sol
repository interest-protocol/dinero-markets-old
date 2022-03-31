//SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "../../OracleV1.sol";

contract TestOracleV2 is OracleV1 {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
