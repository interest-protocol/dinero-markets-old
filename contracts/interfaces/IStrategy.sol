// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

interface IZeroLossStrategy {
    function deposit(address underlying, uint256 amount) external;

    function withdraw(
        address underlying,
        uint256 amount,
        address to
    ) external;

    function totalBalance() external returns (uint256);

    function getPendingRewards(address amount) external returns (uint256);
}
