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

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @dev This is ta receipt token that represents Interest Token farming in the Casa de Papel. Since, Casa de Papel allows for another contract to withdraw tokens in behalf of another user. This token price will essentially be pegged to the Interest Token price.
 * It will be given only when a user deposits Interest Token in the Casa de Papel.
 *
 * @notice It is literally a copy of the Interest Protocol.
 * @notice To withdraw Interest Tokens in the Casa de Papel, the address must have an equivalent amount of this token.
 * @notice The supply is always equal to the amount of {StakedInterestToken}.
 * @notice The ownership will be given to the Casa de Papel without any pre-minting.
 */
contract StakedInterestToken is Ownable, ERC20Votes {
    constructor()
        ERC20("Staked Interest Token", "sInt")
        ERC20Permit("Staked Interest Token")
    // solhint-disable-next-line no-empty-blocks
    {

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
    function mint(address account, uint256 amount) external onlyOwner {
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
    function burn(address account, uint256 amount) external onlyOwner {
        _burn(account, amount);
    }
}
