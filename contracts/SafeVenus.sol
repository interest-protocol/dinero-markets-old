//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "./interfaces/IVenustroller.sol";
import "./interfaces/IVToken.sol";
import "./interfaces/IVenusPriceOracle.sol";
import "./interfaces/IVenusVault.sol";
import "./interfaces/IVenusInterestRateModel.sol";

import "./lib/IntMath.sol";

import "./OracleV1.sol";

/**
 * @dev This is a helper contract, similarly to a library, to interact with Venus Protocol.
 * https://github.com/VenusProtocol
 * It adds a safety room to all values to prevent a shortfall and get liquidations.
 * It prioritizes a safe position over maximizing profits.
 * The functions in this contract assume a very safe strategy of supplying and borrowing the same asset.
 */
contract SafeVenus {
    /*///////////////////////////////////////////////////////////////
                            LIBRARIES
    //////////////////////////////////////////////////////////////*/

    // We need the {bdiv} and {bmul} functions to safely multiply and divide with values with a 1e18 mantissa.
    using IntMath for uint256;

    /*///////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev It is the ERC20 address of the Venus token 0xcf6bb5389c92bdda8a3747ddb454cb7a64626c63
     */
    // solhint-disable-next-line var-name-mixedcase
    address public immutable XVS;

    /**
     * @dev This is the Venus controller 0xfD36E2c2a6789Db23113685031d7F16329158384
     */
    // solhint-disable-next-line var-name-mixedcase
    IVenustroller public immutable VENUS_TROLLER;

    /**
     * @dev This is the oracle we use in the entire project. It uses Chainlink as the primary source.
     * It uses PCS TWAP only when Chainlink fails.
     */
    // solhint-disable-next-line var-name-mixedcase
    OracleV1 public immutable ORACLE;

    /*///////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @param venustroller The address of the Venus controller
     * @param xvs The address of the Venus token
     * @param oracle The address of our maintained oracle address
     */
    constructor(
        IVenustroller venustroller,
        address xvs,
        OracleV1 oracle
    ) {
        VENUS_TROLLER = venustroller;
        XVS = xvs;
        ORACLE = oracle;
    }

    /*///////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev It returns a conservative collateral ratio required to back a loan.
     *
     * @param vault A vault contract
     * @param vToken A Venus vToken contract
     * @return uint256 The conservative collateral requirement
     */
    function safeCollateralLimit(IVenusVault vault, IVToken vToken)
        public
        view
        returns (uint256)
    {
        // Get the Venus Protocol collateral requiement before liquidation
        (, uint256 venusCollateralFactor, ) = VENUS_TROLLER.markets(
            address(vToken)
        );

        // We give a safe margin by lowering based on the `vault` collateral limit.
        uint256 enforcedLimit = venusCollateralFactor.bmul(
            vault.collateralLimit()
        );

        // We calculate a percentage on based profit/cost
        uint256 optimalLimit = vToken.supplyRatePerBlock().bdiv(
            vToken.borrowRatePerBlock()
        );

        // To make sure we stay within the protocol limit we take the minimum between the optimal and enforced limit.
        return enforcedLimit.min(optimalLimit);
    }

    /*///////////////////////////////////////////////////////////////
                        MUTATIVE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev It returns the current borrow and supply amount the `vault` has in the `vToken` market.
     *
     * @param vault A vault contract
     * @param vToken A Venus vToken contract
     * @return borrow The borrow amount
     * @return supply The supply amount
     */
    function borrowAndSupply(IVenusVault vault, IVToken vToken)
        public
        returns (uint256 borrow, uint256 supply)
    {
        borrow = vToken.borrowBalanceCurrent(address(vault));
        supply = vToken.balanceOfUnderlying(address(vault));
    }

    /**
     * @dev It checks if it is profitable to borrow `amount` in a `vToken` market. It assumes supplying and borrowing the same token.
     *
     * @notice It does not have a safety margin.
     *
     * @param vault A vault contract
     * @param vToken A Venus vToken contract
     * @param amount The new borrow amount to calculate the interest rates
     * @return bool True if it is profitable
     */
    function isProfitable(
        IVenusVault vault,
        IVToken vToken,
        uint256 amount
    ) external returns (bool) {
        // Get the current cost and profit of borrowing in `vToken`.
        (
            uint256 borrowInterestUSD, // Cost of borrowing underlying
            uint256 rewardInterestUSD // This is the XVS profit.
        ) = borrowInterestPerBlock(vault, vToken, amount);

        // Get the current profit of supplying.
        uint256 supplyInterestUSD = supplyRewardPerBlock(vault, vToken, amount);

        return supplyInterestUSD + rewardInterestUSD > borrowInterestUSD;
    }

    /**
     * @dev It calculates a borrow amount within the collateral requirements and only if there is a current net profit.
     *
     * @notice This function assumes, that we are borrowing the same asset we are using as collateral.
     *
     * @param vault A vault contract
     * @param vToken A Venus vToken contract
     * @return uint256 The safe borrow amount.
     */
    function safeBorrow(IVenusVault vault, IVToken vToken)
        external
        returns (uint256)
    {
        // Get a safe ratio between borrow amount and collateral required.
        uint256 _collateralLimit = safeCollateralLimit(vault, vToken);

        // Get the current positions of the `vault` in the `vToken` market.
        (uint256 borrow, uint256 supply) = borrowAndSupply(vault, vToken);

        // Get our current collateral requirement ratio
        uint256 currentCollateralFactor = borrow.bdiv(supply);

        // If we are over the limit. We might not be liquidated because we use a safe margin.
        if (currentCollateralFactor >= _collateralLimit) {
            return 0;
        }

        // Maximum amount we can borrow based on our supply.
        uint256 maxBorrowAmount = supply.bmul(_collateralLimit);

        // We calculate how much more we can borrow until we hit our safe maximum.
        // We check how much liquidity there is. We cannot borrow more than the liquidity.
        uint256 newBorrowAmount = maxBorrowAmount.min(vToken.getCash()) -
            borrow;

        // Take a ratio between our current borrow amount and what
        uint256 newBorrowAmountRatio = borrow > 0
            ? newBorrowAmount.bdiv(borrow)
            : 0;

        // We ignore borrowing less than 5% of the current borrow.
        if (newBorrowAmountRatio > 0 && newBorrowAmountRatio <= 0.05e18)
            return 0;

        // Get the current cost and profit of borrowing in `vToken`.
        (
            uint256 borrowInterestUSD, // Cost of borrowing underlying
            uint256 rewardInterestUSD // This is the XVS profit.
        ) = borrowInterestPerBlock(vault, vToken, newBorrowAmount);

        // Get the current profit of supplying.
        uint256 supplyInterestUSD = supplyRewardPerBlock(
            vault,
            vToken,
            newBorrowAmount
        );

        // We only recomment a borrow amount if it is profitable and reduce it by 5% to give a safety margin.
        // 0 represents do not borrow.
        return
            supplyInterestUSD + rewardInterestUSD >
                borrowInterestUSD + borrowInterestUSD.bmul(0.1e18) // We increase the costs by 10% to give a safety margin
                ? newBorrowAmount.bmul(0.95e18)
                : 0;
    }

    /**
     * @dev It calculas an amount that can be redeemed without being liquidated from both supply and borrow balances.
     *
     * @param vault A vault contract
     * @param vToken A Venus vToken contract
     */
    function safeRedeem(IVenusVault vault, IVToken vToken)
        external
        returns (uint256)
    {
        // Get current `vault` borrow and supply balances in `vToken`
        (uint256 borrowBalance, uint256 supplyBalance) = borrowAndSupply(
            vault,
            vToken
        );

        // borrowBalance / collateralLimitRatio will give us a safe supply value that we need to maintain to avoid liquidation.
        uint256 safeCollateral = borrowBalance.bdiv(
            safeCollateralLimit(vault, vToken)
        );

        // If our supply is larger than the safe collateral, we can redeem the difference
        // If not, we should not redeem
        uint256 redeemAmount = supplyBalance > safeCollateral
            ? supplyBalance - safeCollateral
            : 0;

        // We cannot redeem more than the current liquidity in the market.
        // This value can be used to safely redeem from the supply or borrow.
        return redeemAmount.min(vToken.getCash().bmul(0.95e18));
    }

    /**
     * @dev Calculates the hypothethical borrow interest rate and XVS rewards per block with an additional `amount`.
     *
     * @param vault A vault contract
     * @param vToken A Venus vToken contract
     * @param amount The calculation will take into account if you intent to borrow an additional `amount` of the underlying token of `vToken`.
     * @return uint256 borrow interest rate per block in USD
     * @return uint256 reward interest rate per block in USD
     */
    function borrowInterestPerBlock(
        IVenusVault vault,
        IVToken vToken,
        uint256 amount
    ) public returns (uint256, uint256) {
        // Get current total amount being borrowed in the `vToken` plus adding `amount`.
        uint256 totalBorrow = vToken.totalBorrowsCurrent() + amount;
        // Get current borrow of the `vault` in the `vToken` market assuming it borrows an additional `amount`.
        uint256 vaultBorrow = vToken.borrowBalanceCurrent(address(vault)) +
            amount;

        // Get the current rewards given by borrowing in USD per block.
        uint256 xvsInUSDPerBlock = ORACLE.getTokenUSDPrice(
            XVS,
            // Venus speed has 18 decimals
            (VENUS_TROLLER.venusSpeeds(address(vToken)) * vaultBorrow) /
                totalBorrow
        );

        // Get current borrow interest rate for the `vaultBorrow`.
        uint256 borrowInterestRatePerBlock = predictBorrowRate(vToken, amount);

        // Get the cost of borrowing per block in USD
        uint256 underlyingInUSDPerBlock = ORACLE.getTokenUSDPrice(
            vToken.underlying(),
            borrowInterestRatePerBlock
        );

        // Return a tuple with 1st being the borrow interest rate (cost), and the second the rewards in XVS (profit)
        return (underlyingInUSDPerBlock, xvsInUSDPerBlock);
    }

    /**
     * @dev This function predicts hypothetically the supply reward per block with an additional `amount`.
     *
     * @param vault A vault contract
     * @param vToken A Venus vToken contract
     * @param amount An additional borrow amount to calculate the interest rate model for supplying
     * @return uint256 The supply reward rate in USD per block.
     */
    function supplyRewardPerBlock(
        IVenusVault vault,
        IVToken vToken,
        uint256 amount
    ) public returns (uint256) {
        // Total amount of supply amount in the `vToken`.
        uint256 totalSupplyAmount = IERC20(address(vToken)).totalSupply().bmul(
            vToken.exchangeRateCurrent()
        );

        // Current amount of underlying the `vault` is supplying in the `vToken` market.
        uint256 vaultUnderlyingBalance = IVToken(vToken).balanceOfUnderlying(
            address(vault)
        );

        // Current amount of rewards being paid by supplying in `vToken` in XVS in USD terms per block
        uint256 xvsAmountInUSD = ORACLE.getTokenUSDPrice(
            XVS,
            ((VENUS_TROLLER.venusSpeeds(address(vToken)) *
                vaultUnderlyingBalance) / totalSupplyAmount)
        );

        uint256 underlyingSupplyRate = predictSupplyRate(
            IVToken(vToken),
            amount
        ).bmul(vaultUnderlyingBalance);

        // Calculate the supply rate considering an additional borrow `amount` per block in USD and add the current XVS rewards in USD per block
        return
            ORACLE.getTokenUSDPrice(vToken.underlying(), underlyingSupplyRate) +
            xvsAmountInUSD;
    }

    /**
     * @dev Calculate hypothethically the borrow rate based on an additional `amount`.
     *
     * @param vToken A Venus vToken contract
     * @param amount An additional borrow amount
     * @return uint256 Borrow rate per block in underlying token
     */
    function predictBorrowRate(IVToken vToken, uint256 amount)
        public
        returns (uint256)
    {
        // Get current market liquidity (supply - borrow in underlying)
        uint256 cash = vToken.getCash();
        // No point to predict if we wanna borrow more than the liquidity
        if (amount >= cash) return vToken.borrowRatePerBlock();

        // Get current interest model being used by the `vToken`.
        IVenusInterestRateModel interestRateModel = IVenusInterestRateModel(
            vToken.interestRateModel()
        );

        // Calculate the borrow rate adjust by borrowing an additional `amount`.
        return
            interestRateModel.getBorrowRate(
                cash - amount,
                vToken.totalBorrowsCurrent() + amount,
                vToken.totalReserves()
            );
    }

    /**
     * @dev Calculates hypothethically the supply rate assuming an additional `borrow` amount.
     *
     * @param vToken A Venus vToken contract
     * @param amount An additional borrow amount
     * @return uint256 Supply rate per block in underlying token
     */
    function predictSupplyRate(IVToken vToken, uint256 amount)
        public
        returns (uint256)
    {
        // Current market liquidity
        uint256 cash = vToken.getCash();

        // No point to predict if we wanna borrow more than the liquidity
        if (amount >= cash) return vToken.supplyRatePerBlock();

        // Get current `vToken` interest rate model.
        IVenusInterestRateModel interestRateModel = IVenusInterestRateModel(
            vToken.interestRateModel()
        );

        // Calculate the supply rate adjusted for an additional `borrow` amount.
        return
            interestRateModel.getSupplyRate(
                cash - amount,
                vToken.totalBorrowsCurrent() + amount,
                vToken.totalReserves(),
                vToken.reserveFactorMantissa()
            );
    }
}
