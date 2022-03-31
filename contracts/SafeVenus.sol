//SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

import "./interfaces/IVenusController.sol";
import "./interfaces/IVToken.sol";
import "./interfaces/IVenusVault.sol";
import "./interfaces/IVenusInterestRateModel.sol";

import "./lib/IntMath.sol";

import "./OracleV1.sol";

/**
 * @dev This is a helper contract, similarly to a library, to calculate "safe" values. Safe in the essence that they give enough room to avoid liquidation.
 * https://github.com/VenusProtocol
 * It adds a safety room to all values to prevent a shortfall and get liquidated.
 * It prioritizes a safe position over maximizing profits.
 * The functions in this contract assume a very safe strategy of supplying and borrowing the same asset within 1 vToken contract.
 * It requires chainlink feeds to convert all amounts in USD.
 */
contract SafeVenus is Initializable, OwnableUpgradeable, UUPSUpgradeable {
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
    address public XVS;

    /**
     * @dev This is the Venus controller 0xfD36E2c2a6789Db23113685031d7F16329158384
     */
    // solhint-disable-next-line var-name-mixedcase
    IVenusController public VENUS_CONTROLLER;

    /**
     * @dev This is the oracle we use in the entire project. It uses Chainlink as the primary source.
     * It uses PCS TWAP only when Chainlink fails.
     */
    // solhint-disable-next-line var-name-mixedcase
    OracleV1 public ORACLE;

    /*///////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @param venusController The address of the Venus controller
     * @param xvs The address of the Venus token
     * @param oracle The address of our maintained oracle address
     *
     * Requirements:
     *
     * - Can only be called at once and should be called during creation to prevent front running.
     */
    function initialize(
        IVenusController venusController,
        address xvs,
        OracleV1 oracle
    ) external initializer {
        __Ownable_init();

        VENUS_CONTROLLER = venusController;
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
    function safeCollateralRatio(IVenusVault vault, IVToken vToken)
        public
        view
        returns (uint256)
    {
        // Get the Venus Protocol collateral requiement before liquidation
        (, uint256 venusCollateralFactor, ) = VENUS_CONTROLLER.markets(
            address(vToken)
        );

        // We give a safe margin by lowering based on the `vault` collateral limit.
        uint256 enforcedLimit = venusCollateralFactor.bmul(
            vault.collateralLimit()
        );

        uint256 borrowRate = vToken.borrowRatePerBlock();

        if (borrowRate == 0) return enforcedLimit;

        // We calculate a percentage on based profit/cost
        uint256 optimalLimit = vToken.supplyRatePerBlock().bdiv(borrowRate);

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
        uint256 _collateralLimit = safeCollateralRatio(vault, vToken);

        // Get the current positions of the `vault` in the `vToken` market.
        (uint256 borrow, uint256 supply) = borrowAndSupply(vault, vToken);

        require(supply > 0, "SV: no supply");

        // Maximum amount we can borrow based on our supply.
        uint256 maxBorrowAmount = supply.bmul(_collateralLimit);

        // If we are borrowing more than the recommended amount. We return 0;
        if (borrow >= maxBorrowAmount) return 0;

        // We calculate how much more we can borrow until we hit our safe maximum.
        // We check how much liquidity there is. We cannot borrow more than the liquidity.
        uint256 newBorrowAmount = (maxBorrowAmount - borrow).min(
            vToken.getCash()
        );

        // No point to borrow if there is no cash.
        if (newBorrowAmount == 0) return 0;

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
            supplyInterestUSD + rewardInterestUSD > borrowInterestUSD
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
        public
        returns (uint256)
    {
        // Get current `vault` borrow and supply balances in `vToken`
        (uint256 borrowBalance, uint256 supplyBalance) = borrowAndSupply(
            vault,
            vToken
        );

        // If we are not borrowing, we can redeem as much as the liquidity allows
        if (borrowBalance == 0) return supplyBalance.min(vToken.getCash());

        // borrowBalance / collateralLimitRatio will give us a safe supply value that we need to maintain to avoid liquidation.
        uint256 safeCollateral = borrowBalance.bdiv(
            // Should never be 0. As Venus uses the overcollaterized loan model. Cannot borrow without having collatera.
            // If it is 0, it should throw to alert there is an issue with Venus.
            safeCollateralRatio(vault, vToken)
        );

        // If our supply is larger than the safe collateral, we can redeem the difference
        // If not, we should not redeem
        uint256 redeemAmount = supplyBalance > safeCollateral
            ? supplyBalance - safeCollateral
            : 0;

        // We cannot redeem more than the current liquidity in the market.
        // This value can be used to safely redeem from the supply or borrow.
        // C
        return redeemAmount.min(vToken.getCash()).bmul(0.95e18);
    }

    /**
     * @dev Calculates the hypothethical borrow interest rate and XVS rewards per block with an additional `amount`.
     *
     * @notice Use the function {predictBorrowRate} if you wish an `amount` of 0.
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

        // Edge case for a market to have no loans. But since we use it as a denominator, we need to address it.
        if (totalBorrow == 0)
            // It should never happen that we have no borrows and we want to know the cost of borrowing 0.
            return (0, 0);

        // Get the current rewards given by borrowing in USD per block.
        uint256 xvsInUSDPerBlock = ORACLE.getTokenUSDPrice(
            XVS,
            // Venus speed has 18 decimals
            VENUS_CONTROLLER.venusSpeeds(address(vToken)).mulDiv(
                vaultBorrow,
                totalBorrow
            )
        );

        // Get current borrow interest rate times the amount in `vault`.
        uint256 borrowInterestRatePerBlock = predictBorrowRate(vToken, amount)
            .bmul(vaultBorrow);

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
     * @notice Use the function {predictSupplyRate} if you wish an `amount` of 0.
     *
     * @param vault A vault contract
     * @param vToken A Venus vToken contract
     * @param borrowAmount An additional borrow amount to calculate the interest rate model for supplying
     * @return uint256 The supply reward rate in USD per block.
     */
    function supplyRewardPerBlock(
        IVenusVault vault,
        IVToken vToken,
        uint256 borrowAmount
    ) public returns (uint256) {
        // Total amount of supply amount in the `vToken`.
        uint256 totalSupplyAmount = IERC20Upgradeable(address(vToken))
            .totalSupply()
            .bmul(vToken.exchangeRateCurrent());

        // Current amount of underlying the `vault` is supplying in the `vToken` market.
        uint256 vaultUnderlyingBalance = IVToken(vToken).balanceOfUnderlying(
            address(vault)
        );

        // This is super edge case. And should not happen, but we need to address it because we use it as a denominator.
        if (totalSupplyAmount == 0) return 0;

        // Current amount of rewards being paid by supplying in `vToken` in XVS in USD terms per block
        uint256 xvsAmountInUSD = ORACLE.getTokenUSDPrice(
            XVS,
            VENUS_CONTROLLER.venusSpeeds(address(vToken)).mulDiv(
                vaultUnderlyingBalance,
                totalSupplyAmount
            )
        );

        // Get current supply rate times the amout in `vault`.
        uint256 underlyingSupplyRate = predictSupplyRate(
            IVToken(vToken),
            borrowAmount
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

        // Can not borrow more than the current liquidity
        if (amount > cash) amount = cash;

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

        // Can not borrow more than the current liquidity
        if (amount > cash) amount = cash;

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

    /**
     * @dev Helper function to see if a vault should delverage, it deleverages much faster than {safeRedeem}.
     * It returns the amount to deleverage.
     * A 0 means the vault should not deleverage and should probably borrow.
     *
     * @param vault A vault contract
     * @param vToken A Venus vToken contract
     */
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

        // If we are not above the maximum amount. We do not need to deleverage and return 0.
        if (maxSafeBorrowAmount >= borrow) return 0;

        // Get the Venus Protocol collateral requirement before liquidation
        (, uint256 venusCollateralFactor, ) = VENUS_CONTROLLER.markets(
            address(vToken)
        );

        // Get all current liquidity
        uint256 cash = vToken.getCash();

        // We add 15% safety room to the {venusCollateralFactor} to avoid liquidation.
        // We assume vaults are using values below 0.8e18 for their collateral ratio
        uint256 safeSupply = borrow.bdiv(venusCollateralFactor.bmul(0.85e18));

        if (safeSupply > supply) {
            // if the supply is still lower, then it should throw
            uint256 amount = supply -
                borrow.bdiv(venusCollateralFactor.bmul(0.95e18));

            // Cannot withdraw more than liquidity
            return amount.min(cash);
        }

        // Cannot withdraw more than liquidity
        return (supply - safeSupply).min(cash);
    }

    /*///////////////////////////////////////////////////////////////
                          OWNER ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev A hook to guard the address that can update the implementation of this contract. It must be the owner.
     */
    function _authorizeUpgrade(address)
        internal
        view
        override
        onlyOwner
    //solhint-disable-next-line no-empty-blocks
    {

    }
}
