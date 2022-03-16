// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.12;

interface IVBNB {
    // VBep20 Interface
    function mint(uint256 mintAmount) external payable returns (uint256);
}
