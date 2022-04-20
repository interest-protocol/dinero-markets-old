/*

▀█▀ █▀▀▄ ▀▀█▀▀ █▀▀ █▀▀█ █▀▀ █▀▀ ▀▀█▀▀ 　 ▒█▀▄▀█ █▀▀█ █▀▀█ █░█ █▀▀ ▀▀█▀▀ 　 ▒█░░▒█ ▄█░ 
▒█░ █░░█ ░░█░░ █▀▀ █▄▄▀ █▀▀ ▀▀█ ░░█░░ 　 ▒█▒█▒█ █▄▄█ █▄▄▀ █▀▄ █▀▀ ░░█░░ 　 ░▒█▒█░ ░█░ 
▄█▄ ▀░░▀ ░░▀░░ ▀▀▀ ▀░▀▀ ▀▀▀ ▀▀▀ ░░▀░░ 　 ▒█░░▒█ ▀░░▀ ▀░▀▀ ▀░▀ ▀▀▀ ░░▀░░ 　 ░░▀▄▀░ ▄█▄

Copyright (c) 2021 Jose Cerqueira - All rights reserved

*/

//SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import "../interfaces/IPancakeRouter02.sol";
import "../interfaces/IPancakePair.sol";

import "../tokens/Dinero.sol";

import "../lib/Rebase.sol";
import "../lib/IntMath.sol";
import "../lib/IntERC20.sol";

import "../master-chef-vaults/MasterChefVault.sol";

import "../OracleV1.sol";

import "./DineroMarket.sol";

/**
 * @dev It is an overcollaterized isolated lending market between a collateral token and the synthetic stable coin Dinero.
 * The market supports PancakePair token  farms them in PancakeSwap.
 * The objective is to have the rewards in PCS higher than the interest rate of borrowing.
 * The idea behind a synthethic stable coin is to allow for a fixed low interest rate to make investment strategies built with Interest Protocol cheaper and predictable.
 *
 * @notice If the market has a vault. `ms.sender` has to approve the vault if not it has to approve the market.
 * @notice There is no deposit fee.
 * @notice There is a liquidation fee.
 * @notice Since Dinero is assumed to always be pegged to USD. Only need an exchange rate from collateral to USD.
 * @notice We assume that {_exchangeRate} has 18 decimals. Please check OracleV1 and PancakeOracle
 * @notice The govenor owner has sole access to critical functions in this contract.
 * @notice Market will only support tokens on BSC with immutable contracts and 18 decimals.
 * @notice We will start by supporting tokens with high liquidity. The {maxLTVRatio} will start at 60% and slow be raised up to 80%.
 * @notice It relies on third party liquidators to close loans underwater.
 * @notice It depends on Chainlink price feeds oracles. However, we will add a backup using PCS TWAPS before the live release.
 * @notice The Rebase library is helper library to easily calculate the principal + fees owed by borrowers.
 * @notice To be effective this requires a strong DNR/BNB or DNR/BUSD pair. The contract CasaDePapel will be responsible for this.
 * @notice This contract enforces that Dinero remains pegged to USD.
 * If Dinero falls below, borrowers that have open  loans and swapped to a different crypto, can buy dinero cheaper and close their loans running a profit. Liquidators can accumulate Dinero to close underwater positions with an arbitrate. As liquidation will always assume 1 Dinero is worth 1 USD. If Dinero goes above a dollar, people are encouraged to borrow more Dinero for arbitrage. We believe this will keep the price pegged at 1 USD.
 *
 * Contracts that will be supported in V1:
 *
 * BTC - 0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c
 * ETH - 0x2170Ed0880ac9A755fd29B2688956BD959F933F8
 * CAKE - 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82
 * PCS Pairs of all this tokens with WBNB - 0xA527a61703D82139F8a06Bc30097cC9CAA2df5A6
 * ADA - 0x3ee2200efb3400fabb9aacf31297cbdd1d435d47
 */
contract InterestERC20Market is Initializable, DineroMarket {
    /*///////////////////////////////////////////////////////////////
                            LIBRARIES
    //////////////////////////////////////////////////////////////*/

    using RebaseLibrary for Rebase;
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using SafeCastUpgradeable for uint256;
    using IntMath for uint256;
    using IntERC20 for address;

    /*///////////////////////////////////////////////////////////////
                            EVENTS
    //////////////////////////////////////////////////////////////*/

    event AddCollateral(
        address indexed from,
        address indexed to,
        uint256 amount
    );

    event WithdrawCollateral(
        address indexed from,
        address indexed to,
        uint256 amount
    );

    /*///////////////////////////////////////////////////////////////
                            STATE
    //////////////////////////////////////////////////////////////*/

    // solhint-disable-next-line var-name-mixedcase
    IERC20Upgradeable public COLLATERAL; // Token to be used to cover the loan.

    // solhint-disable-next-line var-name-mixedcase
    MasterChefVault public VAULT; // A vault to interact with PCS master chef.

    uint256 public totalCollateral; // Total amount of collateral in this market.

    /*///////////////////////////////////////////////////////////////
                                INITIALIZER
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev This is only callable once to set the initial data.
     *
     * @param dinero The address of Dinero.
     * @param feeTo Treasury address.
     * @param oracle The address of the oracle.
     * @param collateral The address of the collateral of this market, an ERC20
     * @param vault The address of a master chef vault. It can be address(0)
     * @param interestRate the interest rate charged every second
     * @param _maxLTVRatio The maximum ltv ratio before liquidation
     * @param _liquidationFee The fee charged when positions under water are liquidated
     *
     * Requirements:
     *
     * - Can only be called at once and should be called during creation to prevent front running.
     */
    function initialize(
        Dinero dinero,
        address feeTo,
        OracleV1 oracle,
        IERC20Upgradeable collateral,
        MasterChefVault vault,
        uint64 interestRate,
        uint256 _maxLTVRatio,
        uint256 _liquidationFee
    ) external initializer {
        // Collateral must not be zero address.
        require(address(collateral) != address(0), "MKT: no zero address");
        // {maxLTVRatio} must be within the acceptable bounds.
        require(
            0.9e18 >= _maxLTVRatio && _maxLTVRatio >= 0.5e18,
            "MKT: ltc ratio out of bounds"
        );

        __DineroMarket_init();

        DINERO = dinero;
        FEE_TO = feeTo;
        ORACLE = oracle;
        COLLATERAL = collateral;
        VAULT = vault;
        loan.INTEREST_RATE = interestRate;
        maxLTVRatio = _maxLTVRatio;
        liquidationFee = _liquidationFee;

        // Also make sure that {COLLATERAL} is a deployed ERC20.
        // Approve the router to trade the collateral.
        COLLATERAL.safeApprove(address(ROUTER), type(uint256).max);
    }

    /*///////////////////////////////////////////////////////////////
                        MUTATIVE PUBLIC FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev This function is to increase the allowance to the PCS router for liquidation purposes. It will bring it to the maximum.
     */
    function approve() external {
        COLLATERAL.safeIncreaseAllowance(
            address(ROUTER),
            type(uint256).max -
                COLLATERAL.allowance(address(this), address(ROUTER))
        );
    }

    /**
     * @dev This function gets the latest exchange rate between {COLLATERAL} and USD from chainlink.
     *
     * @notice Supports for PCS TWAPS will be added before release as a back up.
     *
     * @return rate The latest exchange rate from Chainlink
     *
     * Requirements:
     *
     * - exchange rate has to be above 0.
     */
    function updateExchangeRate()
        public
        override(DineroMarket)
        returns (uint256 rate)
    {
        // Get USD price for 1 Token (18 decimals). The USD price also has 18 decimals. We need to reduce
        rate = ORACLE.getUSDPrice(address(COLLATERAL), 1 ether);

        require(rate > 0, "MKT: invalid exchange rate");

        // if the exchange rate is different we need to update the global state
        if (rate != exchangeRate) {
            exchangeRate = rate;
            emit ExchangeRate(rate);
        }
    }

    /**
     * @dev A utility function to addCollateral and borrow in one call.
     *
     * @param to The address that will have collateral added.
     * @param amount The number of collateral tokens to add.
     * @param borrowTo The address that will receive the borrow dinero.
     * @param borrowAmount The number of DNR tokens to borrow.
     */
    function addCollateralAndBorrow(
        address to,
        uint256 amount,
        address borrowTo,
        uint256 borrowAmount
    ) external isSolvent {
        require(
            to != address(0) && borrowTo != address(0),
            "DM: no zero address"
        );
        require(amount != 0 && borrowAmount != 0, "DM: no zero amount");
        accrue();
        addCollateral(to, amount);
        _borrowFresh(borrowTo, borrowAmount);
    }

    /**
     * @dev A utility function to repay and withdraw collateral in one call.
     *
     * @param account The account that will have its loan repaid.
     * @param principal The number of loan shares to repay.
     * @param to The address that will receive the withdawn collateral
     * @param amount The number of collateral tokens to remove.
     */
    function repayAndWithdrawCollateral(
        address account,
        uint256 principal,
        address to,
        uint256 amount
    ) external isSolvent {
        require(
            account != address(0) && to != address(0),
            "DM: no zero address"
        );
        require(principal > 0 && amount > 0, "DM: no zero amount");
        accrue();
        _repayFresh(account, principal);
        _withdrawCollateralFresh(to, amount);
    }

    /**
     * @dev Allows `msg.sender` to add collateral
     *
     * @notice If the contract has a vault `msg.sender` needs to give approval to the vault. If not it needs to give to this contract.
     *
     * @param to The address, which the `COLLATERAL` will be assigned to.
     * @param amount The number of `COLLATERAL` tokens to be used for collateral
     */
    function addCollateral(address to, uint256 amount) public {
        // Get `COLLATERAL` from `msg.sender`
        _depositCollateral(_msgSender(), to, amount);

        // Update Global state
        userCollateral[to] += amount;
        totalCollateral += amount;

        emit AddCollateral(_msgSender(), to, amount);
    }

    /**
     * @dev Functions allows the `msg.sender` to remove his collateral as long as he remains solvent.
     *
     * @param to The address that will receive the collateral being withdrawn.
     * @param amount The number of `COLLATERAL` tokens he wishes to withdraw
     *
     * Requirements:
     *
     * - `msg.sender` must remain solvent after removing the collateral.
     */
    function withdrawCollateral(address to, uint256 amount) external isSolvent {
        require(to != address(0), "DM: no zero address");
        // Update how much is owed to the protocol before allowing collateral to be removed
        accrue();

        _withdrawCollateralFresh(to, amount);
    }

    /**
     * @dev This function closes underwater positions. It charges the borrower a fee and rewards the liquidator for keeping the integrity of the protocol
     * @notice Liquidator can use collateral to close the position or must have enough dinero in this account.
     * @notice Liquidators can only close a portion of an underwater position.
     * @notice We do not require the  liquidator to use the collateral. If there are any "lost" tokens in the contract. Those can be use as well.
     * @notice The liquidator must have more than the sum of principals in Dinero because of the fees accrued over time. Unless he chooses to use the collateral to cover the positions.
     * @notice We assume PCS will remain most liquid exchange in BSC for this version of the contract. We will also add liquidate of BNB/DNR to PCS.
     * @notice In the case `COLLATERAL` is a PCS pair {IERC20} and the user chooses to use collateral to liquidate he needs to pass a `path` for token0 and `path2` for token1.
     * @notice If the `COLLATERAL` is NOT a PCS pair {IERC20} and the user chooses to use the collateral to liquidate, the `path2` should be empty, but the `path` has to have a length >= 2.
     * @notice In the case of `COLLATERAL` being a PCS pair {IERC20} and the liquidator chooses to use the collateral to cover the loan.
     * The liquidator will have to go to PCS to remove the liquidity afterwards.
     *
     * @param accounts The  list of accounts to be liquidated.
     * @param principals The amount of principal the `msg.sender` wants to liquidate for each account.
     * @param recipient The address that will receive the proceeds gained by liquidating.
     * @param path The list of tokens from collateral to dinero in case the `msg.sender` wishes to use collateral to cover the debt.
     * Or The list of tokens to sell the token0 if `COLLATERAL` is a PCS pair {IERC20}.
     * @param path2 The list of tokens to sell the token1 if `COLLATERAL` is a PCS pair {IERC20}.
     *
     * Requirements:
     *
     * - If the liquidator wishes to use collateral to pay off a debt. He must exchange it to Dinero.
     * - He must hold enough Dinero to cover the sum of principals if opts to not sell the collateral in PCS to avoid slippage costs.
     */
    function liquidate(
        address[] calldata accounts,
        uint256[] calldata principals,
        address recipient,
        address[] calldata path,
        address[] calldata path2
    ) external {
        // Make sure the token is always exchanged to Dinero as we need to burn at the end.
        // path can be empty if the liquidator has enough dinero in his accounts to close the positions.
        require(
            path.length == 0 || path[path.length - 1] == address(DINERO),
            "MKT: no dinero at last index"
        );
        // Liquidations must be based on the current exchange rate.
        uint256 _exchangeRate = updateExchangeRate();

        // Update all debt
        accrue();

        // Save state to memory for gas saving

        LiquidationInfo memory liquidationInfo;

        Rebase memory _totalLoan = totalLoan;

        uint256 _liquidationFee = liquidationFee;

        // Loop through all positions
        for (uint256 i = 0; i < accounts.length; i++) {
            address account = accounts[i];

            // If the user has enough collateral to cover his debt. He cannot be liquidated. Move to the next one.
            if (_isSolvent(account, _exchangeRate)) continue;

            uint256 principal;

            {
                // How much principal the user has borrowed.
                uint256 loanPrincipal = userLoan[account];

                // Liquidator cannot repay more than the what `account` borrowed.
                // Note the liquidator does not need to close the full position.
                principal = principals[i] > loanPrincipal
                    ? loanPrincipal
                    : principals[i];

                // Update the userLoan global state
                userLoan[account] -= principal;
            }

            // How much is owed in principal + accrued fees
            uint256 debt = _totalLoan.toElastic(principal, false);

            // Calculate the collateralFee (for the liquidator and the protocol)
            uint256 fee = debt.bmul(_liquidationFee);

            // How much collateral is needed to cover the loan + fees.
            // Since Dinero is always USD we can calculate this way.
            uint256 collateralToCover = (debt + fee).bdiv(_exchangeRate);

            // Remove the collateral from the account. We can consider the debt paid.
            userCollateral[account] -= collateralToCover;

            // Get the Rewards and collateral if they are in a vault to this contract.
            // The rewards go to the `account`.
            // The collateral comes to this contract.
            // If the collateral is in this contract do nothing.
            if (MasterChefVault(address(0)) != VAULT) {
                VAULT.withdraw(account, address(this), collateralToCover);
            }

            emit WithdrawCollateral(account, address(this), collateralToCover);
            emit Repay(_msgSender(), account, principal, debt);

            // Update local information. It should not overflow max uint128.
            liquidationInfo.allCollateral += collateralToCover.toUint128();
            liquidationInfo.allPrincipal += principal.toUint128();
            liquidationInfo.allDebt += debt.toUint128();
            liquidationInfo.allFee += fee.toUint128();
        }

        // There must have liquidations or we throw an error;
        // We throw an error instead of returning because we already changed state, sent events and withdrew tokens from collateral.
        // We need to revert all that.
        require(liquidationInfo.allPrincipal > 0, "MKT: no liquidations");

        // If the there is no more open positions, the elastic should also equal to 0.
        // Due to limits of math in solidity. elastic might end up with dust.
        if (liquidationInfo.allPrincipal == _totalLoan.base)
            liquidationInfo.allDebt = _totalLoan.elastic;

        // Update Global state
        totalLoan = _totalLoan.sub(
            liquidationInfo.allPrincipal,
            liquidationInfo.allDebt
        );

        // Update the total collateral.
        totalCollateral -= liquidationInfo.allCollateral;

        // 10% of the liquidation fee to be given to the protocol.
        uint256 protocolFee = uint256(liquidationInfo.allFee).bmul(0.1e18);

        unchecked {
            // Should not overflow.
            // Pay the fee to the protocol
            loan.feesEarned += protocolFee.toUint128();
        }

        // If a path is provided, we will use the collateral to cover the debt
        if (path.length >= 2) {
            // Sell `COLLATERAL` and send `DINERO` to recipient.
            // Abstracted the logic to a function to avoid; Stack too deep compiler error.
            // This function will consider if the `COLLATERAL` is a 'flip' token or not.
            _sellCollateral(
                liquidationInfo.allCollateral,
                recipient,
                path,
                path2
            );
            // This step we destroy `DINERO` equivalent to all outstanding debt + protocol fee. This does not include the liquidator fee.
            // Liquidator keeps the rest as profit.
            // Liquidator recipient Dinero from the swap.
            DINERO.burn(recipient, liquidationInfo.allDebt + protocolFee);
        } else {
            // Liquidator will be paid in `COLLATERAL`
            // Send collateral to the `recipient` (includes liquidator fee + protocol fee)
            address(COLLATERAL).safeERC20Transfer(
                recipient,
                liquidationInfo.allCollateral
            );
            // This step we destroy `DINERO` equivalent to all outstanding debt + protocol fee. This does not include the liquidator fee.
            // Liquidator keeps the rest as profit.
            // Liquidator has dinero in this scenario
            DINERO.burn(_msgSender(), liquidationInfo.allDebt + protocolFee);
        }
    }

    /*///////////////////////////////////////////////////////////////
                            PRIVATE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev It allows the `msg.sender` to remove collateral. The caller has to run {accrue beforehand}  and must do solvency checks.
     *
     * @param to The address that will receive the collateral being withdrawn.
     * @param amount The number of `COLLATERAL` tokens he wishes to withdraw
     */
    function _withdrawCollateralFresh(address to, uint256 amount) private {
        // Update State
        userCollateral[_msgSender()] -= amount;
        totalCollateral -= amount;

        // Return the collateral to the user
        _withdrawCollateral(_msgSender(), to, amount);

        emit WithdrawCollateral(_msgSender(), to, amount);
    }

    /**
     * @dev A helper function to sell collateral for dinero.
     *
     * @notice It checks if the `COLLATERAL` is a PCS pair token and treats it accordingly.
     * @notice Slippage is not an issue because on {liquidate} we always burn the necessary amount of `DINERO`.
     * @notice We are only  using highly liquid pairs. So slippage should not be an issue. Front-running can be an issue, but the liquidation fee should cover it. It will be between 10%-15% (minus 10% for the protocol) of the debt liquidated.
     *
     * @param collateralAmount The amount of tokens to remove from the liquidity in case of `COLLATERAL` being a PCS pair {IERC20}.
     * Or the amount of collateral to sell if it is a normal {IERC20}.
     * @param recipient The address that will receive the `DINERO` after the swap.
     * @param path In the case of `COLLATERAL` being a PCS pair {IERC20}. It is the swap path for token0.
     * If not, it will be the path for the `COLLATERAL`.
     * @param path2 Can be empty if `COLLATERAL` is not a PCS pair {IERC20}. Otherwise, it needs to be the swap path for token1.
     *
     * Requirements:
     *
     * - path2 length needs to be >= 2 if `COLLATERAL` is PCS pair {IERC20}.
     * - path2 last item has to be the `DINERO` token.
     */
    function _sellCollateral(
        uint256 collateralAmount,
        address recipient,
        address[] calldata path,
        address[] calldata path2
    ) private {
        if ((address(COLLATERAL)).isPair()) {
            require(path2.length >= 2, "MKT: provide a path for token1");
            require(
                path2[path2.length - 1] == address(DINERO),
                "MKT: no dinero on last index"
            );

            address token0 = IPancakePair(address(COLLATERAL)).token0();
            address token1 = IPancakePair(address(COLLATERAL)).token1();
            // save gas
            IPancakeRouter02 router = ROUTER;

            // Even if one of the tokens is WBNB. We dont want BNB because we want to use {swapExactTokensForTokens} for Dinero after.
            // Avoids unecessary routing through WBNB {deposit} and {withdraw}.
            (uint256 amount0, uint256 amount1) = router.removeLiquidity(
                token0,
                token1,
                collateralAmount,
                0, // The liquidator will pay for slippage
                0, // The liquidator will pay for slippage
                address(this), // The contract needs the tokens to sell them.
                //solhint-disable-next-line not-rely-on-time
                block.timestamp
            );

            // We need to approve the router to {transferFrom} token0 and token1 to sell them for {DINERO}.
            IERC20Upgradeable(token0).safeIncreaseAllowance(
                address(router),
                amount0
            );
            IERC20Upgradeable(token1).safeIncreaseAllowance(
                address(router),
                amount1
            );

            router.swapExactTokensForTokens(
                // Sell all token0 removed from the liquidity.
                amount0,
                // The liquidator will pay for the slippage.
                0,
                // Sell token0 -> ... -> DINERO
                path[0] == token0 ? path : path2,
                // Send DINERO to the recipient. Since this has to happen in this block. We can burn right after
                recipient,
                // This TX must happen in this block.
                //solhint-disable-next-line not-rely-on-time
                block.timestamp
            );

            router.swapExactTokensForTokens(
                // Sell all token1 obtained from removing the liquidity.
                amount1,
                // The liquidator will pay for the slippage.
                0,
                // Sell token1 -> ... -> DINERO
                path[0] == token0 ? path2 : path,
                // Send DINERO to the recipient. Since this has to happen in this block. We can burn right after
                recipient,
                // This TX must happen in this block.
                //solhint-disable-next-line not-rely-on-time
                block.timestamp
            );
        } else {
            // If it is not a pair contract, we can swap it on PCS.
            ROUTER.swapExactTokensForTokens(
                // Sell all collateral for this liquidation
                collateralAmount,
                // Liquidator will pay for slippage
                0,
                // Sell COLLATERAL -> ... -> DINERO
                path,
                // Send DINERO to the recipient. Since this has to happen in this block. We can burn right after
                recipient,
                // This TX must happen in this block.
                //solhint-disable-next-line not-rely-on-time
                block.timestamp
            );
        }
    }

    /**
     * @dev This is a helper function to account for the fact that some contracts have a vault to farm the collateral.
     * It deposits the collateral in the vault if there is a vault. Otherwise, it deposits in this contract.
     *
     * @param from The address that needs to approve the contract and will have tokens transferred to this contract.
     * @param amount The number of tokens it needs to provide as collateral.
     */
    function _depositCollateral(
        address from,
        address to,
        uint256 amount
    ) private {
        if (MasterChefVault(address(0)) == VAULT) {
            COLLATERAL.safeTransferFrom(from, address(this), amount);
        } else {
            VAULT.deposit(from, to, amount);
        }
    }

    /**
     * @dev This is a helper function to withdraw the collateral from this contract or the `VAULT`.
     *
     * @notice In the case of the vault the rewards will always go to the `account`. The principal may not.
     *
     * @param account The address who owns the collateral being withdrawn.
     * @param recipient The address that will receive the collateral + rewards if applicable.
     * @param amount The amount of collateral to withdraw.
     */
    function _withdrawCollateral(
        address account,
        address recipient,
        uint256 amount
    ) private {
        if (MasterChefVault(address(0)) == VAULT) {
            address(COLLATERAL).safeERC20Transfer(recipient, amount);
        } else {
            VAULT.withdraw(account, recipient, amount);
        }
    }
}
