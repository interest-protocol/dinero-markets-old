// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

library SafeCastLib {
    function toUint128(uint256 x) internal pure returns (uint128) {
        //solhint-disable-next-line reason-string
        require(x < 1 << 128);

        return uint128(x);
    }

    function toUint64(uint256 x) internal pure returns (uint64) {
        //solhint-disable-next-line reason-string
        require(x < 1 << 64);

        return uint64(x);
    }

    function toUint256(int256 value) internal pure returns (uint256) {
        //solhint-disable-next-line reason-string
        require(value >= 0);
        return uint256(value);
    }
}
