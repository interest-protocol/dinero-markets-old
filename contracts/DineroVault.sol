//SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import "./tokens/Dinero.sol";

import "./lib/IntERC20.sol";

/**
 * @dev This vault simply accepts stable coins and mints them Dinero and 1:1 ratio.
 *
 * @notice Users with DAI/USDT/BUSD/USDC on BSC can easily mint Dinero leaving their coins as back up. They can get their deposit back by returning the minted dinero.
 */
contract DineroVault is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    /*///////////////////////////////////////////////////////////////
                            LIBRARIES
    //////////////////////////////////////////////////////////////*/

    using SafeERC20Upgradeable for IERC20Upgradeable;
    using IntERC20 for address;

    /*///////////////////////////////////////////////////////////////
                            EVENTS
    //////////////////////////////////////////////////////////////*/

    event Deposit(
        address indexed account,
        address indexed underlying,
        uint256 underlyingAmount,
        uint256 dineroMinted
    );

    event Withdraw(
        address indexed account,
        address indexed underlying,
        uint256 underlyingAmount,
        uint256 dineroMinted
    );

    event AddUnderlying(address indexed underlying);

    event RemoveUnderlying(address indexed underlying);

    /*///////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    //solhint-disable-next-line var-name-mixedcase
    Dinero public DINERO; // 18 decimals

    // UNDERLYING -> USER -> UserAccount
    mapping(address => mapping(address => uint256)) public balanceOf;

    mapping(address => bool) public isUnderlyingSupported;

    /*///////////////////////////////////////////////////////////////
                            INITIALIZER
    //////////////////////////////////////////////////////////////*/

    /**
     * @param dinero The contract of the dinero stable coin
     *
     * Requirements:
     *
     * - Can only be called at once and should be called during creation to prevent front running.
     */
    function initialize(Dinero dinero) external initializer {
        __Ownable_init();

        DINERO = dinero;
    }

    /*///////////////////////////////////////////////////////////////
                            MODIFIER
    //////////////////////////////////////////////////////////////*/

    modifier isWhitelisted(address underlying) {
        require(isUnderlyingSupported[underlying], "DV: not supported");
        _;
    }

    /*///////////////////////////////////////////////////////////////
                            MUTATIVE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev It allows an address to deposit an underlying to get Dinero at 1:1 ratio.
     *
     * @param underlying The stable coin the `msg.sender` wishes to deposit
     * @param amount The number of `underlying` tokens the `msg.sender` wishes to deposit
     *
     * Requirements:
     *
     * - `amount` needs to be greater than 0, otherwise the `msg.sender` will just waste gas.
     */
    function deposit(address underlying, uint256 amount)
        external
        isWhitelisted(underlying)
    {
        require(amount > 0, "DV: no amount 0");
        // Get the deposit from the user
        IERC20Upgradeable(underlying).safeTransferFrom(
            _msgSender(),
            address(this),
            amount
        );

        // Update amount after getting the deposit
        balanceOf[underlying][_msgSender()] += amount;

        uint256 dineroAmount = _scaleDecimals(
            amount,
            underlying.safeDecimals()
        );

        // Mint Dinero to `msg.sender`
        DINERO.mint(_msgSender(), dineroAmount);

        emit Deposit(_msgSender(), underlying, amount, dineroAmount);
    }

    /**
     * @dev It allows an address to withdraw his deposited `underlying` but returning the Dinero minted.
     *
     * @param underlying The stable coin the `msg.sender` wishes to withdraw
     * @param amount The number of `underlying` tokens the `msg.sender` wishes to withdraw
     *
     * Requirements:
     *
     * - `amount` needs to be greater than 0, otherwise the `msg.sender` will just waste gas.
     */
    function withdraw(address underlying, uint256 amount)
        external
        isWhitelisted(underlying)
    {
        require(amount > 0, "DV: no amount 0");
        // Update support after getting the deposit
        balanceOf[underlying][_msgSender()] -= amount;

        uint256 dineroAmount = _scaleDecimals(
            amount,
            underlying.safeDecimals()
        );

        // Burn the dinero back
        DINERO.burn(_msgSender(), dineroAmount);

        // Return the amount to the user
        IERC20Upgradeable(underlying).safeTransfer(_msgSender(), amount);

        emit Withdraw(_msgSender(), underlying, amount, dineroAmount);
    }

    /*///////////////////////////////////////////////////////////////
                            PRIVATE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Adjusts the amount of a token to have 18 decimal like Dinero.
     *
     * @param amount The amount of Tokens to be properly scaled.
     * @param decimals The current decimals the price has
     * @return uint256 the new price supporting 18 decimal houses
     */
    function _scaleDecimals(uint256 amount, uint8 decimals)
        private
        pure
        returns (uint256)
    {
        uint256 baseDecimals = 18;

        if (decimals == baseDecimals) return amount;

        if (decimals < baseDecimals)
            return amount * 10**(baseDecimals - decimals);

        return amount / 10**(decimals - baseDecimals);
    }

    /*///////////////////////////////////////////////////////////////
                              OWNER
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Add support for a stable coin.
     *
     * @param underlying The address of the stable coin that this vault will support
     *
     * Requirements:
     *
     * - onlyOwner as this vault mints dinero 1:1 with `underlying`. We need to make sure they are reputable stable coins.
     */
    function addUnderlying(address underlying) external onlyOwner {
        isUnderlyingSupported[underlying] = true;

        emit AddUnderlying(underlying);
    }

    /**
     * @dev Add support for a stable coin.
     *
     * @param underlying The address of the stable coin that this vault will remove support
     *
     * Requirements:
     *
     * - onlyOwner as this vault mints dinero 1:1 with `underlying`. We need to make sure that only the owner can remove a stable coin.
     */
    function removeUnderlying(address underlying) external onlyOwner {
        isUnderlyingSupported[underlying] = false;

        emit RemoveUnderlying(underlying);
    }

    /**
     * @dev A hook to guard the address that can update the implementation of this contract. It must be the owner.
     */
    function _authorizeUpgrade(address)
        internal
        view
        override
        onlyOwner
    //solhint-disable-next-line no-empty-blocks
    {

    }
}
