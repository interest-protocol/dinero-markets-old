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

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract InterestToken is Ownable, ERC20Votes {
    constructor()
        ERC20("Interest Token", "Int")
        ERC20Permit("Interest Token")
    // solhint-disable-next-line no-empty-blocks
    {

    }

    /**
     * @dev This function will be used by the MasterChef to distribute tokens to pool and farms
     * @param account The address to receive the new tokens
     * @param amount The `amount` of tokens to mint for the `account`
     *
     * This account has the modifier {onlyOwner} to make sure only the MasterChef contract can mint
     *
     */
    function mint(address account, uint256 amount) external onlyOwner {
        _mint(account, amount);
    }
}
