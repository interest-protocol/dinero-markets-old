//SPDX-License-Identifier: MIT
pragma solidity 0.8.12;

import "../../DineroVault.sol";

contract TestDineroVaultV2 is DineroVault {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
