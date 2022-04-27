// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import "../../interfaces/IVenusController.sol";
import "../../interfaces/IVToken.sol";
import "../../interfaces/IPancakeRouter02.sol";

import "../../tokens/Dinero.sol";

import "../../DineroLeveragedVenusVault.sol";
import "../../SafeVenus.sol";

//solhint-disable

contract TestDineroVenusVault is DineroLeveragedVenusVault {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // Testing
    function borrow(IVToken vToken, uint256 amount) external {
        vToken.borrow(amount);
    }

    function burnERC20(IERC20Upgradeable token, uint256 amount) external {
        token.transfer(address(0xdead), amount);
    }

    function donate(address underlying, uint256 amount) external {
        // There is no reason to call this function as "harvest" because we "compound" the rewards as they are already being supplied.
        require(amount > 0, "DV: no zero amount");
        // Get the VToken of the `underlying`.
        IVToken vToken = vTokenOf[underlying];

        // Get User Account data
        UserAccount memory userAccount = accountOf[underlying][_msgSender()];

        // We need to get the underlying from the `msg.sender` before we mint V Tokens.
        // Get the underlying from the user.
        IERC20Upgradeable(underlying).safeTransferFrom(
            _msgSender(),
            address(this),
            amount
        );

        // Supply underlying to Venus right away to start earning.
        // It returns the new VTokens minted.
        uint256 vTokensMinted = _mintVToken2(vToken, amount);

        accountOf[underlying][FEE_TO].vTokens += uint128(vTokensMinted);

        // Update global state
        accountOf[underlying][_msgSender()] = userAccount;

        emit Deposit(_msgSender(), underlying, amount, vTokensMinted);
    }

    /**
     * @dev Helper function to supply underlying to a `vToken` to mint vTokens and know how many vTokens we got.
     * It supplies all underlying.
     *
     * @param vToken The vToken market we wish to mint.
     */
    function _mintVToken2(IVToken vToken, uint256 amount)
        private
        returns (uint256 mintedAmount)
    {
        // Find how many VTokens we currently have.
        uint256 balanceBefore = IERC20Upgradeable(address(vToken)).balanceOf(
            address(this)
        );

        // Supply ALL underlyings present in the contract even lost tokens to mint VTokens. It will revert if it fails.
        vToken.mint(amount);

        // Subtract the new balance from the previous one, to find out how many VTokens we minted.
        mintedAmount =
            IERC20Upgradeable(address(vToken)).balanceOf(address(this)) -
            balanceBefore;
    }
}
