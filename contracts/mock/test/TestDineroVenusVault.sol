// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

import "../../interfaces/IVenusController.sol";
import "../../interfaces/IVToken.sol";
import "../../interfaces/IPancakeRouter02.sol";

import "../../tokens/Dinero.sol";

import "../../DineroLeveragedVenusVault.sol";
import "../../SafeVenus.sol";

//solhint-disable

contract TestDineroVenusVault is DineroLeveragedVenusVault {
    // Testing
    function borrow(IVToken vToken, uint256 amount) external {
        vToken.borrow(amount);
    }
}
