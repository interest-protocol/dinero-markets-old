//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

//solhint-disable
contract MockReceiveErrorVBNB {
    receive() external payable {
        require(false);
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}

contract MockRedeemUnderlyingErrorVBNB {
    receive() external payable {}

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function redeem(uint256) external pure returns (uint256 rate) {
        return 1;
    }

    function exchangeRateCurrent() external pure returns (uint256) {
        return 216754716238298913961403676;
    }

    function borrowIndex() external pure returns (uint256) {
        return 1104168746983935733;
    }

    function totalBorrows() external pure returns (uint256) {
        return 0;
    }
}
