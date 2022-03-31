//SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "../test/TestDineroVenusVault.sol";

contract TestDineroVenusVaultV2 is TestDineroVenusVault {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
