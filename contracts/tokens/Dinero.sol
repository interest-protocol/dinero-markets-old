/*

░█▀▀▄ ▀█▀ ░█▄─░█ ░█▀▀▀ ░█▀▀█ ░█▀▀▀█
░█─░█ ░█─ ░█░█░█ ░█▀▀▀ ░█▄▄▀ ░█──░█
░█▄▄▀ ▄█▄ ░█──▀█ ░█▄▄▄ ░█─░█ ░█▄▄▄█

*/

//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/draft-ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @dev This is the stable coin of Interest Protocol that has it's value pegged to the USD and guaranteed by collateral in various markets and vaults.
 * The goal is to have Vaults and Markets be able to mint and burn them to keep the price pegged to USD based on their collateral.
 * The longer term vision for DINERO, is to give control to a DAO that will grant/revoke roles to other protocols to  grow this stable coin
 *
 * @notice Please note that roles have immense power and need to be granted to secure contracts, multisigs and timelocks.
 * @notice It supports https://eips.ethereum.org/EIPS/eip-2612[EIP-2612].
 * @notice We use the contract version 4.5.0, which gives an infinite allowance.
 * @notice This contract is upgradeable using the UUPS pattern with Open Zeppelin plugins. For security, the address with the {DEVELOPER_ROLE} will be a timelock.
 */
contract Dinero is
    Initializable,
    AccessControlUpgradeable,
    ERC20PermitUpgradeable,
    UUPSUpgradeable
{
    /*///////////////////////////////////////////////////////////////
                                ROLES
    //////////////////////////////////////////////////////////////*/

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant DEVELOPER_ROLE = keccak256("DEVELOPER_ROLE");

    /*///////////////////////////////////////////////////////////////
                            INITIALIZER
    //////////////////////////////////////////////////////////////*/

    /**
     * Requirements:
     *
     * - Can only be called at once and should be called during creation to prevent front running.
     */
    function initialize() external initializer {
        __Context_init();
        __UUPSUpgradeable_init();
        __ERC20_init("Dinero", "DNR");
        __ERC20Permit_init("Dinero");
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _msgSender());
        _grantRole(DEVELOPER_ROLE, _msgSender());
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

    /**
     * @dev A hook to guard the address that can update the implementation of this contract. It must have the {DEVELOPER_ROLE}.
     */
    function _authorizeUpgrade(address)
        internal
        override
        onlyRole(DEVELOPER_ROLE)
    //solhint-disable-next-line no-empty-blocks
    {

    }
}
