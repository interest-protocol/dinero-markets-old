/*

░█▀▀▄ ▀█▀ ░█▄─░█ ░█▀▀▀ ░█▀▀█ ░█▀▀▀█
░█─░█ ░█─ ░█░█░█ ░█▀▀▀ ░█▄▄▀ ░█──░█
░█▄▄▀ ▄█▄ ░█──▀█ ░█▄▄▄ ░█─░█ ░█▄▄▄█

*/

//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/draft-ERC20Permit.sol";

/**
 * @dev This is the stable coin of Interest Protocol that has it's value pegged to the USD and guaranteed by collateral in various markets and vaults.
 * The goal is to have Vaults and Markets be able to mint and burn them to keep the price pegged to USD based on their collateral.
 *
 * @notice Please note that roles have immense power and need to be granted to secure contracts, multisigs and timelocks.
 * @notice It supports https://eips.ethereum.org/EIPS/eip-2612[EIP-2612].
 * @notice We use the contract version 4.5.0-rc.0, which the allowance does not go down on {transferFrom} if the allowance is the max uint256.
 */
contract Dinero is AccessControl, ERC20Permit {
    /*///////////////////////////////////////////////////////////////
                                ROLES
    //////////////////////////////////////////////////////////////*/

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    /*///////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor() ERC20("Dinero", "DNR") ERC20Permit("Dinero") {
        _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());
    }

    /*///////////////////////////////////////////////////////////////
                        ROLE BASED FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Creates `amount` of tokens for the `account` address.
     *
     * @notice Markets and Vaults contracts will create `Dinero` to lend to borrowers or as a receipt token to a basket of tokens.
     *
     * @param account The address to whom the new tokens will be created to.
     * @param amount The number of tokens to create.
     *
     * Requirements:
     *
     * - The caller must have the `MINTER_ROLE`
     */
    function mint(address account, uint256 amount)
        external
        onlyRole(MINTER_ROLE)
    {
        _mint(account, amount);
    }

    /**
     * @dev Destroys `amount` tokens from `account`. Only callable by the `BURNER_ROLE` role.
     *
     * @notice Only contracts can have access to this role as it can burn tokens from any account.
     *
     * @param account The address whom the tokens will be burned
     * @param amount The number of `DINERO` tokens to burn
     *
     * Requirements:
     *
     * - The caller must have the `BURNER_ROLE`
     */
    function burn(address account, uint256 amount)
        external
        onlyRole(BURNER_ROLE)
    {
        _burn(account, amount);
    }
}
