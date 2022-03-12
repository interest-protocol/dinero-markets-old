// SPDX-License-Identifier: MIT
pragma solidity 0.8.12;

contract ReceiveErrorAssert {
    receive() external payable {
        assert(false);
    }
}

contract ReceiveErrorRequire {
    receive() external payable {
        require(false, "test error");
    }
}
