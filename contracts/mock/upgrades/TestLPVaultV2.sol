//SPDX-License-Identifier: MIT
pragma solidity 0.8.12;

import "../../master-chef-vaults/LPVault.sol";

contract TestLPVaultV2 is LPVault {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
