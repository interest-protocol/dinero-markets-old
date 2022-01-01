//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./interfaces/IMasterChef.sol";

contract LPVault is Ownable {
    /**************************** LIBRARIES ****************************/

    using SafeERC20 for IERC20;

    /****************************  EVENTS ****************************/

    event Deposit(address indexed account, uint256 amount);

    event Withdraw(address indexed account, uint256 amount);

    event LogCompound(uint256 fee, uint256 indexed blockNumber);

    /****************************  STRUCT ****************************/

    struct User {
        uint256 amount;
        uint256 rewardDebt;
        uint256 rewards;
    }

    /****************************  CONSTANTS ****************************/

    //solhint-disable-next-line var-name-mixedcase
    IMasterChef public immutable CAKE_MASTER_CHEF;

    // solhint-disable-next-line var-name-mixedcase
    address public immutable CAKE;

    // solhint-disable-next-line
    IERC20 public immutable STAKING_TOKEN;

    // solhint-disable-next-line var-name-mixedcase
    address public immutable MARKET;

    /**************************** STATE ****************************/

    uint256 public rewardsPerToken;

    uint256 public lastUpdateTime;

    uint256 public poolId;

    mapping(address => uint256) public userRewardsPerTokenPaid;

    mapping(address => User) public userInfo;

    uint256 public totalAmount;

    uint256 public totalRewards; // has boosted by 1e12

    /**************************** CONSTRUCTOR ****************************/

    constructor(
        IMasterChef cakeMasterChef,
        address cake,
        IERC20 stakingToken,
        uint256 _poolId,
        address market
    ) {
        CAKE_MASTER_CHEF = cakeMasterChef;
        CAKE = cake;
        STAKING_TOKEN = stakingToken;
        MARKET = market;
        poolId = _poolId;
        stakingToken.safeApprove(address(cakeMasterChef), type(uint256).max);
    }

    /**************************** MODIFIER ****************************/

    modifier onlyMarket() {
        require(_msgSender() == MARKET, "Vault: only market");
        _;
    }

    /**************************** VIEW FUNCTIONS ****************************/

    function getPendingRewards() external view returns (uint256) {
        return CAKE_MASTER_CHEF.pendingCake(poolId, address(this));
    }

    /**************************** MUTATIVE FUNCTIONS ****************************/

    function approve() external {
        STAKING_TOKEN.safeApprove(address(CAKE_MASTER_CHEF), type(uint256).max);
    }

    function compound() external {
        uint256 cakeRewards;
        // Get rewards in the farm
        cakeRewards += _depositFarm(0);
        // Stake rewards in the CAKE pool
        cakeRewards += _stakeCake();

        totalRewards += cakeRewards * 1e12;

        uint256 fee = (cakeRewards * 300) / 1e5; // 0.3% of the rewards obtained

        uint256 cakeBalance = getCakeBalance();

        if (fee > cakeBalance) {
            totalRewards += _unStakeCake(fee - cakeBalance);
        }

        IERC20(CAKE).safeTransfer(_msgSender(), fee);

        emit LogCompound(fee, block.number);
    }

    /**************************** PRIVATE FUNCTIONS ****************************/

    function getCakeBalance() private view returns (uint256) {
        return IERC20(CAKE).balanceOf(address(this));
    }

    function _withdrawFarm(uint256 amount)
        private
        returns (uint256 cakeHarvested)
    {
        uint256 preBalance = getCakeBalance();
        CAKE_MASTER_CHEF.withdraw(poolId, amount);
        // Find how much cake we earned after depositing as it always gives the rewards
        cakeHarvested = getCakeBalance() - preBalance;
    }

    function _depositFarm(uint256 amount)
        private
        returns (uint256 cakeHarvested)
    {
        uint256 preBalance = getCakeBalance();
        CAKE_MASTER_CHEF.deposit(poolId, amount);
        // Find how much cake we earned after depositing as it always gives the rewards
        cakeHarvested = getCakeBalance() - preBalance;
    }

    function _stakeCake() private returns (uint256 cakeHarvested) {
        CAKE_MASTER_CHEF.enterStaking(getCakeBalance());
        // Current Balance of Cake are extra rewards because we just staked our entire CAKE balance
        cakeHarvested = getCakeBalance();
    }

    function _unStakeCake(uint256 amount)
        private
        returns (uint256 cakeHarvested)
    {
        uint256 preBalance = getCakeBalance();

        CAKE_MASTER_CHEF.leaveStaking(amount);
        cakeHarvested = getCakeBalance() - preBalance - amount;
    }

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
        // Reinvest all cake into the CAKE pool and get the current rewards
        _totalRewards += _stakeCake() * 1e12;

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
            _totalRewards += _unStakeCake(rewards - cakeBalance);
        }

        user.rewardDebt = ((_totalRewards / _totalAmount) * user.amount) / 1e12;

        // Update Gloabl state
        totalAmount = _totalAmount;
        totalRewards = _totalRewards;
        userInfo[account] = user;

        IERC20(CAKE).safeTransfer(recipient, rewards);

        // Send the underlying token to the recipient
        STAKING_TOKEN.safeTransfer(recipient, amount);

        emit Withdraw(account, amount);
    }

    /**************************** ONLY MARKET ****************************/

    function deposit(address account, uint256 amount) external onlyMarket {
        require(amount > 0, "Vault: no zero amount");
        require(account != address(0), "Vault: no zero address");

        _deposit(account, amount);
    }

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

    function updateFarm(uint256 id) external onlyOwner {
        uint256 _totalAmount = totalAmount;
        uint256 _totalRewards = totalRewards;

        // update the total rewards
        _totalRewards += _withdrawFarm(totalAmount) * 1e12;

        STAKING_TOKEN.safeApprove(address(CAKE_MASTER_CHEF), type(uint256).max);

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
