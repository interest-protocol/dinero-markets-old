//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

import "../interfaces/IVenusVault.sol";

contract MockVenusVault is IVenusVault {
    uint256 public collateralLimit;

    constructor(uint256 _collateralLimit) {
        collateralLimit = _collateralLimit;
    }

    function setCollateralLimit(uint256 _collateralLimit) external {
        collateralLimit = _collateralLimit;
    }
}
