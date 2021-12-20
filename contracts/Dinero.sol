/*

░█▀▀▄ ▀█▀ ░█▄─░█ ░█▀▀▀ ░█▀▀█ ░█▀▀▀█
░█─░█ ░█─ ░█░█░█ ░█▀▀▀ ░█▄▄▀ ░█──░█
░█▄▄▀ ▄█▄ ░█──▀█ ░█▄▄▄ ░█─░█ ░█▄▄▄█

*/

//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/draft-ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

contract Dinero is AccessControl, ERC20Permit, ERC20Burnable {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    constructor() ERC20("Dinero", "DNR") ERC20Permit("Dinero") {
        _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());
    }

    /**
     * @dev Creates `amount` of tokens for the `account` address.
     * @param account The address to whom the new tokens will be created to.
     * @param amount The number of tokens to create.
     *
     * Market contracts will create `Dinero` to lend to borrowers.
     *
     */
    function mint(address account, uint256 amount)
        external
        onlyRole(MINTER_ROLE)
    {
        _mint(account, amount);
    }

    /**
     * @dev Destroys an `amount` of tokens from the `account`.
     * @param account The address that will have it's tokens destroyed.
     * @param amount The number of tokens to destroy.
     *
     * Market contracts will burn `Dinero` on repayments and liquidations.
     * This is to avoid users to have to approve before burning
     *
     */
    function forcedBurn(address account, uint256 amount)
        external
        onlyRole(BURNER_ROLE)
    {
        _burn(account, amount);
    }
}
