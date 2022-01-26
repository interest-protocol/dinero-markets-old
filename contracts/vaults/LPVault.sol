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

import "./Vault.sol";

/**
 * @dev This vault is designed to work with PCS {MasterChef} contract, 0x73feaa1eE314F8c655E354234017bE2193C9E24E, PancakePairs pools.
 *
 * @notice the PancakePairs have 18 decimals, which is vital to work with the {ORACLE} in the {VAULT}.
 * An example of a {PancakePair} contract can be found here: 0xA527a61703D82139F8a06Bc30097cC9CAA2df5A6
 * @notice We can not use the pool id 0 and the burn pool as they are not for Pancake Pairs.
 * @notice This contract is meant to work in conjunction with the {InterestMarketV1} to stake the collateral users provide when opening loans.
 * @notice This contract inherits the {Vault} contract and overrides the {_withdraw} and {_deposit} functions.
 * @notice We use the Open Zeppelin {SafeERC20} to interact with the {CAKE} token and the {PancakePair} tokens, which follow the {IERC20} interface.
 */
contract LPVault is Vault {
    /*///////////////////////////////////////////////////////////////
                                 LIBRARIES
    //////////////////////////////////////////////////////////////*/

    using SafeERC20 for IERC20;

    /*///////////////////////////////////////////////////////////////
                                 CONSTANTS
    //////////////////////////////////////////////////////////////*/

    // solhint-disable-next-line
    IERC20 public immutable STAKING_TOKEN; // The current {PancakePair} token being farmed.

    // solhint-disable-next-line var-name-mixedcase
    uint256 public immutable POOL_ID; // The current master chef farm being used.

    /*///////////////////////////////////////////////////////////////
                                CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev We need to approve the {CAKE_MASTER_CHEF} to have full access to the {CAKE} and {STAKING_TOKEN} (PancakePair) tokens.
     *
     * @param cakeMasterChef The address of the PancakeSwap master chef.
     * @param cake The address of the {CAKE} token.
     * @param stakingToken The address of the {PancakePair} token.
     * @param poolId The id of the {PancakePair} token in the {CAKE_MASTER_CHEF}.
     */
    constructor(
        IMasterChef cakeMasterChef,
        IERC20 cake,
        IERC20 stakingToken,
        uint256 poolId
    ) Vault(cakeMasterChef, cake) {
        require(poolId != 0, "LPVault: this is a LP vault");
        STAKING_TOKEN = stakingToken;
        POOL_ID = poolId;
        stakingToken.safeApprove(address(cakeMasterChef), type(uint256).max);
        cake.safeApprove(address(cakeMasterChef), type(uint256).max);
    }

    /*///////////////////////////////////////////////////////////////
                                VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev It returns the pending {CAKE} rewards in the {CAKE_MASTER_CHEF} for the {CAKE} pool, the id 0, and the {STAKING_TOKEN} pool.
     *
     * @return The number of {CAKE} this contract has accrued as rewards in the {CAKE_MASTER_CHEF}.
     */
    function getPendingRewards() public view override(Vault) returns (uint256) {
        return
            CAKE_MASTER_CHEF.pendingCake(POOL_ID, address(this)) +
            CAKE_MASTER_CHEF.pendingCake(0, address(this));
    }

    /*///////////////////////////////////////////////////////////////
                                MUTATIVE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev It gives maximum allowance to {CAKE_MASTER_CHEF} for {CAKE} and the {STAKING_TOKEN}.
     *
     * @notice Front-running is not an issue as we trust {CAKE_MASTER_CHEF}. It is an non-upgradeable contract.
     */
    function approve() external {
        STAKING_TOKEN.safeIncreaseAllowance(
            address(CAKE_MASTER_CHEF),
            type(uint256).max -
                STAKING_TOKEN.allowance(
                    address(this),
                    address(CAKE_MASTER_CHEF)
                )
        );
        CAKE.safeIncreaseAllowance(
            address(CAKE_MASTER_CHEF),
            type(uint256).max -
                CAKE.allowance(address(this), address(CAKE_MASTER_CHEF))
        );
    }

    /**
     * @dev This function compounds the {CAKE} rewards in the pool id 0 and rewards the caller with 2% of the pending rewards.
     *
     * @notice The compounding fee base unit is 1e6.
     * @notice The {totalRewardsPerAmount} has a base unit of 1e12.
     */
    function compound() external {
        // Variable to keep track of the {CAKE} rewards we will get by depositing and unstaking.
        uint256 cakeRewards;

        // Save storage state in memory to save gas.
        uint256 _totalRewardsPerAmount = totalRewardsPerAmount;
        uint256 _totalAmount = totalAmount;

        // Get rewards from the {STAKING_TOKEN} pool.
        cakeRewards += _depositFarm(0);
        // Get rewards from the {CAKE} pool.
        cakeRewards += _unStakeCake(0);

        // Calculate the fee to reward the `msg.sender`.
        // The fee amounts to 2% of all the rewards harvested in this block.
        uint256 fee = (cakeRewards * 2e4) / 1e6;

        // Update the state
        _totalRewardsPerAmount += ((cakeRewards - fee) * 1e12) / _totalAmount;

        // Pay the `msg.sender` the fee.
        CAKE.safeTransfer(_msgSender(), fee);

        // Compound the remaining rewards in the {CAKE} pool.
        // We already got the rewards up to this block. So the {CAKE} pool rewards should be 0.
        // Therefore, we do not need to update the {_totalRewardsPerAmount} variable.
        CAKE_MASTER_CHEF.enterStaking(_getCakeBalance());

        // Update global state
        totalRewardsPerAmount = _totalRewardsPerAmount;

        emit Compound(cakeRewards - fee, fee, block.number);
    }

    /*///////////////////////////////////////////////////////////////
                                PRIVATE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev It withdraws an `amount` of {STAKING_TOKEN} from the pool. And it keeps track of the rewards obtained by using the {_getBalance} function.
     *
     * @param amount The number of {STAKING_TOKEN} to be withdrawn from the {CAKE_MASTER_CHEF}.
     * @return cakeHarvested It returns how many {CAKE} we got as reward.
     */
    function _withdrawFarm(uint256 amount)
        private
        returns (uint256 cakeHarvested)
    {
        // Save the current {CAKE} balance before calling the withdraw function because it will give us rewards.
        uint256 preBalance = _getCakeBalance();
        CAKE_MASTER_CHEF.withdraw(POOL_ID, amount);
        // The difference between the previous {CAKE} balance and the current balance is the rewards obtained via the withdraw function.
        cakeHarvested = _getCakeBalance() - preBalance;
    }

    /**
     * @dev This function deposits {STAKING_TOKEN} in the pool and calculates/returns the rewards obtained via the deposit function.
     *
     * @param amount The number of {STAKING_TOKEN} to deposit in the {CAKE_MASTER_CHEF}.
     * @return cakeHarvested It returns how many {CAKE} we got as reward from the depsit function.
     */
    function _depositFarm(uint256 amount)
        private
        returns (uint256 cakeHarvested)
    {
        // Need to save the {balanceOf} {CAKE} before the deposit function to calculate the rewards.
        uint256 preBalance = _getCakeBalance();
        CAKE_MASTER_CHEF.deposit(POOL_ID, amount);
        // Find how much cake we earned after depositing as the deposit functions always {transfer} the pending {CAKE} rewards.
        cakeHarvested = _getCakeBalance() - preBalance;
    }

    /*///////////////////////////////////////////////////////////////
                        INTERNAL OVERRIDE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev We update the rewards for all users with the {_totalRewardsPerAccount} variable.
     * Then we use the {transferFrom} function to get the {STAKING_TOKEN} from the `from`.
     * We keep track of the amounts and rewards and deposit the acquired {STAKING_TOKEN} in the {CAKE_MASTER_CHEF}.
     * We also compound any {CAKE} tokens in this contract int he {CAKE} pool.
     * It assigns the deposit to the `to` account for composability.
     *
     * @notice It assumes the `from` has given enough approval to this contract.
     * @notice The variable {_totalRewardsPerAmount} has a base unit of 1e12.
     * @notice This function does not send the current rewards accrued to the `to`.
     *
     * @param from The address that needs to have {STAKING_TOKEN} and provide approval.
     * @param to The address, which the deposit will be assigned to
     * @param amount The number of {STAKING_TOKEN} that the `from` wishes to deposit.
     */
    function _deposit(
        address from,
        address to,
        uint256 amount
    ) internal override(Vault) {
        // Save storage state in memory to save gas.
        User memory user = userInfo[to];
        uint256 _totalAmount = totalAmount;
        uint256 _totalRewardsPerAmount = totalRewardsPerAmount;

        // If there are no tokens deposited, we do not have to update the current rewards.
        if (_totalAmount > 0) {
            // Get rewards currently in the {STAKING_TOKEN} pool.
            _totalRewardsPerAmount += (_depositFarm(0) * 1e12) / _totalAmount;
            // Reinvest all {CAKE} rewards into the CAKE pool.
            // The functions on this block send pending {CAKE} to this contract. Therefore, we need to update the {_totalRewardsPerAccount}.
            _totalRewardsPerAmount += (_stakeCake() * 1e12) / _totalAmount;
        }

        // We do not need to calculate rewards if the user has no open deposits in this contract.
        if (user.amount > 0) {
            // Calculate and add how many rewards the user accrued.
            user.rewards +=
                ((_totalRewardsPerAmount * user.amount) / 1e12) -
                user.rewardDebt;
        }

        // Update State
        _totalAmount += amount;
        user.amount += amount;

        // Get {STAKING_TOKEN} from `account`.
        // This is to save gas. `account` has to approve this vault and not the market.
        STAKING_TOKEN.safeTransferFrom(from, address(this), amount);

        // Deposit the new acquired tokens in the pool.
        // Since we already got the rewards up to this block. There should be no rewards right now to harvest.
        // Therefore, we do not need to update the {_totalRewardsPerAmount}.
        CAKE_MASTER_CHEF.deposit(POOL_ID, amount);
        // Compound the rewards. Deposit any current {CAKE} in the cake pool.
        CAKE_MASTER_CHEF.enterStaking(_getCakeBalance());

        // Update State to tell us that user has been completed paid up to this point.
        user.rewardDebt = (_totalRewardsPerAmount * user.amount) / 1e12;

        // Update Global state
        userInfo[to] = user;
        totalAmount = _totalAmount;
        totalRewardsPerAmount = _totalRewardsPerAmount;

        emit Deposit(from, to, amount);
    }

    /**
     * @dev We withdraw an `amount` of tokens from the `from` stored in the {CAKE_MASTER_CHEF}.
     *
     * @notice The base unit for {totalRewardsPerAmount} is 1e12.
     * @notice The {user.rewards} is sent to the `from` and not the `to`.
     * During liquidations, the rewards will go to the `from` that opened the loan, but some of the deposited
     * tokens will go to the liquidator or the {InterestMarketV1} contract.
     *
     * @param from The address that we are withdrawing the {STAKING_TOKEN} from.
     * @param to the address which will get the {STAKING_TOKEN}.
     * @param amount The number of {STAKING_TOKEN} that will be withdrawn from the `from`.
     *
     * Requirements:
     *
     * - `account` must have enough tokens in the `user.amount` to withdraw the desited `amount`.
     *
     */
    function _withdraw(
        address from,
        address to,
        uint256 amount
    ) internal override(Vault) {
        User memory user = userInfo[from];

        // Illogical to allow `amount` to be higher than the amount the `account` has deposited in the contract.
        require(user.amount >= amount, "Vault: not enough tokens");

        // Save storage state in memory to save gas.
        uint256 _totalAmount = totalAmount;
        uint256 _totalRewardsPerAmount = totalRewardsPerAmount;

        // The {Vault} contract ensures that the `amount` is greater than 0.
        // It also ensured that the {totalAmount} is greater than 0.
        // We withdraw from the {CAKE_MASTER_CHEF} the desired `amount`.
        _totalRewardsPerAmount += (_withdrawFarm(amount) * 1e12) / _totalAmount;
        // Collect the current rewards in the {CAKE} pool to properly update {_totalRewardsPerAmount}.
        _totalRewardsPerAmount += (_unStakeCake(0) * 1e12) / _totalAmount;

        // Calculate how many rewards the user is entitled before this deposit
        uint256 rewards = ((_totalRewardsPerAmount * user.amount) / 1e12) -
            user.rewardDebt;

        // Update the state
        _totalAmount -= amount;
        user.amount -= amount;

        // Add all accrued rewards. As this contract only sends the rewards on withdraw.
        rewards += user.rewards;

        // Set rewards to 0
        user.rewards = 0;

        // Get the current {CAKE} balance to make sure we have enough to cover the {CAKE} the rewards.
        uint256 cakeBalance = _getCakeBalance();

        if (cakeBalance < rewards) {
            // Already took the rewards up to this block. So we do not need to update the {_totalRewardsPerAmount}.
            CAKE_MASTER_CHEF.leaveStaking(rewards - cakeBalance);
        }

        // Send the rewards to the `from`.
        CAKE.safeTransfer(from, rewards);

        // Only restake if there is at least 1 {CAKE} in the contract after sending the rewards.
        // If there are no {STAKING TOKENS} left, we do not need to restake. Because it means the vault is empty.
        if (_totalAmount > 0 && _getCakeBalance() >= 1 ether) {
            // Already took the rewards up to this block. So we do not need to update the {_totalRewardsPerAmount}.
            CAKE_MASTER_CHEF.enterStaking(_getCakeBalance());
        }

        // If the Vault still has assets, we need to update the global  state as usual.
        if (_totalAmount > 0) {
            // Reset totalRewardsPerAmount if the pool is totally empty
            totalRewardsPerAmount = _totalRewardsPerAmount;
            user.rewardDebt = (_totalRewardsPerAmount * user.amount) / 1e12;
            totalAmount = _totalAmount;
        } else {
            // If the Vault does not have any {STAKING_TOKEN}, reset the global state.
            totalAmount = 0;
            totalRewardsPerAmount = 0;
            user.rewardDebt = 0;
            user.amount = 0;
        }

        // We always need to update the `from` info.
        userInfo[from] = user;

        // Send the underlying token to the recipient
        STAKING_TOKEN.safeTransfer(to, amount);

        emit Withdraw(from, to, amount);
    }
}
