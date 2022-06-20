//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

import "../interfaces/IVenusVault.sol";

contract MockVenusVault is IVenusVault {
    uint256 public collateralLimit;

    constructor(uint256 _collateralLimit) {
        collateralLimit = _collateralLimit;
    }

    function setCollateralLimit(uint256 _collateralLimit) external {
        collateralLimit = _collateralLimit;
    }

    function transferToken(
        IERC20Upgradeable token,
        address dst,
        uint256 amount
    ) external {
        token.transfer(dst, amount);
    }
}
