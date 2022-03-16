// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.12;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20Decimals is ERC20 {
    uint8 private _decimals;

    constructor(
        string memory name,
        string memory symbol,
        uint256 initialSupply,
        uint8 __decimals
    ) ERC20(name, symbol) {
        _mint(_msgSender(), initialSupply);
        _decimals = __decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public view override(ERC20) returns (uint8) {
        return _decimals;
    }

    function setAllowance(
        address owner,
        address spender,
        uint256 amount
    ) external {
        _approve(owner, spender, amount);
    }
}
