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
     * @param account The address whom the tokens will be destroyed
     * @param amount The number of `Staked Interest Token` that will be destroyed
     *
     * See {ERC20-_burn}.
     *
     * Requirements:
     *
     * The caller must be the {owner}.
     */
    function burn(address account, uint256 amount) external onlyOwner {
        _burn(account, amount);
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
    function burnFrom(address account, uint256 amount) external {
        uint256 currentAllowance = allowance(account, _msgSender());
        // solhint-disable-next-line reason-string
        require(
            currentAllowance >= amount,
            "ERC20: burn amount exceeds allowance"
        );
        unchecked {
            _approve(account, _msgSender(), currentAllowance - amount);
        }
        _burn(account, amount);
    }
}
