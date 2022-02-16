// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

//solhint-disable

contract MockSafeVenus {
    uint256 public _safeCollateralRatio;

    uint256 public _borrow;

    uint256 public _supply;

    bool public _isProfitable;

    uint256 public _safeBorrow;

    uint256 public _safeRedeem;

    uint256 public _borrowInterestPerBlockCost;
    uint256 public _borrowInterestPerBlockReward;

    uint256 public _supplyRewardPerBlock;

    uint256 public _predictBorrowRate;

    uint256 public _predictSupplyRate;

    uint256 public _deleverage;

    function safeCollateralRatio(address, address)
        public
        view
        returns (uint256)
    {
        return _safeCollateralRatio;
    }

    function __setSafeCollateralRatio(uint256 amount) external {
        _safeCollateralRatio = amount;
    }

    function borrowAndSupply(address, address)
        public
        view
        returns (uint256 borrow, uint256 supply)
    {
        borrow = _borrow;
        supply = _supply;
    }

    function __setBorrowAndSupply(uint256 borrow, uint256 supply) external {
        _borrow = borrow;
        _supply = supply;
    }

    function isProfitable(
        address,
        address,
        uint256
    ) external view returns (bool) {
        return _isProfitable;
    }

    function __setIsProfitable(bool predicate) external {
        _isProfitable = predicate;
    }

    function safeBorrow(address, address) external view returns (uint256) {
        return _safeBorrow;
    }

    function __setSafeBorrow(uint256 amount) external {
        _safeBorrow = amount;
    }

    function safeRedeem(address, address) public view returns (uint256) {
        return _safeRedeem;
    }

    function __safeRedeem(uint256 amount) external {
        _safeRedeem = amount;
    }

    function borrowInterestPerBlock(
        address,
        address,
        uint256
    ) public view returns (uint256, uint256) {
        return (_borrowInterestPerBlockCost, _borrowInterestPerBlockReward);
    }

    function __setBorrowInterestPerBlock(uint256 cost, uint256 profit)
        external
    {
        _borrowInterestPerBlockCost = cost;
        _borrowInterestPerBlockReward = profit;
    }

    function supplyRewardPerBlock(
        address,
        address,
        uint256
    ) public view returns (uint256) {
        return _supplyRewardPerBlock;
    }

    function __setSupplyRewardPerBlock(uint256 amount) external {
        _supplyRewardPerBlock = amount;
    }

    function predictBorrowRate(address, uint256) public view returns (uint256) {
        return _predictBorrowRate;
    }

    function __setPredictBorrowRate(uint256 amount) external {
        _predictBorrowRate = amount;
    }

    function predictSupplyRate(address, uint256) public view returns (uint256) {
        return _predictSupplyRate;
    }

    function __predictSupplyRate(uint256 amount) external {
        _predictSupplyRate = amount;
    }

    function deleverage(address, address) external view returns (uint256) {
        return _deleverage;
    }

    function __setDeleverage(uint256 amount) external {
        _deleverage = amount;
    }
}
