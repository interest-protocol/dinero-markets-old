//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

contract MockInterestMarketV1 {
    bool public initialized;

    function initialize(bytes calldata) external payable {
        initialized = true;
    }
}
