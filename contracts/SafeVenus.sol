//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "./interfaces/IVenustroller.sol";
import "./interfaces/IVToken.sol";
import "./interfaces/IVenusPriceOracle.sol";
import "./interfaces/IVenusVault.sol";
import "./interfaces/IVenusInterestRateModel.sol";

import "./lib/IntMath.sol";

import "./OracleV1.sol";

contract SafeVenus {
    using IntMath for uint256;

    // solhint-disable-next-line var-name-mixedcase
    address public immutable XVS;

    // solhint-disable-next-line var-name-mixedcase
    IVenustroller public immutable VENUS_TROLLER;

    // solhint-disable-next-line var-name-mixedcase
    OracleV1 public immutable ORACLE;

    constructor(
        IVenustroller venustroller,
        address xvs,
        OracleV1 oracle
    ) {
        VENUS_TROLLER = venustroller;
        XVS = xvs;
        ORACLE = oracle;
    }

    function getVTokenBorrowLiquidity(address vToken) public returns (uint256) {
        uint256 underlyingSupply = IERC20(vToken).totalSupply().bmul(
            IVToken(vToken).exchangeRateCurrent()
        );
        uint256 totalBorrowCurrent = IVToken(vToken).totalBorrowsCurrent();
        uint256 marketLiquidity = underlyingSupply > totalBorrowCurrent
            ? underlyingSupply - totalBorrowCurrent
            : 0;
        return marketLiquidity.bmul(0.9e18);
    }

    function getVenusBorrowAndSupply(address vault, address vToken)
        public
        returns (uint256 borrow, uint256 supply)
    {
        borrow = IVToken(vToken).borrowBalanceCurrent(vault);
        supply = IVToken(vToken).balanceOfUnderlying(vault);
    }

    function getSafeCollateralLimit(IVenusVault vault, address vToken)
        public
        view
        returns (uint256)
    {
        (, uint256 venusCollateralFactor, ) = VENUS_TROLLER.markets(vToken);
        uint256 enforcedLimit = venusCollateralFactor.bmul(
            vault.collateralLimit()
        );
        uint256 optimalLimit = IVToken(vToken).supplyRatePerBlock().bdiv(
            IVToken(vToken).borrowRatePerBlock()
        );
        return enforcedLimit.min(optimalLimit);
    }

    function getVTokenBorrowAmount(IVenusVault vault, address vToken)
        external
        returns (uint256)
    {
        uint256 _collateralLimit = getSafeCollateralLimit(vault, vToken);
        (uint256 borrow, uint256 supply) = getVenusBorrowAndSupply(
            address(vault),
            vToken
        );

        uint256 currentCollateralFactor = borrow.bdiv(supply);

        if (currentCollateralFactor >= _collateralLimit) {
            return 0;
        }

        uint256 maxBorrowAmount = supply.bmul(_collateralLimit);
        uint256 newBorrowAmount = maxBorrowAmount.min(
            getVTokenBorrowLiquidity(vToken)
        );

        uint256 newBorrowAmountRatio = borrow > 0
            ? newBorrowAmount.bdiv(borrow)
            : 0;

        // We ignore borrowing less than 5% of the current borrow.
        if (newBorrowAmountRatio > 0 && newBorrowAmountRatio <= 0.05e18)
            return 0;

        (
            uint256 borrowInterestUSD,
            uint256 rewardInterestUSD
        ) = getVenusBorrowInterestPerBlock(vault, vToken, newBorrowAmount);

        uint256 supplyInterestUSD = getVenusSupplyRewardPerBlock(
            vault,
            vToken,
            newBorrowAmount
        );

        // 0 represents do not borrow.
        return
            supplyInterestUSD + rewardInterestUSD >
                borrowInterestUSD + borrowInterestUSD.bmul(0.2e18)
                ? newBorrowAmount
                : 0;
    }

    function getVenusBorrowInterestPerBlock(
        IVenusVault vault,
        address vToken,
        uint256 borrowAmount
    ) public returns (uint256, uint256) {
        require(borrowAmount > 0, "SV: no amount 0");
        uint256 totalBorrow = IVToken(vToken).totalBorrowsCurrent() +
            borrowAmount;
        uint256 vaultBorrow = IVToken(vToken).borrowBalanceCurrent(
            address(vault)
        ) + borrowAmount;

        uint256 xvsUSDPerBlock = ORACLE.getTokenUSDPrice(
            XVS,
            // Venus speed has 18 decimals
            (VENUS_TROLLER.venusSpeeds(vToken) * vaultBorrow) / totalBorrow
        );

        uint256 borrowInterestRatePerBlock = _predictBorrowRate(
            IVToken(vToken),
            borrowAmount
        );

        uint256 underlyingUSDPerBlock = ORACLE.getTokenUSDPrice(
            IVToken(vToken).underlying(),
            borrowInterestRatePerBlock
        );

        return (underlyingUSDPerBlock, xvsUSDPerBlock);
    }

    function getVenusSupplyRewardPerBlock(
        IVenusVault vault,
        address vToken,
        uint256 borrowAmount
    ) public returns (uint256) {
        uint256 totalUnderlying = IERC20(vToken).totalSupply().bmul(
            IVToken(vToken).exchangeRateCurrent()
        );

        uint256 vaultUnderlyingBalance = IVToken(vToken).balanceOfUnderlying(
            address(vault)
        );

        uint256 xvsAmountUSD = ORACLE.getTokenUSDPrice(
            XVS,
            ((VENUS_TROLLER.venusSpeeds(vToken) * vaultUnderlyingBalance) /
                totalUnderlying)
        );

        return
            _predictSupplyRate(IVToken(vToken), borrowAmount).bmul(
                vaultUnderlyingBalance
            ) + xvsAmountUSD;
    }

    function _predictBorrowRate(IVToken vToken, uint256 borrowAmount)
        private
        returns (uint256)
    {
        uint256 cash = vToken.getCash();
        // No point to predict if we wanna borrow more than the liquidity
        if (borrowAmount >= cash) return vToken.borrowRatePerBlock();

        IVenusInterestRateModel interestRateModel = IVenusInterestRateModel(
            vToken.interestRateModel()
        );

        return
            interestRateModel.getBorrowRate(
                cash - borrowAmount,
                vToken.totalBorrowsCurrent() + borrowAmount,
                vToken.totalReserves()
            );
    }

    function _predictSupplyRate(IVToken vToken, uint256 borrowAmount)
        private
        returns (uint256)
    {
        uint256 cash = vToken.getCash();

        // No point to predict if we wanna borrow more than the liquidity
        if (borrowAmount >= cash) return vToken.supplyRatePerBlock();

        IVenusInterestRateModel interestRateModel = IVenusInterestRateModel(
            vToken.interestRateModel()
        );

        return
            interestRateModel.getSupplyRate(
                cash,
                vToken.totalBorrowsCurrent() + borrowAmount,
                vToken.totalReserves(),
                vToken.reserveFactorMantissa()
            );
    }
}
