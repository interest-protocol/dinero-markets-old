// SPDX-License-Identifier: MIT
pragma solidity 0.8.12;

import "../../dinero-markets/InterestBearingMarket.sol";

import "./Receive.sol";

contract ErrorInterestBearingSendBNBAssetAssert is ReceiveErrorAssert {
    function addCollateral(InterestBearingMarket market) external payable {
        market.addCollateral{value: msg.value}(0);
    }

    function withdrawCollateral(InterestBearingMarket market, uint256 amount)
        external
    {
        market.withdrawCollateral(amount, true);
    }
}

contract ErrorInterestBearingSendBNBAssetRequire is ReceiveErrorRequire {
    function addCollateral(InterestBearingMarket market) external payable {
        market.addCollateral{value: msg.value}(0);
    }

    function withdrawCollateral(InterestBearingMarket market, uint256 amount)
        external
    {
        market.withdrawCollateral(amount, true);
    }
}
