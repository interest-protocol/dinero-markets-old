// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

import "../interfaces/IVToken.sol";
import "../interfaces/IVenusVault.sol";

import "../lib/Math.sol";

//solhint-disable

/**
 * @dev We simplify this contract for easier calculations, but try to keep the core logic similar enough for testing
 */
contract MockSafeVenus {
    using Math for uint256;

    uint256 public constant DEFAULT = 1234;

    uint256 public _borrowInterestPerBlockCost;
    uint256 public _borrowInterestPerBlockReward;

    uint256 public _supplyRewardPerBlock;

    uint256 public _predictBorrowRate;

    uint256 public _predictSupplyRate;

    uint256 public _safeReddem = DEFAULT;

    uint256 public _totalBorrowsCurrent;

    uint256 public safeRedeemReturn;

    uint256 public _deleverageAmount = DEFAULT;

    uint256 public _supplyBalance;

    // Because we do not want to add complexity by mocking the Venus Controller
    mapping(IVToken => uint256) public vTokenCollateralFactor;

    function viewCurrentBorrow(IVToken vToken, address account)
        public
        view
        returns (uint256)
    {
        return vToken.borrowBalanceStored(account);
    }

    function viewExchangeRate(IVToken vToken) public view returns (uint256) {
        return vToken.exchangeRateStored();
    }

    function viewTotalBorrowsCurrent(IVToken) public view returns (uint256) {
        return _totalBorrowsCurrent;
    }

    function viewUnderlyingBalanceOf(IVToken vToken, address account)
        public
        view
        returns (uint256)
    {
        return
            IERC20Upgradeable(address(vToken)).balanceOf(account).wadMul(
                vToken.exchangeRateStored()
            );
    }

    function safeCollateralRatio(IVToken vToken, uint256 collateralLimit)
        public
        view
        returns (uint256)
    {
        return vTokenCollateralFactor[IVToken(vToken)].wadMul(collateralLimit);
    }

    function borrowAndSupply(IVToken vToken, address account)
        public
        returns (uint256 borrow, uint256 supply)
    {
        borrow = vToken.borrowBalanceStored(account);

        supply = vToken.balanceOfUnderlying(account);
    }

    function safeBorrow(
        IVToken vToken,
        address account,
        uint256 collateralLimit
    ) external returns (uint256) {
        (uint256 borrow, uint256 supply) = borrowAndSupply(vToken, account);
        uint256 collateralRatio = safeCollateralRatio(vToken, collateralLimit);

        return supply.wadMul(collateralRatio) - borrow;
    }

    function safeRedeem(
        IVToken vToken,
        address account,
        uint256 collateralLimit
    ) external returns (uint256) {
        if (_safeReddem != DEFAULT) return _safeReddem;

        (uint256 borrow, uint256 supply) = borrowAndSupply(vToken, account);

        if (borrow == 0) return supply;

        uint256 collateralRatio = safeCollateralRatio(vToken, collateralLimit);
        uint256 result = supply - borrow.wadDiv(collateralRatio);

        return result;
    }

    function __setSafeRedeem(uint256 amount) external {
        _safeReddem = amount;
    }

    function borrowInterestPerBlock(
        IVToken,
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
        IVToken,
        address,
        uint256
    ) public view returns (uint256) {
        return _supplyRewardPerBlock;
    }

    /**
     * @dev We simplify the logic to its core elements, to make sure the contract using it handles all scenarios.
     */
    function deleverage(
        IVToken vToken,
        address account,
        uint256 collateralLimit
    ) external returns (uint256) {
        if (_deleverageAmount != DEFAULT) return _deleverageAmount;

        // Get a safe ratio between borrow amount and collateral required.
        uint256 _collateralLimit = safeCollateralRatio(vToken, collateralLimit);

        // Get the current positions of the `vault` in the `vToken` market.
        (uint256 borrow, uint256 supply) = borrowAndSupply(vToken, account);

        // Maximum amount we can borrow based on our supply.
        uint256 maxSafeBorrowAmount = supply.wadMul(_collateralLimit);

        // If we are not above the maximum amount. We do not need to deleverage and return 0.
        if (maxSafeBorrowAmount >= borrow) return 0;

        // Get the Venus Protocol collateral requirement before liquidation
        uint256 venusCollateralFactor = vTokenCollateralFactor[IVToken(vToken)];

        // We add 15% safety room to the {venusCollateralFactor} to avoid liquidation.
        // We assume vaults are using values below 0.8e18 for their collateral ratio
        uint256 safeSupply = borrow.wadDiv(
            venusCollateralFactor.wadMul(0.9e18)
        );

        if (safeSupply > supply) {
            // if the supply is still lower, then it should throw
            uint256 amount = supply -
                borrow.wadDiv(venusCollateralFactor.wadMul(0.95e18));

            // Cannot withdraw more than liquidity
            return amount;
        }

        // Cannot withdraw more than liquidity
        return (supply - safeSupply);
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

    // Because we do not want to add complexity by mocking the Venus Controller
    function __setDeleverageAmount(uint256 amount) external {
        _deleverageAmount = amount;
    }

    // Because we do not want to add complexity by mocking the Venus Controller
    function __setTotalborrowsCurrent(uint256 amount) external {
        _totalBorrowsCurrent = amount;
    }

    function __setSupplyBalance(uint256 amount) external {
        _supplyBalance = amount;
    }
}
