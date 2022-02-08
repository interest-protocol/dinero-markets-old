//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "./IVToken.sol";

interface IVenusPriceOracle {
    function getUnderlyingPrice(IVToken vToken) external view returns (uint256);
}
