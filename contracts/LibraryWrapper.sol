//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.12;

import "./lib/PancakeLibrary.sol";
import "./lib/UniswapV2OracleLibrary.sol";

/**
 * @notice This contract just wraps libraries so we can easily mock it for tests.
 */
contract LibraryWrapper {
    function sortTokens(address tokenA, address tokenB)
        external
        pure
        returns (address, address)
    {
        return PancakeLibrary.sortTokens(tokenA, tokenB);
    }

    function pairFor(
        address factory,
        address tokenA,
        address tokenB
    ) external pure returns (address) {
        return PancakeLibrary.pairFor(factory, tokenA, tokenB);
    }

    function currentCumulativePrices(address pair)
        external
        view
        returns (
            uint256,
            uint256,
            uint32
        )
    {
        return UniswapV2OracleLibrary.currentCumulativePrices(pair);
    }
}
