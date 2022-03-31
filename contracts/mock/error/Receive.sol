// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

//solhint-disable

contract ReceiveErrorRequireNoMsg {
    receive() external payable {
        require(false);
    }
}

contract ReceiveErrorRequireMsg {
    receive() external payable {
        require(false, "test error");
    }
}
