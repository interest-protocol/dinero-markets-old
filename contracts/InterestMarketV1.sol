/*

▀█▀ █▀▀▄ ▀▀█▀▀ █▀▀ █▀▀█ █▀▀ █▀▀ ▀▀█▀▀ 　 ▒█▀▄▀█ █▀▀█ █▀▀█ █░█ █▀▀ ▀▀█▀▀ 　 ▒█░░▒█ ▄█░ 
▒█░ █░░█ ░░█░░ █▀▀ █▄▄▀ █▀▀ ▀▀█ ░░█░░ 　 ▒█▒█▒█ █▄▄█ █▄▄▀ █▀▄ █▀▀ ░░█░░ 　 ░▒█▒█░ ░█░ 
▄█▄ ▀░░▀ ░░▀░░ ▀▀▀ ▀░▀▀ ▀▀▀ ▀▀▀ ░░▀░░ 　 ▒█░░▒█ ▀░░▀ ▀░▀▀ ▀░▀ ▀▀▀ ░░▀░░ 　 ░░▀▄▀░ ▄█▄

Copyright (c) 2021 Jose Cerqueira - All rights reserved

*/

//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Context.sol";

import "./interfaces/IPancakeRouter02.sol";

import "./lib/Rebase.sol";

import "./vaults/Vault.sol";

import "./Dinero.sol";
import "./OracleV1.sol";
import "./InterestGovernorV1.sol";

/**
 * @dev notice If the market has a vault. `ms.sender` has to approve the vault if not it has to approve the market
 * INTEREST_RATE has a precision of 1e8
 * exchange rate has 18 decimals
 * collateralRatio precision is 1e6
 * liquidationFee precision 1e6
 */
contract InterestMarketV1 is Initializable, Context {
    /*********************************** LIBRARY ***********************************/

    using RebaseLibrary for Rebase;
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /*********************************** EVENTS ***********************************/

    event ExchangeRate(uint256 rate);

    event Accrue(uint256 accruedAmount);

    event AddCollateral(address indexed account, uint256 amount);

    event RemoveCollateral(address indexed account, uint256 amount);

    event Borrow(
        address indexed from,
        address indexed to,
        uint256 principal,
        uint256 amount
    );

    event Repay(
        address indexed payer,
        address indexed borrower,
        uint256 principal,
        uint256 debt
    );

    event GetEarnings(address indexed treasury, uint256 amount);

    /**************************** STRUCTS ****************************/

    struct Loan {
        uint64 lastAccrued;
        // INTEREST_RATE is per second with a precision of 1e18
        // solhint-disable-next-line var-name-mixedcase
        uint64 INTEREST_RATE;
        uint128 feesEarned;
    }

    struct LiquidationInfo {
        uint128 allCollateral;
        uint128 allDebt;
        uint128 allPrincipal;
        uint128 allFee;
    }

    /**************************** MASTER CONTRACT STATE ****************************/

    // solhint-disable-next-line var-name-mixedcase
    InterestMarketV1 public immutable MASTER_CONTRACT;

    // solhint-disable-next-line var-name-mixedcase
    IPancakeRouter02 public immutable ROUTER;

    // solhint-disable-next-line var-name-mixedcase
    Dinero public immutable DINERO;

    // solhint-disable-next-line var-name-mixedcase
    InterestGovernorV1 public immutable GOVERNOR;

    // solhint-disable-next-line var-name-mixedcase
    OracleV1 public immutable ORACLE;

    /*********************************** CLONE STATE ***********************************/

    // Only support tokens with 18 decimals
    // Clone only variable
    // solhint-disable-next-line var-name-mixedcase
    IERC20 public COLLATERAL;

    // solhint-disable-next-line var-name-mixedcase
    Vault public VAULT;

    // Clone only variable
    uint256 public totalCollateral;

    // Clone only variable
    Rebase public totalLoan;

    // Clone only variable
    mapping(address => uint256) public userCollateral;

    // Clone only variable
    mapping(address => uint256) public userLoan;

    // Clone only variable
    uint256 public exchangeRate;

    // Clone only variable
    Loan public loan;

    uint256 public collateralRatio;

    uint256 public liquidationFee; // Percent

    /**************************** CONSTRUCTOR ****************************/

    constructor(
        IPancakeRouter02 router,
        Dinero dinero,
        InterestGovernorV1 governor,
        OracleV1 oracle
    ) {
        MASTER_CONTRACT = this;
        ROUTER = router;
        DINERO = dinero;
        GOVERNOR = governor;
        ORACLE = oracle;
    }

    /**************************** INITIALIZE ****************************/

    function initialize(bytes calldata data) external payable initializer {
        require(address(MASTER_CONTRACT) != address(this), "MKT: not allowed");

        (
            COLLATERAL,
            // Note the VAULT can be the address(0)
            VAULT,
            loan.INTEREST_RATE,
            collateralRatio,
            liquidationFee
        ) = abi.decode(data, (IERC20, Vault, uint64, uint256, uint256));

        // Approve the router to trade the collateral
        COLLATERAL.safeApprove(address(ROUTER), type(uint256).max);

        require(address(COLLATERAL) != address(0), "MKT: no zero address");
    }

    /**************************** MODIFIER ****************************/

    modifier isSolvent() {
        _;
        // `msg.sender` has to be solvent after he performed all operations not
        require(
            _isSolvent(_msgSender(), updateExchangeRate()),
            "MKT: sender is insolvent"
        );
    }

    /**
     * @dev Throws if called by any account other than the owner.
     */
    modifier onlyGovernorOwner() {
        require(
            GOVERNOR.owner() == _msgSender(),
            "MKT: caller is not the owner"
        );
        _;
    }

    /**************************** VIEW PUBLIC FUNCTIONS ****************************/

    /**
     * View function to easily find who the governor owner is. Since it is the address that can call the governor owner functions
     */
    function governorOwner() external view returns (address) {
        return GOVERNOR.owner();
    }

    /**************************** MUTATIVE PUBLIC FUNCTIONS ****************************/

    /**
     * This function is to increase the allowance to the PCS router for liquidation purposes
     * @param amount The amount of tokens to add to the allowance
     */
    function approve(uint256 amount) external {
        COLLATERAL.safeIncreaseAllowance(address(ROUTER), amount);
    }

    /**
     * This function sends the collected fees by this market to the treasury.
     * This `DINERO` will be used to burn INTEREST TOKENS.
     */
    function getEarnings() external {
        // Update the total debt
        accrue();

        uint256 earnings = loan.feesEarned;
        // Reset to 0
        loan.feesEarned = 0;

        address treasury = GOVERNOR.feeTo();

        // This can be minted. Because once users get liquidated or repay the loans. This amount will be burned (fees).
        DINERO.mint(treasury, earnings);

        emit GetEarnings(treasury, earnings);
    }

    /**
     * @dev Updates the total fees owed to the protocol and the new total borrowed with the new fees included
     */
    function accrue() public {
        // Save gas save accrueInfo to memory
        Loan memory _loan = loan;

        uint256 elapsedTime;

        unchecked {
            // Check how much time passed since the last we accrued interest
            // solhint-disable-next-line not-rely-on-time
            elapsedTime = block.timestamp - _loan.lastAccrued;
        }

        // If no time has passed. There is nothing to do;
        if (elapsedTime == 0) return;

        // Update the lastAccrued time to this block
        // solhint-disable-next-line not-rely-on-time
        _loan.lastAccrued = block.timestamp.toUint64();

        // Save to memory the totalLoan information for gas optimization
        Rebase memory _totalLoan = totalLoan;

        // If there are no open loans. We do not need to update the fees.
        if (_totalLoan.base == 0) {
            // Save the lastAccrued time to storage and return.
            loan = _loan;
            return;
        }

        // Amount of tokens every borrower together owes the protocol
        // Reminder: `INTEREST_RATE` is boosted by 1e18
        uint256 debt = (uint256(_totalLoan.elastic) *
            _loan.INTEREST_RATE *
            elapsedTime) / 1e18;

        unchecked {
            // Debt will eventually be paid to treasury so we update the information here
            _loan.feesEarned += debt.toUint128();
        }

        // Update the total debt owed to the protocol
        totalLoan.addElastic(debt);
        // Update the loan
        loan = _loan;

        emit Accrue(debt);
    }

    /**
     * This function updates the global exchange rate and returns the new exchange rate
     * @return rate The latest exchange rate from Chainlink
     */
    function updateExchangeRate() public returns (uint256 rate) {
        // Get USD price for 1 Token (18 decimals). The USD price also has 18 decimals. We need to reduc
        rate = ORACLE.getUSDPrice(address(COLLATERAL), 1 ether);

        // if the exchange rate is different we need to update the global state
        if (rate != exchangeRate) {
            exchangeRate = rate;
            emit ExchangeRate(rate);
        }
    }

    /**
     * Function adds collateral to the `msg.sender`
     * @param amount The number of `COLLATERAL` tokens to be used for collateral
     */
    function addCollateral(uint256 amount) external {
        // Get `COLLATERAL` from `msg.sender`
        _depositCollateral(_msgSender(), amount);

        // Update Global state
        userCollateral[_msgSender()] += amount;
        totalCollateral += amount;

        emit AddCollateral(_msgSender(), amount);
    }

    /**
     * Functions allows the `msg.sender` to remove his collateral as long as he remains solvent
     * @param amount The number of `COLLATERAL` tokens he wishes to withdraw
     */
    function removeCollateral(uint256 amount) external isSolvent {
        // Update how much is owed to the protocol before allowing collateral to be removed
        accrue();

        // Update State
        userCollateral[_msgSender()] -= amount;
        totalCollateral -= amount;

        // Return the collateral to the user
        _withdrawCollateral(_msgSender(), _msgSender(), amount);

        emit RemoveCollateral(_msgSender(), amount);
    }

    /**
     * This function allows the `msg.sender` to use his collateral to borrow `DINERO` to a desired address
     * @param to The address which will receive the borrowed `DINERO`
     * @param amount The number of `DINERO` to borrow
     */
    function borrow(address to, uint256 amount) external isSolvent {
        require(to != address(0), "MKT: no zero address");
        // Update how much is owed to the protocol before allowing collateral to be removed
        accrue();

        uint256 principal;

        // Update global state
        (totalLoan, principal) = totalLoan.add(amount, true);
        userLoan[_msgSender()] += principal;

        // Note the `msg.sender` can use his collateral to lend to someone else
        DINERO.mint(to, amount);

        emit Borrow(_msgSender(), to, principal, amount);
    }

    /**
     * This function allows the `msg.sender` to repay a portion of the loan to any `account`
     * @param account The address which will have some of its principal paid back
     * @param principal How many `DINERO` tokens (princicpal) to be paid back for the `account`
     */
    function repay(address account, uint256 principal) external {
        // Update how much is owed to the protocol before allowing collateral to be removed
        accrue();

        // Debt includes principal + accrued interest owed
        uint256 debt;

        // Update Global state
        (totalLoan, debt) = totalLoan.sub(principal, true);
        userLoan[account] -= principal;

        // Since all debt is in `DINERO`. We can simply burn it from the `msg.sender`
        DINERO.burn(_msgSender(), debt);

        emit Repay(_msgSender(), account, principal, debt);
    }

    /**
     * @param accounts The  list of accounts to be liquidated
     * @param principals The amount of debt the `msg.sender` wants to liquidate for each account
     * @param recipient The address that will receive the proceeds gained by liquidating
     * @param path The list of tokens from collateral to dinero in case the `msg.sender` wishes to use collateral to cover the debt
     *
     * This function closes under-collaterized position. It charges the borrower a fee and rewards the liquidator for keeping the integrity of the protocol
     *
     */
    function liquidate(
        address[] calldata accounts,
        uint256[] calldata principals,
        address recipient,
        address[] calldata path
    ) external {
        require(
            path.length == 0 || path[path.length - 1] == address(DINERO),
            "MKT: no dinero at last index"
        );
        // Liquidations must be based on the current exchange rate
        uint256 _exchangeRate = updateExchangeRate();

        // Update all debt
        accrue();

        LiquidationInfo memory liquidationInfo;

        Rebase memory _totalLoan = totalLoan;

        uint256 _liquidationFee = liquidationFee;

        for (uint256 i = 0; i < accounts.length; i++) {
            address account = accounts[i];

            // If the user has enough collateral to cover his debt. Move to the next one
            if (_isSolvent(account, _exchangeRate)) continue;

            uint256 principal;

            {
                // How much principal the user owes
                uint256 loanPrincipal = userLoan[account];

                // Liquidator cannot repay more than the what `account` owes
                principal = principals[i] > loanPrincipal
                    ? loanPrincipal
                    : principals[i];

                // Update the userLoan global state
                userLoan[account] -= principal;
            }

            // How much is the owed principal + accrued fees
            uint256 debt = _totalLoan.toElastic(principal, false);

            // Calculate the collateralFee (for the liquidator and the protocol)
            uint256 fee = (debt * _liquidationFee) / 1e6;

            uint256 collateralToCover = ((debt + fee) * 1e18) / _exchangeRate;

            // Remove the collateral from the account. We can consider the debt paid.
            userCollateral[account] -= collateralToCover;

            // Get the Rewards and collateral if they are in a vault to this contract.
            // The rewards go to the `account`
            // The collateral comes to this contract
            if (Vault(address(0)) != VAULT) {
                VAULT.withdraw(account, address(this), collateralToCover);
            }

            emit RemoveCollateral(account, collateralToCover);
            emit Repay(_msgSender(), account, principal, debt);

            liquidationInfo.allCollateral += collateralToCover.toUint128();
            liquidationInfo.allPrincipal += principal.toUint128();
            liquidationInfo.allDebt += debt.toUint128();
            liquidationInfo.allFee += fee.toUint128();
        }

        // There must have liquidations or we throw an error;
        require(liquidationInfo.allPrincipal > 0, "MKT: no liquidations");

        // Clean up dust
        if (liquidationInfo.allPrincipal == _totalLoan.base)
            liquidationInfo.allDebt = _totalLoan.elastic;

        // Update Global state
        totalLoan = _totalLoan.sub(
            liquidationInfo.allPrincipal,
            liquidationInfo.allDebt
        );

        totalCollateral -= liquidationInfo.allCollateral;

        // 10% of the liquidation fee to be given to the protocol
        uint256 protocolFee = (liquidationInfo.allFee * 100) / 1000;

        unchecked {
            // Pay the fee to the protocol
            loan.feesEarned += protocolFee.toUint128();
        }

        // If a path is provided, we will use the collateral to cover the debt
        if (path.length >= 2) {
            // We need to get enough `DINERO` to cover outstanding debt + protocol fee. This means the liquidator will pay for the slippage
            uint256 minAmount = liquidationInfo.allDebt + protocolFee;

            ROUTER.swapExactTokensForTokens(
                // Sell all collateral for this liquidation
                liquidationInfo.allCollateral,
                minAmount,
                // Sell COLLATERAL -> DINERO
                path,
                // Send DINERO to the recipient. Since this has to happen in this block. We can burn right after
                recipient,
                // This to suceed in this block
                //solhint-disable-next-line not-rely-on-time
                block.timestamp
            );

            // This step we destroy `DINERO` equivalent to all outstanding debt + protocol fee. This does not include the liquidator fee
            DINERO.burn(recipient, minAmount);
        } else {
            // Liquidator will be paid in `COLLATERAL`
            // Liquidator needs to cover the whole loan + fees
            DINERO.burn(_msgSender(), liquidationInfo.allDebt + protocolFee);
            // Send collateral to the `recipient` (includes liquidator fee + protocol fee)
            COLLATERAL.safeTransfer(recipient, liquidationInfo.allCollateral);
        }
    }

    /**************************** PRIVATE FUNCTIONS ****************************/

    /**
     * @dev Checks if an account has enough collateral to back his loan
     * @param account The address to check if he is solvent
     * @param _exchangeRate The current exchange rate of `COLLATERAL` in USD
     * @return bool True if the user can cover his loan. False if he cannot.
     */
    function _isSolvent(address account, uint256 _exchangeRate)
        private
        view
        returns (bool)
    {
        uint256 principal = userLoan[account];

        // Account has no open loans. So he is solvent
        if (principal == 0) return true;

        uint256 collateralAmount = userCollateral[account];

        // Account has no collateral so he can not open any loans. He is insolvent
        if (collateralAmount == 0) return false;

        Rebase memory _totalLoan = totalLoan;

        // Convert the collateral to USD. USD has 18 decimals so we need to remove them
        uint256 collateralInUSD = (collateralAmount * _exchangeRate) / 1e18;

        /**
        All Loans are emitted in `DINERO` which is based on USD price
        Collateral in USD times collateral ratio has to be greater than what is borrowing + interest rate accrued in DINERO which is pegged to USD
         */
        return
            (collateralInUSD * collateralRatio) >
            // Multiplying the collateral precision ratio this way gives more precision
            _totalLoan.toElastic(principal, true) * 1e6;
    }

    /**
     * This is a helper function to account for the fact that some contracts have a vault to farm the collateral
     * @param account The address who needs to deposit collateral
     * @param amount The number of tokens it needs to provide as collateral
     */
    function _depositCollateral(address account, uint256 amount) private {
        if (Vault(address(0)) == VAULT) {
            COLLATERAL.safeTransferFrom(account, address(this), amount);
        } else {
            VAULT.deposit(account, amount);
        }
    }

    /**
     * This is a helper function to withdraw the collateral from this contract or the `VAULT`
     * @param account The address who owns the collateral being withdrawn
     * @param recipient The address that will receive the collateral + rewards if applicable
     * @param amount The amount of collateral to withdraw
     */
    function _withdrawCollateral(
        address account,
        address recipient,
        uint256 amount
    ) private {
        if (Vault(address(0)) == VAULT) {
            COLLATERAL.safeTransfer(recipient, amount);
        } else {
            VAULT.withdraw(account, recipient, amount);
        }
    }

    /**************************** OWNER ONLY FUNCTIONS ****************************/

    /**
     * @param amount The new collateralRatio. Be mindful that it has a precision of 1e6
     *
     * Requirements:
     * Collateral Ratio cannot be higher than 90% due to the high volatility of crypto assets
     * It can only be called by the governor owner to avoid griefing
     *
     */
    function setCollateralRatio(uint256 amount) external onlyGovernorOwner {
        require(9e5 >= amount, "MKT: too high");
        collateralRatio = amount;
    }

    /**
     * @param amount The new liquidation fee. It is a percentage with a precision of 1e6
     *
     * Requirements:
     * It cannot be higher than 15%
     * It can only be called by the governor owner to avoid griefing
     *
     */
    function setLiquidationFee(uint256 amount) external onlyGovernorOwner {
        require(15e4 >= amount, "MKT: too high");
        liquidationFee = amount;
    }

    /**
     * @param amount The new interest rate.
     *
     * Requirements:
     *
     * This function is guarded by the {onlyGovernorOwner} modifier to disallow users from arbitrarly changing the interest rate of borrowing
     * It also requires the new interest rate to be lower than 4% annually. Please note that the value is boosted by 1e18
     *
     */
    function setInterestRate(uint64 amount) external onlyGovernorOwner {
        require(13e8 >= amount, "MKT: too high");
        loan.INTEREST_RATE = amount;
    }
}
