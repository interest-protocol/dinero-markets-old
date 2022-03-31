//SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "../../PancakeOracle.sol";

contract TestPancakeOracleV2 is PancakeOracle {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
