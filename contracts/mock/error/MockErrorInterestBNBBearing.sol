// SPDX-License-Identifier: MIT
pragma solidity 0.8.12;

import "../../dinero-markets/InterestBNBBearingMarket.sol";

import "./Receive.sol";

contract ErrorInterestBearingSendBNBAssetAssert is ReceiveErrorAssert {
    function addCollateral(InterestBNBBearingMarket market) external payable {
        market.addCollateral{value: msg.value}();
    }

    function withdrawCollateral(InterestBNBBearingMarket market, uint256 amount)
        external
    {
        market.withdrawCollateral(amount, true);
    }
}

contract ErrorInterestBearingSendBNBAssetRequire is ReceiveErrorRequire {
    function addCollateral(InterestBNBBearingMarket market) external payable {
        market.addCollateral{value: msg.value}();
    }

    function withdrawCollateral(InterestBNBBearingMarket market, uint256 amount)
        external
    {
        market.withdrawCollateral(amount, true);
    }
}
