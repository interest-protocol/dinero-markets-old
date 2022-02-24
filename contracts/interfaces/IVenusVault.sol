// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

interface IVenusVault {
    function collateralLimit() external view returns (uint256);
}
