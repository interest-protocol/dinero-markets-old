//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "../../SafeVenus.sol";

contract TestSafeVenusV2 is SafeVenus {
    function version() external pure returns (string memory) {
        return "V2";
    }
}
