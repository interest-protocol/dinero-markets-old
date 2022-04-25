// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

contract MockBigChainLinkFeedV2 {
    function decimals() external pure returns (uint8) {
        return 20;
    }

    function latestRoundData()
        external
        pure
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        // Taken from https://bscscan.com/address/0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee#readContract
        roundId = 36893488147419307956;
        answer = 1 ether;
        startedAt = 1639814685;
        updatedAt = 1639814685;
        answeredInRound = 36893488147419307956;
    }
}
