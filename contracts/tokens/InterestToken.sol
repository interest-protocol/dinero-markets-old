/*

██╗███╗░░██╗████████╗███████╗██████╗░███████╗░██████╗████████╗  ████████╗░█████╗░██╗░░██╗███████╗███╗░░██╗
██║████╗░██║╚══██╔══╝██╔════╝██╔══██╗██╔════╝██╔════╝╚══██╔══╝  ╚══██╔══╝██╔══██╗██║░██╔╝██╔════╝████╗░██║
██║██╔██╗██║░░░██║░░░█████╗░░██████╔╝█████╗░░╚█████╗░░░░██║░░░  ░░░██║░░░██║░░██║█████═╝░█████╗░░██╔██╗██║
██║██║╚████║░░░██║░░░██╔══╝░░██╔══██╗██╔══╝░░░╚═══██╗░░░██║░░░  ░░░██║░░░██║░░██║██╔═██╗░██╔══╝░░██║╚████║
██║██║░╚███║░░░██║░░░███████╗██║░░██║███████╗██████╔╝░░░██║░░░  ░░░██║░░░╚█████╔╝██║░╚██╗███████╗██║░╚███║
╚═╝╚═╝░░╚══╝░░░╚═╝░░░╚══════╝╚═╝░░╚═╝╚══════╝╚═════╝░░░░╚═╝░░░  ░░░╚═╝░░░░╚════╝░╚═╝░░╚═╝╚══════╝╚═╝░░╚══╝

*/

//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20VotesUpgradeable.sol";

/**
 * @dev This is the governance token of the Interest Protocol. It will be given by the Casa de Papel to attract liquidity to desired pairs.
 *
 * @notice Value of the token is to dictate the future of protocol and get a share of the fees via deflation.
 * @notice The token has no maximum supply. And it's minting rate is dictated by the Casa de Papel. The idea is to have protocol fees from markets and future products be used to {burn} tokens.
 * @notice Please note that owner will be the deployer. An initial amount might be minted for a private sale before the ownership if given to the Casa de Papel.
 * @notice It supports https://eips.ethereum.org/EIPS/eip-2612[EIP-2612].
 * @notice It implements {ERC20Votes} for governance purposes.
 * @notice We use the contract version 4.5.0-rc.0, which the allowance does not go down on {transferFrom} if the allowance is the max uint256.
 * This is critical for composability with the {StakedInterestToken}.
 */
contract InterestToken is
    Initializable,
    AccessControlUpgradeable,
    ERC20VotesUpgradeable,
    UUPSUpgradeable
{
    /*///////////////////////////////////////////////////////////////
                                ROLES
    //////////////////////////////////////////////////////////////*/

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
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
        __ERC20_init("Interest Token", "Int");
        __ERC20Permit_init("Interest Token");

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
     * See {ERC20-_burn}.
     */
    function burn(uint256 amount) public {
        _burn(_msgSender(), amount);
    }

    /**
     * @dev Destroys `amount` tokens from `account`, deducting from the caller's
     * allowance.
     *
     * See {ERC20-_burn} and {ERC20-allowance}.
     *
     * Requirements:
     *
     * - the caller must have allowance for ``accounts``'s tokens of at least
     * `amount`.
     */
    function burnFrom(address account, uint256 amount) public {
        uint256 currentAllowance = allowance(account, _msgSender());
        //solhint-disable-next-line reason-string
        require(
            currentAllowance >= amount,
            "ERC20: burn amount exceeds allowance"
        );
        unchecked {
            _approve(account, _msgSender(), currentAllowance - amount);
        }
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
