//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "../../CasaDePapel.sol";

contract TestCasaDePapelV2 is CasaDePapel {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
