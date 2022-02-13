//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

contract MockInterestRateModel {
    uint256 public _supplyRate;
    uint256 public _borrowRate;

    function getBorrowRate(
        uint256,
        uint256,
        uint256
    ) public view returns (uint256) {
        return _borrowRate;
    }

    function getSupplyRate(
        uint256,
        uint256,
        uint256,
        uint256
    ) public view returns (uint256) {
        return _supplyRate;
    }

    function __setBorrowRate(uint256 rate) external {
        _borrowRate = rate;
    }

    function __setSupplyRate(uint256 rate) external {
        _supplyRate = rate;
    }
}
