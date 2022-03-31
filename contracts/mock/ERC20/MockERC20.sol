// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor(
        string memory name,
        string memory symbol,
        uint256 initialSupply
    ) ERC20(name, symbol) {
        _mint(_msgSender(), initialSupply);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setAllowance(
        address owner,
        address spender,
        uint256 amount
    ) external {
        _approve(owner, spender, amount);
    }
}
