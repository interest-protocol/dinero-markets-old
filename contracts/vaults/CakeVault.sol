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

contract CakeVault is Vault {
    /**************************** LIBRARIES ****************************/

    using SafeERC20 for IERC20;

    /**************************** CONSTRUCTOR ****************************/

    constructor(
        IMasterChef cakeMasterChef,
        IERC20 cake,
        address market
    ) Vault(cakeMasterChef, cake, market) {
        // Master chef needs full approval. {safeApprove} is fine to be used for the initial allowance
        cake.safeApprove(address(cakeMasterChef), type(uint256).max);
    }

    /**************************** VIEW FUNCTIONS ****************************/
    /**
     * It checks the pending `CAKE` in the CAKE pool which is always Id 0
     * @return The number of `CAKE` the contract has as rewards in the pool
     */
    function getPendingRewards() public view override(Vault) returns (uint256) {
        return CAKE_MASTER_CHEF.pendingCake(0, address(this));
    }

    /**************************** MUTATIVE FUNCTIONS ****************************/

    /**
     * This function gives the `CAKE_MASTER_CHEF` maximum approval of the underlying token and the `CAKE` token
     * @param amount How many more units of `CAKE` the `CAKE_MASTER_CHEF` will have access to
     */
    function approve(uint256 amount) external {
        CAKE.safeIncreaseAllowance(address(CAKE_MASTER_CHEF), amount);
    }

    /**
     * This function compounds the `CAKE` rewards in the farm to the `CAKE` pool and pays the caller a small fee as reward
     */
    function compound() external {
        uint256 cakeRewards;

        uint256 _totalRewardsPerAmount = totalRewardsPerAmount;
        uint256 _totalAmount = totalAmount;

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

    /**************************** INTERNAL OVERRIDE FUNCTIONS ****************************/

    /**
     * This function takes `STAKING_TOKEN` from the `msg.sender` and puts it in the `CAKE_MASTER_CHEF`
     * This function will update the global state and recalculate the `totalAmount`, `totalRewards` and `userInfo` accordingly
     * This function does not send the current rewards accrued to the user
     * @param account The account that is depositing `STAKING_TOKEN`
     * @param amount The number of `STAKING_TOKEN` that he/she wishes to deposit
     */
    function _deposit(address account, uint256 amount)
        internal
        override(Vault)
    {
        User memory user = userInfo[account];
        uint256 _totalAmount = totalAmount;
        uint256 _totalRewardsPerAmount = totalRewardsPerAmount;

        // If there are no tokens deposited, we do not need to run these operations
        if (_totalAmount > 0) {
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
        CAKE.safeTransferFrom(account, address(this), amount);

        // Deposit the new acquired tokens + any rewards  in the `CAKE` pool
        // Since we already got the rewards in this block. There should be no rewards right now to harvest.
        CAKE_MASTER_CHEF.enterStaking(_getCakeBalance());

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
    ) internal override(Vault) {
        User memory user = userInfo[account];

        require(user.amount >= amount, "Vault: not enough tokens");

        uint256 _totalAmount = totalAmount;
        uint256 _totalRewardsPerAmount = totalRewardsPerAmount;

        // Collect the current rewards in the `CAKE` pool to properly calculate rewards
        // And withdraw the amount of `CAKE` from the pool
        _totalRewardsPerAmount += (_unStakeCake(amount) * 1e12) / _totalAmount;

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
        uint256 amountToRecipient = amount + rewards;

        if (amountToRecipient > cakeBalance) {
            // Already took the rewards up to this block. So the poo should be empty
            CAKE_MASTER_CHEF.leaveStaking(amountToRecipient - cakeBalance);
        }

        // Send the underlying token to the recipient
        CAKE.safeTransfer(recipient, amount);
        CAKE.safeTransfer(account, rewards);

        // Only restake if there is at least 1 `CAKE` in the contract after sending the rewards
        // If there are no `STAKING TOKENS` left, we do not need to restake
        if (_totalAmount > 0 && _getCakeBalance() >= 1 ether) {
            // Already took the rewards up to this block. So the poo should be empty
            CAKE_MASTER_CHEF.enterStaking(_getCakeBalance());
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

        emit Withdraw(account, recipient, amount);
    }
}
