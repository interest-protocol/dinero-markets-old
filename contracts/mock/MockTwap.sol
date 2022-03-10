//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.12;

contract MockTWAP {
    uint256 public value;

    function setValue(uint256 _value) external {
        value = _value;
    }

    function consult(
        address,
        uint256 amount,
        address
    ) external view returns (uint256 amountOut) {
        amountOut = (value * amount) / 1 ether;
    }
}
