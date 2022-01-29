//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

contract MockTWAP {
    uint256 public value;

    function setValue(uint256 _value) external {
        value = _value;
    }

    function consult(
        address,
        uint256,
        address
    ) external view returns (uint256 amountOut) {
        amountOut = value;
    }
}
