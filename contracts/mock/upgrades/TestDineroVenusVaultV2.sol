//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "../TestDineroVenusVault.sol";

contract TestDineroVenusVaultV2 is TestDineroVenusVault {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
