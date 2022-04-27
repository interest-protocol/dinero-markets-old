//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

//solhint-disable
contract MockMintErrorVBTC {
    function mint(uint256) external pure returns (uint256) {
        return 1;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}

contract MockRedeemUnderlyingErrorVBTC {
    receive() external payable {}

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function redeem(uint256) external pure returns (uint256 rate) {
        return 1;
    }

    function exchangeRateCurrent() external pure returns (uint256) {
        return 202161072932165912322545889;
    }

    function borrowIndex() external pure returns (uint256) {
        return 1058823703742428347;
    }

    function totalBorrows() external pure returns (uint256) {
        return 0;
    }
}
