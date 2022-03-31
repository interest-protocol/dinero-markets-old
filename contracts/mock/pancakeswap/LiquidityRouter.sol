//SPDX-License-Identifier: Unlicensed
pragma solidity 0.8.13;

import "./interfaces/IPancakeFactory.sol";

import "./lib/PancakeLib.sol";
import "./interfaces/IPancakePair.sol";
import "./interfaces/IPancakeERC20.sol";

//solhint-disable

contract LiquidityRouter {
    address public immutable factory;
    //solhint-disable-next-line
    address public immutable WETH;

    //solhint-disable-next-line
    constructor(address _factory, address _WETH) {
        factory = _factory;
        WETH = _WETH;
    }

    // **** ADD LIQUIDITY ****
    function _addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin
    ) internal virtual returns (uint256 amountA, uint256 amountB) {
        // create the pair if it doesn't exist yet
        if (IPancakeFactory(factory).getPair(tokenA, tokenB) == address(0)) {
            IPancakeFactory(factory).createPair(tokenA, tokenB);
        }
        (uint256 reserveA, uint256 reserveB) = PancakeLib.getReserves(
            factory,
            tokenA,
            tokenB
        );
        if (reserveA == 0 && reserveB == 0) {
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint256 amountBOptimal = PancakeLib.quote(
                amountADesired,
                reserveA,
                reserveB
            );
            if (amountBOptimal <= amountBDesired) {
                //solhint-disable-next-line
                require(
                    amountBOptimal >= amountBMin,
                    "PancakeRouter: INSUFFICIENT_B_AMOUNT"
                );
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal = PancakeLib.quote(
                    amountBDesired,
                    reserveB,
                    reserveA
                );
                assert(amountAOptimal <= amountADesired);
                //solhint-disable-next-line
                require(
                    amountAOptimal >= amountAMin,
                    "PancakeRouter: INSUFFICIENT_A_AMOUNT"
                );
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256
    )
        external
        virtual
        returns (
            uint256 amountA,
            uint256 amountB,
            uint256 liquidity
        )
    {
        (amountA, amountB) = _addLiquidity(
            tokenA,
            tokenB,
            amountADesired,
            amountBDesired,
            amountAMin,
            amountBMin
        );
        address pair = PancakeLib.pairFor(factory, tokenA, tokenB);
        IPancakeERC20(tokenA).transferFrom(msg.sender, pair, amountA);
        IPancakeERC20(tokenB).transferFrom(msg.sender, pair, amountB);
        liquidity = IPancakePair(pair).mint(to);
    }
}
