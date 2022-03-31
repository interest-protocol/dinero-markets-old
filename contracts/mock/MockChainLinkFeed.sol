// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "../interfaces/AggregatorV3Interface.sol";

contract MockChainLinkFeed is AggregatorV3Interface {
    uint8 private _decimals;

    string private _description;

    uint256 private _version;

    int256 private _answer;

    constructor(
        uint8 decimals_,
        string memory description_,
        uint256 version_
    ) {
        _decimals = decimals_;
        _description = description_;
        _version = version_;
    }

    function setAnswer(int256 answer) external {
        _answer = answer;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    function version() external view returns (uint256) {
        return _version;
    }

    function getRoundData(uint80)
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
        answer = 52607743315;
        startedAt = 1639814685;
        updatedAt = 1639814685;
        answeredInRound = 36893488147419307956;
    }

    function latestRoundData()
        external
        view
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
        answer = _answer;
        startedAt = 1639814685;
        updatedAt = 1639814685;
        answeredInRound = 36893488147419307956;
    }
}
