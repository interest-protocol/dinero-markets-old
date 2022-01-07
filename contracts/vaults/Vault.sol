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
import "@openzeppelin/contracts/utils/Context.sol";

import "../interfaces/IMasterChef.sol";
import "../interfaces/IVault.sol";

contract Vault is IVault, Context {
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

    // solhint-disable-next-line var-name-mixedcase
    address public immutable MARKET; // The market contract that deposits/withdraws from this contract

    /**************************** STATE ****************************/

    mapping(address => User) public userInfo; // Account Address => Account Info

    uint256 public totalAmount; // total amount of staking token in the contract

    uint256 public totalRewardsPerAmount; // is boosted by 1e12

    /**************************** CONSTRUCTOR ****************************/

    constructor(
        IMasterChef cakeMasterChef,
        IERC20 cake,
        address market
    ) {
        CAKE_MASTER_CHEF = cakeMasterChef;
        CAKE = cake;
        MARKET = market;
    }

    /**************************** MODIFIER ****************************/

    // Make sure that only the Market has access to certain functionality
    modifier onlyMarket() {
        require(_msgSender() == MARKET, "Vault: only market");
        _;
    }

    /**************************** PRIVATE FUNCTIONS ****************************/

    /**
     * A helper function to get the current `CAKE` balance in this vault
     */
    function _getCakeBalance() internal view returns (uint256) {
        return CAKE.balanceOf(address(this));
    }

    /**
     * The logic for this function is to be implemented by the child contract
     */
    //solhint-disable-next-line no-empty-blocks
    function _deposit(address, uint256) internal virtual {}

    /**
     * This function is to be implemented by the child contract
     */
    function _withdraw(
        address,
        address,
        uint256 //solhint-disable-next-line no-empty-blocks
    ) internal virtual {}

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
