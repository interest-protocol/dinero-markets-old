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

contract StakedInterestToken is Ownable, ERC20Votes {
    constructor()
        ERC20("Staked Interest Token", "sInt")
        ERC20Permit("Staked Interest Token")
    // solhint-disable-next-line no-empty-blocks
    {

    }

    /**
     * @dev This function will be used to mint sInt as a receipt token by the Master Chef.
     * @param account The address to receive the new tokens
     * @param amount The `amount` of tokens to mint for the `account`
     *
     * This account has the modifier {onlyOwner} to make sure only the MasterChef contract can mint
     *
     */
    function mint(address account, uint256 amount) external onlyOwner {
        _mint(account, amount);
    }

    /**
     * @dev Destroys `amount` tokens from the caller.
     *
     * This account has the modifier {onlyOwner} to make sure only the MasterChef contract can burn tokens
     */
    function burn(address account, uint256 amount) external onlyOwner {
        _burn(account, amount);
    }
}
