//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "../../master-chef-vaults/CakeVault.sol";

contract TestCakeVaultV2 is CakeVault {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
