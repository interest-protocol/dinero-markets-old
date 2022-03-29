//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

import "../interfaces/IVenusController.sol";
import "./ERC20/MockERC20.sol";

//solhint-disable

contract MockVenusController is IVenusController {
    event EnterMarket(address vToken);

    event ExitMarket(address vToken);

    event Claim(address account, uint256 amount);

    struct Market {
        /// @notice Whether or not this market is listed
        bool isListed;
        /**
         * @notice Multiplier representing the most one can borrow against their collateral in this market.
         *  For instance, 0.9 to allow borrowing 90% of collateral value.
         *  Must be between 0 and 1, and stored as a mantissa.
         */
        uint256 collateralFactorMantissa;
        /// @notice Per-market mapping of "accounts in this asset"
        mapping(address => bool) accountMembership;
        /// @notice Whether or not this market receives XVS
        bool isVenus;
    }

    struct AccountLiquidity {
        uint256 error;
        uint256 liquidity;
        uint256 shortfall;
    }

    AccountLiquidity public liquidity;

    mapping(address => Market) public markets;

    mapping(address => uint256) public venusSpeeds;

    uint256 private _enterMarketValueReturn;

    uint256 private _claimVenusAmount;

    uint256 private _exitMarketValueReturn;

    MockERC20 public immutable XVS;

    constructor(MockERC20 xvs) {
        XVS = xvs;
    }

    function enterMarkets(address[] calldata _markets)
        external
        returns (uint256[] memory)
    {
        uint256 len = _markets.length;

        for (uint256 i = 0; i < len; i++) {
            emit EnterMarket(_markets[i]);
        }

        uint256[] memory data = new uint256[](1);
        data[0] = _enterMarketValueReturn;

        return data;
    }

    //solhint-disable-next-line no-empty-blocks
    function exitMarket(address vToken) external returns (uint256) {
        emit ExitMarket(vToken);
        return _exitMarketValueReturn;
    }

    function getAccountLiquidity(address)
        external
        view
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        return (liquidity.error, liquidity.liquidity, liquidity.shortfall);
    }

    //solhint-disable-next-line no-empty-blocks
    function claimVenus(address) external {}

    //solhint-disable-next-line no-empty-blocks
    function claimVenus(address account, address[] calldata) external {
        if (_claimVenusAmount == 0) return;
        XVS.mint(account, _claimVenusAmount);
        emit Claim(account, _claimVenusAmount);
    }

    function __setMarkets(
        address account,
        bool isListed,
        uint256 collateralFactorMantissa,
        bool accountMembership,
        bool isVenus
    ) external {
        Market storage market = markets[account];

        market.isListed = isListed;
        market.collateralFactorMantissa = collateralFactorMantissa;
        market.accountMembership[account] = accountMembership;
        market.isVenus = isVenus;
    }

    function __setLiquidity(
        uint256 error,
        uint256 _liquidity,
        uint256 shortfall
    ) external {
        liquidity.error = error;
        liquidity.liquidity = _liquidity;
        liquidity.shortfall = shortfall;
    }

    function __setVenusSpeeds(address vToken, uint256 amount) external {
        venusSpeeds[vToken] = amount;
    }

    function __setEnterMarketReturn(uint256 value) external {
        _enterMarketValueReturn = value;
    }

    function __setClaimVenusValue(uint256 value) external {
        _claimVenusAmount = value;
    }

    function __setExitMarketReturn(uint256 value) external {
        _exitMarketValueReturn = value;
    }
}
