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
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Context.sol";

import "./interfaces/IMasterChef.sol";
import "./interfaces/IVault.sol";

contract LPVault is IVault, Context {
    /**************************** LIBRARIES ****************************/

    using SafeERC20 for IERC20;

    /****************************  EVENTS ****************************/

    event Deposit(address indexed account, uint256 amount);

    event Withdraw(
        address indexed account,
        address indexed recipient,
        uint256 amount
    );

    event Compound(uint256 rewards, uint256 fee, uint256 indexed blockNumber);

    /****************************  STRUCT ****************************/

    struct User {
        uint256 amount;
        uint256 rewardDebt;
        uint256 rewards;
    }

    /****************************  CONSTANTS ****************************/

    //solhint-disable-next-line var-name-mixedcase
    IMasterChef public immutable CAKE_MASTER_CHEF; // The cake masterchef. He is an honest Cooker!

    // solhint-disable-next-line var-name-mixedcase
    IERC20 public immutable CAKE; // The famous Cake token!!

    // solhint-disable-next-line
    IERC20 public immutable STAKING_TOKEN; // The current token being farmed

    // solhint-disable-next-line var-name-mixedcase
    address public immutable MARKET; // The market contract that deposits/withdraws from this contract

    // solhint-disable-next-line var-name-mixedcase
    uint256 public immutable POOL_ID; // The current master chef farm being used

    /**************************** STATE ****************************/

    mapping(address => User) public userInfo; // Account Address => Account Info

    uint256 public totalAmount; // total amount of staking token in the contract

    uint256 public totalRewardsPerAmount; // is boosted by 1e12

    /**************************** CONSTRUCTOR ****************************/

    constructor(
        IMasterChef cakeMasterChef,
        IERC20 cake,
        IERC20 stakingToken,
        uint256 _poolId,
        address market
    ) {
        require(_poolId != 0, "LPVault: this is a LP vault");
        CAKE_MASTER_CHEF = cakeMasterChef;
        CAKE = cake;
        STAKING_TOKEN = stakingToken;
        MARKET = market;
        POOL_ID = _poolId;
        // Master chef needs full approval. {safeApprove} is fine to be used for the initial allowance
        stakingToken.safeApprove(address(cakeMasterChef), type(uint256).max);
        cake.safeApprove(address(cakeMasterChef), type(uint256).max);
    }

    /**************************** MODIFIER ****************************/

    // Make sure that only the Market has access to certain functionality
    modifier onlyMarket() {
        require(_msgSender() == MARKET, "Vault: only market");
        _;
    }

    /**************************** VIEW FUNCTIONS ****************************/
    /**
     * It checks the pending `CAKE` the farm and the CAKE pool which is always Id 0
     * @return The number of `CAKE` the contract has as rewards in the farm
     */
    function getPendingRewards() public view returns (uint256) {
        return
            CAKE_MASTER_CHEF.pendingCake(POOL_ID, address(this)) +
            CAKE_MASTER_CHEF.pendingCake(0, address(this));
    }

    /**
     * It checks how many pending `CAKE` a user is entitled to by calculating how much `CAKE` they have accrued + pending `CAKE` in `CAKE_MASTER_CHEF`
     * @param account The address to check how much pending `CAKE` he will get
     * @return rewards The number of `CAKE`
     */
    function getUserPendingRewards(address account)
        external
        view
        returns (uint256 rewards)
    {
        uint256 _totalAmount = totalAmount;
        // No need to calculate rewards if there are no tokens deposited in this contract;
        // Also add this condition to avoid dividing by 0 when calculating the rewards
        if (_totalAmount <= 0) return 0;

        uint256 _totalRewardsPerAmount = totalRewardsPerAmount;
        User memory user = userInfo[account];

        uint256 pendingRewardsPerAmount = (getPendingRewards() * 1e12) /
            _totalAmount;

        rewards +=
            (((_totalRewardsPerAmount + pendingRewardsPerAmount) *
                user.amount) / 1e12) -
            user.rewardDebt;

        return rewards + user.rewards;
    }

    /**************************** MUTATIVE FUNCTIONS ****************************/

    /**
     * This function gives the `CAKE_MASTER_CHEF` maximum approval of the underlying token and the `CAKE` token
     */
    function approve(uint256 stakingAmount, uint256 cakeAmount) external {
        STAKING_TOKEN.safeIncreaseAllowance(
            address(CAKE_MASTER_CHEF),
            stakingAmount
        );
        CAKE.safeIncreaseAllowance(address(CAKE_MASTER_CHEF), cakeAmount);
    }

    /**
     * This function compounds the `CAKE` rewards in the farm to the `CAKE` pool and pays the caller a small fee as reward
     */
    function compound() external {
        uint256 cakeRewards;

        uint256 _totalRewardsPerAmount = totalRewardsPerAmount;
        uint256 _totalAmount = totalAmount;

        // Get rewards from the `STAKING_TOKEN` farm
        cakeRewards += _depositFarm(0);
        // Get rewards from the `CAKE` pool
        cakeRewards += _unStakeCake(0);

        // Calculate fee to reward the `msg.sender`
        uint256 fee = (cakeRewards * 2e4) / 1e6; // 2% of the rewards obtained

        // update state
        _totalRewardsPerAmount += ((cakeRewards - fee) * 1e12) / _totalAmount;

        // Pay the `msg.sender`
        CAKE.safeTransfer(_msgSender(), fee);

        // Compound the rewards. We already took the rewards up to this block. So the `CAKE` pool rewards should be 0.
        CAKE_MASTER_CHEF.enterStaking(_getCakeBalance());

        // Update global state
        totalRewardsPerAmount = _totalRewardsPerAmount;

        emit Compound(cakeRewards - fee, fee, block.number);
    }

    /**************************** PRIVATE FUNCTIONS ****************************/

    /**
     * A helper function to get the current `CAKE` balance in this vault
     */
    function _getCakeBalance() private view returns (uint256) {
        return CAKE.balanceOf(address(this));
    }

    /**
     * This function removes `STAKING_TOKEN` from the farm and returns the amount of `CAKE` farmed
     * @param amount The number of `STAKING_TOKEN` to be withdrawn from the `CAKE_MASTER_CHEF`
     * @return cakeHarvested It returns how many `CAKE` we got as reward
     */
    function _withdrawFarm(uint256 amount)
        private
        returns (uint256 cakeHarvested)
    {
        uint256 preBalance = _getCakeBalance();
        CAKE_MASTER_CHEF.withdraw(POOL_ID, amount);
        // Find how much cake we earned after withdrawing as it always gives the rewards
        cakeHarvested = _getCakeBalance() - preBalance;
    }

    /**
     * This function deposits `STAKING_TOKEN` in the farm and returns the amount of `CAKE` farmed
     * @param amount The number of `STAKING_TOKEN` to deposit in the `CAKE_MASTER_CHEF`
     * @return cakeHarvested It returns how many `CAKE` we got as reward
     */
    function _depositFarm(uint256 amount)
        private
        returns (uint256 cakeHarvested)
    {
        uint256 preBalance = _getCakeBalance();
        CAKE_MASTER_CHEF.deposit(POOL_ID, amount);
        // Find how much cake we earned after depositing as it always gives the rewards
        cakeHarvested = _getCakeBalance() - preBalance;
    }

    /**
     * This function stakes the current `CAKE` in this vault in the farm
     * @return cakeHarvested it returns the amount of `CAKE` farmed
     */
    function _stakeCake() private returns (uint256 cakeHarvested) {
        CAKE_MASTER_CHEF.enterStaking(_getCakeBalance());
        // Current Balance of Cake are extra rewards because we just staked our entire CAKE balance
        cakeHarvested = _getCakeBalance();
    }

    /**
     * This function withdraws `CAKE` from the cake staking pool and returns the amount of rewards `CAKE`
     * @param amount The number of `CAKE` to be unstaked
     * @return cakeHarvested The number of `CAKE` that was farmed as reward
     */
    function _unStakeCake(uint256 amount)
        private
        returns (uint256 cakeHarvested)
    {
        uint256 preBalance = _getCakeBalance();

        CAKE_MASTER_CHEF.leaveStaking(amount);
        cakeHarvested = _getCakeBalance() - preBalance - amount;
    }

    /**
     * This function takes `STAKING_TOKEN` from the `msg.sender` and puts it in the `CAKE_MASTER_CHEF`
     * This function will update the global state and recalculate the `totalAmount`, `totalRewards` and `userInfo` accordingly
     * This function does not send the current rewards accrued to the user
     * @param account The account that is depositing `STAKING_TOKEN`
     * @param amount The number of `STAKING_TOKEN` that he/she wishes to deposit
     */
    function _deposit(address account, uint256 amount) private {
        User memory user = userInfo[account];
        uint256 _totalAmount = totalAmount;
        uint256 _totalRewardsPerAmount = totalRewardsPerAmount;

        // If there are no tokens deposited, we do not need to run these operations
        if (_totalAmount > 0) {
            // Get rewards currently in the farm
            _totalRewardsPerAmount += (_depositFarm(0) * 1e12) / _totalAmount;
            // Reinvest all cake into the CAKE pool and get the current rewards
            _totalRewardsPerAmount += (_stakeCake() * 1e12) / _totalAmount;
        }

        // No need to calculate rewards if the user has no deposit
        if (user.amount > 0) {
            // Calculate and add how many rewards the user accrued
            user.rewards +=
                ((_totalRewardsPerAmount * user.amount) / 1e12) -
                user.rewardDebt;
        }

        // Update State
        _totalAmount += amount;
        user.amount += amount;

        // Get Tokens from `account`
        // This is to save gas. `account` has to approve the vault
        STAKING_TOKEN.safeTransferFrom(account, address(this), amount);

        // Deposit the new acquired tokens in the farm
        // Since we already got the rewards in this block. There should be no rewards right now to harvest.
        CAKE_MASTER_CHEF.deposit(POOL_ID, amount);

        // Update State to tell us that user has been completed paid up to this point
        user.rewardDebt = (_totalRewardsPerAmount * user.amount) / 1e12;

        // Update Global state
        userInfo[account] = user;
        totalAmount = _totalAmount;
        totalRewardsPerAmount = _totalRewardsPerAmount;

        emit Deposit(account, amount);
    }

    /**
     * This function withdraws `STAKING_TOKEN` from the `CAKE_MASTER_CHEF` and sends to the `recipient`
     * This function will update the global state and recalculate the `totalAmount`, `totalRewards` and `userInfo` accordingly
     * This function will send the current accrued rewards to the `recipient`
     * @param account The account that is depositing `STAKING_TOKEN`
     * @param recipient the account which will get the `STAKING_TOKEN` and `CAKE` rewards
     * @param amount The number of `STAKING_TOKEN` that he/she wishes to withdraw
     */
    function _withdraw(
        address account,
        address recipient,
        uint256 amount
    ) private {
        User memory user = userInfo[account];

        require(user.amount >= amount, "Vault: not enough tokens");

        uint256 _totalAmount = totalAmount;
        uint256 _totalRewardsPerAmount = totalRewardsPerAmount;

        _totalRewardsPerAmount += (_withdrawFarm(amount) * 1e12) / _totalAmount;
        // Collect the current rewards in the `CAKE` pool to properly calculate rewards
        _totalRewardsPerAmount += (_unStakeCake(0) * 1e12) / _totalAmount;

        // Calculate how many rewards the user is entitled before this deposit
        uint256 rewards = ((_totalRewardsPerAmount * user.amount) / 1e12) -
            user.rewardDebt;

        _totalAmount -= amount;
        user.amount -= amount;

        // Send all accrued rewards
        rewards += user.rewards;

        // Set rewards to 0
        user.rewards = 0;

        uint256 cakeBalance = _getCakeBalance();

        if (cakeBalance < rewards) {
            uint256 unstakeRewards = _unStakeCake(rewards - cakeBalance);
            // If the pool no longer has any supply we do not need to add to the totalRewardsPerAmount
            if (_totalAmount > 0) {
                // Take cake from the Cake pool in case the contract does not enough CAKE
                _totalRewardsPerAmount +=
                    (unstakeRewards * 1e12) /
                    _totalAmount;
            }
        }

        // Send the rewards to the recipient
        CAKE.safeTransfer(recipient, rewards);

        // Only restake if there is at least 1 `CAKE` in the contract after sending the rewards
        // If there are no `STAKING TOKENS` left, we do not need to restake
        if (_totalAmount > 0 && _getCakeBalance() >= 1 ether) {
            _totalRewardsPerAmount += (_stakeCake() * 1e12) / _totalAmount;
        }

        // If the Vault still has assets update the state as usual
        if (_totalAmount > 0) {
            // Reset totalRewardsPerAmount if the pool is totally empty
            totalRewardsPerAmount = _totalRewardsPerAmount;
            user.rewardDebt = (_totalRewardsPerAmount * user.amount) / 1e12;
            totalAmount = _totalAmount;
        } else {
            // If the Vault does not have any `STAKING_TOKEN`, reset the whole state.
            totalAmount = 0;
            totalRewardsPerAmount = 0;
            user.rewardDebt = 0;
            user.amount = 0;
        }

        userInfo[account] = user;

        // Send the underlying token to the recipient
        STAKING_TOKEN.safeTransfer(recipient, amount);

        emit Withdraw(account, recipient, amount);
    }

    /**************************** ONLY MARKET ****************************/

    /**
     * @param account The account that is depositing `STAKING_TOKEN`
     * @param amount The number of `STAKING_TOKEN` that he/she wishes to deposit
     *
     * This function disallows 0 values as they are applicable in the context. Cannot deposit 0 `amount` as we do not send rewards on deposit
     * This function uses the {_deposit} function and is protected by the modifier {onlyMarket} to disallow funds mismanegement
     *
     */
    function deposit(address account, uint256 amount) external onlyMarket {
        require(amount > 0, "Vault: no zero amount");
        require(account != address(0), "Vault: no zero address");

        _deposit(account, amount);
    }

    /**
     * @param account The account that is depositing `STAKING_TOKEN`
     * @param recipient The account which will get the `CAKE` rewards and `STAKING_TOKEN`
     * @param amount The number of `STAKING_TOKEN` that he/she wishes to deposit
     *
     * This function disallows 0 values as they are applicable in the context. Cannot withdraw 0 `amount` as rewards are only paid for liquidators or on repayment.
     * This function uses the {_withdraw} function and is protected by the modifier {onlyMarket} to disallow funds mismanegement
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

        _withdraw(account, recipient, amount);
    }
}
