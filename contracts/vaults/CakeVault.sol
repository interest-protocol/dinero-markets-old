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
 * @dev This vault is designed to work with PCS {MasterChef} contract, 0x73feaa1eE314F8c655E354234017bE2193C9E24E, pool id 0.
 * The pool 0 is designed to stake the {CakeToken}, 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82.
 *
 * @notice This contract is meant to work in conjunction with the {InterestMarketV1} to stake the collateral users provide when opening loans.
 * @notice This contract inherits the {Vault} contract and overrides the {_withdraw} and {_deposit} functions.
 * @notice We use the Open Zeppelin {SafeERC20} to interact with the Cake token, which follows the {IERC20} interface.
 * @notice The pool id 0, accepts {CAKE} and rewards {CAKE}.
 */
contract CakeVault is Vault {
    /*///////////////////////////////////////////////////////////////
                                 LIBRARIES
    //////////////////////////////////////////////////////////////*/

    using SafeERC20 for IERC20;

    /*///////////////////////////////////////////////////////////////
                                 CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @param cakeMasterChef the address of the cake {MasterChef}
     * @param cake the address of the {CakeToken}
     */
    constructor(IMasterChef cakeMasterChef, IERC20 cake)
        Vault(cakeMasterChef, cake)
    {
        // Master chef needs full approval for us to deposit tokens on it.
        cake.safeApprove(address(cakeMasterChef), type(uint256).max);
    }

    /*///////////////////////////////////////////////////////////////
                                VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev It returns the total amount of pending {CakeToken} rewards in the CAKE pool, which is always id 0.
     *
     * @return The number of `CAKE` the contract has as rewards in the pool
     */
    function getPendingRewards() public view override(Vault) returns (uint256) {
        return CAKE_MASTER_CHEF.pendingCake(0, address(this));
    }

    /*///////////////////////////////////////////////////////////////
                                MUTATIVE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev It gives maximum allowance to {CAKE_MASTER_CHEF} for {CAKE}.
     *
     * @notice Front-running is not an issue as we trust {CAKE_MASTER_CHEF}. It is an non-upgradeable contract.
     */
    function approve() external {
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
        uint256 cakeRewards;

        uint256 _totalRewardsPerAmount = totalRewardsPerAmount;
        uint256 _totalAmount = totalAmount;

        // Get rewards from the `CAKE` pool. We do not update the {_totalRewardsPerAmount} here because we need to first deduct the feee.
        cakeRewards += _unStakeCake(0);

        // Calculate the compounding fee to sent to the `msg.sender`. It has a base unit of 1e6, which makes it 2%.
        uint256 fee = (cakeRewards * 2e4) / 1e6;

        // update the {_totalRewardsPerAmount} without the fee
        _totalRewardsPerAmount += ((cakeRewards - fee) * 1e12) / _totalAmount;

        // Pay the `msg.sender`
        CAKE.safeTransfer(_msgSender(), fee);

        // Compound the rewards. We already got all the rewards up to this block. So the {CAKE} pool rewards should be 0.
        // Therefore, we do not need to update the {_totalRewardsPerAmount}.
        CAKE_MASTER_CHEF.enterStaking(_getCakeBalance());

        // Update global state.
        totalRewardsPerAmount = _totalRewardsPerAmount;

        emit Compound(cakeRewards - fee, fee, block.number);
    }

    /*///////////////////////////////////////////////////////////////
                            INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev The objective of this function is to deposit the {CAKE} from an `from` to the {CAKE_MASTER_CHEF} and correctly calculate it's rewards and deposit.
     * It uses the {IERC20} {transferFrom} function to take the {CAKE} token from the `from`.
     * It assigns the deposit to the `to` address.
     *
     * @notice It assumes the `from` has given enough approval to this contract.
     * @notice The variable {_totalRewardsPerAmount} has a base unit of 1e12.
     * @notice This function does not send the current rewards accrued to the `to`.
     *
     * @param from The address that will {transferFrom} {CAKE} tokens.
     * @param to The address that will get the deposit assigned to.
     * @param amount The number of {CAKE} tokens the `account` wishes to deposit.
     */
    function _deposit(
        address from,
        address to,
        uint256 amount
    ) internal override(Vault) {
        // Save the storage state in memory to save gas.
        User memory user = userInfo[to];
        uint256 _totalAmount = totalAmount;
        uint256 _totalRewardsPerAmount = totalRewardsPerAmount;

        // If there are no tokens deposited in the vault, We do not need to update the {_totalRewardsPerAmount}. As there are no rewards to be updated.
        if (_totalAmount > 0) {
            // Reinvest all cake into the CAKE pool and get the current rewards.
            _totalRewardsPerAmount += (_stakeCake() * 1e12) / _totalAmount;
        }

        // If the user has no deposited tokens, we do not need to update his rewards.
        if (user.amount > 0) {
            // Update how many rewards the user has accrued up to this point.
            user.rewards +=
                ((_totalRewardsPerAmount * user.amount) / 1e12) -
                user.rewardDebt;
        }

        // Update State.
        _totalAmount += amount;
        user.amount += amount;

        // Get Tokens from `account`.
        CAKE.safeTransferFrom(from, address(this), amount);

        // Deposit the new acquired {CAKE} tokens, plus any pending rewards  in the {CAKE} pool.
        // Since we already got the rewards up to this block. We do not need to update the {_totalRewardsPerAmount}, because the pool is empty.
        CAKE_MASTER_CHEF.enterStaking(_getCakeBalance());

        // Update State to tell us that the `account` has been completed "paid" up to this point.
        user.rewardDebt = (_totalRewardsPerAmount * user.amount) / 1e12;

        // Update Global state
        userInfo[to] = user;
        totalAmount = _totalAmount;
        totalRewardsPerAmount = _totalRewardsPerAmount;

        emit Deposit(from, to, amount);
    }

    /**
     * @dev The objective of this function is to allow the `from` to withdraw some of his previously deposited tokens from the {CAKE_MASTER_CHEF}.
     *
     * @notice The base unit for {totalRewardsPerAmount} is 1e12.
     * @notice The {user.rewards} is sent to the `from` and not the `recipient`.
     * @notice The Cake rewards always go to the `to` address.
     * During liquidations, the rewards will go to the `from` that opened the loan, but some of the deposited
     * tokens will go to the liquidator or the {InterestMarketV1} contract.
     *
     * @param from The account that has deposited {CAKE} in the {_deposit} function.
     * @param to the account which will get the rewards accrued by the deposit from `from`.
     * @param amount The number of {CAKE} tokens to withdraw.
     *
     * Requirements:
     *
     * - `from` must have enough tokens in the `user.amount` to withdraw the desited `amount`.
     *
     */
    function _withdraw(
        address from,
        address to,
        uint256 amount
    ) internal override(Vault) {
        User memory user = userInfo[from];

        // It is impossible to withdraw more than what the `account` owns.
        require(user.amount >= amount, "Vault: not enough tokens");

        // Save global state in memory to save gas.
        uint256 _totalAmount = totalAmount;
        uint256 _totalRewardsPerAmount = totalRewardsPerAmount;

        // Collect the current rewards from {CAKE} pool to properly calculate rewards.
        // And withdraw the requested amount of {CAKE} from the pool.
        // The {Vault} contract ensures that the `amount` is greater than 0.
        // It also ensured that the {totalAmount} is greater than 0.
        _totalRewardsPerAmount += (_unStakeCake(amount) * 1e12) / _totalAmount;

        // Calculate how many rewards the `account` has acrrued up to this block.
        uint256 rewards = ((_totalRewardsPerAmount * user.amount) / 1e12) -
            user.rewardDebt;

        // Update the state.
        _totalAmount -= amount;
        user.amount -= amount;

        // Add all rewards the user has accrued since his first deposit.
        rewards += user.rewards;

        // Reset the `account` rewards to 0, because we are ready to send all rewards to the `recipient`.
        user.rewards = 0;

        uint256 cakeBalance = _getCakeBalance();
        uint256 amountToRecipient = amount + rewards;

        // In case the `account` has accrued more rewards than what the vault has at the moment. We need to withdraw more {CAKE} from the pool.
        if (amountToRecipient > cakeBalance) {
            // Already took the rewards up to this block.
            // Withdraw more tokens to be able to fully pay the rewards.
            CAKE_MASTER_CHEF.leaveStaking(amountToRecipient - cakeBalance);
        }

        // If the `recipient` is also the `account` we only do one {transfer} call to save gas.
        // This happens when the user is removing collateral from the {InterestMarketV1}.
        if (to == from) {
            CAKE.safeTransfer(to, rewards + amount);
        } else {
            CAKE.safeTransfer(to, amount);
            CAKE.safeTransfer(from, rewards);
        }

        // Only restake if there is at least 1 {CAKE} in the contract after sending the rewards and `amount`.
        if (_totalAmount > 0 && _getCakeBalance() >= 1 ether) {
            // We already took the rewards up to this block.
            CAKE_MASTER_CHEF.enterStaking(_getCakeBalance());
        }

        if (_totalAmount > 0) {
            // If the Vault still has assets update the state as usual
            totalRewardsPerAmount = _totalRewardsPerAmount;
            user.rewardDebt = (_totalRewardsPerAmount * user.amount) / 1e12;
            totalAmount = _totalAmount;
        } else {
            // If the Vault does not have any {CAKE}, reset the whole state.
            totalAmount = 0;
            totalRewardsPerAmount = 0;
            user.rewardDebt = 0;
            user.amount = 0;
        }

        // Update the `from` global information.
        userInfo[from] = user;

        emit Withdraw(from, to, amount);
    }
}
