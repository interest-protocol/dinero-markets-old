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
import "@openzeppelin/contracts/access/Ownable.sol";

import "./interfaces/IMasterChef.sol";
import "./interfaces/IVault.sol";

contract LPVault is Ownable, IVault {
    /**************************** LIBRARIES ****************************/

    using SafeERC20 for IERC20;

    /****************************  EVENTS ****************************/

    event Deposit(address indexed account, uint256 amount);

    event Withdraw(
        address indexed account,
        address indexed recipient,
        uint256 amount
    );

    event LogCompound(
        uint256 rewards,
        uint256 fee,
        uint256 indexed blockNumber
    );

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

    /**************************** STATE ****************************/

    uint256 public poolId; // The current master chef farm being used

    mapping(address => User) public userInfo; // Account Address => Account Info

    uint256 public totalAmount; // total amount of staking token in the contract

    uint256 public totalRewards; // is boosted by 1e12

    /**************************** CONSTRUCTOR ****************************/

    constructor(
        IMasterChef cakeMasterChef,
        IERC20 cake,
        IERC20 stakingToken,
        uint256 _poolId,
        address market
    ) {
        CAKE_MASTER_CHEF = cakeMasterChef;
        CAKE = cake;
        STAKING_TOKEN = stakingToken;
        MARKET = market;
        poolId = _poolId;
        // Master chef needs full approval
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
     * It checks the pending Cake in the farm and the CAKE pool which is always Id 0
     * @return The number of CAKE the contract has as rewards in the farm
     */
    function getPendingRewards() external view returns (uint256) {
        return
            CAKE_MASTER_CHEF.pendingCake(poolId, address(this)) +
            CAKE_MASTER_CHEF.pendingCake(0, address(this));
    }

    /**************************** MUTATIVE FUNCTIONS ****************************/

    /**
     * This function gives the `CAKE_MASTER_CHEF` maximum approval of the underlying token and the `CAKE` token
     */
    function approve() external {
        STAKING_TOKEN.safeApprove(address(CAKE_MASTER_CHEF), type(uint256).max);
        CAKE.safeApprove(address(CAKE_MASTER_CHEF), type(uint256).max);
    }

    /**
     * This function compounds the `CAKE` rewards in the farm to the `CAKE` pool and pays the caller a small fee as reward
     */
    function compound() external {
        uint256 cakeRewards;

        uint256 _totalRewards = totalRewards;

        // Get rewards from the `STAKING_TOKEN` farm
        cakeRewards += _depositFarm(0);
        // Get rewards from the `CAKE` pool
        cakeRewards += _unStakeCake(0);

        // Calculate fee to reward the `msg.sender`
        uint256 fee = (cakeRewards * 1000) / 1e5; // 1% of the rewards obtained

        // update state
        _totalRewards += (cakeRewards - fee) * 1e12;

        uint256 cakeBalance = getCakeBalance();

        if (fee > cakeBalance) {
            _totalRewards += _unStakeCake(fee - cakeBalance) * 1e12;
        }

        // Pay the `msg.sender`
        CAKE.safeTransfer(_msgSender(), fee);

        // Compound the rewards
        _totalRewards += _stakeCake() * 1e12;

        // Update global state
        totalRewards = _totalRewards;

        emit LogCompound(cakeRewards - fee, fee, block.number);
    }

    /**************************** PRIVATE FUNCTIONS ****************************/

    /**
     * A helper function to get the current `CAKE` balance in this vault
     */
    function getCakeBalance() private view returns (uint256) {
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
        uint256 preBalance = getCakeBalance();
        CAKE_MASTER_CHEF.withdraw(poolId, amount);
        // Find how much cake we earned after depositing as it always gives the rewards
        cakeHarvested = getCakeBalance() - preBalance;
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
        uint256 preBalance = getCakeBalance();
        CAKE_MASTER_CHEF.deposit(poolId, amount);
        // Find how much cake we earned after depositing as it always gives the rewards
        cakeHarvested = getCakeBalance() - preBalance;
    }

    /**
     * This function stakes the current `CAKE` in this vault in the farm
     * @return cakeHarvested it returns the amount of `CAKE` farmed
     */
    function _stakeCake() private returns (uint256 cakeHarvested) {
        CAKE_MASTER_CHEF.enterStaking(getCakeBalance());
        // Current Balance of Cake are extra rewards because we just staked our entire CAKE balance
        cakeHarvested = getCakeBalance();
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
        uint256 preBalance = getCakeBalance();

        CAKE_MASTER_CHEF.leaveStaking(amount);
        cakeHarvested = getCakeBalance() - preBalance - amount;
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
        uint256 _totalRewards = totalRewards;

        // Get rewards currently in the farm
        _totalRewards += _depositFarm(0) * 1e12;
        // Reinvest all cake into the CAKE pool and get the current rewards
        _totalRewards += _stakeCake() * 1e12;

        // Calculate how many rewards the user is entitled before this deposit
        uint256 rewards = (((_totalRewards / _totalAmount) * user.amount) /
            1e12) - user.rewardDebt;

        // Update State
        _totalAmount += amount;
        user.amount += amount;
        user.rewards += rewards;

        // Get Tokens from `msg.sender`
        STAKING_TOKEN.safeTransferFrom(_msgSender(), address(this), amount);

        // Deposit the new acquired tokens in the farm
        _totalRewards += _depositFarm(amount) * 1e12;

        // Update State to tell us that user has been completed paid up to this point
        user.rewardDebt = ((_totalRewards / _totalAmount) * user.amount) / 1e12;

        // Update Global state
        userInfo[account] = user;
        totalAmount = _totalAmount;
        totalRewards = _totalRewards;

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
        require(amount > 0, "Vault: no zero amount");
        require(account != address(0), "Vault: no zero address");

        User memory user = userInfo[account];

        require(user.amount >= amount, "Vault: not enough tokens");

        uint256 _totalAmount = totalAmount;
        uint256 _totalRewards = totalRewards;

        _totalRewards += _withdrawFarm(amount) * 1e12;
        // Collect the current rewards in the `CAKE` pool to properly calculate rewards
        _totalRewards += _unStakeCake(0) * 1e12;

        // Calculate how many rewards the user is entitled before this deposit
        uint256 rewards = (((_totalRewards / _totalAmount) * user.amount) /
            1e12) - user.rewardDebt;

        _totalAmount -= amount;
        user.amount -= amount;

        // Send all accrued rewards
        rewards += user.rewards;

        // Set rewards to 0
        user.rewards = 0;

        uint256 cakeBalance = getCakeBalance();

        if (cakeBalance < rewards) {
            // Take cake from the Cake pool in case the contract does not enough CAKE
            _totalRewards += _unStakeCake(rewards - cakeBalance) * 1e12;
        }

        // Send the rewards tot he recipient
        CAKE.safeTransfer(recipient, rewards);

        // Only restake if there is at least 1 `CAKE` in the contract after sending the rewards
        if (getCakeBalance() > 1 ether) {
            _totalRewards += _stakeCake() * 1e12;
        }

        user.rewardDebt = ((_totalRewards / _totalAmount) * user.amount) / 1e12;

        // Update Gloabl state
        totalAmount = _totalAmount;
        totalRewards = _totalRewards;
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
        require(account != address(0), "Vault: no zero address");

        _withdraw(account, recipient, amount);
    }

    /**************************** ONLY OWNER ****************************/

    /**
     * In case PCS creates a new farm for a specific market and we need to migrate to a new farm
     * It will properly update the `totalRewards`, withdraw the `STAKING_TOKEN` from the old farm and deposit in the new one and compound `CAKE` as well.
     * @param id The new id of the pool.
     *
     * This function is protected by the {onlyOwner} modifier to disallow griefing
     *
     */
    function updateFarm(uint256 id) external onlyOwner {
        uint256 _totalAmount = totalAmount;
        uint256 _totalRewards = totalRewards;

        // update the total rewards
        _totalRewards += _withdrawFarm(totalAmount) * 1e12;

        // Refresh full approval
        STAKING_TOKEN.safeApprove(address(CAKE_MASTER_CHEF), type(uint256).max);
        CAKE.safeApprove(address(CAKE_MASTER_CHEF), type(uint256).max);

        // Update pool Id
        poolId = id;

        // This should happen once so there are no rewards
        CAKE_MASTER_CHEF.deposit(id, _totalAmount);

        // Stake current Cake in the Cake pool and update rewards
        _totalRewards += _stakeCake() * 1e12;

        // Update global state
        totalRewards = _totalRewards;
    }
}
