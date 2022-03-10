//SPDX-License-Identifier: Unlicensed
pragma solidity 0.8.12;

contract Migrations {
    address public owner;
    //solhint-disable-next-line
    uint256 public last_completed_migration;

    modifier restricted() {
        if (msg.sender == owner) _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setCompleted(uint256 completed) public restricted {
        last_completed_migration = completed;
    }
}
