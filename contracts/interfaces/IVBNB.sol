// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

interface IVBNB {
    // VBep20 Interface
    function mint(uint256 amount) external payable returns (uint256);
}
