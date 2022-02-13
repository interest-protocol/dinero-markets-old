//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

contract MockInterestRateModel {
    event BorrowRateArgs(
        uint256 cash,
        uint256 totalBorrow,
        uint256 totalReserves
    );

    event SupplyRateArgs(
        uint256 cash,
        uint256 totalBorrow,
        uint256 totalReserves,
        uint256 mantissa
    );

    uint256 public _supplyRate;
    uint256 public _borrowRate;

    function getBorrowRate(
        uint256 cash,
        uint256 totalBorrow,
        uint256 totalReserves
    ) external returns (uint256) {
        emit BorrowRateArgs(cash, totalBorrow, totalReserves);

        return _borrowRate;
    }

    function getSupplyRate(
        uint256 cash,
        uint256 totalBorrow,
        uint256 totalReserves,
        uint256 mantissa
    ) external returns (uint256) {
        emit SupplyRateArgs(cash, totalBorrow, totalReserves, mantissa);
        return _supplyRate;
    }

    function __setBorrowRate(uint256 rate) external {
        _borrowRate = rate;
    }

    function __setSupplyRate(uint256 rate) external {
        _supplyRate = rate;
    }
}
