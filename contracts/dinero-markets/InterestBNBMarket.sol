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
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

import "../interfaces/IPancakeRouter02.sol";

import "../lib/Rebase.sol";
import "../lib/IntMath.sol";

import "../tokens/Dinero.sol";

import "../OracleV1.sol";

import "./DineroMarket.sol";

/**
 * @dev It is an overcollaterized isolated lending market that accepts BNB as coollateral to back a loan in a synthetic stable coin called Dinero.
 * The idea behind a synthethic stable coin is to allow for a fixed low interest rate to make investment strategies built with Interest Protocol cheaper and predictable.
 * It has the same logic as the Interest Market V1 but this one is specifically for BNB without a vault.
 *
 * @notice There is no deposit fee.
 * @notice There is a liquidation fee.
 * @notice Since Dinero is assumed to always be pegged to USD. Only need an exchange rate from collateral to USD.
 * @notice exchange rate has a base unit of 18 decimals
 * @notice The govenor owner has sole access to critical functions in this contract.
 * @notice Market will only supports BNB, which has 18 decimals.
 * @notice The {maxLTVRatio} will start at 60% and slow be raised up to 80%.
 * @notice It relies on third party liquidators to close loans underwater.
 * @notice It depends on Chainlink price feeds oracles. However, we will add a backup using PCS TWAPS before the live release.
 * @notice The Rebase library is helper library to easily calculate the principal + fees owed by borrowers.
 * @notice To be effective this requires a strong DNR/BNB or DNR/BUSD pair. The contract CasaDePapel will be responsible for this.
 * @notice This contract enforces that Dinero remains pegged to USD.
 * If Dinero falls below, borrowers that have open  loans and swapped to a different crypto, can buy dinero cheaper and close their loans running a profit. Liquidators can accumulate Dinero to close underwater positions with an arbitrate. As liquidation will always assume 1 Dinero is worth 1 USD. If Dinero goes above a dollar, people are encouraged to borrow more Dinero for arbitrage. We believe this will keep the price pegged at 1 USD.
 *
 */
contract InterestBNBMarketV1 is
    Initializable,
    ReentrancyGuardUpgradeable,
    DineroMarket
{
    /*///////////////////////////////////////////////////////////////
                            LIBRARIES
    //////////////////////////////////////////////////////////////*/

    using RebaseLibrary for Rebase;
    using SafeCastUpgradeable for uint256;
    using IntMath for uint256;

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
                            INITIALIZER
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice `interestRate` has a base unit of 1e18.
     *
     * @param dinero The address of Dinero.
     * @param feeTo Treasury address.
     * @param oracle The address of the oracle.
     * @param interestRate How much to charge borrowers every second in Dinero
     * @param _maxLTVRatio Maximum loan to value ratio on loans. Positions above this value can be liquidated.
     * @param _liquidationFee A fee charged on positions underwater and rewarded to the liquidator and protocol.
     *
     * Requirements:
     *
     * - Can only be called at once and should be called during creation to prevent front running.
     */
    function initialize(
        Dinero dinero,
        address feeTo,
        OracleV1 oracle,
        uint64 interestRate,
        uint256 _maxLTVRatio,
        uint256 _liquidationFee
    ) external initializer {
        __DineroMarket_init();
        __ReentrancyGuard_init();

        DINERO = dinero;
        FEE_TO = feeTo;
        ORACLE = oracle;
        loan.INTEREST_RATE = interestRate;
        maxLTVRatio = _maxLTVRatio;
        liquidationFee = _liquidationFee;
    }

    /*///////////////////////////////////////////////////////////////
                        MUTATIVE PUBLIC FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev This function gets the latest exchange rate between BNB and USD from chainlink.
     *
     * @notice Supports for PCS TWAPS will be added before release as a back up.
     * @notice USD price has a base unit of 1e18.
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
        rate = ORACLE.getBNBUSDPrice(1 ether);

        require(rate > 0, "MKT: invalid exchange rate");

        // if the exchange rate is different we need to update the global state
        if (rate != exchangeRate) {
            exchangeRate = rate;
            emit ExchangeRate(rate);
        }
    }

    /**
     * @dev A utility function to add BNB and borrow Dinero in one call. It applies all restrictions of {addCollateral} and {borrow}.
     *
     * @param collateralRecipient The address that will receive the collateral
     * @param loanRecipient The address that will receive the DNR loan
     * @param borrowAmount The number of DNR tokens to borrow.
     */
    function addCollateralAndBorrow(
        address collateralRecipient,
        address loanRecipient,
        uint256 borrowAmount
    ) external payable isSolvent {
        require(
            collateralRecipient != address(0) && loanRecipient != address(0),
            "DM: no zero address"
        );
        require(borrowAmount > 0, "DM: no zero amount");
        accrue();

        addCollateral(collateralRecipient);
        _borrowFresh(loanRecipient, borrowAmount);
    }

    /**
     * @dev A utility function to repay and withdraw collateral in one call.
     *
     * @param account The address that will have its loan paid.
     * @param principal How many shares of loans to repay.
     * @param to The address that will receive the collateral being withdrawn
     * @param amount The number of collateral to withdraw.
     */
    function repayAndWithdrawCollateral(
        address account,
        uint256 principal,
        address to,
        uint256 amount
    ) external nonReentrant isSolvent {
        require(
            account != address(0) && to != address(0),
            "DM: no zero address"
        );
        require(principal > 0, "DM: principal cannot be 0");
        require(amount > 0, "DM: no zero amount");
        accrue();

        _repayFresh(account, principal);

        _withdrawCollateralFresh(to, amount);
    }

    /**
     * @dev Allows `msg.sender` to add collateral to a `to` address.
     *
     * @notice This is a payable function.
     *
     * @param to The address, which the collateral will be assigned to.
     */
    function addCollateral(address to) public payable {
        // Update Global state
        userCollateral[to] += msg.value;

        emit AddCollateral(_msgSender(), to, msg.value);
    }

    /**
     * @dev This a version of {addCollateral} that adds to the `msg.sender`.
     */
    receive() external payable {
        addCollateral(_msgSender());
    }

    /**
     * @dev Function allows the `msg.sender` to remove his collateral as long as he remains solvent.
     *
     * @param to The address that will receive the collateral being withdrawn.
     * @param amount The number of BNB tokens he wishes to withdraw.
     *
     * Requirements:
     *
     * - `msg.sender` must remain solvent after removing the collateral.
     */
    function withdrawCollateral(address to, uint256 amount)
        external
        nonReentrant
        isSolvent
    {
        // Update how much is owed to the protocol before allowing collateral to be withdrawn
        accrue();

        _withdrawCollateralFresh(to, amount);
    }

    /**
     * @dev This function closes underwater positions. It charges the borrower a fee and rewards the liquidator for keeping the integrity of the protocol
     *
     * @notice Liquidator can use collateral to close the position or must have enough dinero in this account.
     * @notice Liquidators can only close a portion of an underwater position.
     * @notice {exchangeRate} has a base unit of 1e18.
     * @notice The liquidator must have more than the sum of principals in Dinero because of the fees accrued over time. Unless he chooses to use the collateral to cover the positions.
     * @notice We assume PCS will remain most liquid exchange in BSC for this version of the contract. We will also add liquidate of BNB/DNR to PCS.
     *
     * @param accounts The  list of accounts to be liquidated.
     * @param principals The amount of principal the `msg.sender` wants to liquidate for each account.
     * @param recipient The address that will receive the proceeds gained by liquidating.
     * @param path The list of tokens from BNB to dinero in case the `msg.sender` wishes to use collateral to cover the debt.
     *
     * Requirements:
     *
     * - If the liquidator wishes to use collateral to pay off a debt. He must exchange it to Dinero.
     * - He must hold enough Dinero to cover the sum of principals if opts to not sell the collateral in PCS.
     */
    function liquidate(
        address[] calldata accounts,
        uint256[] calldata principals,
        address payable recipient,
        address[] calldata path
    ) external nonReentrant {
        // Make sure token is always exchanged to Dinero as we need to burn at the end.
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

            // How much is the owed in principal + accrued fees
            uint256 debt = _totalLoan.toElastic(principal, false);

            // Calculate the collateralFee (for the liquidator and the protocol)
            uint256 fee = debt.bmul(_liquidationFee);

            // How much collateral is needed to cover the loan + fees.
            // Since Dinero is always USD we can calculate this way.
            uint256 collateralToCover = (debt + fee).bdiv(_exchangeRate);

            // Remove the collateral from the account. We can consider the debt paid.
            userCollateral[account] -= collateralToCover;

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

        // 10% of the liquidation fee to be given to the protocol.
        uint256 protocolFee = uint256(liquidationInfo.allFee).bmul(0.1e18);

        unchecked {
            // Should not overflow.
            // Pay the fee to the protocol
            loan.feesEarned += protocolFee.toUint128();
        }

        // If a path is provided, we will use the collateral to cover the debt
        if (path.length >= 2) {
            // We need to get enough `DINERO` to cover outstanding debt + protocol fees. This means the liquidator will pay for the slippage.
            uint256 minAmount = liquidationInfo.allDebt + protocolFee;

            // Sell all collateral for this liquidation
            ROUTER.swapExactETHForTokens{value: liquidationInfo.allCollateral}(
                // Minimum amount to cover the collateral
                minAmount,
                // Sell COLLATERAL -> DINERO
                path,
                // Send DINERO to the recipient. Since this has to happen in this block. We can burn right after
                recipient,
                // This TX must happen in this block.
                //solhint-disable-next-line not-rely-on-time
                block.timestamp
            );

            // This step we destroy `DINERO` equivalent to all outstanding debt + protocol fee. This does not include the liquidator fee.
            // Liquidator keeps the rest as profit.
            DINERO.burn(recipient, minAmount);
        } else {
            // Liquidator will be paid in `COLLATERAL`
            // Liquidator needs to cover the whole loan + fees.
            DINERO.burn(_msgSender(), liquidationInfo.allDebt + protocolFee);

            // Send him the collateral + a portion of liquidation fee.
            _sendCollateral(recipient, liquidationInfo.allCollateral);
        }
    }

    /*///////////////////////////////////////////////////////////////
                            PRIVATE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Function allows the `msg.sender` to remove his collateral as long as he remains solvent. It does not run solvency checks nor accrue beforehand. The caller must check for those.
     *
     * @param to The address that will receive the collateral being withdrawn.
     * @param amount The number of BNB tokens he wishes to withdraw.
     */
    function _withdrawCollateralFresh(address to, uint256 amount) private {
        // Update State
        userCollateral[_msgSender()] -= amount;

        _sendCollateral(payable(to), amount);

        emit WithdrawCollateral(_msgSender(), to, amount);
    }

    /**
     * @dev A helper function to send BNB to an address.
     *
     * @param to The account that will receive BNB.
     * @param amount How much BNB to send to the `to` address.
     */
    function _sendCollateral(address payable to, uint256 amount) private {
        assert(address(this).balance >= amount);

        //solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory returnData) = to.call{value: amount}("");
        require(
            success,
            returnData.length == 0
                ? "MKT: unable to remove collateral"
                : string(returnData)
        );
    }
}
