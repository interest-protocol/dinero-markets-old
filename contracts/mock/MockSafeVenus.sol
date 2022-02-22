// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

import "../interfaces/IVToken.sol";
import "../interfaces/IVenusVault.sol";

import "../lib/IntMath.sol";
import "hardhat/console.sol";

//solhint-disable

/**
 * @dev We simplify this contract for easier calculations, but try to keep the core logic similar enough for testing
 */
contract MockSafeVenus {
    using IntMath for uint256;

    uint256 public constant DEFAULT = 1234;

    bool public _isProfitable;

    uint256 public _borrowInterestPerBlockCost;
    uint256 public _borrowInterestPerBlockReward;

    uint256 public _supplyRewardPerBlock;

    uint256 public _predictBorrowRate;

    uint256 public _predictSupplyRate;

    uint256 public _safeReddem = DEFAULT;

    uint256 public safeRedeemReturn;

    uint256 public borrowBalance;
    uint256 public supplyBalance;

    // Because we do not want to add complexity by mocking the Venus Controller
    mapping(IVToken => uint256) public vTokenCollateralFactor;

    function safeCollateralRatio(IVenusVault vault, IVToken vToken)
        public
        view
        returns (uint256)
    {
        return vTokenCollateralFactor[vToken].bmul(vault.collateralLimit());
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

    function deleverage(IVenusVault vault, IVToken vToken)
        external
        returns (uint256)
    {
        // Get a safe ratio between borrow amount and collateral required.
        uint256 _collateralLimit = safeCollateralRatio(vault, vToken);

        // Get the current positions of the `vault` in the `vToken` market.
        (uint256 borrow, uint256 supply) = borrowAndSupply(vault, vToken);

        // Maximum amount we can borrow based on our supply.
        uint256 maxSafeBorrowAmount = supply.bmul(_collateralLimit);
        console.log(_collateralLimit, "_collateralLimit");
        console.log(maxSafeBorrowAmount, "maxSafeBorrowAmount");
        console.log(borrow, "borrow");
        // If we are not above the maximum amount. We do not need to deleverage and return 0.
        if (maxSafeBorrowAmount >= borrow) return 0;

        // Get the Venus Protocol collateral requirement before liquidation
        uint256 venusCollateralFactor = vTokenCollateralFactor[vToken];

        uint256 maxBorrow = venusCollateralFactor.bmul(supply);

        // Cannot withdraw more than liquidity
        return maxBorrow - borrow;
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

    // Because we do not want to add complexity by mocking the Venus Controller
    function __setVTokenCollateralFactor(IVToken vToken, uint256 amount)
        external
    {
        vTokenCollateralFactor[vToken] = amount;
    }
}
