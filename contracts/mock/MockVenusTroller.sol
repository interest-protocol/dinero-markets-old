//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

import "../interfaces/IVenusTroller.sol";

contract MockVenusTroller is IVenusTroller {
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

    //solhint-disable-next-line no-empty-blocks
    function enterMarkets(address[] calldata) external {}

    //solhint-disable-next-line no-empty-blocks
    function exitMarket(address) external {}

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
    function claimVenus(address, address[] calldata) external {}

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
}
