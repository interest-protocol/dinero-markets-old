//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "./interfaces/IVenusTroller.sol";
import "./interfaces/IVToken.sol";
import "./interfaces/IVenusVault.sol";
import "./interfaces/IPancakeRouter02.sol";

import "./lib/IntMath.sol";
import "./lib/IntERC20.sol";

import "./tokens/Dinero.sol";
import "./SafeVenus.sol";

/**
 * @dev This is a Vault to mint Dinero. The idea is to always keep the vault assets 1:1 to Dinero minted.
 * @dev IMPORT to note that VTokens do not usually have 18 decimals. But their exchangeRate has a mantissa of 18. https://github.com/VenusProtocol/venus-protocol/blob/master/contracts/VToken.sol comment on line 21
 * The vault can incur a loss even though, we employ very conservative strategy. But the returns from the {DINERO} lent out, should cover it.
 * Losses can occur if the price of XVS drops drastically or there is a lot of demand for USDC compared to suppliers depending on the interest rate model.
 * This contract needs the {MINTER_ROLE} from {DINERO}.
 * Depositors will earn an interest on their deposits while losing 0 liquidity.
 * The vault employs Venus Protocol, https://app.venus.io/dashboard, to investment all it's assets by supplying them and opening loans of the same asset and keep doing this process as long as it is profitable.
 * We rely on the {SafeVenus} contract to safely interact with Venus to avoid liquidation. The vault employes a conservative strategy by always borrowing and supplying the same asset at a ratio lower than required by the Venus Protocol.
 * Core functions can be paused in case of a security issue.
 * Due to Venus being the leading lending platform in the ecosystem with 2bn in TVL. We feel confident to use it.
 * If Venus's markets get compromised the 1:1 Dinero peg will suffer. So we need to monitor Venus activity to use {emergencyRecovery} in case we feel a new feature is not properly audited. The contract then can be upgraded to properly give the underlying to depositors.
 */
contract DineroVenusVault is Ownable, Pausable, IVenusVault {
    /*///////////////////////////////////////////////////////////////
                            LIBRARIES
    //////////////////////////////////////////////////////////////*/

    using EnumerableSet for EnumerableSet.AddressSet;
    using SafeERC20 for IERC20;
    using IntMath for uint256;
    using SafeCast for uint256;
    using IntERC20 for address;

    /*///////////////////////////////////////////////////////////////
                            EVENTS
    //////////////////////////////////////////////////////////////*/

    event Deposit(
        address indexed account,
        address indexed underlying,
        uint256 amount,
        uint256 vTokenAmount
    );

    event Withdraw(
        address indexed account,
        address indexed underlying,
        uint256 vTokenAmount,
        uint256 amount
    );

    event CompoundDepth(uint256 oldValue, uint256 indexed newValue);

    event CollateralLimit(uint256 oldValue, uint256 indexed newValue);

    event AddVToken(IVToken indexed vToken, address indexed underlying);

    event RemoveVToken(IVToken indexed vToken, address indexed underlying);

    event Loss(
        uint256 previousTotalUnderlying,
        uint256 currentTotalUnderlying,
        uint256 loss
    );

    /*///////////////////////////////////////////////////////////////
                                STRUCT
    //////////////////////////////////////////////////////////////*/

    struct UserAccount {
        uint128 principal; // Amount of stable coins deposited - withdrawn
        uint128 vTokens; // Amount of VTokens supplied based on principal + rewards from XVS sales.
        uint256 rewardsPaid; // Rewards paid to the user since his last interaction.
        uint256 lossVTokensAccrued; // Losses paid to the user since his last interaction.
    }

    /*///////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    // solhint-disable-next-line var-name-mixedcase
    address public immutable XVS; // 0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63 18 decimals

    // solhint-disable-next-line var-name-mixedcase
    address public immutable WBNB; // 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c 18 decimals

    // solhint-disable-next-line var-name-mixedcase
    IPancakeRouter02 public immutable ROUTER; // PCS router 0x10ED43C718714eb63d5aA57B78B54704E256024E

    // solhint-disable-next-line var-name-mixedcase
    IVenusTroller public immutable VENUS_TROLLER; // 0xfD36E2c2a6789Db23113685031d7F16329158384

    //solhint-disable-next-line var-name-mixedcase
    Dinero public immutable DINERO; // 18 decimals

    //solhint-disable-next-line var-name-mixedcase
    SafeVenus public immutable SAFE_VENUS;

    //solhint-disable-next-line var-name-mixedcase
    address public immutable FEE_TO;

    // Compound and by extension Venus return 0 on successful calls.
    uint256 private constant NO_ERROR = 0;

    // How many times the contract is allowed to open loans backed by previous loans.
    uint8 public compoundDepth; // No more than 5

    // Stable coins supported by this contract.
    // BUSD - 0xe9e7cea3dedca5984780bafc599bd69add087d56 18 decimals
    // USDC - 0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d 18 decimals
    // DAI - 0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3  18 decimals
    EnumerableSet.AddressSet private _underlyingWhitelist;

    // UNDERLYING -> USER -> UserAccount
    mapping(address => mapping(address => UserAccount)) public accountOf;

    // VTOKEN -> AMOUNT
    mapping(IVToken => uint256) public totalFreeVTokenOf;

    // UNDERLYING -> AMOUNT
    mapping(address => uint256) public totalFreeUnderlying;

    // VTOKEN -> LOSS PER TOKEN
    mapping(IVToken => uint256) public totalLossOf;

    // VTOKEN -> REWARDS PER TOKEN
    mapping(IVToken => uint256) public rewardsOf;

    // UNDERLYING -> VTOKEN
    mapping(address => IVToken) public vTokenOf;

    // Percentage with a mantissa of 18.
    uint256 public collateralLimit;

    /*///////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @param xvs The contract of th Venus Token
     * @param wbnb The contract for Wrapped BNB token
     * @param router The contract of PCS router v2
     * @param venusTroller The contract of the Venus Controller
     * @param dinero The contract of the dinero stable coin
     * @param safeVenus The helper contract address to interact with Venus
     * @param feeTo The address that will collect the fee
     */
    constructor(
        address xvs,
        address wbnb,
        IPancakeRouter02 router,
        IVenusTroller venusTroller,
        Dinero dinero,
        SafeVenus safeVenus,
        address feeTo
    ) {
        XVS = xvs;
        WBNB = wbnb;
        ROUTER = router;
        VENUS_TROLLER = venusTroller;
        DINERO = dinero;
        SAFE_VENUS = safeVenus;
        FEE_TO = feeTo;

        // We trust `router` so we can fully approve because we need to sell it.
        IERC20(XVS).safeApprove(address(router), type(uint256).max);
    }

    /*///////////////////////////////////////////////////////////////
                            MODIFIER
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Checks if `underlyin` is supported by the vault.
     *
     * @param underlying The address of the token to check if it is supported.
     */
    modifier isWhitelisted(address underlying) {
        require(
            _underlyingWhitelist.contains(underlying),
            "DV: underlying not whitelisted"
        );
        _;
    }

    /*///////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev View function to see if the Vault supports the `underlying`.
     * This function are needed because sets need to be private.
     *
     * @param underlying The address of the token to check if it is supported.
     * @return bool
     */
    function isUnderlyingSupported(address underlying)
        external
        view
        returns (bool)
    {
        return _underlyingWhitelist.contains(underlying);
    }

    /**
     * @dev Returns the underlying on index `index`.
     * This function are needed because sets need to be private.
     *
     * @param index The index to look up the underlying.
     * @return address The ERC20 compliant underlying address.
     */
    function getUnderlyingAt(uint256 index) external view returns (address) {
        return _underlyingWhitelist.at(index);
    }

    /**
     * @dev Returns the total number of underlyings supported
     * This function are needed because sets need to be private.
     *
     * @return uint256
     */
    function getTotalUnderlyings() external view returns (uint256) {
        return _underlyingWhitelist.length();
    }

    /**
     * @dev Returns an array with all underlyings
     * This function are needed because sets need to be private.
     *
     * @return address[] All underlyings
     */
    function getAllUnderlyings() external view returns (address[] memory) {
        return _underlyingWhitelist.values();
    }

    /*///////////////////////////////////////////////////////////////
                            MUTATIVE FUNCTION
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Increases the {ROUTER} allowance to the maximum uint256 value
     */
    function approveXVS() external {
        IERC20(XVS).safeIncreaseAllowance(
            address(ROUTER),
            type(uint256).max -
                IERC20(XVS).allowance(address(this), address(ROUTER))
        );
    }

    /**
     * @dev It accepts an `amount` of `underlyinng` from a depositor and mints an equivalent amount of `DINERO` to `msg.sender`.
     *
     * @notice `msg.sender` has to approve this contract to use the `underlying`.
     * @notice `msg.sender` will be paid rewards and incur a loss if there is one.
     *
     * @param underlying The stable coin the `msg.sender` wishes to deposit
     * @param amount How many `underlying`, the `msg.sender` wishes to deposit.
     *
     * Requirements:
     *
     * - The underlying must have been whitelisted by the owner.
     * - The contract must be unpaused.
     * - `amount` must be greater than 0, as it makes no sense to deposit nothing.
     */
    function deposit(address underlying, uint256 amount)
        public
        isWhitelisted(underlying)
        whenNotPaused
    {
        // There is no reason to call this function as "harvest" because we "compound" the rewards as they are already being supplied.
        require(amount > 0, "DV: no zero amount");
        // Get the VToken of the `underlying`.
        IVToken vToken = vTokenOf[underlying];

        // Update the rewards before any state mutation, to fairly distribute them.
        _investXVS(vToken);
        // In the line above, we converted XVS to `underlying` and minted VTokens. This increases the free underlying.
        // It has to be done before calculating losses.
        // Update loss losses before any mutations to fairly charge them.
        // This already updates the storage state.
        // {lossPerVToken} is vToken loss per vToken since genesis
        (bool hadLoss, uint256 lossPerVToken) = _updateLoss(underlying, vToken);

        // Total amount of VTokens minted by deposits from users. NOT FROM LOANS.
        uint256 totalFreeVTokens = totalFreeVTokenOf[vToken];

        // Get User Account data
        UserAccount memory userAccount = accountOf[underlying][_msgSender()];

        // Get current total rewards accrued per vToken since genesis.
        uint256 rewardPerVToken = rewardsOf[vToken];

        // VTokens have different decimals, so we need to be careful when dividing and multiplying.
        uint256 decimals = address(vToken).safeDecimals();

        // If the user has deposited before. He is entitled to rewards from XVS sales.
        // This also checks for totalFreeVTokens not being 0.
        if (userAccount.vTokens > 0) {
            // If there was a loss, we need to charge the user.
            if (hadLoss) {
                uint256 lossInVTokens = uint256(userAccount.vTokens).mulDiv(
                    lossPerVToken,
                    decimals
                ) - userAccount.lossVTokensAccrued;

                // Fairly calculate how much to charge the user, based on his balance and deposit length.
                // Charge the user.
                userAccount.vTokens -= lossInVTokens.toUint128();
                // Tokens were used to cover the debt.
                totalFreeVTokens -= lossInVTokens;
            }

            uint256 rewards = uint256(userAccount.vTokens).mulDiv(
                rewardPerVToken,
                decimals
            ) - userAccount.rewardsPaid;

            // We calculate the rewards based on the VToken rewards and give to the user.
            userAccount.vTokens += rewards.toUint128();
            // They will be given to the user so they became free.
            totalFreeVTokens += rewards;
        }

        // We need to get the underlying from the `msg.sender` before we mint V Tokens.
        // Get the underlying from the user.
        IERC20(underlying).safeTransferFrom(
            _msgSender(),
            address(this),
            amount
        );

        // Supply underlying to Venus right away to start earning.
        // It returns the new VTokens minted.
        uint256 vTokensMinted = _mintVToken(vToken);

        // Update the data
        totalFreeVTokens += vTokensMinted;
        userAccount.principal += amount.toUint128();
        userAccount.vTokens += vTokensMinted.toUint128();

        // Consider all rewards fairly paid to the user up to this point.
        userAccount.rewardsPaid = uint256(userAccount.vTokens).mulDiv(
            rewardPerVToken,
            decimals
        );

        // Consider all losses fairly charged to the user up to this point.
        userAccount.lossVTokensAccrued = uint256(userAccount.vTokens).mulDiv(
            lossPerVToken,
            decimals
        );

        // Update global state
        accountOf[underlying][_msgSender()] = userAccount;
        totalFreeVTokenOf[vToken] = totalFreeVTokens;
        totalFreeUnderlying[underlying] = _getTotalFreeUnderlying(vToken);

        // Give the same amount of `DINERO` to the `msg.sender`; essentially giving them liquidity to employ more strategies.
        DINERO.mint(_msgSender(), amount);

        emit Deposit(_msgSender(), underlying, amount, vTokensMinted);
    }

    /**
     * @dev It withdraws the underlying by redeeming an amout of Vtokens from Venus.
     * @dev UI should check the VToken liquidity before calling this function to prevent failures.
     *
     * @notice It charges a 0.5% fee.
     * @notice Withdraws will fail if Venus does not have enough liquidity. Try to withdraw a smaller amount on failure.
     *
     * @param underlying The address of the underlying the `msg.sender` wishes to withdraw.
     * @param vTokenAmount The number of VTokens the `msg.sender` wishes to withdraw.
     *
     * Requirements:
     *
     * - The underlying must have been whitelisted by the owner.
     * - The contract must be unpaused.
     * - `amount` must be greater than 0, as it makes no sense to withdraw nothing.
     * - Venus must have enough liquidity to be redeemed.
     * - Vault must have enough room to withdraw the `amount` desired.
     */
    function withdraw(address underlying, uint256 vTokenAmount)
        external
        whenNotPaused
        isWhitelisted(underlying)
    {
        // We do not support the concept of harvesting the rewards as they are "auto compounded".
        // `msg.sender` must always withdraw some VTokens.
        // Rewards will be given on top of every withdrawl.
        require(vTokenAmount > 0, "DV: no zero amount");

        // Get User Account data
        UserAccount memory userAccount = accountOf[underlying][_msgSender()];

        // Find the vToken of the underlying.
        IVToken vToken = vTokenOf[underlying];

        // Update the rewards before any state mutation, to fairly distribute them.
        _investXVS(vToken);

        // Get the V Token rewards from the sales of XVS.
        uint256 rewardPerVToken = rewardsOf[vToken];

        // Total amount of VTokens minted by deposits from users. NOT FROM LOANS.
        uint256 totalFreeVTokens = totalFreeVTokenOf[vToken];

        // Store the rewards that will be given on this call on top of the `vTokenAmount` in underlying.
        uint256 rewards;
        uint256 lossPerVToken;

        // VTokens have different decimals, so we need to be careful when dividing and multiplying.
        uint256 decimals = address(vToken).safeDecimals();

        // Uniswap style ,block scoping, to prevent stack too deep local variable errors.
        {
            bool hadLoss;
            // It has to be done before calculating losses.
            // Best to be called after {_investXVS} as it increases the free underlying.
            // Update loss losses before any mutations to fairly charge them.
            // This already updates the storage state.
            (hadLoss, lossPerVToken) = _updateLoss(underlying, vToken);

            // If there was a loss, we need to charge the user.
            if (hadLoss) {
                // Fairly calculate how much to charge the user, based on his balance and deposit length.
                uint256 lossInVTokens = uint256(userAccount.vTokens).mulDiv(
                    lossPerVToken,
                    decimals
                ) - userAccount.lossVTokensAccrued;

                // Charge the user.
                userAccount.vTokens -= lossInVTokens.toUint128();
                // They are no longer free because they need were used to cover the loss.
                totalFreeVTokens -= lossInVTokens;
            }

            // Calculate the rewards the user is entitled to based on the current VTokens he holds and rewards per VTokens.
            // We do not need to update the {totalFreeVTokens} because we will give these rewards to the user.
            rewards =
                uint256(userAccount.vTokens).mulDiv(rewardPerVToken, decimals) -
                userAccount.rewardsPaid;
        }

        // Uniswap style ,block scoping, to prevent stack too deep local variable errors.
        {
            // Amount of Dinero that needs to be burned.
            // Need to calculate this before updating {userAccount.vTokens}.
            uint256 dineroToBurn = vTokenAmount.mulDiv(
                decimals,
                userAccount.vTokens
            );

            // We do effects before checks/updates here to save memory and we can trust this token.
            // Recover the Dinero lent to keep the ratio 1:1
            DINERO.burn(_msgSender(), dineroToBurn);

            // Update State
            totalFreeVTokens -= vTokenAmount;
            userAccount.principal -= dineroToBurn.toUint128();

            // Rewards are paid in this call; so we do not need to add here.
            // We need to update the userAccount.vTokens before updating the {lossVTokensAccrued and rewardsPaid}
            // Otherwise, the calculations for rewards and losses will be off in the next call for this user.
            userAccount.vTokens -= vTokenAmount.toUint128();

            // Consider all rewards fairly paid.
            userAccount.rewardsPaid = uint256(userAccount.vTokens).mulDiv(
                rewardPerVToken,
                decimals
            );
            // Consider all debt paid.
            userAccount.lossVTokensAccrued = uint256(userAccount.vTokens)
                .mulDiv(lossPerVToken, decimals);
        }
        // Update Global State
        accountOf[underlying][_msgSender()] = userAccount;
        totalFreeVTokenOf[vToken] = totalFreeVTokens;

        uint256 amountOfUnderlyingToRedeem = (rewards + vTokenAmount).bmul(
            vToken.exchangeRateCurrent()
        );

        // Uniswap style ,block scoping, to prevent stack too deep local variable errors.
        {
            // Save gas
            SafeVenus safeVenus = SAFE_VENUS;

            // Get a safe redeemable amount to prevent liquidation.
            uint256 safeAmount = safeVenus.safeRedeem(this, vToken);

            // Upper bound to prevent infinite loops.
            uint256 maxTries;

            // If we cannot redeem enough to cover the `amountOfUnderlyingToRedeem`. We will start to deleverage; up to 4x.
            // The less we are borrowing, the more we can redeem because the loans are overcollaterized.
            while (amountOfUnderlyingToRedeem > safeAmount && maxTries <= 4) {
                _redeemAndRepay(vToken, safeAmount);
                // update the safeAmout for the next iteration.
                safeAmount = safeVenus.safeRedeem(this, vToken);
                maxTries += 1;
            }

            // Make sure we can safely withdraw the `amountOfUnderlyingToRedeem`.
            require(
                safeAmount >= amountOfUnderlyingToRedeem,
                "DV: failed to withdraw"
            );

            // Redeem the underlying. It will revert if we are unable to withdraw.
            _invariant(
                vToken.redeemUnderlying(amountOfUnderlyingToRedeem),
                "DV: failed to redeem"
            );
        }

        // Uniswap style ,block scoping, to prevent stack too deep local variable errors.
        {
            // Update current free underlying after all mutations in underlying.
            totalFreeUnderlying[underlying] = _getTotalFreeUnderlying(vToken);

            // Protocol charges a 0.5% fee on withdrawls.
            uint256 fee = amountOfUnderlyingToRedeem.bmul(0.005e18);
            uint256 amountToSend = amountOfUnderlyingToRedeem - fee;

            // Send underlying to user.
            IERC20(underlying).safeTransfer(_msgSender(), amountToSend);

            // Send fee to the protocol treasury.
            IERC20(underlying).safeTransfer(FEE_TO, fee);

            emit Withdraw(_msgSender(), underlying, vTokenAmount, amountToSend);
        }
    }

    /**
     * @dev Enters a Venus market to enable the Vtokens to be used as collateral
     *
     * @param underlying The underlying asset we wish to use as collateral.
     *
     * Requirements:
     *
     * - The underlying must have been whitelisted by the owner.
     * - The contract must be unpaused.
     */
    function enterMarket(address underlying)
        external
        whenNotPaused
        isWhitelisted(underlying)
    {
        // Get VToken associated with the `underlying`.
        IVToken vToken = vTokenOf[underlying];

        address[] memory vTokenArray = new address[](1);

        vTokenArray[0] = address(vToken);

        // Allow the `underlying` to be used as collateral to leverage.
        uint256[] memory results = VENUS_TROLLER.enterMarkets(vTokenArray);

        // Check if we successfully entered the market. If not we revert.
        _invariant(results[0], "SF: failed to enter market");
    }

    /**
     * @dev It leverages the vault position in Venus. By using the current supply as collateral to borrow same token. Supply and borrow {compoundDepth} times.
     *
     * @param vToken The contract of the vToken we wish to leverage.
     *
     * Requirements:
     *
     * - The contract must be unpaused.
     */
    function leverage(IVToken vToken) public whenNotPaused {
        // Save Gas
        uint256 depth = compoundDepth;

        // We open an loan -> supply to the same market -> open a second loan -> ....
        // We do this process `depth` times. We will be conservative and have a value of around 3 or 4.
        // We do not need to store the information about these new minted vTokens as they loan-backed VTokens.
        for (uint256 i = 0; i < depth; i++) {
            _borrowAndSupply(vToken);
        }
    }

    /**
     * @dev Leverages all VTokens. Explanation of leverage above.
     *
     * Requirements:
     *
     * - The contract must be unpaused.
     */
    function leverageAll() external {
        // Get all underlyings.
        address[] memory underlyingArray = _underlyingWhitelist.values();

        // Get total number of underlyings.
        uint256 len = underlyingArray.length;

        // Leverage each VToken.
        for (uint256 i = 0; i < len; i++) {
            leverage(vTokenOf[underlyingArray[i]]);
        }
    }

    /**
     * @dev It reduces the loan size to stay within a safe margin to avoid liquidations.
     *
     * @param vToken The contract of the VToken that we wish to reduce our open loan on them.
     *
     * Requirements:
     *
     * - The contract must be unpaused.
     */
    function deleverage(IVToken vToken) public whenNotPaused {
        // Save gas
        SafeVenus safeVenus = SAFE_VENUS;

        // We check if we are above our safety threshold.
        uint256 amount = safeVenus.deleverage(this, vToken);

        // Safety mechanism
        uint256 maxTries;

        // Stop either when deleverage returns 0 or if we are not above the max tries threshold.
        // Deleverage function from safeVenus returns 0 when we are within a safe limit.
        while (amount > 0 && maxTries < 5) {
            _redeemAndRepay(vToken, amount);

            // Update the amount for the next iteration.
            amount = safeVenus.deleverage(this, vToken);
            maxTries += 1;
        }
    }

    /**
     * @dev Deleverages all current VTokens positions from this vault.
     */
    function deleverageAll() external {
        // Get all underlyings.
        address[] memory underlyingArray = _underlyingWhitelist.values();

        // Get total number of underlyings.
        uint256 len = underlyingArray.length;

        // Deleverage all positions in all vTokens.
        for (uint256 i = 0; i < len; i++) {
            deleverage(vTokenOf[underlyingArray[i]]);
        }
    }

    /*///////////////////////////////////////////////////////////////
                         PRIVATE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev It checks if there was a loss in non-debt backed underlying. In the case there is one, it updates the global state accordingly.
     *
     * @param underlying The underlying of the `vToken`, which we will check if we incurred a loss or not.
     * @param vToken The VToken market that holds the underlying.
     * @return (bool, uint256) The first value indicates if there was a loss or not. The second value the current total loss per token.
     */
    function _updateLoss(address underlying, IVToken vToken)
        private
        returns (bool, uint256)
    {
        // Get previous recorded total non-debt underlying.
        uint256 prevFreeUnderlying = totalFreeUnderlying[underlying];
        // Get current recorded total non-debt underlying.
        uint256 currentFreeUnderlying = _getTotalFreeUnderlying(vToken);

        // Get previous recorded total loss per vToken
        uint256 totalLoss = totalLossOf[vToken];

        // If our underlying balance decreases, we incurred a loss.
        if (prevFreeUnderlying > currentFreeUnderlying) {
            // Need to find the difference, then convert to vTokens by multiplying by the {vToken.exchangeRateCurrent}. Lastly, we need to devide by the total free vTokens.
            // Important to note the mantissa of exchangeRateCurrent is 18 while vTokens usually have a mantissa of 8.
            uint256 loss = (prevFreeUnderlying - currentFreeUnderlying)
                .bdiv(vToken.exchangeRateCurrent())
                .mulDiv(
                    address(vToken).safeDecimals(),
                    totalFreeVTokenOf[vToken]
                );

            // Update the loss
            uint256 newTotalLoss = totalLoss + loss;
            totalLossOf[vToken] = newTotalLoss;
            emit Loss(prevFreeUnderlying, currentFreeUnderlying, loss);
            return (true, newTotalLoss);
        }

        // In the case of no loss recorded. Return the current values.
        return (false, totalLoss);
    }

    /**
     * @dev A helper function to find out how much non-debt backed underlying we have in the `vToken`.
     *
     * @param vToken The market, which we want to check how much non-debt underlying we have.
     * @return uint256 The total non-debt backed underlying.
     */
    function _getTotalFreeUnderlying(IVToken vToken) private returns (uint256) {
        (uint256 borrowBalance, uint256 supplyBalance) = SAFE_VENUS
            .borrowAndSupply(this, vToken);

        return supplyBalance - borrowBalance;
    }

    /**
     * @dev CLaims and sells all XVS on Pancake swap for the underlying of a `vToken` and supplies the new underlying on Venus.
     *
     * @param vToken The VToken market, which we wish to claim the XVS and swap to the underlying.
     */
    function _investXVS(IVToken vToken) private {
        // Save Gas
        address xvs = XVS;

        address[] memory vTokenArray = new address[](1);

        vTokenArray[0] = address(vToken);

        // Claim XVS in the `vToken`.
        VENUS_TROLLER.claimVenus(address(this), vTokenArray);

        address underlying = vToken.underlying();

        // Build the swap path XVS -> WBNB -> UNDERLYING
        address[] memory path = new address[](3);
        path[0] = xvs;
        path[1] = WBNB;
        path[2] = underlying;

        // Sell XVS to `underlying` to reinvest back to Venus, as this is a stable vault. We do not want volatile assets.
        ROUTER.swapExactTokensForTokens(
            // Assume all XVS in the contract are rewards.
            _contractBalanceOf(xvs),
            // We do not care about slippage
            0,
            // WBNB being the bridge token in BSC. This path will be the most liquid.
            path,
            // Get the `underlying` to this contract in order to supply it to Venus.
            address(this),
            // Needs to be done in this block.
            //solhint-disable-next-line not-rely-on-time
            block.timestamp
        );

        uint256 totalFreeVTokens = totalFreeVTokenOf[vToken];

        // Assume sall current underlying are from the XVS swap.
        // This contract should never have underlyings as they should always be converted to VTokens, unless it is paused and the owner calls {emergencyRecovery}.
        rewardsOf[vToken] += _mintVToken(vToken).mulDiv(
            address(vToken).safeDecimals(),
            totalFreeVTokens
        );
    }

    /**
     * @dev Helper function to leverage the Vault. It borrows and then supplies.
     *
     * @param vToken The VToken market we wish to leverage our position.
     *
     * Requirements:
     *
     * - We will not leverage positions lower than 500 USD.
     */
    function _borrowAndSupply(IVToken vToken) private {
        // Calculate a safe borrow amount to avoid liquidation
        uint256 safeBorrowAmount = SAFE_VENUS.safeBorrow(this, vToken);

        // We will not compound if we can only borrow 500 USD or less. This vault only supports USD stable coins with 18 decimal.
        if (safeBorrowAmount <= 500 ether) return;

        // Borrow from the vToken. We will throw if it fails.
        _invariant(vToken.borrow(safeBorrowAmount), "DV: failed to borrow");

        // Supply the underlying we got from the loan on the same market.
        // We do not care how many VTokens are minted.
        _mintVToken(vToken);
    }

    /**
     * @dev Helper function to redeem and repay an `amount` in a Venus `vToken` market.
     *
     * @param vToken The Venus market we wish to redeem and repay a portion of the loan.
     * @param amount The amount of the  loan we wish to pay.
     */
    function _redeemAndRepay(IVToken vToken, uint256 amount) private {
        // Redeem `amount` from `vToken`. It will revert on failure.
        _invariant(vToken.redeemUnderlying(amount), "DV: failed to redeem");

        // Repay a portion, the `amount`, of the loan. It will revert on failure.
        _invariant(vToken.repayBorrow(amount), "DV: failed to repay");
    }

    /**
     * @dev Helper function to supply underlying to a `vToken` to mint vTokens and know how many vTokens we got.
     * It supplies all underlying.
     *
     * @param vToken The vToken market we wish to mint.
     */
    function _mintVToken(IVToken vToken)
        private
        returns (uint256 mintedAmount)
    {
        // Find how many VTokens we currently have.
        uint256 balanceBefore = _contractBalanceOf(address(vToken));

        // Supply ALL underlyings present in the contract even lost tokens to mint VTokens. It will revert if it fails.
        _invariant(
            vToken.mint(_contractBalanceOf(vToken.underlying())),
            "DV: failed to mint"
        );

        // Subtract the new balance from the previous one, to find out how many VTokens we minted.
        mintedAmount = _contractBalanceOf(address(vToken)) - balanceBefore;
    }

    /**
     * @dev Helper function to check the balance of a `token` this contract has.
     *
     * @param token An ERC20 compliant token.
     */
    function _contractBalanceOf(address token) private view returns (uint256) {
        // Find how many ERC20 complaint tokens this contract has.
        return IERC20(token).balanceOf(address(this));
    }

    /**
     * @dev It is used to check if Compound style functions failed or suceeded by comparing `value` to 0.
     * If they fai, it reverts with `message`.
     *
     * @param value The number we wish to compare with {NO_ERROR}. Anything other than 0 indicates an error.
     * @param message The error message.
     */
    function _invariant(uint256 value, string memory message) private pure {
        // Revert for all values other than 0 with the `message`.
        require(value == NO_ERROR, message);
    }

    /*///////////////////////////////////////////////////////////////
                           ONLY OWNER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Adds support for an underlying/VToken to this contract.
     *
     * @param vToken The VToken contract we wish to support.
     *
     * Requirements:
     *
     * - Only the owner can call to assure proper issuance of Dinero (only support stable coins) and legitimacy of the markets.
     */
    function addVToken(IVToken vToken) external onlyOwner {
        // Get the underlying contract of the VToken.
        address underlying = vToken.underlying();

        // Give full approval to `vToken` so we can mint on deposits.
        IERC20(underlying).safeApprove(address(vToken), type(uint256).max);

        // Update global state
        _underlyingWhitelist.add(underlying);
        vTokenOf[underlying] = vToken;

        emit AddVToken(vToken, underlying);
    }

    /**
     * @dev Removes support for an underlying.
     *
     * @param vToken The Vtoken market we wish to remove support for.
     *
     * Requirements:
     *
     * - Only the owner can call to avoid griefing.
     */
    function removeVToken(IVToken vToken) external onlyOwner {
        // Get the underlying contract of the VToken.
        address underlying = vToken.underlying();

        // Remove all current allowance, since we will not be using it anymore.
        IERC20(underlying).safeDecreaseAllowance(
            address(vToken),
            IERC20(underlying).allowance(address(this), address(vToken))
        );

        // Update global state
        _underlyingWhitelist.remove(underlying);
        delete vTokenOf[underlying];

        emit RemoveVToken(vToken, underlying);
    }

    /**
     * @dev Function repays all loans. Essentially removes all leverage.
     * Leverage can be called once the strategy is profitable again.
     *
     * @param vToken The VToken market we wish to remove all leverage.
     *
     * Requirements:
     *
     * - Only the owner can call to avoid investment losses.
     * - The strategy must be currently unprofitable.
     */
    function repayAll(IVToken vToken) public onlyOwner {
        // Save gas.
        SafeVenus safeVenus = SAFE_VENUS;

        // We do not want to repay our loans, if it is profitable.
        if (safeVenus.isProfitable(this, vToken, 0)) return;

        // We will keep repaying as long as we have enough redeemable amount in our supply.
        uint256 redeemAmount = safeVenus.safeRedeem(this, vToken);

        uint256 borrowAmount;

        (borrowAmount, ) = safeVenus.borrowAndSupply(this, vToken);

        // Value to store the maximum amount we want to loop in a single call
        uint256 maxTries;

        // Keep redeeming and repaying as long as we have an open loan position, have enough redeemable amount or have done it 10x in this call.
        // We intend to only have a compound depth of 3. So an upperbound of 10 is more than enough.
        while (redeemAmount > 0 && borrowAmount > 0 && maxTries <= 10) {
            // redeem and repay
            _redeemAndRepay(vToken, redeemAmount);
            // Update the redeem and borrow amount to see if we can get to net iteration
            redeemAmount = safeVenus.safeRedeem(this, vToken);
            (borrowAmount, ) = safeVenus.borrowAndSupply(this, vToken);
            // Update the maximum numbers we can iterate
            maxTries += 1;
        }
    }

    /**
     * @dev It is only to be used on an emergency to completely remove all leverage and redeem all supply. Only if there is an issue with Venus.
     *
     * Requirements:
     *
     * - Only the owner can call because there is no means to withdraw underlying directly at the moment.
     * - Contract must be paused.
     */
    function emergencyRecovery() external onlyOwner whenPaused {
        // Get all underlyings.
        address[] memory underlyingArray = _underlyingWhitelist.values();

        // Get total number of underlyings.
        uint256 len = underlyingArray.length;

        // Repay and remove all supply
        for (uint256 i = 0; i < len; i++) {
            IVToken vToken = vTokenOf[underlyingArray[i]];
            repayAll(vToken);
            vToken.redeem(_contractBalanceOf(address(vToken)));
        }
    }

    /**
     * @dev Pauses the core functions of the contract
     *
     * Requirements:
     *
     * - Only the owner can call to avoid griefing.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @dev Unpauses the core functions of the contract
     *
     * Requirements:
     *
     * - Only the owner can call to avoid griefing.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Sets a new collateral limit to be used on top of the Venus limit.
     *
     * @param _collateralLimit The new collateral limit
     *
     * Requirements:
     *
     * - Only the owner can call to avoid griefing.
     * - Must be below 90%  to avoid liquidations. In reality will not be set above 70%.
     */
    function setCollateralLimit(uint256 _collateralLimit) external onlyOwner {
        require(0.9e18 > _collateralLimit, "DV: must be lower than 90%");
        uint256 previousValue = collateralLimit;
        collateralLimit = _collateralLimit;

        emit CollateralLimit(previousValue, _collateralLimit);
    }

    /**
     * @dev Sets the {compoundDepth}, which determines how many loan-backed loans we wish to open.
     *
     * @notice We will not set it above 5.
     *
     * @param _compoundDepth The number of times to issue loan-backed loans.
     *
     * Requirements:
     *
     * - Only the owner can call to ensure we do not hage highly leveraged positions.
     */
    function setCompoundDepth(uint8 _compoundDepth) external onlyOwner {
        require(20 > _compoundDepth, "DV: must be lower than 20");
        uint256 previousValue = compoundDepth;
        compoundDepth = _compoundDepth;

        emit CompoundDepth(previousValue, _compoundDepth);
    }
}
