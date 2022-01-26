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
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/Context.sol";

import "./interfaces/IPancakeRouter02.sol";
import "./interfaces/IPancakePair.sol";

import "./lib/Rebase.sol";

import "./vaults/Vault.sol";

import "./Dinero.sol";
import "./OracleV1.sol";
import "./InterestGovernorV1.sol";

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
 * @notice {INTEREST_RATE} has a base unit of 1e8
 * @notice exchange rate has a base unit of 18 decimals
 * @notice {maxLTVRatio} has a base unit of 1e6
 * @notice {liquidationFee} has a base unit of 1e6
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
contract InterestMarketV1 is Initializable, Context {
    /*///////////////////////////////////////////////////////////////
                            LIBRARIES
    //////////////////////////////////////////////////////////////*/

    using RebaseLibrary for Rebase;
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

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
    InterestMarketV1 public immutable MASTER_CONTRACT; // The implementation contract

    // solhint-disable-next-line var-name-mixedcase
    IPancakeRouter02 public immutable ROUTER; // PCS router

    // solhint-disable-next-line var-name-mixedcase
    Dinero public immutable DINERO; // Dinero stable coin

    // solhint-disable-next-line var-name-mixedcase
    InterestGovernorV1 public immutable GOVERNOR; // Governor contract

    // solhint-disable-next-line var-name-mixedcase
    OracleV1 public immutable ORACLE; // Oracle contract

    /*///////////////////////////////////////////////////////////////
                        CLONE CONTRACT VARIABLES
    //////////////////////////////////////////////////////////////*/

    // Clone only variable
    // solhint-disable-next-line var-name-mixedcase
    IERC20 public COLLATERAL; // Token to be used to cover the loan.

    // solhint-disable-next-line var-name-mixedcase
    Vault public VAULT; // A vault to interact with PCS master chef.

    // Clone only variable
    uint256 public totalCollateral; // Total amount of collateral in this market.

    // Clone only variable
    Rebase public totalLoan; // Total amount of princicpal borrowed in Dinero.

    // Clone only variable
    mapping(address => uint256) public userCollateral; // How much collateral an address has deposited.

    // Clone only variable
    mapping(address => uint256) public userLoan; // How much principal an address has borrowed.

    // Clone only variable
    uint256 public exchangeRate; // Current exchange rate between collateral and USD.

    // Clone only variable
    Loan public loan; // Information about the current loan.

    uint256 public maxLTVRatio; // principal + interest rate / collateral. If it is above this value, the user might get liquidated.

    uint256 public liquidationFee; // A fee that will be charged as a penalty of being liquidated.

    /*///////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev This will only be called once in the master contract. Clones will need to call {initialize}.
     *
     * @notice We save the address of the master contract to prevent it from being initialized.
     *
     * @param router The address of the PCS router.
     * @param dinero The address of Dinero.
     * @param governor The address of the governor.
     * @param oracle The address of the oracle.
     *
     */
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

    /*///////////////////////////////////////////////////////////////
                            INITIALIZE
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev A function to set the initial parameters of the contract. To be called once per market.
     *
     * @notice the modifier {initializer}. This can only be called once.
     * @notice Vault can be the 0 address. All other variables should be set. We assume the owner will set them up properly.
     *
     * @param data A collection of all the needed variables to operate this contract.
     *
     * Requirements:
     *
     * - The master contract should be initialized.
     * - Collateral token cannot be the zero address.
     * - {maxLTVRatio} needs to be checked because it can cause a total failure of the system if set up wrongly.
     *
     */
    function initialize(bytes calldata data) external initializer {
        require(address(MASTER_CONTRACT) != address(this), "MKT: not allowed");

        (
            COLLATERAL,
            VAULT, // Note the VAULT can be the address(0). As non  pair addresses will not have a vault in this version.
            loan.INTEREST_RATE,
            maxLTVRatio,
            liquidationFee
        ) = abi.decode(data, (IERC20, Vault, uint64, uint256, uint256));

        // Collateral must not be zero address.
        require(address(COLLATERAL) != address(0), "MKT: no zero address");
        // {maxLTVRatio} must be within the acceptable bounds.
        require(
            9e5 >= maxLTVRatio && maxLTVRatio >= 5e5,
            "MKT: ltc ratio out of bounds"
        );

        // Also make sure that {COLLATERAL} is a deployed ERC20.
        // Approve the router to trade the collateral.
        COLLATERAL.safeApprove(address(ROUTER), type(uint256).max);
    }

    /*///////////////////////////////////////////////////////////////
                            MODIFIERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Check if a user loan is below the {maxLTVRatio}.
     *
     * @notice This function requires this contract to be deployed in a blockchain with low TX fees. As calling an oracle can be quite expensive.
     * @notice That the oracle is called in this function. In case of failure, liquidations, borrowing dinero and removing collateral will be disabled.
     * Open loans if underwater will not be liquidated, but good news is that borrowing and removing collateral will remain closed.
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
     * @dev This function sends the collected fees by this market to the treasury.
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
        uint256 debt = (uint256(_totalLoan.elastic) *
            _loan.INTEREST_RATE *
            elapsedTime) / 1e18;

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
     * @dev This function gets the latest exchange rate between {COLLATERAL} and USD from chainlink.
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
        rate = ORACLE.getUSDPrice(address(COLLATERAL), 1 ether);

        require(rate > 0, "MKT: invalid exchange rate");

        // if the exchange rate is different we need to update the global state
        if (rate != exchangeRate) {
            exchangeRate = rate;
            emit ExchangeRate(rate);
        }
    }

    /**
     * @dev Allows `msg.sender` to add collateral
     *
     * @notice If the contract has a vault `msg.sender` needs to give approval to the vault. If not it needs to give to this contract.
     *
     * @param to The address, which the `COLLATERAL` will be assigned to.
     * @param amount The number of `COLLATERAL` tokens to be used for collateral
     */
    function addCollateral(address to, uint256 amount) external {
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
        // Update how much is owed to the protocol before allowing collateral to be removed
        accrue();

        // Update State
        userCollateral[_msgSender()] -= amount;
        totalCollateral -= amount;

        // Return the collateral to the user
        _withdrawCollateral(_msgSender(), to, amount);

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
     * @notice Liquidator can use collateral to close the position or must have enough dinero in this account.
     * @notice Liquidators can only close a portion of an underwater position.
     * @notice {liquidationFee} has a base unit of 6.
     * @notice {exchangeRate} has a base unit of 1e18.
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
     * - He must hold enough Dinero to cover the sum of principals if opts to not sell the collateral in PCS.
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
            uint256 fee = (debt * _liquidationFee) / 1e6;

            // How much collateral is needed to cover the loan + fees.
            // Since Dinero is always USD we can calculate this way.
            uint256 collateralToCover = ((debt + fee) * 1e18) / _exchangeRate;

            // Remove the collateral from the account. We can consider the debt paid.
            userCollateral[account] -= collateralToCover;

            // Get the Rewards and collateral if they are in a vault to this contract.
            // The rewards go to the `account`.
            // The collateral comes to this contract.
            // If the collateral is in this contract do nothing.
            if (Vault(address(0)) != VAULT) {
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
        uint256 protocolFee = (liquidationInfo.allFee * 100) / 1000;

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
        } else {
            // Liquidator will be paid in `COLLATERAL`
            // Send collateral to the `recipient` (includes liquidator fee + protocol fee)
            COLLATERAL.safeTransfer(recipient, liquidationInfo.allCollateral);
        }

        // This step we destroy `DINERO` equivalent to all outstanding debt + protocol fee. This does not include the liquidator fee.
        // Liquidator keeps the rest as profit.
        DINERO.burn(_msgSender(), liquidationInfo.allDebt + protocolFee);
    }

    /*///////////////////////////////////////////////////////////////
                            PRIVATE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev A helper function to check if a token is a Pancake Swap Pair token
     *
     * @notice We need to use a try/catch beacuse the {IERC20} interface makes the symbol an optional field.
     *
     * @param token The address of the token.
     * @return result A boolean that indicates if `token` is a pair token.
     */
    function _isPair(address token) private view returns (bool result) {
        try IERC20Metadata(token).symbol() returns (string memory symbol) {
            result =
                keccak256(abi.encodePacked(symbol)) == keccak256("Cake-LP");
            //solhint-disable-next-line no-empty-blocks
        } catch Error(string memory) {} catch (bytes memory) {}
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
        if (_isPair(address(COLLATERAL))) {
            require(path2.length >= 2, "MKT: provide a path for token1");
            require(
                path2[path2.length - 1] == address(DINERO),
                "MKT: no dinero on last index"
            );

            // Even if one of the tokens is WBNB. We dont want BNB because we want to use {swapExactTokensForTokens} for Dinero after.
            // Avoids unecessary routing through WBNB {deposit} and {withdraw}.
            (uint256 amount0, uint256 amount1) = ROUTER.removeLiquidity(
                IPancakePair(address(COLLATERAL)).token0(),
                IPancakePair(address(COLLATERAL)).token1(),
                collateralAmount,
                0, // The liquidator will pay for slippage
                0, // The liquidator will pay for slippage
                address(this), // The contract needs the tokens to sell them.
                //solhint-disable-next-line not-rely-on-time
                block.timestamp
            );

            ROUTER.swapExactTokensForTokens(
                // Sell all token0 removed from the liquidity.
                amount0,
                // The liquidator will pay for the slippage.
                0,
                // Sell token0 -> ... -> DINERO
                path,
                // Send DINERO to the recipient. Since this has to happen in this block. We can burn right after
                recipient,
                // This TX must happen in this block.
                //solhint-disable-next-line not-rely-on-time
                block.timestamp
            );

            ROUTER.swapExactTokensForTokens(
                // Sell all token1 obtained from removing the liquidity.
                amount1,
                // The liquidator will pay for the slippage.
                0,
                // Sell token1 -> ... -> DINERO
                path2,
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
        uint256 collateralInUSD = (collateralAmount * _exchangeRate) / 1e18;

        // All Loans are emitted in `DINERO` which is based on USD price
        // Collateral in USD * {maxLTVRatio} has to be greater than principal + interest rate accrued in DINERO which is pegged to USD
        return
            (collateralInUSD * maxLTVRatio) >
            // Multiply the {maxLTVRatio} this way gives to be more precise.
            _totalLoan.toElastic(principal, true) * 1e6;
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
        if (Vault(address(0)) == VAULT) {
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
        if (Vault(address(0)) == VAULT) {
            COLLATERAL.safeTransfer(recipient, amount);
        } else {
            VAULT.withdraw(account, recipient, amount);
        }
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
