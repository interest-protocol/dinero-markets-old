/*

▀█▀ █▀▀▄ ▀▀█▀▀ █▀▀ █▀▀█ █▀▀ █▀▀ ▀▀█▀▀ 　 ▒█▀▄▀█ █▀▀█ █▀▀█ █░█ █▀▀ ▀▀█▀▀ 　 ▒█░░▒█ ▄█░ 
▒█░ █░░█ ░░█░░ █▀▀ █▄▄▀ █▀▀ ▀▀█ ░░█░░ 　 ▒█▒█▒█ █▄▄█ █▄▄▀ █▀▄ █▀▀ ░░█░░ 　 ░▒█▒█░ ░█░ 
▄█▄ ▀░░▀ ░░▀░░ ▀▀▀ ▀░▀▀ ▀▀▀ ▀▀▀ ░░▀░░ 　 ▒█░░▒█ ▀░░▀ ▀░▀▀ ▀░▀ ▀▀▀ ░░▀░░ 　 ░░▀▄▀░ ▄█▄

Copyright (c) 2021 Jose Cerqueira - All rights reserved

*/

//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "./interfaces/IPancakeRouter02.sol";

import "./lib/Rebase.sol";
import "./lib/FullMath.sol";

import "./tokens/Dinero.sol";

import "./OracleV1.sol";
import "./InterestGovernorV1.sol";

/**
 * @dev It is an overcollaterized isolated lending market that accepts BNB as coollateral to back a loan in a synthetic stable coin called Dinero.
 * The idea behind a synthethic stable coin is to allow for a fixed low interest rate to make investment strategies built with Interest Protocol cheaper and predictable.
 * It has the same logic as the Interest Market V1 but this one is specifically for BNB without a vault.
 *
 * @notice There is no deposit fee.
 * @notice There is a liquidation fee.
 * @notice Since Dinero is assumed to always be pegged to USD. Only need an exchange rate from collateral to USD.
 * @notice {INTEREST_RATE} has a base unit of 1e8
 * @notice exchange rate has a base unit of 18 decimals
 * @notice {maxLTVRatio} has a base unit of 1e6
 * @notice {liquidationFee} has a base unit of 1e6
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
contract InterestBNBMarketV1 is Context {
    /*///////////////////////////////////////////////////////////////
                            LIBRARIES
    //////////////////////////////////////////////////////////////*/

    using RebaseLibrary for Rebase;
    using SafeCast for uint256;
    using FullMath for uint256;

    /*///////////////////////////////////////////////////////////////
                            EVENTS
    //////////////////////////////////////////////////////////////*/

    event ExchangeRate(uint256 rate);

    event Accrue(uint256 accruedAmount);

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
                        MASTER CONTRACT VARIABLES
    //////////////////////////////////////////////////////////////*/

    // solhint-disable-next-line var-name-mixedcase
    IPancakeRouter02 public immutable ROUTER; // PCS router

    // solhint-disable-next-line var-name-mixedcase
    Dinero public immutable DINERO; // Dinero stable coin

    // solhint-disable-next-line var-name-mixedcase
    InterestGovernorV1 public immutable GOVERNOR; // Governor contract

    // solhint-disable-next-line var-name-mixedcase
    OracleV1 public immutable ORACLE; // Oracle contract

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

    /*///////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice `interestRate` has a base unit of 1e18.
     *
     * @param router The address of the PCS router.
     * @param dinero The address of Dinero.
     * @param governor The address of the governor.
     * @param oracle The address of the oracle.
     * @param interestRate How much to charge borrowers every second in Dinero
     * @param _maxLTVRatio Maximum loan to value ratio on loans. Positions above this value can be liquidated.
     * @param _liquidationFee A fee charged on positions underwater and rewarded to the liquidator and protocol.
     */
    constructor(
        IPancakeRouter02 router,
        Dinero dinero,
        InterestGovernorV1 governor,
        OracleV1 oracle,
        uint64 interestRate,
        uint256 _maxLTVRatio,
        uint256 _liquidationFee
    ) {
        ROUTER = router;
        DINERO = dinero;
        GOVERNOR = governor;
        ORACLE = oracle;
        loan.INTEREST_RATE = interestRate;
        maxLTVRatio = _maxLTVRatio;
        liquidationFee = _liquidationFee;
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

    /**
     * @dev Throws if called by any account other than the governor owner.
     */
    modifier onlyGovernorOwner() {
        require(
            GOVERNOR.owner() == _msgSender(),
            "MKT: caller is not the owner"
        );
        _;
    }

    /*///////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev View function to easily find who the governor owner is. Since it is the address that can call the governor owner functions.
     *
     * @return address the governor owner address.
     */
    function governorOwner() external view returns (address) {
        return GOVERNOR.owner();
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

        address feeTo = GOVERNOR.feeTo();

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
        // Reminder: `INTEREST_RATE` has a base unit of 1e18
        uint256 debt = (uint256(_totalLoan.elastic) * _loan.INTEREST_RATE)
            .mulDiv(elapsedTime, 1e18);

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
    function updateExchangeRate() public returns (uint256 rate) {
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
    function withdrawCollateral(address to, uint256 amount) external isSolvent {
        // Update how much is owed to the protocol before allowing collateral to be withdrawn
        accrue();

        // Update State
        userCollateral[_msgSender()] -= amount;

        _sendCollateral(payable(to), amount);

        emit WithdrawCollateral(_msgSender(), to, amount);
    }

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
        // To prevent loss of funds.
        require(to != address(0), "MKT: no zero address");
        // Update how much is owed to the protocol before allowing collateral to be removed
        accrue();

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
     * @dev This function closes underwater positions. It charges the borrower a fee and rewards the liquidator for keeping the integrity of the protocol
     *
     * @notice Liquidator can use collateral to close the position or must have enough dinero in this account.
     * @notice Liquidators can only close a portion of an underwater position.
     * @notice {liquidationFee} has a base unit of 6.
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
    ) external {
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
            uint256 fee = debt.mulDiv(_liquidationFee, 1e6);

            // How much collateral is needed to cover the loan + fees.
            // Since Dinero is always USD we can calculate this way.
            uint256 collateralToCover = (debt + fee).mulDiv(
                1e18,
                _exchangeRate
            );

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
        uint256 protocolFee = uint256(liquidationInfo.allFee).mulDiv(100, 1000);

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
     * @dev A helper function to send BNB to an address.
     *
     * @param to The account that will receive BNB.
     * @param amount How much BNB to send to the `to` address.
     */
    function _sendCollateral(address payable to, uint256 amount) private {
        //solhint-disable-next-line avoid-low-level-calls
        (bool success, ) = to.call{value: amount}("");
        require(success, "MKT: unable to remove collateral");
    }

    /**
     * @dev Checks if an `account` has enough collateral to back his loan based on the {maxLTVRatio}.
     *
     * @notice Note the {exchangeRate} base unit of 1e18.
     * @notice Note the {maxLTVRatio} base unit of 1e6.
     *
     * @param account The address to check if he is solvent.
     * @param _exchangeRate The current exchange rate of `COLLATERAL` in USD
     * @return bool True if the user can cover his loan. False if he cannot.
     */
    function _isSolvent(address account, uint256 _exchangeRate)
        private
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
        uint256 collateralInUSD = collateralAmount.mulDiv(_exchangeRate, 1e18);

        // All Loans are emitted in `DINERO` which is based on USD price
        // Collateral in USD * {maxLTVRatio} has to be greater than principal + interest rate accrued in DINERO which is pegged to USD
        return
            collateralInUSD.mulDiv(maxLTVRatio, 1e6) >
            _totalLoan.toElastic(principal, true);
    }

    /*///////////////////////////////////////////////////////////////
                         GOVERNOR OWNER ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev updates the {maxLTVRatio} of the whole contract.
     *
     * @notice Be mindful that it has a base unit of 1e6.
     *
     * @param amount The new {maxLTVRatio}.
     *
     * Requirements:
     *
     * - {maxLTVRatio} cannot be higher than 90% due to the high volatility of crypto assets and we are using the overcollaterization ratio.
     * - It can only be called by the governor owner to avoid griefing
     *
     */
    function setMaxLTVRatio(uint256 amount) external onlyGovernorOwner {
        require(9e5 >= amount, "MKT: too high");
        maxLTVRatio = amount;
    }

    /**
     * @dev Updates the {liquidationFee}.
     *
     * @notice It is a percentage with a  base unit of 1e6.
     *
     * @param amount The new liquidation fee.
     *
     * Requirements:
     *
     * - It cannot be higher than 15%.
     * - It can only be called by the governor owner to avoid griefing.
     *
     */
    function setLiquidationFee(uint256 amount) external onlyGovernorOwner {
        require(15e4 >= amount, "MKT: too high");
        liquidationFee = amount;
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
     * - This function is guarded by the {onlyGovernorOwner} modifier to disallow users from arbitrarly changing the interest rate of borrowing.
     * - It also requires the new interest rate to be lower than 4% annually.
     *
     */
    function setInterestRate(uint64 amount) external onlyGovernorOwner {
        require(13e8 >= amount, "MKT: too high");
        loan.INTEREST_RATE = amount;
    }
}
