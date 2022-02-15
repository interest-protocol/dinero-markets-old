// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

interface IVenusTroller {
    function enterMarkets(address[] memory _vtokens)
        external
        returns (uint256[] memory);

    function exitMarket(address _vtoken) external;

    function markets(address vTokenAddress)
        external
        view
        returns (
            bool,
            uint256,
            bool
        );

    function getAccountLiquidity(address account)
        external
        view
        returns (
            uint256,
            uint256,
            uint256
        );

    function claimVenus(address holder) external;

    function claimVenus(address holder, address[] memory vTokens) external;

    function venusSpeeds(address vToken) external returns (uint256);
}
