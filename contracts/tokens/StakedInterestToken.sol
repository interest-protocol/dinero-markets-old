/*


░██████╗████████╗░█████╗░██╗░░██╗███████╗██████╗░  ██╗███╗░░██╗████████╗███████╗██████╗░███████╗░██████╗████████╗
██╔════╝╚══██╔══╝██╔══██╗██║░██╔╝██╔════╝██╔══██╗  ██║████╗░██║╚══██╔══╝██╔════╝██╔══██╗██╔════╝██╔════╝╚══██╔══╝
╚█████╗░░░░██║░░░███████║█████═╝░█████╗░░██║░░██║  ██║██╔██╗██║░░░██║░░░█████╗░░██████╔╝█████╗░░╚█████╗░░░░██║░░░
░╚═══██╗░░░██║░░░██╔══██║██╔═██╗░██╔══╝░░██║░░██║  ██║██║╚████║░░░██║░░░██╔══╝░░██╔══██╗██╔══╝░░░╚═══██╗░░░██║░░░
██████╔╝░░░██║░░░██║░░██║██║░╚██╗███████╗██████╔╝  ██║██║░╚███║░░░██║░░░███████╗██║░░██║███████╗██████╔╝░░░██║░░░
╚═════╝░░░░╚═╝░░░╚═╝░░╚═╝╚═╝░░╚═╝╚══════╝╚═════╝░  ╚═╝╚═╝░░╚══╝░░░╚═╝░░░╚══════╝╚═╝░░╚═╝╚══════╝╚═════╝░░░░╚═╝░░░

████████╗░█████╗░██╗░░██╗███████╗███╗░░██╗
╚══██╔══╝██╔══██╗██║░██╔╝██╔════╝████╗░██║
░░░██║░░░██║░░██║█████═╝░█████╗░░██╔██╗██║
░░░██║░░░██║░░██║██╔═██╗░██╔══╝░░██║╚████║
░░░██║░░░╚█████╔╝██║░╚██╗███████╗██║░╚███║
░░░╚═╝░░░░╚════╝░╚═╝░░╚═╝╚══════╝╚═╝░░╚══╝

*/

//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20VotesUpgradeable.sol";

/**
 * @dev This is ta receipt token that represents Interest Token farming in the Casa de Papel. Since, Casa de Papel allows for another contract to withdraw tokens in behalf of another user. This token price will essentially be pegged to the Interest Token price.
 * It will be given only when a user deposits Interest Token in the Casa de Papel.
 *
 * @notice It is literally a copy of the Interest Protocol.
 * @notice To withdraw Interest Tokens in the Casa de Papel, the address must have an equivalent amount of this token.
 * @notice The supply is always equal to the amount of {StakedInterestToken}.
 * @notice The ownership will be given to the Casa de Papel without any pre-minting.
 */
contract StakedInterestToken is
    Initializable,
    AccessControlUpgradeable,
    ERC20VotesUpgradeable,
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

    function initialize() external initializer {
        __Context_init();
        __UUPSUpgradeable_init();
        __ERC20Votes_init();
        __ERC20_init("Staked Interest Token", "sInt");
        __ERC20Permit_init("Staked Interest Token");
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _msgSender());
        _grantRole(DEVELOPER_ROLE, _msgSender());
    }

    /**
     * @dev This function will be used by the MasterChef to distribute tokens to pool and farms.
     *
     * @param account The address to receive the new tokens.
     * @param amount The `amount` of tokens to mint for the `account`.
     *
     * Requirements:
     *
     * - We cannot allow an arbitrary address to mint tokens.
     */
    function mint(address account, uint256 amount)
        external
        onlyRole(MINTER_ROLE)
    {
        _mint(account, amount);
    }

    /**
     * @dev Destroys `amount` tokens from the caller.
     *
     * @param account The address whom the tokens will be destroyed
     * @param amount The number of `Staked Interest Token` that will be destroyed
     *
     * See {ERC20-_burn}.
     *
     * Requirements:
     *
     * - The caller must be the {owner}.
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
