// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.12;

interface IVenusVault {
    function collateralLimit() external view returns (uint256);
}
