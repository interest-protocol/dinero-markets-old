//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.12;

contract MockSimplePair {
    string public symbol;

    address public token0;
    address public token1;

    uint256 private _reserve0;
    uint256 private _reserve1;

    uint256 public totalSupply;

    constructor(
        address _token0,
        address _token1,
        string memory _symbol
    ) {
        token0 = _token0;
        token1 = _token1;
        symbol = _symbol;
    }

    function setTotalSupply(uint256 amount) external {
        totalSupply = amount;
    }

    function setReserves(uint256 amount0, uint256 amount1) external {
        _reserve0 = amount0;
        _reserve1 = amount1;
    }

    function getReserves()
        external
        view
        returns (
            uint256,
            uint256,
            uint32
        )
    {
        return (_reserve0, _reserve1, 1);
    }
}
