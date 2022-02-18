// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

import "../interfaces/IVToken.sol";
import "../interfaces/IVenusVault.sol";

import "../lib/IntMath.sol";
import "hardhat/console.sol";

//solhint-disable

contract MockSafeVenus {
    using IntMath for uint256;

    uint256 public constant DEFAULT = 1234;

    bool public _isProfitable;

    uint256 public _borrowInterestPerBlockCost;
    uint256 public _borrowInterestPerBlockReward;

    uint256 public _supplyRewardPerBlock;

    uint256 public _predictBorrowRate;

    uint256 public _predictSupplyRate;

    uint256 public _deleverage;

    uint256 public _safeReddem = DEFAULT;

    uint256 public safeRedeemReturn;

    uint256 public borrowBalance;
    uint256 public supplyBalance;

    mapping(IVToken => uint256) public vTokenCollateralFactor;

    function safeCollateralRatio(IVenusVault vault, IVToken vToken)
        public
        view
        returns (uint256)
    {
        return vault.collateralLimit().bmul(vTokenCollateralFactor[vToken]);
    }

    function borrowAndSupply(IVenusVault vault, IVToken vToken)
        public
        returns (uint256 borrow, uint256 supply)
    {
        borrow = vToken.borrowBalanceCurrent(address(vault));
        supply = vToken.balanceOfUnderlying(address(vault));
        borrowBalance = borrow;
        supplyBalance = supply;
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

    function safeBorrow(IVenusVault vault, IVToken vToken)
        external
        returns (uint256)
    {
        (uint256 borrow, uint256 supply) = borrowAndSupply(vault, vToken);
        uint256 collateralRatio = safeCollateralRatio(vault, vToken);

        return supply.bmul(collateralRatio) - borrow;
    }

    function safeRedeem(IVenusVault vault, IVToken vToken)
        public
        returns (uint256)
    {
        if (_safeReddem != DEFAULT) return _safeReddem;

        (uint256 borrow, uint256 supply) = borrowAndSupply(vault, vToken);

        uint256 collateralRatio = safeCollateralRatio(vault, vToken);

        uint256 result = supply - borrow.bdiv(collateralRatio);

        safeRedeemReturn = result;

        return result;
    }

    function __setSafeRedeem(uint256 amount) external {
        _safeReddem = amount;
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

    function __setVTokenCollateralFactor(IVToken vToken, uint256 amount)
        external
    {
        vTokenCollateralFactor[vToken] = amount;
    }
}
