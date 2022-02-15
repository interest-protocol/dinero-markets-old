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

import "./tokens/Dinero.sol";
import "./SafeVenus.sol";

contract DineroVenusVault is Ownable, Pausable, IVenusVault {
    /*///////////////////////////////////////////////////////////////
                            LIBRARIES
    //////////////////////////////////////////////////////////////*/

    using EnumerableSet for EnumerableSet.AddressSet;
    using SafeERC20 for IERC20;
    using IntMath for uint256;
    using SafeCast for uint256;

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
        uint256 amount,
        uint256 vTokenAmount
    );

    /*///////////////////////////////////////////////////////////////
                                STRUCT
    //////////////////////////////////////////////////////////////*/

    struct UserAccount {
        uint128 principal; // Amount of stable coins deposited - withdrawn
        uint128 vTokens; // Amount of VTokens supplied based on principal
        uint256 rewardsPaid; // All rewards paid to user.
    }

    /*///////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    // solhint-disable-next-line var-name-mixedcase
    address public immutable XVS;

    // solhint-disable-next-line var-name-mixedcase
    address public immutable WBNB;

    // solhint-disable-next-line var-name-mixedcase
    IPancakeRouter02 public immutable ROUTER; // PCS router

    // solhint-disable-next-line var-name-mixedcase
    IVenusTroller public immutable VENUS_TROLLER;

    //solhint-disable-next-line var-name-mixedcase
    Dinero public immutable DINERO;

    //solhint-disable-next-line var-name-mixedcase
    SafeVenus public immutable SAFE_VENUS;

    address public immutable FEE_TO;

    // Compound and by extension Venus return 0 on successful calls.
    uint256 private constant NO_ERROR = 0;

    // How many times the contract is allowed to open loans backed by previous loans.
    uint256 public compoundDepth;

    // Stable coins supported by this contract.
    EnumerableSet.AddressSet private _underlyingWhitelist;

    // Underlying -> USER -> UserAccount
    mapping(address => mapping(address => UserAccount)) public accountOf;

    // Underlying -> AMOUNT
    mapping(address => uint256) public totalFreeVTokenOf;

    // VTOKEN -> AMOUNT
    mapping(address => uint256) public rewardsOf;

    // Percentage with a mantissa of 18.
    uint256 public collateralLimit;

    // UNDERLYING -> VTOKEN
    mapping(address => IVToken) public vTokenOf;

    /*///////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

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

        IERC20(XVS).safeApprove(address(router), type(uint256).max);
    }

    /*///////////////////////////////////////////////////////////////
                            MODIFIER
    //////////////////////////////////////////////////////////////*/

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

    function isUnderlyingSupported(address underlying)
        external
        view
        returns (bool)
    {
        return _underlyingWhitelist.contains(underlying);
    }

    function getUnderlyingAt(uint256 index) external view returns (address) {
        return _underlyingWhitelist.at(index);
    }

    function getTotalUnderlyings() external view returns (uint256) {
        return _underlyingWhitelist.length();
    }

    function getAllUnderlyings() external view returns (address[] memory) {
        return _underlyingWhitelist.values();
    }

    /*///////////////////////////////////////////////////////////////
                            MUTATIVE FUNCTIONW
    //////////////////////////////////////////////////////////////*/

    function approveXVS() external {
        IERC20(XVS).safeApprove(address(ROUTER), type(uint256).max);
    }

    function deposit(address underlying, uint256 amount)
        public
        isWhitelisted(underlying)
        whenNotPaused
    {
        // There is no reason to call this function as "harvest" because we "compound" the rewards as they are already being supplied.
        require(amount > 0, "DV: no zero amount");

        // Total Amount of VTokens minted by deposit from users. NOT FROM LOANS.
        uint256 totalFreeVTokens = totalFreeVTokenOf[underlying];

        // Get VToken associated with the `underlying`.
        IVToken vToken = vTokenOf[underlying];

        // Update the rewards before any state mutation.
        investXVS(vToken);

        // Get User Account data
        UserAccount memory userAccount = accountOf[underlying][_msgSender()];

        uint256 vTokenRewards = rewardsOf[address(vToken)];

        uint256 rewards;

        // If the user has deposited before. He is entitled to rewards from XVS sales.
        // This also checks for totalFreeVTokens not being 0.
        if (userAccount.vTokens > 0) {
            // We calculate the rewards based on the VToken rewards.
            rewards =
                uint256(userAccount.vTokens).mulDiv(
                    vTokenRewards,
                    totalFreeVTokens
                ) -
                userAccount.rewardsPaid;
        }

        // We need to get it here to mint VTokens.
        // Get the underlying from the user.
        IERC20(underlying).safeTransferFrom(
            _msgSender(),
            address(this),
            amount
        );

        // Supply underlying to Venus right away to start earning.
        uint256 vTokensMinted = _mintVToken(vToken);

        // Update the data
        totalFreeVTokens += vTokensMinted;
        userAccount.principal += amount.toUint128();

        // We give the rewards to the user here.
        userAccount.vTokens += vTokensMinted.toUint128() + rewards.toUint128();

        // We already updated the userAccount.vTokens and totalFreeVTokens  above.
        userAccount.rewardsPaid = uint256(userAccount.vTokens).mulDiv(
            vTokenRewards,
            totalFreeVTokens
        );

        // Update global state
        accountOf[underlying][_msgSender()] = userAccount;
        totalFreeVTokenOf[underlying] = totalFreeVTokens;

        // Give the same amount of `DINERO` to the `msg.sender`.
        DINERO.mint(_msgSender(), amount);

        emit Deposit(_msgSender(), underlying, amount, vTokensMinted + rewards);
    }

    function withdraw(address underlying, uint256 vTokenAmount)
        public
        isWhitelisted(underlying)
    {
        // We do not support the concept of harvesting the rewards as they are "auto compounded".
        // User must always withdraw some VTokens.
        // Rewards will be given on top of every withdrawl.
        require(vTokenAmount > 0, "DV: no zero amount");

        // Get User Account data
        UserAccount memory userAccount = accountOf[underlying][_msgSender()];

        // Find the vToken of the underlying.
        IVToken vToken = vTokenOf[underlying];

        // Update the rewards before any state mutation.
        investXVS(vToken);

        // Get the V Token rewards from the sales of XVS.
        uint256 vTokenRewards = rewardsOf[address(vToken)];

        // Total Amount of VTokens minted by deposit from users. NOT FROM LOANS.
        uint256 totalFreeVTokens = totalFreeVTokenOf[underlying];

        // Amount of Dinero that needs to be burned.
        // We find the percentage of vToken being withdrawn vs current vTokenBalance of the user in relation to the principal.
        uint256 dineroToBurn = vTokenAmount.mulDiv(
            userAccount.principal,
            userAccount.vTokens
        );

        // Calculate the rewards the user is entitled to based on the current VTokens he holds and total amount of free V Tokens in the contract.
        uint256 rewards = uint256(userAccount.vTokens).mulDiv(
            vTokenRewards,
            totalFreeVTokens
        ) - userAccount.rewardsPaid;

        // Calculate how much the current `vTokenAmount` + `rewards` are worth.
        uint256 amountOfUnderlyingToRedeem = vToken.exchangeRateCurrent().bmul(
            vTokenAmount + rewards
        );

        // Update State
        totalFreeVTokens -= vTokenAmount;
        userAccount.principal -= dineroToBurn.toUint128();
        userAccount.vTokens -= vTokenAmount.toUint128();
        userAccount.rewardsPaid = uint256(userAccount.vTokens).mulDiv(
            vTokenRewards,
            totalFreeVTokens
        );

        // Update Global State
        accountOf[underlying][_msgSender()] = userAccount;
        totalFreeVTokenOf[underlying] = totalFreeVTokens;

        // Uniswap style ,block scoping, to prevent stack too deep local variable errors.
        {
            // Save gas
            SafeVenus safeVenus = SAFE_VENUS;

            // Get a safe redeemable amount to prevent liquidation.
            uint256 safeAmount = safeVenus.safeRedeem(this, vToken);

            // Upper bound to prevent infinite loops.
            uint256 maxTries;

            // If we cannot redeem enough to cover the `amountOfUnderlyingToRedeem`. We will start to deleverage; up to 4x.
            while (amountOfUnderlyingToRedeem > safeAmount && maxTries <= 4) {
                _redeemAndRepay(vToken, safeAmount);
                safeAmount = safeVenus.safeRedeem(this, vToken);
                maxTries += 1;
            }

            // Make sure we can safely withdraw the `amountOfUnderlyingToRedeem`.
            require(
                safeAmount >= amountOfUnderlyingToRedeem,
                "DV: failed to withdraw"
            );
        }

        // Recover the Dinero lent to keep the ratio 1:1
        DINERO.burn(_msgSender(), dineroToBurn);

        // Redeem the underlying
        _invariant(
            vToken.redeemUnderlying(amountOfUnderlyingToRedeem),
            "DV: failed to redeem"
        );

        {
            // Protocol charges a 0.5% fee on withdrawls.
            uint256 fee = amountOfUnderlyingToRedeem.bmul(0.005e18);
            uint256 amountToSend = amountOfUnderlyingToRedeem - fee;

            // Send underlying to user.
            IERC20(underlying).safeTransfer(_msgSender(), amountToSend);

            // Send fee to the protocol treasury.
            IERC20(underlying).safeTransfer(FEE_TO, fee);

            emit Withdraw(
                _msgSender(),
                underlying,
                amountToSend,
                vTokenAmount + rewards
            );
        }
    }

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

    function repayAll(IVToken vToken) external whenNotPaused {
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

    function investXVS(IVToken vToken) public {
        // Save Gas
        address xvs = XVS;
        IPancakeRouter02 router = ROUTER;
        IVenusTroller venusController = VENUS_TROLLER;

        address[] memory vTokenArray = new address[](1);

        vTokenArray[0] = address(vToken);

        // Claim XVS for `underlying`
        venusController.claimVenus(address(this), vTokenArray);

        address[] memory path = new address[](3);

        path[0] = xvs;
        path[1] = WBNB;
        path[2] = vToken.underlying();

        // Sell XVS to `underlying` to reinvest back to Venus, as this is a stable vault. We do not want volatile assets.
        router.swapExactTokensForTokens(
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

        // Assume all current underlying are from the XVS swap.
        // This contract should never have underlyings as they should always be converted to VTokens.
        rewardsOf[address(vToken)] += _mintVToken(vToken);
    }

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

    function leverageAll() external {
        // Get all underlyings.
        address[] memory underlyingArray = _underlyingWhitelist.values();

        // Get total number of underlyings.
        uint256 len = underlyingArray.length;

        // Leverage each VToken.
        for (uint256 i = 0; i < len; i++) {
            IVToken vToken = vTokenOf[underlyingArray[i]];
            leverage(vToken);
        }
    }

    function deleverage(IVToken vToken) public whenNotPaused {
        // Save gas
        SafeVenus safeVenus = SAFE_VENUS;

        // We check if we are above our safety threshold.
        uint256 amount = safeVenus.deleverage(this, vToken);

        // Safety mechanism
        uint256 maxTries;

        // deleverage returns 0, if we are not above the threshold.
        while (amount > 0 && maxTries < 5) {
            _redeemAndRepay(vToken, amount);

            // Update the amount for the next iteration.
            amount = safeVenus.deleverage(this, vToken);
            maxTries += 1;
        }
    }

    function deleverageAll() external {
        // Get all underlyings.
        address[] memory underlyingArray = _underlyingWhitelist.values();

        // Get total number of underlyings.
        uint256 len = underlyingArray.length;

        // Deleverage all positions in all vTokens.
        for (uint256 i = 0; i < len; i++) {
            IVToken vToken = vTokenOf[underlyingArray[i]];
            deleverage(vToken);
        }
    }

    /*///////////////////////////////////////////////////////////////
                         PRIVATE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _borrowAndSupply(IVToken vToken) private {
        // Save gas
        SafeVenus safeVenus = SAFE_VENUS;

        // Calculate a safe borrow amount to avoid liquidation
        uint256 safeBorrowAmount = safeVenus.safeBorrow(this, vToken);

        // We will not compound if we can only borrow 500 USD or less. This vault only supports USD stable coins  with 18 decimal.
        if (safeBorrowAmount <= 500 ether) return;

        // Borrow from the vToken. We will throw if it fails.
        _invariant(vToken.borrow(safeBorrowAmount), "DV: failed to borrow");

        // Supply the underlying we got from the loan on the same market.
        _mintVToken(vToken);
    }

    function _redeemAndRepay(IVToken vToken, uint256 amount) private {
        // Redeem from VToken. It will revert on failure.
        _invariant(vToken.redeemUnderlying(amount), "DV: failed to redeem");

        // Repay a portion of the loan the loan. It will revert on failure.
        _invariant(vToken.repayBorrow(amount), "DV: failed to repay");
    }

    function _mintVToken(IVToken vToken)
        private
        returns (uint256 mintedAmount)
    {
        // Find how many VTokens we currently have.
        uint256 balanceBefore = _contractBalanceOf(address(vToken));

        // Supply underlyings to mint VTokens. It will revert if it fails.
        _invariant(
            vToken.mint(_contractBalanceOf(vToken.underlying())),
            "DV: failed to mint"
        );

        // Subtract the new balance from the previous one, to find out how many VTokens we minted.
        mintedAmount = _contractBalanceOf(address(vToken)) - balanceBefore;
    }

    function _contractBalanceOf(address token) private view returns (uint256) {
        // find how many ERC20 complaint tokens this contract has.
        return IERC20(token).balanceOf(address(this));
    }

    function _invariant(uint256 value, string memory message) private pure {
        // Revert for all values other than 0 with the `message`.
        require(value == NO_ERROR, message);
    }

    /*///////////////////////////////////////////////////////////////
                           ONLY OWNER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function addUnderlying(IVToken vToken) external onlyOwner {
        // Get the underlying contract of the VToken.
        address underlying = vToken.underlying();

        // Give full approval to `vToken` so we can mint on deposits.
        IERC20(underlying).safeApprove(address(vToken), type(uint256).max);

        // Update global state
        _underlyingWhitelist.add(underlying);
        vTokenOf[underlying] = vToken;
    }

    function removeUnderlying(IVToken vToken) external onlyOwner {
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
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setCollateralLimit(uint256 _collateralLimit) external onlyOwner {
        require(0.9e18 >= _collateralLimit, "DV: too high");
        collateralLimit = _collateralLimit;
    }

    function setCompoundDepth(uint256 _compoundDepth) external onlyOwner {
        compoundDepth = _compoundDepth;
    }
}
