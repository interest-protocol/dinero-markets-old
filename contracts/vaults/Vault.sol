/*

██╗███╗░░██╗████████╗███████╗██████╗░███████╗░██████╗████████╗  ██╗░░░██╗░█████╗░██╗░░░██╗██╗░░░░░████████╗
██║████╗░██║╚══██╔══╝██╔════╝██╔══██╗██╔════╝██╔════╝╚══██╔══╝  ██║░░░██║██╔══██╗██║░░░██║██║░░░░░╚══██╔══╝
██║██╔██╗██║░░░██║░░░█████╗░░██████╔╝█████╗░░╚█████╗░░░░██║░░░  ╚██╗░██╔╝███████║██║░░░██║██║░░░░░░░░██║░░░
██║██║╚████║░░░██║░░░██╔══╝░░██╔══██╗██╔══╝░░░╚═══██╗░░░██║░░░  ░╚████╔╝░██╔══██║██║░░░██║██║░░░░░░░░██║░░░
██║██║░╚███║░░░██║░░░███████╗██║░░██║███████╗██████╔╝░░░██║░░░  ░░╚██╔╝░░██║░░██║╚██████╔╝███████╗░░░██║░░░
╚═╝╚═╝░░╚══╝░░░╚═╝░░░╚══════╝╚═╝░░╚═╝╚══════╝╚═════╝░░░░╚═╝░░░  ░░░╚═╝░░░╚═╝░░╚═╝░╚═════╝░╚══════╝░░░╚═╝░░░

*/

//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../interfaces/IMasterChef.sol";
import "../interfaces/IVault.sol";

import "../lib/IntMath.sol";

/**
 * @dev It provides the events, state variables and an interface for the {InterestMarketV1} to interact with the Pancake Swap Master Chef.
 * This can be seen as part of the {InterestMarketV1}.
 *
 * @notice Vault contracts are part of the {InterestMarketV1}. Therefore, they never interact with the end user directly. That is why the {deposit} and {withdraw} functions are guarded by the {onlyMarket} modifier. As security logic sits on the {InterestMarketV1}.
 * @notice contract is not meant to be deployed without a child contract to implement the core logic.
 * @notice It relies on all it's virtual functions to be overriden to have any use!
 * @notice It is meant to work with the {CAKE_MASTER_CHEF} deployed at 0x73feaa1eE314F8c655E354234017bE2193C9E24E.
 * @notice It is meant to be used only with tokens supported by tge {CAKE_MASTER_CHEF}.
 */
abstract contract Vault is IVault, Ownable {
    /*///////////////////////////////////////////////////////////////
                                LIBRARIES
    //////////////////////////////////////////////////////////////*/

    using IntMath for uint256;

    /*///////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Deposit(address indexed from, address indexed to, uint256 amount);

    event Withdraw(address indexed from, address indexed to, uint256 amount);

    event Compound(uint256 rewards, uint256 fee, uint256 indexed blockNumber);

    /*///////////////////////////////////////////////////////////////
                                STRUCTS
    //////////////////////////////////////////////////////////////*/

    struct User {
        uint256 amount;
        uint256 rewardDebt;
        uint256 rewards;
    }

    /*///////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    //solhint-disable-next-line var-name-mixedcase
    IMasterChef public immutable CAKE_MASTER_CHEF; // The cake masterchef. He is an honest Cooker!

    // solhint-disable-next-line var-name-mixedcase
    IERC20 public immutable CAKE; // The famous Cake token!!

    // solhint-disable-next-line var-name-mixedcase
    address public MARKET; // The market contract that deposits/withdraws from this contract.

    /*///////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    mapping(address => User) public userInfo; // Account Address => Account Info

    uint256 public totalAmount; // total amount of staking token in the contract

    uint256 public totalRewardsPerAmount;

    /*///////////////////////////////////////////////////////////////
                                CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @param cakeMasterChef The address of the Pancake Swap master chef.
     * @param cake The address of the Pancake Swap cake token.
     */
    constructor(IMasterChef cakeMasterChef, IERC20 cake) {
        CAKE_MASTER_CHEF = cakeMasterChef;
        CAKE = cake;
    }

    /*///////////////////////////////////////////////////////////////
                                MODIFIER
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Only the {MARKET} should be able to deposit and withdraw from this contract.
     */
    modifier onlyMarket() {
        require(_msgSender() == MARKET, "Vault: only market");
        _;
    }

    /*///////////////////////////////////////////////////////////////
                               VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev It is meant to return the total pending {CAKE} rewards.
     *
     * @notice The implementation of this function is supposed to be implemented by the child contract.
     */
    function getPendingRewards() public view virtual returns (uint256) {
        return 0;
    }

    /**
     * @dev It checks how many pending {CAKE] an `account` is entitled to by calculating
     * how much {CAKE} they have accrued + pending {CAKE} in {CAKE_MASTER_CHEF}.
     *
     * @param account The address, which we will return how much pending {CAKE} it current has.
     * @return rewards The number of pending {CAKE} rewards.
     */
    function getUserPendingRewards(address account)
        external
        view
        returns (uint256 rewards)
    {
        uint256 _totalAmount = totalAmount;
        // We do not need to calculate the pending rewards, if there are no tokens deposited in this contract.
        if (_totalAmount <= 0) return 0;

        // Save storage in memory to save gas.
        uint256 _totalRewardsPerAmount = totalRewardsPerAmount;
        User memory user = userInfo[account];

        // Get all current pending rewards.
        uint256 pendingRewardsPerAmount = getPendingRewards().bdiv(
            _totalAmount
        );

        // Calculates how many of {CAKE} rewards the user has accrued since his last deposit/withdraw.
        rewards +=
            (_totalRewardsPerAmount + pendingRewardsPerAmount).bmul(
                user.amount
            ) -
            user.rewardDebt;

        // This contract only sends the rewards on withdraw. So in case the user never withdraw, we need to add the `user.rewards`.
        return rewards + user.rewards;
    }

    /*///////////////////////////////////////////////////////////////
                            INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev It deposits all {CAKE} stored in the contract in the {CAKE} pool in the {CAKE_MASTER_CHEF} and returns the rewards obtained.
     *
     * @return cakeHarvested The reward acrrued up to this block in {CAKE}.
     */
    function _stakeCake() internal returns (uint256 cakeHarvested) {
        CAKE_MASTER_CHEF.enterStaking(_getCakeBalance());
        // Current {balanceOf} Cake are all rewards because we just staked our entire {CAKE} balance.
        cakeHarvested = _getCakeBalance();
    }

    /**
     * @dev It withdraws an `amount` of {CAKE} from the {CAKE_MASTER_CHEF} and returns the arewards obtained.
     *
     * @param amount The number of {CAKE} to be unstaked.
     * @return cakeHarvested The number of {CAKE} that was obtained as reward.
     */
    function _unStakeCake(uint256 amount)
        internal
        returns (uint256 cakeHarvested)
    {
        uint256 preBalance = _getCakeBalance();

        CAKE_MASTER_CHEF.leaveStaking(amount);
        // Need to subtract the previous balance and withdrawn amount from the current {balanceOf} to know many reward {CAKE} we got.
        cakeHarvested = _getCakeBalance() - preBalance - amount;
    }

    /**
     * @dev A helper function to get the current {CAKE} balance in this vault.
     */
    function _getCakeBalance() internal view returns (uint256) {
        return CAKE.balanceOf(address(this));
    }

    /**
     * @dev The logic for this function is to be implemented by the child contract.
     * It needs to {transferFrom} a token from an account and correctly keep track of the amounts and rewards.
     */
    function _deposit(
        address,
        address,
        uint256 //solhint-disable-next-line no-empty-blocks
    ) internal virtual {}

    /**
     * @dev The logic for this function is to be implemented by the child contract.
     * It needs to send the underlying token and rewards correctly.
     * The rewards are always sent to the first address and the underlying token to the second address.
     */
    function _withdraw(
        address,
        address,
        uint256 //solhint-disable-next-line no-empty-blocks
    ) internal virtual {}

    /*///////////////////////////////////////////////////////////////
                            ONLY MARKET FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev This function acts as a guard wrapper for the {_deposit} function.
     *
     * @param from The account that needs to have enough {STAKING_TOKEN} and approve the contract.
     * @param to The account that the deposit will be assigned to.
     * @param amount The number of {STAKING_TOKEN} the `account` wishes to deposit.
     *
     * Requirements:
     * - `amount` has to be greater than 0. Since rewards are not send on deposit. It does not make sense to allow an amount of 0.
     * - `account` cannot be the zero address. That is an impossibility and is here to avoid bad UI.
     * - {onlyMarket} on deposit is here because even if we allow deposits by anyone, they would never be able to withdraw.
     *
     */
    function deposit(
        address from,
        address to,
        uint256 amount
    ) external onlyMarket {
        require(amount > 0, "Vault: no zero amount");
        require(
            from != address(0) && to != address(0),
            "Vault: no zero address"
        );

        _deposit(from, to, amount);
    }

    /**
     * @dev this fuction acts as a guard wrapper for the {_withdraw} function.
     *
     * @notice we need an `account` and `recipient` because on liquidations the {STAKING_TOKEN} will go to the liquidator or market to cover the collateral. However, the `account` still gets the rewards.
     *
     * @param account The address that the {STAKING_TOKEN} will be withdrawn from. It will also receive the rewards accrued.
     * @param recipient The address, which will get the {STAKING_TOKEN}.
     * @param amount The number of {STAKING_TOKEN} that will be withdrawn.
     *
     * Requirements:
     * - `amount` has to be greater than 0.
     * - `totalAmount` has to be greater than 0. Makes no sense to withdraw from an empty vault.
     * - `account` and `recipient` cannot be the zero address. This is to avoid accidently burning tokens and bad UI.
     * - {onlyMarket} modifier is needed. Otherwise, anyone could steal tokens from this contract.
     *
     */
    function withdraw(
        address account,
        address recipient,
        uint256 amount
    ) external onlyMarket {
        require(amount > 0, "Vault: no zero amount");
        require(
            account != address(0) && recipient != address(0),
            "Vault: no zero address"
        );
        require(totalAmount > 0, "Vault: no tokens");

        _withdraw(account, recipient, amount);
    }

    /*///////////////////////////////////////////////////////////////
                        ONLY OWNER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev This function is required due to the deployment order. We need to deploy Vaults before the {InterestMarketV1}.
     *
     * @notice This function can only be called once for security reasons. Otherwise, the owner could change the {MARKET} and have access to the user funds.
     *
     * @param market The address of the {MARKET}.
     *
     * Requirements:
     *
     * - Only the {owner} can call this function to avoid griefing.
     * - {MARKET} must be the zero address. This guarantees that this function can only be called once.
     * - ` market` cannot be the zero address. This combined with the previous requirement makes sure that it is only callable once.
     *
     */
    function setMarket(address market) external onlyOwner {
        require(market != address(0), "Vault: no zero address");
        require(address(0) == MARKET, "Vault: already set");
        MARKET = market;
    }
}
