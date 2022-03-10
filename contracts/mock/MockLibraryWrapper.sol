//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.12;

import "../lib/PancakeLibrary.sol";
import "../lib/UniswapV2OracleLibrary.sol";

/**
 * @notice This contract just wraps libraries so we can easily mock it for tests.
 */
contract MockLibraryWrapper {
    address public pair;

    function sortTokens(address tokenA, address tokenB)
        public
        pure
        returns (address, address)
    {
        return PancakeLibrary.sortTokens(tokenA, tokenB);
    }

    function pairFor(
        address,
        address,
        address
    ) external view returns (address) {
        return pair;
    }

    function setPair(address _pair) external {
        pair = _pair;
    }

    function currentCumulativePrices(address)
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
