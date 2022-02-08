//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

import "./interfaces/IVenustroller.sol";
import "./interfaces/IVToken.sol";
import "./interfaces/IVenusPriceOracle.sol";

import "./lib/IntMath.sol";
import "./lib/Rebase.sol";

import "./tokens/Dinero.sol";
import "./OracleV1.sol";
import "./SafeVenus.sol";

contract DineroVenusVault is Ownable, Pausable {
    /*///////////////////////////////////////////////////////////////
                            LIBRARIES
    //////////////////////////////////////////////////////////////*/

    using EnumerableSet for EnumerableSet.AddressSet;
    using SafeERC20 for IERC20;
    using IntMath for uint256;

    /*///////////////////////////////////////////////////////////////
                            EVENTS
    //////////////////////////////////////////////////////////////*/

    event Deposit(
        address indexed account,
        address indexed underlying,
        uint256 amount
    );

    event Withdraw(
        address indexed account,
        address indexed underlying,
        uint256 amount
    );

    /*///////////////////////////////////////////////////////////////
                            STATE
    //////////////////////////////////////////////////////////////*/

    // solhint-disable-next-line var-name-mixedcase
    address public immutable XVS;

    // solhint-disable-next-line var-name-mixedcase
    address public immutable WBNB;

    // solhint-disable-next-line var-name-mixedcase
    IVenustroller public immutable VENUS_TROLLER;

    //solhint-disable-next-line var-name-mixedcase
    Dinero public immutable DINERO;

    //solhint-disable-next-line var-name-mixedcase
    OracleV1 public immutable ORACLE;

    //solhint-disable-next-line var-name-mixedcase
    SafeVenus public immutable SAFE_VENUS;

    EnumerableSet.AddressSet private _underlyingWhitelist;

    // VTOKEN -> USER -> AMOUNT
    mapping(address => mapping(address => uint256)) public balanceOf;

    mapping(address => uint256) public principalOf;

    uint256 public totalSupply;

    uint256 private collateralLimit;

    mapping(address => IVToken) public vTokenOf;

    /*///////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        address xvs,
        address wbnb,
        IVenustroller venusTroller,
        Dinero dinero,
        OracleV1 oracle,
        SafeVenus safeVenus
    ) {
        XVS = xvs;
        WBNB = wbnb;
        VENUS_TROLLER = venusTroller;
        DINERO = dinero;
        ORACLE = oracle;
        SAFE_VENUS = safeVenus;
    }

    /*///////////////////////////////////////////////////////////////
                            MODIFIER
    //////////////////////////////////////////////////////////////*/

    modifier isWhitelisted(address underlying) {
        require(
            _underlyingWhitelist.contains(underlying),
            "DV: underlying not whitelisted"
        );
        _;
    }

    /*///////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function isUnderlyingSupported(address underlying)
        external
        view
        returns (bool)
    {
        return _underlyingWhitelist.contains(underlying);
    }

    function getUnderlyingAt(uint256 index) external view returns (address) {
        return _underlyingWhitelist.at(index);
    }

    function getTotalUnderlyings() external view returns (uint256) {
        return _underlyingWhitelist.length();
    }

    function getAllUnderlyings() external view returns (address[] memory) {
        return _underlyingWhitelist.values();
    }

    /*///////////////////////////////////////////////////////////////
                            MUTATIVE FUNCTIONW
    //////////////////////////////////////////////////////////////*/

    function deposit(address underlying, uint256 amount)
        public
        isWhitelisted(underlying)
        whenNotPaused
    {
        require(amount > 0, "DV: no zero amount");

        // View variable to know how many stable coins have been deposited
        totalSupply += amount;

        principalOf[_msgSender()] += amount;

        IERC20(underlying).safeTransferFrom(
            _msgSender(),
            address(this),
            amount
        );

        uint256 shares = _mintVToken(underlying);

        IVToken vToken = vTokenOf[underlying];

        balanceOf[address(vToken)][_msgSender()] += shares;

        DINERO.mint(_msgSender(), amount);

        emit Deposit(_msgSender(), underlying, amount);
    }

    function withdraw(address underlying, uint256 shares)
        public
        isWhitelisted(underlying)
    {
        // require(shares > 0, "DV: no zero amount");
        // Rebase memory investment = investmentOf[underlying];
        // uint256 balance = balanceOf[underlying][_msgSender()];
        // uint256 principal = principalOf[_msgSender()];
        // uint256 amount;
        // (investment, amount) = investment.sub(shares, false);
        // totalSupply -= amount;
        // uint256 principalOwed = shares.bdiv(balance).bmul(principal);
        // balance -= shares;
        // principal -= principalOwed;
        // // Update Global State
        // balanceOf[underlying][_msgSender()] = balance;
        // principalOf[_msgSender()] = principal;
        // investmentOf[underlying] = investment;
        // // Recover the Dinero lent to keep the ratio 1:1
        // DINERO.burn(_msgSender(), principalOwed);
        // // Send V Token Underlying
        // emit Withdraw(_msgSender(), underlying, amount);
    }

    function getSafeCollateralLimit(address vToken)
        public
        view
        returns (uint256)
    {
        (, uint256 venusCollateralFactor, ) = VENUS_TROLLER.markets(vToken);
        uint256 enforcedLimit = venusCollateralFactor.bmul(collateralLimit);
        uint256 optimalLimit = IVToken(vToken).supplyRatePerBlock().bdiv(
            IVToken(vToken).borrowRatePerBlock()
        );
        return enforcedLimit.min(optimalLimit);
    }

    /*///////////////////////////////////////////////////////////////
                         PRIVATE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _mintVToken(address underlying)
        private
        returns (uint256 mintedAmount)
    {
        IVToken vToken = vTokenOf[underlying];
        uint256 balanceBefore = IERC20(address(vToken)).balanceOf(
            address(this)
        );
        vToken.mint(IERC20(underlying).balanceOf(address(this)));

        mintedAmount =
            IERC20(address(vToken)).balanceOf(address(this)) -
            balanceBefore;
    }

    function _vTokenBorrow(address vToken) private {
        uint256 _collateralLimit = getSafeCollateralLimit(vToken);
        (uint256 borrow, uint256 supply) = SAFE_VENUS.getVenusBorrowAndSupply(
            address(this),
            vToken
        );

        uint256 currentCollateralFactor = borrow.bdiv(supply);

        if (currentCollateralFactor >= _collateralLimit) {
            // Lower to meet the limit
            return;
        }

        uint256 maxBorrowAmount = supply.bmul(_collateralLimit);
        uint256 newBorrowAmount = maxBorrowAmount.min(
            SAFE_VENUS.getVTokenBorrowLiquidity(vToken)
        );
    }

    /*///////////////////////////////////////////////////////////////
                           ONLY OWNER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function addUnderlying(address underlying, IVToken vToken)
        external
        onlyOwner
    {
        _underlyingWhitelist.add(underlying);
        vTokenOf[underlying] = vToken;
    }

    function removeUnderlying(address underlying) external onlyOwner {
        _underlyingWhitelist.remove(underlying);
        delete vTokenOf[underlying];
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setCollateralLimit(uint256 _collateralLimit) external onlyOwner {
        require(0.9e18 > _collateralLimit, "DV: too risky");
        collateralLimit = _collateralLimit;
    }
}
