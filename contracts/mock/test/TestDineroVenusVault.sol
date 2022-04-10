// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

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

    function burnERC20(IERC20Upgradeable token, uint256 amount) external {
        token.transfer(address(0xdead), amount);
    }
}
