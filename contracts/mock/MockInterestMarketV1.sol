//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

import "../interfaces/InterestMarketV1Interface.sol";

contract MockInterestMarketV1 is InterestMarketV1Interface {
    function initialize(bytes calldata) external {}
}
