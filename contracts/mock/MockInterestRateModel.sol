//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

contract MockInterestRateModel {
    uint256 public _supplyRate;
    uint256 public _borrowRate;

    function getBorrowRate(
        uint256 amount,
        uint256,
        uint256
    ) external view returns (uint256) {
        if (amount == 0) return 1 ether;
        return _borrowRate;
    }

    function getSupplyRate(
        uint256 amount,
        uint256,
        uint256,
        uint256
    ) external view returns (uint256) {
        if (amount == 0) return 1 ether;
        return _supplyRate;
    }

    function __setBorrowRate(uint256 rate) external {
        _borrowRate = rate;
    }

    function __setSupplyRate(uint256 rate) external {
        _supplyRate = rate;
    }
}
