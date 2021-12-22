/*


░█████╗░░█████╗░░██████╗░█████╗░  ██████╗░███████╗  ██████╗░░█████╗░██████╗░███████╗██╗░░░░░
██╔══██╗██╔══██╗██╔════╝██╔══██╗  ██╔══██╗██╔════╝  ██╔══██╗██╔══██╗██╔══██╗██╔════╝██║░░░░░
██║░░╚═╝███████║╚█████╗░███████║  ██║░░██║█████╗░░  ██████╔╝███████║██████╔╝█████╗░░██║░░░░░
██║░░██╗██╔══██║░╚═══██╗██╔══██║  ██║░░██║██╔══╝░░  ██╔═══╝░██╔══██║██╔═══╝░██╔══╝░░██║░░░░░
╚█████╔╝██║░░██║██████╔╝██║░░██║  ██████╔╝███████╗  ██║░░░░░██║░░██║██║░░░░░███████╗███████╗
░╚════╝░╚═╝░░╚═╝╚═════╝░╚═╝░░╚═╝  ╚═════╝░╚══════╝  ╚═╝░░░░░╚═╝░░╚═╝╚═╝░░░░░╚══════╝╚══════╝

*/
//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./InterestToken.sol";
import "./StakedInterestToken.sol";

contract CasaDePapel is Ownable {
    /**************************** LIBRARIES ****************************/

    using SafeERC20 for IERC20;

    /**************************** EVENTS****************************/

    event Deposit(address indexed user, uint256 indexed poolId, uint256 amount);

    event Withdraw(
        address indexed user,
        uint256 indexed poolId,
        uint256 amount
    );

    event Transfer(address indexed from, address indexed to, uint256 amount);

    event EmergencyWithdraw(
        address indexed user,
        uint256 indexed poolId,
        uint256 amount
    );

    /**************************** STRUCTS ****************************/

    struct User {
        uint256 amount;
        uint256 rewardsPaid;
    }

    struct Pool {
        IERC20 stakingToken;
        uint256 allocationPoints; // These points determine how many Int tokens the pool distributes per block
        uint256 lastRewardBlock; // The last block the pool has distributed rewards
        uint256 accruedIntPerShare; // Total of accrued Int tokens per share
        uint256 totalSupply;
    }

    /**************************** STATE ****************************/

    // solhint-disable-next-line var-name-mixedcase
    InterestToken public immutable INTEREST_TOKEN;

    // Receipt token to represent how many INT tokens the user has staked. Only distributed when staking INT directly
    // solhint-disable-next-line var-name-mixedcase
    StakedInterestToken public immutable STAKED_INTEREST_TOKEN;

    uint256 public interestTokenPerBlock;

    // Devs will receive 10% of all minted Int
    address public devAccount;

    Pool[] public pools;

    // PoolId -> User -> UserInfo
    mapping(uint256 => mapping(address => User)) public userInfo;

    // User -> Contract -> Permission
    mapping(address => mapping(address => bool)) public permission;

    // Check if the token has a pool
    mapping(address => bool) public hasPool;

    uint256 public totalAllocationPoints;

    // Time when the minting of INT starts
    uint256 public startBlock;

    /**************************** CONSTRUCTOR ****************************/

    constructor(
        InterestToken interestToken,
        StakedInterestToken stakedInterestToken,
        address _devAccount,
        uint256 _interestTokenPerBlock,
        uint256 _startBlock
    ) {
        // Setup initial state
        INTEREST_TOKEN = interestToken;
        STAKED_INTEREST_TOKEN = stakedInterestToken;
        devAccount = _devAccount;
        interestTokenPerBlock = _interestTokenPerBlock;
        startBlock = _startBlock;

        hasPool[address(interestToken)] = true;

        // Setup the first pool. Stake INT for INT
        pools.push(
            Pool({
                stakingToken: interestToken,
                allocationPoints: 1000,
                lastRewardBlock: _startBlock,
                accruedIntPerShare: 0,
                totalSupply: 0
            })
        );

        // Update the total points allocated
        totalAllocationPoints = 1000;
    }

    /**************************** MODIFIERS ****************************/

    modifier updatePools(bool update) {
        if (update) {
            updateAllPools();
        }
        _;
    }

    /**************************** MUTATIVE FUNCTIONS ****************************/

    /**
     * @dev This function updates the rewards for 1 pool and the dev rewards based on the current amount tokens
     * @param poolId The Id of the pool to be updated
     */
    function updatePool(uint256 poolId) public {
        // Save Gas
        Pool memory pool = pools[poolId];

        if (block.number <= pool.lastRewardBlock) return;

        uint256 amountOfStakedTokens = pool.totalSupply;

        // If no one is staking. Update the last time rewards were awarded (althrough its 0) and do nothing.
        if (amountOfStakedTokens == 0) {
            pools[poolId].lastRewardBlock = block.number;
            return;
        }

        uint256 blocksElapsed = block.number - pool.lastRewardBlock;

        uint256 intReward = (blocksElapsed *
            interestTokenPerBlock *
            pool.allocationPoints) / totalAllocationPoints;

        INTEREST_TOKEN.mint(devAccount, intReward / 10);

        pool.accruedIntPerShare =
            pool.accruedIntPerShare +
            ((intReward * 1e12) / amountOfStakedTokens);
        pool.lastRewardBlock = block.number;

        // Update global state
        pools[poolId] = pool;
    }

    /**
     * @dev This pool updates ALL pools. Care for the gas cost
     */
    function updateAllPools() public {
        uint256 length = pools.length;

        for (uint256 i = 0; i < length; i++) {
            updatePool(i);
        }
    }

    /**
     * @dev This function is used for all tokens other then {INTEREST_TOKEN}
     * @param poolId The id of the pool that the user wishes to make a deposit
     * @param amount the number of tokens the user wishes to deposit
     *
     * The user needs to approve the token he wishes to deposit first
     * This function can be called with amount 0 to only retrieve the rewards
     * Depositing always sends the rewards to the user to update the debt
     *
     */
    function deposit(uint256 poolId, uint256 amount) external {
        // Int has to be staked via the `staking` function
        require(poolId != 0, "CP: Not allowed");

        // Update all rewards before any operation for proper calculation of rewards
        updatePool(poolId);

        // Get global state in memory to save gas
        Pool memory pool = pools[poolId];
        User memory user = userInfo[poolId][_msgSender()];

        uint256 pendingRewards;

        // Check how many rewards to mint for the user
        if (user.amount > 0) {
            pendingRewards =
                ((user.amount * pool.accruedIntPerShare) / 1e12) -
                user.rewardsPaid;
        }

        if (amount > 0) {
            // Update user deposited amount
            user.amount += amount;
            // Update pool total supply
            pool.totalSupply += amount;

            // Get the tokens from the user first
            pool.stakingToken.safeTransferFrom(
                _msgSender(),
                address(this),
                amount
            );
        }

        // He has been paid all rewards up to this point
        user.rewardsPaid = (user.amount * pool.accruedIntPerShare) / 1e12;

        // Update global state
        pools[poolId] = pool;
        userInfo[poolId][_msgSender()] = user;

        if (pendingRewards > 0) {
            // Pay the user the rewards
            INTEREST_TOKEN.mint(_msgSender(), pendingRewards);
        }

        emit Deposit(_msgSender(), poolId, amount);
    }

    /**
     * @dev This function allows the user to withdraw his staked tokens
     * @param poolId the pool that `msg.sender` wishes to withdraw his funds from
     * @param amount Number of tokens the `msg.sender` wishes to withdraw
     *
     * This function a always gives the `msg.sender` his rewards if any
     * Can be called with an amount 0 to get rewards
     *
     */
    function withdraw(uint256 poolId, uint256 amount) external {
        // Int has to be staked via the `staking` function
        require(poolId != 0, "CP: Not allowed");

        // User cannot withdraw more than he staked
        require(
            userInfo[poolId][_msgSender()].amount >= amount,
            "CP: not enough tokens"
        );

        // Update the rewards to properly pay the user
        updatePool(poolId);

        // Get global state in memory to save gas
        Pool memory pool = pools[poolId];
        User memory user = userInfo[poolId][_msgSender()];

        // Save user rewards before any state manipulation
        uint256 pendingRewards = ((user.amount * pool.accruedIntPerShare) /
            1e12) - user.rewardsPaid;

        if (amount > 0) {
            user.amount -= amount;
            pool.totalSupply -= amount;
            pool.stakingToken.safeTransfer(_msgSender(), amount);
        }

        // Updte the amount of reward paid to the user
        user.rewardsPaid = (user.amount * pool.accruedIntPerShare) / 1e12;

        // Update global state
        pools[poolId] = pool;
        userInfo[poolId][_msgSender()] = user;

        if (pendingRewards > 0) {
            INTEREST_TOKEN.mint(_msgSender(), pendingRewards);
        }

        emit Withdraw(_msgSender(), poolId, amount);
    }

    /**
     * @dev This function should only be called for urgent situations. It will not calculate or give rewards. It will simply send the staked tokens
     * @param poolId the pool that the user wishes to completely exit
     */
    function emergencyWithdraw(uint256 poolId) external {
        // No need to save gas on an urgent function
        Pool storage pool = pools[poolId];
        User storage user = userInfo[poolId][_msgSender()];

        uint256 amount = user.amount;

        // Clean user history
        user.amount = 0;
        user.rewardsPaid = 0;

        pool.stakingToken.safeTransfer(_msgSender(), amount);

        emit EmergencyWithdraw(_msgSender(), poolId, amount);
    }

    /**************************** VIEW FUNCTIONS ****************************/

    /**
     * @dev This function returns the total number of pools in this contract
     * @return uint256 The total number of pools
     */
    function getPoolsLength() external view returns (uint256) {
        return pools.length;
    }

    /**
     * @dev This function will help the front end know how many rewards the user has in the pool at any given block
     * @param poolId The id of the pool we wish to find the rewards for `_user`
     * @param _user The address of the user we wish to find his/her rewards
     */
    function pendingInt(uint256 poolId, address _user)
        external
        view
        returns (uint256)
    {
        Pool memory pool = pools[poolId];
        User memory user = userInfo[poolId][_user];

        uint256 accruedIntPerShare = pool.accruedIntPerShare;
        uint256 numberOfTokenStaked = pool.stakingToken.balanceOf(
            address(this)
        );

        if (block.number > pool.lastRewardBlock && numberOfTokenStaked != 0) {
            uint256 blocksElaped = block.number - pool.lastRewardBlock;
            uint256 intReward = (blocksElaped *
                interestTokenPerBlock *
                pool.allocationPoints) / totalAllocationPoints;
            accruedIntPerShare =
                accruedIntPerShare +
                (intReward * 1e12) /
                numberOfTokenStaked;
        }
        return ((user.amount * accruedIntPerShare) / 1e12) - user.rewardsPaid;
    }

    /**
     * @dev This function allows the `msg.sender` to deposit {INTEREST_TOKEN} and start earning rewards. It also gives a receipt token {STAKED_INTEREST_TOKEN}. The receipt token will be needed to withdraw the tokens!
     * @param amount The number of {INTEREST_TOKEN} the `msg.sender` wishes to stake
     */
    function stake(uint256 amount) external {
        updatePool(0);

        Pool memory pool = pools[0];
        User memory user = userInfo[0][_msgSender()];

        uint256 pendingRewards;

        if (user.amount > 0) {
            pendingRewards =
                ((user.amount * pool.accruedIntPerShare) / 1e12) -
                user.rewardsPaid;
        }

        if (amount > 0) {
            user.amount += amount;
            pool.totalSupply += amount;
            // Get Int from the user
            IERC20(INTEREST_TOKEN).safeTransferFrom(
                _msgSender(),
                address(this),
                amount
            );

            // Give the user the receipt token
            STAKED_INTEREST_TOKEN.mint(_msgSender(), amount);
        }

        user.rewardsPaid = (user.amount * pool.accruedIntPerShare) / 1e12;

        if (pendingRewards > 0) {
            INTEREST_TOKEN.mint(_msgSender(), pendingRewards);
        }

        pools[0] = pool;
        userInfo[0][_msgSender()] = user;

        emit Deposit(_msgSender(), 0, amount);
    }

    /**
     * @dev This function needs to be called before `transfer` as it gives permission to transfer Int tokens
     * @param account The address that will have permission to move the funds. Beware this is very powerful as it gives acces to the entire funds of pool[0].
     */
    function givePermission(address account) external {
        require(account != address(0), "CP: zero address");
        permission[_msgSender()][account] = true;
    }

    /**
     * @dev This function can be called to revoke an `account` to have access to your funds after calling `givePermission`
     * @param account The address that will no longer have permission to move funds from ur pool[0]
     */
    function revokePermission(address account) external {
        require(account != address(0), "CP: zero address");
        permission[_msgSender()][account] = false;
    }

    /**
     * @dev This function is to allow composability with contracts that will accept sInt. It will allow them to call this function and make sure they can withdraw the Int in the future
     * @param from The account which will transfer his amount and rewardsPaid
     * @param to The account which will receieve the amount and rewardsPaid transferred
     * @param amount The amount of tokens the `from` wants to send to `to`
     */
    function transfer(
        address from,
        address to,
        uint256 amount
    ) external {
        if (_msgSender() != from) {
            // @dev Important to first call the `givePermission` function
            require(permission[from][_msgSender()], "CP: no permission");
        }

        require(userInfo[0][from].amount >= amount, "CP: not enough tokens");

        // Update the rewards to properly pay the user
        updatePool(0);

        User memory user = userInfo[0][from];
        User memory beneficiary = userInfo[0][to];

        uint256 rewardsPaid = (amount * pools[0].accruedIntPerShare) / 1e12;

        user.rewardsPaid -= rewardsPaid;
        user.amount -= amount;

        beneficiary.rewardsPaid += rewardsPaid;
        beneficiary.amount += amount;

        // Make sure the `to` address has enough `STAKED_INTEREST_TOKEN` to redeem `INTEREST_TOKEN` in the future.
        require(
            STAKED_INTEREST_TOKEN.balanceOf(to) >= beneficiary.amount,
            "CP: not enough tokens"
        );

        userInfo[0][from] = user;
        userInfo[0][to] = beneficiary;

        emit Transfer(from, to, amount);
    }

    function leaveStaking(uint256 amount) external {
        require(
            userInfo[0][_msgSender()].amount >= amount,
            "CP: not enough tokens"
        );

        updatePool(0);

        Pool memory pool = pools[0];
        User memory user = userInfo[0][_msgSender()];

        uint256 pendingRewards = ((user.amount * pool.accruedIntPerShare) /
            1e12) - user.rewardsPaid;

        if (amount > 0) {
            // `msg.sender` must have enough receipt tokens. As sINT totalSupply must always be equal to the `pool.totalSupply` of Int
            STAKED_INTEREST_TOKEN.burn(_msgSender(), amount);
            user.amount -= amount;
            pool.totalSupply -= amount;
            uint256 intBalance = IERC20(INTEREST_TOKEN).balanceOf(
                address(this)
            );
            IERC20(INTEREST_TOKEN).safeTransfer(
                _msgSender(),
                intBalance >= amount ? amount : intBalance
            );
        }

        // Update user reward. He has been  paid in full amount
        user.rewardsPaid = (user.amount * pool.accruedIntPerShare) / 1e12;

        pools[0] = pool;
        userInfo[0][_msgSender()] = user;

        if (pendingRewards > 0) {
            INTEREST_TOKEN.mint(_msgSender(), pendingRewards);
        }

        emit Withdraw(_msgSender(), 0, amount);
    }

    /**************************** PRIVATE FUNCTIONS ****************************/

    /**
     * @dev This function updates the allocation points of the INT staking pool based on the allocation of all other pools
     */
    function _updateStakingPool() private {
        uint256 _totalAllocationPoints = totalAllocationPoints;

        uint256 allOtherPoolsPoints = _totalAllocationPoints -
            pools[0].allocationPoints;

        // If we have other pools
        if (allOtherPoolsPoints != 0) {
            // This will be the new INT staking pool points
            allOtherPoolsPoints = allOtherPoolsPoints / 3;

            _totalAllocationPoints -= pools[0].allocationPoints;
            _totalAllocationPoints += allOtherPoolsPoints;

            totalAllocationPoints = _totalAllocationPoints;

            pools[0].allocationPoints = allOtherPoolsPoints;
        }
    }

    /**************************** ONLY OWNER FUNCTIONS ****************************/

    /**
     * @dev This function allows us to update the global minting of INT per Block
     * @param _interestTokenPerBlock how many Int tokens to be minted per Block
     * @param update Decide if we should update all pools in this call. Care for the gas cost
     *
     * This function has two modifiers:
     * The first is to allow only the owner to call it for obvious reasons
     * The second is to run the logic to update the pools
     *
     */
    function setIntPerBlock(uint256 _interestTokenPerBlock, bool update)
        external
        onlyOwner
        updatePools(update)
    {
        interestTokenPerBlock = _interestTokenPerBlock;
    }

    /**
     * @dev This function adds a new pool. At the end this function updates the INT staking pool allocation points.
     * @param allocationPoints How many INT tokens should this pool get related to the whole allocation
     * @param token The address of the staking token the pool will accept
     * @param update If the caller wishes to update all pools
     *
     * This function has two modifiers:
     * The first is to allow only the owner to prevent unwanted pools and temperig with allocation points
     * The second is to run the logic to update the pools
     *
     */
    function addPool(
        uint256 allocationPoints,
        IERC20 token,
        bool update
    ) external onlyOwner updatePools(update) {
        // Prevent the owner from adding the same token twice, which will cause a rewards problem
        require(!hasPool[address(token)], "CP: poola already added");
        // If the pool is added before the start block. The last rewardBlock is the startBlock
        uint256 lastRewardBlock = block.number > startBlock
            ? block.number
            : startBlock;

        hasPool[address(token)] = true;

        // Update the allocation points
        totalAllocationPoints += allocationPoints;

        // Add the pool
        pools.push(
            Pool({
                stakingToken: token,
                allocationPoints: allocationPoints,
                lastRewardBlock: lastRewardBlock,
                accruedIntPerShare: 0,
                totalSupply: 0
            })
        );

        _updateStakingPool();
    }

    /**
     * @dev This function updates the allocation points of a pool. At the end this function updates the INT staking pool allocation points.
     * @param poolId The index of the pool to be updated
     * @param allocationPoints The new value for the allocation points for the pool with id `poolId`
     * @param update Option to update all pools
     *
     * This function is protected by the modifier {onlyOwner}
     * The modifier {updatePools} is to run the logic to update all pools
     *
     */
    function setAllocationPoints(
        uint256 poolId,
        uint256 allocationPoints,
        bool update
    ) external onlyOwner updatePools(update) {
        uint256 prevAllocationPoints = pools[poolId].allocationPoints;

        // No need to update if they are the same
        if (prevAllocationPoints == allocationPoints) return;

        // Update the allocation points
        pools[poolId].allocationPoints = allocationPoints;

        uint256 _totalAllocationPoints = totalAllocationPoints;

        _totalAllocationPoints -= prevAllocationPoints;
        _totalAllocationPoints += allocationPoints;

        totalAllocationPoints = _totalAllocationPoints;

        _updateStakingPool();
    }

    /**
     * @dev Only the current dev can update this account. The devAccount can be different than the owner, which maintains the masterChef
     * @param account the new account for the dev
     */
    function setDevAccount(address account) external {
        require(_msgSender() == devAccount, "CP: only the dev");
        devAccount = account;
    }
}
