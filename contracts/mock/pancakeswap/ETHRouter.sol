//SPDX-License-Identifier: Unlicensed
pragma solidity 0.8.10;

import "./interfaces/IPancakeFactory.sol";

import "./lib/PancakeLib.sol";
import "./interfaces/IPancakePair.sol";
import "./interfaces/IPancakeERC20.sol";
import "./interfaces/IWETH.sol";

//solhint-disable

contract ETHRouter {
    address public immutable factory;
    //solhint-disable-next-line
    address public immutable WETH;

    //solhint-disable-next-line
    constructor(address _factory, address _WETH) {
        factory = _factory;
        WETH = _WETH;
    }

    // **** SWAP ****
    // requires the initial amount to have already been sent to the first pair
    function _swap(
        uint256[] memory amounts,
        address[] memory path,
        address _to
    ) internal virtual {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0, ) = PancakeLib.sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) = input == token0
                ? (uint256(0), amountOut)
                : (amountOut, uint256(0));
            address to = i < path.length - 2
                ? PancakeLib.pairFor(factory, output, path[i + 2])
                : _to;
            IPancakePair(PancakeLib.pairFor(factory, input, output)).swap(
                amount0Out,
                amount1Out,
                to,
                new bytes(0)
            );
        }
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external payable virtual returns (uint256[] memory amounts) {
        require(path[0] == WETH, "PancakeRouter: INVALID_PATH");
        amounts = PancakeLib.getAmountsOut(factory, msg.value, path);
        require(
            amounts[amounts.length - 1] >= amountOutMin,
            "PancakeRouter: INSUFFICIENT_OUTPUT_AMOUNT"
        );
        IWETH(WETH).deposit{value: amounts[0]}();
        assert(
            IWETH(WETH).transfer(
                PancakeLib.pairFor(factory, path[0], path[1]),
                amounts[0]
            )
        );
        _swap(amounts, path, to);
    }
}
