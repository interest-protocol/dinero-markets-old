/*

▀█▀ █▀▀▄ ▀▀█▀▀ █▀▀ █▀▀█ █▀▀ █▀▀ ▀▀█▀▀ 　 ▒█▀▄▀█ █▀▀█ █▀▀█ █░█ █▀▀ ▀▀█▀▀ 　 ▒█░░▒█ ▄█░ 
▒█░ █░░█ ░░█░░ █▀▀ █▄▄▀ █▀▀ ▀▀█ ░░█░░ 　 ▒█▒█▒█ █▄▄█ █▄▄▀ █▀▄ █▀▀ ░░█░░ 　 ░▒█▒█░ ░█░ 
▄█▄ ▀░░▀ ░░▀░░ ▀▀▀ ▀░▀▀ ▀▀▀ ▀▀▀ ░░▀░░ 　 ▒█░░▒█ ▀░░▀ ▀░▀▀ ▀░▀ ▀▀▀ ░░▀░░ 　 ░░▀▄▀░ ▄█▄

Copyright (c) 2021 Jose Cerqueira - All rights reserved

*/

//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./interfaces/InterestMarketV1Interface.sol";
import "./interfaces/IPancakeRouter02.sol";

import "./lib/Rebase.sol";

import "./Dinero.sol";
import "./OracleV1.sol";
import "./InterestGovernorV1.sol";

/**
 * @notice
 * INTEREST_RATE has a precision of 1e18
 * exchange rate has 18 decimals
 * collateralRatio precision is 1e6
 */
contract InterestMarketV1 is InterestMarketV1Interface, Initializable, Ownable {
    /*********************************** LIBRARY ***********************************/

    using RebaseLibrary for Rebase;
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /*********************************** EVENTS ***********************************/

    event ExchangeRate(uint256 rate);

    event Accrue(uint256 accruedAmount);

    event AddCollateral(address indexed account, uint256 amount);

    event RemoveCollateral(address indexed account, uint256 amount);

    event Borrow(address indexed from, address indexed to, uint256 amount);

    event Repay(
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 part
    );

    event WithdrawFees(address indexed feeTo, uint256 amount);

    /**************************** STRUCTS ****************************/

    struct AccrueInfo {
        uint64 lastAccrued;
        // INTEREST_RATE is per second with a precision of 1e18
        // solhint-disable-next-line var-name-mixedcase
        uint64 INTEREST_RATE;
        uint128 feesEarned;
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

    // Clone only variable
    uint256 public totalCollateral;

    // Clone only variable
    Rebase public totalBorrow;

    // Clone only variable
    mapping(address => uint256) public userCollateral;

    // Clone only variable
    mapping(address => uint256) public userBorrow;

    // Clone only variable
    uint256 public exchangeRate;

    // Clone only variable
    AccrueInfo public accrueInfo;

    uint256 public collateralRatio;

    uint256 public liquidationRate;

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
        require(address(MASTER_CONTRACT) != address(this), "IMV1: not allowed");

        (
            COLLATERAL,
            accrueInfo.INTEREST_RATE,
            collateralRatio,
            liquidationRate
        ) = abi.decode(data, (IERC20, uint64, uint256, uint256));

        // Approve the router to trade the collateral
        COLLATERAL.safeApprove(address(ROUTER), type(uint256).max);

        require(address(COLLATERAL) != address(0), "MKT: no zero address");
    }

    /**************************** MODIFIER ****************************/

    modifier isSolvent() {
        _;
        // `msg.sender` has to be solvent after he performed all operations not before
        require(
            _isSolvent(_msgSender(), exchangeRate),
            "MKT: sender is insolvent"
        );
    }

    /**************************** MUTATIVE PUBLIC FUNCTIONS ****************************/

    /**
     * @dev Updates the total fees owed to the protocol and the new total borrowed with the new fees included
     */
    function accrue() public {
        // Save gas save accrueInfo to memory
        AccrueInfo memory _accrueInfo = accrueInfo;

        // Check how much time passed since the last we accrued interest
        // solhint-disable-next-line not-rely-on-time
        uint256 elapsedTime = block.timestamp - _accrueInfo.lastAccrued;

        // If no time has passed. There is nothing to do;
        if (elapsedTime == 0) return;

        // Update the lastAccrued time to this block
        // solhint-disable-next-line not-rely-on-time
        _accrueInfo.lastAccrued = block.timestamp.toUint64();

        // Save to memory the totalBorrow information for gas optimization
        Rebase memory _totalBorrow = totalBorrow;

        // If there are no open loans. We do not need to update the fees.
        if (_totalBorrow.base == 0) {
            // Save the lastAccrued time to storage and return.
            accrueInfo = _accrueInfo;
            return;
        }

        // Amount of tokens every borrower together owes the protocol
        // Reminder: `INTEREST_RATE` is boosted by 1e18
        uint256 debt = (uint256(_totalBorrow.elastic) *
            _accrueInfo.INTEREST_RATE *
            elapsedTime) / 1e18;

        // Debt will eventually be paid to treasury so we update the information here
        _accrueInfo.feesEarned += debt.toUint128();

        // Update the total debt owed to the protocol
        totalBorrow.addElastic(debt);
        // Update the accrueInfo
        accrueInfo = _accrueInfo;

        emit Accrue(debt);
    }

    /**
     * This function updates the global exchange rate and returns the new exchange rate
     * @return rate The latest exchange rate from Chainlink
     */
    function updateExchangeRate() public returns (uint256 rate) {
        // Get USD price for 1 Token (18 decimals). The USD price also has 18 decimals
        rate = ORACLE.getTokenUSDPrice(address(COLLATERAL), 1 ether);

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
        COLLATERAL.transferFrom(_msgSender(), address(this), amount);

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
        COLLATERAL.safeTransfer(_msgSender(), amount);

        emit RemoveCollateral(_msgSender(), amount);
    }

    /**
     * This function allows the `msg.sender` to use his collateral to borrow `DINERO` to a desired address
     * @param to The address which will receive the borrowed `DINERO`
     * @param amount The number of `DINERO` to borrow
     */
    function borrow(address to, uint256 amount) external isSolvent {
        // Update how much is owed to the protocol before allowing collateral to be removed
        accrue();

        // Update global state
        (totalBorrow, ) = totalBorrow.add(amount, true);
        userBorrow[_msgSender()] += amount;

        // Note the `msg.sender` can use his collateral to lend to someone else
        DINERO.mint(to, amount);

        emit Borrow(_msgSender(), to, amount);
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
        uint256 borrowAmount = userBorrow[account];

        // Account has no open loans. So he is solvent
        if (borrowAmount == 0) return true;

        uint256 collateralAmount = userCollateral[account];

        // Account has no collateral so he can not open any loans. He is insolvent
        if (collateralAmount == 0) return false;

        Rebase memory _totalBorrow = totalBorrow;

        // Convert the collateral to USD. USD has 18 decimals so we need to remove them
        uint256 collateralInUSD = (collateralAmount * _exchangeRate) / 1e18;

        /**
        All Loans are emitted in `DINERO` which is based on USD price
        Collateral in USD times collateral ratio has to be greater than what is borrowing + interest rate accrued in DINERO which is pegged to USD
         */
        return
            (collateralInUSD * collateralRatio) / 1e6 >
            (borrowAmount * _totalBorrow.elastic) / _totalBorrow.base;
    }
}
