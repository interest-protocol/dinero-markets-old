//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

import "../lib/UniswapV2OracleLibrary.sol";

contract TestTPCSLibrary {
    function currentCumulativePrices(address pair)
        external
        view
        returns (
            uint256 price0Cumulative,
            uint256 price1Cumulative,
            uint32 blockTimestamp
        )
    {
        return UniswapV2OracleLibrary.currentCumulativePrices(pair);
    }
}
