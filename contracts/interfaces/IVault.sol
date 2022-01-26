// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

interface IVault {
    function deposit(
        address from,
        address to,
        uint256 amount
    ) external;

    function withdraw(
        address account,
        address recipient,
        uint256 amount
    ) external;

    function compound() external;
}
