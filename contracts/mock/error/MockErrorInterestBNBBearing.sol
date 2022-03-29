// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "../../dinero-markets/InterestBNBBearingMarket.sol";

import "./Receive.sol";

contract ErrorInterestBearingSendBNBRequireNoMessage is
    ReceiveErrorRequireNoMsg
{
    function addCollateral(InterestBNBBearingMarket market) external payable {
        market.addCollateral{value: msg.value}();
    }

    function withdrawCollateral(InterestBNBBearingMarket market, uint256 amount)
        external
    {
        market.withdrawCollateral(amount, true);
    }
}

contract ErrorInterestBearingSendBNBRequireMessage is ReceiveErrorRequireMsg {
    function addCollateral(InterestBNBBearingMarket market) external payable {
        market.addCollateral{value: msg.value}();
    }

    function withdrawCollateral(InterestBNBBearingMarket market, uint256 amount)
        external
    {
        market.withdrawCollateral(amount, true);
    }
}
