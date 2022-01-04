/*

░█▀▀▄ ▀█▀ ░█▄─░█ ░█▀▀▀ ░█▀▀█ ░█▀▀▀█
░█─░█ ░█─ ░█░█░█ ░█▀▀▀ ░█▄▄▀ ░█──░█
░█▄▄▀ ▄█▄ ░█──▀█ ░█▄▄▄ ░█─░█ ░█▄▄▄█

*/

//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/draft-ERC20Permit.sol";

contract Dinero is AccessControl, ERC20Permit {
    /**************************** ROLES ****************************/

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    /**************************** CONSTRUCTOR ****************************/

    constructor() ERC20("Dinero", "DNR") ERC20Permit("Dinero") {
        _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());
    }

    /**************************** RESTRICTED FUNCTIONS ****************************/

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
     * @dev Destroys `amount` tokens from `account`. Only callable by `BURNER_ROLE` role.
     * @param account The address whom the tokens will be burned
     * @param amount The number of `DINERO` tokens to burn
     *
     * Requirements:
     *
     * The caller must have the `BURNER_ROLE`
     */
    function burn(address account, uint256 amount)
        external
        onlyRole(BURNER_ROLE)
    {
        _burn(account, amount);
    }
}
