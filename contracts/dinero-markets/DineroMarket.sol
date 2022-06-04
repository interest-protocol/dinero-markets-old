/*

▀█▀ █▀▀▄ ▀▀█▀▀ █▀▀ █▀▀█ █▀▀ █▀▀ ▀▀█▀▀ 　 ▒█▀▄▀█ █▀▀█ █▀▀█ █░█ █▀▀ ▀▀█▀▀ 　 ▒█░░▒█ ▄█░ 
▒█░ █░░█ ░░█░░ █▀▀ █▄▄▀ █▀▀ ▀▀█ ░░█░░ 　 ▒█▒█▒█ █▄▄█ █▄▄▀ █▀▄ █▀▀ ░░█░░ 　 ░▒█▒█░ ░█░ 
▄█▄ ▀░░▀ ░░▀░░ ▀▀▀ ▀░▀▀ ▀▀▀ ▀▀▀ ░░▀░░ 　 ▒█░░▒█ ▀░░▀ ▀░▀▀ ▀░▀ ▀▀▀ ░░▀░░ 　 ░░▀▄▀░ ▄█▄

Copyright (c) 2021 Jose Cerqueira - All rights reserved

*/

//SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";

import "../interfaces/IPancakeRouter02.sol";

import "../lib/Rebase.sol";
import "../lib/IntMath.sol";

import "../tokens/Dinero.sol";

import "../Oracle.sol";

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
abstract contract DineroMarket is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    /*///////////////////////////////////////////////////////////////
                            LIBRARIES
    //////////////////////////////////////////////////////////////*/

    using RebaseLibrary for Rebase;
    using SafeCastUpgradeable for uint256;
    using IntMath for uint256;

    /*///////////////////////////////////////////////////////////////
                                  STRUCTS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice We use 2 uint64 and 1 uint128 for memory efficiency. These ranges should cover all cases.
     */
    struct Loan {
        uint64 lastAccrued; // Last block in which we have calculated the total fees owed to the protocol.
        // solhint-disable-next-line var-name-mixedcase
        uint64 INTEREST_RATE; // INTEREST_RATE is charged per second and has a base unit of 1e18.
        uint128 feesEarned; // How many fees have the protocol earned since the last time the {owner} has collected the fees.
    }
    /**
     * @dev A struct to avoid stack error for variable. It collects data needed to properly liquidate users.
     *
     * @notice We use uint128 for memory efficiency. Liquidation information should not be higher than the maximum uint128.
     */
    struct LiquidationInfo {
        uint128 allCollateral; // How much collateral will be used to repay the underwater positions.
        uint128 allDebt; // How much principal + interest rate is being repaid to the protocol.
        uint128 allPrincipal; // How much principal is being repaid to the protocol.
        uint128 allFee; // Total amount of liquidation fee the liquidator and protocol will earn.
    }

    /*///////////////////////////////////////////////////////////////
                            EVENTS
    //////////////////////////////////////////////////////////////*/

    event ExchangeRate(uint256 rate);

    event Accrue(uint256 accruedAmount);

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

    event LiquidationFee(uint256 fee);

    event MaxTVLRatio(uint256 ltv);

    event InterestRate(uint256 rate);

    event MaxBorrowAmount(uint256 maxBorrowAmount);

    /*///////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    // Requests
    uint8 internal constant ADD_COLLATERAL_REQUEST = 0;

    uint8 internal constant WITHDRAW_COLLATERAL_REQUEST = 1;

    uint8 internal constant BORROW_REQUEST = 2;

    uint8 internal constant REPAY_REQUEST = 3;

    // solhint-disable-next-line var-name-mixedcase
    IPancakeRouter02 internal constant ROUTER =
        IPancakeRouter02(0x10ED43C718714eb63d5aA57B78B54704E256024E); // PCS router

    // solhint-disable-next-line var-name-mixedcase
    Dinero public DINERO; // Dinero stable coin

    // solhint-disable-next-line var-name-mixedcase
    address public FEE_TO; // treasury address

    // solhint-disable-next-line var-name-mixedcase
    Oracle public ORACLE; // Oracle contract

    // Total amount of princicpal borrowed in Dinero.
    Rebase public totalLoan;

    // How much collateral an address has deposited.
    mapping(address => uint256) public userCollateral;

    // How much principal an address has borrowed.
    mapping(address => uint256) public userLoan;

    // Current exchange rate between BNB and USD.
    uint256 public exchangeRate;

    // Information about the global loan.
    Loan public loan;

    // principal + interest rate / collateral. If it is above this value, the user might get liquidated.
    uint256 public maxLTVRatio;

    // A fee that will be charged as a penalty of being liquidated.
    uint256 public liquidationFee;

    // Dinero Markets must have a max of how much DNR they can create to prevent liquidity issues during liquidations.
    uint256 public maxBorrowAmount;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     */
    uint256[50] private __gap;

    /*///////////////////////////////////////////////////////////////
                            INITIALIZER
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Sets up the ownable contract, it is to be called by the child contract.
     */
    //solhint-disable-next-line func-name-mixedcase
    function __DineroMarket_init() internal onlyInitializing {
        __Ownable_init();
    }

    /*///////////////////////////////////////////////////////////////
                            MODIFIERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Check if a user loan is below the {maxLTVRatio}.
     *
     * @notice This function requires this contract to be deployed in a blockchain with low TX fees. As calling an oracle can be quite expensive.
     * @notice That the oracle is called in this function. In case of failure, liquidations, borrowing dinero and removing collateral will be disabled. Underwater loans will not be liquidated, but good news is that borrowing and removing collateral will remain closed.
     */
    modifier isSolvent() {
        _;
        // `msg.sender` has to be solvent after he performed all operations not
        require(
            _isSolvent(_msgSender(), updateExchangeRate()),
            "MKT: sender is insolvent"
        );
    }

    /*///////////////////////////////////////////////////////////////
                        MUTATIVE PUBLIC FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev This function sends the collected fees by this market to the governor feeTo address.
     */
    function getEarnings() external {
        // Update the total debt, includes the {loan.feesEarned}.
        accrue();

        uint256 earnings = loan.feesEarned;

        // Reset to 0
        loan.feesEarned = 0;

        address feeTo = FEE_TO;

        // This can be minted. Because once users get liquidated or repay the loans. This amount will be burned (fees).
        // So it will keep the peg to USD. There must be always at bare minimum 1 USD in collateral to 1 Dinero in existence.
        DINERO.mint(feeTo, earnings);

        emit GetEarnings(feeTo, earnings);
    }

    /**
     * @dev Updates the total fees owed to the protocol and the new total borrowed with the new fees included.
     *
     * @notice We use {block.timestamp} instead of block number for calculations but should be an issue. This is to make it easier once we expand crosschain.
     * @notice {loan.INTEREST_RATE} has a base unit of 1e18.
     * @notice uncheck blocks to save gas. They are on operation that should not overflow.
     */
    function accrue() public {
        // Save gas save loan info to memory
        Loan memory _loan = loan;

        // Variable to know how many blocks have passed since {loan.lastAccrued}.
        uint256 elapsedTime;

        unchecked {
            // Should never overflow.
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
        // By using {bmul} at the end we get a higher precision
        uint256 debt = (uint256(_totalLoan.elastic) * _loan.INTEREST_RATE).bmul(
            elapsedTime
        );

        unchecked {
            // Should not overflow.
            // Debt will eventually be paid to treasury so we update the information here.
            _loan.feesEarned += debt.toUint128();
        }

        // Update the total debt owed to the protocol
        totalLoan.addElastic(debt);
        // Update the loan
        loan = _loan;

        emit Accrue(debt);
    }

    /**
     * @dev This function gets the latest exchange rate between the collateral and USD from chainlink.
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
    function updateExchangeRate() public virtual returns (uint256);

    /**
     * @dev Allows the `msg.sender` to use his collateral to borrow `DINERO` to a desired `to` address.
     *
     * @param to The address which will receive the borrowed `DINERO`
     * @param amount The number of `DINERO` to borrow
     *
     * Requirements:
     *
     * - `msg.sender` must remain solvent after borrowing Dinero.
     */
    function borrow(address to, uint256 amount) external isSolvent {
        require(
            maxBorrowAmount >= totalLoan.elastic + amount,
            "MKT: max borrow amount reached"
        );
        // To prevent loss of funds.
        require(to != address(0), "MKT: no zero address");
        // Update how much is owed to the protocol before allowing collateral to be removed
        accrue();

        _borrowFresh(to, amount);
    }

    /**
     * @dev It allows the `msg.sender` to repay a portion of the loan to any `account`
     *
     * @notice The amount burned is higher than the `principal` because it includes fees.
     *
     * @param account The address which will have some of its principal paid back.
     * @param principal How many `DINERO` tokens (princicpal) to be paid back for the `account`
     *
     * Requirements:
     *
     * - account cannot be the zero address to avoid loss of funds
     * - principal has to be greater than 0. Otherwise, the user is just wasting gas and congesting the network.
     */
    function repay(address account, uint256 principal) external {
        require(account != address(0), "MKT: no zero address");
        require(principal > 0, "MKT: principal cannot be 0");

        // Update how much is owed to the protocol before allowing collateral to be removed
        accrue();

        _repayFresh(account, principal);
    }

    /*///////////////////////////////////////////////////////////////
                            INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev The core logic of borrow. Careful it does not accrue or check for solvency.
     *
     * @param to The address which will receive the borrowed `DINERO`
     * @param amount The number of `DINERO` to borrow
     */
    function _borrowFresh(address to, uint256 amount) internal {
        // What is the principal in proportion to the `amount` of Dinero based on the {loan}.
        uint256 principal;

        // Update global state
        (totalLoan, principal) = totalLoan.add(amount, true);
        userLoan[_msgSender()] += principal;

        // Note the `msg.sender` can use his collateral to lend to someone else.
        DINERO.mint(to, amount);

        emit Borrow(_msgSender(), to, principal, amount);
    }

    /**
     * @dev The core logic to repay a loan without accrueing or require checks.
     *
     * @param account The address which will have some of its principal paid back.
     * @param principal How many `DINERO` tokens (princicpal) to be paid back for the `account`
     */
    function _repayFresh(address account, uint256 principal) internal {
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
     * @dev Checks if an `account` has enough collateral to back his loan based on the {maxLTVRatio}.
     *
     * @param account The address to check if he is solvent.
     * @param _exchangeRate The current exchange rate of `COLLATERAL` in USD
     * @return bool True if the user can cover his loan. False if he cannot.
     */
    function _isSolvent(address account, uint256 _exchangeRate)
        internal
        view
        returns (bool)
    {
        // How much the user has borrowed.
        uint256 principal = userLoan[account];

        // Account has no open loans. So he is solvent.
        if (principal == 0) return true;

        // How much collateral he has deposited.
        uint256 collateralAmount = userCollateral[account];

        // Account has no collateral so he can not open any loans. He is insolvent.
        if (collateralAmount == 0) return false;

        // Save storage in memory to save gas.
        Rebase memory _totalLoan = totalLoan;

        // Convert the collateral to USD. USD has 18 decimals so we need to remove them.
        uint256 collateralInUSD = collateralAmount.bmul(_exchangeRate);

        // All Loans are emitted in `DINERO` which is based on USD price
        // Collateral in USD * {maxLTVRatio} has to be greater than principal + interest rate accrued in DINERO which is pegged to USD
        return
            collateralInUSD.bmul(maxLTVRatio) >
            _totalLoan.toElastic(principal, true);
    }

    /**
     * @dev Helper function to check if we should check for solvency in the request functions
     *
     * @param _request The request action
     * @return bool if true the function should check for solvency
     */
    function _checkForSolvency(uint8 _request) internal pure returns (bool) {
        if (_request == WITHDRAW_COLLATERAL_REQUEST) return true;
        if (_request == BORROW_REQUEST) return true;

        return false;
    }

    /**
     * @dev Helper function to check if we should accrue for the request functions
     *
     * @param _request The request action
     * @return bool if true the function should accrue
     */
    function _checkIfAccrue(uint8 _request) internal pure returns (bool) {
        if (_request == WITHDRAW_COLLATERAL_REQUEST) return true;
        if (_request == REPAY_REQUEST) return true;
        if (_request == BORROW_REQUEST) return true;

        return false;
    }

    /*///////////////////////////////////////////////////////////////
                         OWNER ONLY
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev updates the {maxLTVRatio} of the whole contract.
     *
     * @param amount The new {maxLTVRatio}.
     *
     * Requirements:
     *
     * - {maxLTVRatio} cannot be higher than 90% due to the high volatility of crypto assets and we are using the overcollaterization ratio.
     * - It can only be called by the owner to avoid griefing
     *
     */
    function setMaxLTVRatio(uint256 amount) external onlyOwner {
        require(0.9e18 >= amount, "MKT: too high");
        maxLTVRatio = amount;
        emit MaxTVLRatio(amount);
    }

    /**
     * @dev Updates the {liquidationFee}.
     *
     * @param amount The new liquidation fee.
     *
     * Requirements:
     *
     * - It cannot be higher than 15%.
     * - It can only be called by the owner to avoid griefing.
     *
     */
    function setLiquidationFee(uint256 amount) external onlyOwner {
        require(0.15e18 >= amount, "MKT: too high");
        liquidationFee = amount;
        emit LiquidationFee(amount);
    }

    /**
     * @dev Sets the new {loan.INTEREST_RATE}.
     *
     * @notice Please note that the value has a precision of 1e18.
     *
     * @param amount The new interest rate.
     *
     * Requirements:
     *
     * - This function is guarded by the {onlyOwner} modifier to disallow users from arbitrarly changing the interest rate of borrowing.
     * - It also requires the new interest rate to be lower than 4% annually.
     *
     */
    function setInterestRate(uint64 amount) external onlyOwner {
        // 13e8 * 60 * 60 * 24 * 365 / 1e18 = ~ 0.0409968
        require(13e8 >= amount, "MKT: too high");
        loan.INTEREST_RATE = amount;
        emit InterestRate(amount);
    }

    /**
     * @dev Sets a new value to the {maxBorrowAmount}.
     *
     * @notice Allows the {owner} to set a limit on how DNR can be created by this market.
     *
     * @param amount The new maximum amount that can be borrowed.
     *
     * Requirements:
     *
     * - Function can only be called by the {owner}
     */
    function setMaxBorrowAmount(uint256 amount) external onlyOwner {
        maxBorrowAmount = amount;
        emit MaxBorrowAmount(amount);
    }

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
