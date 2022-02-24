//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../tokens/Dinero.sol";

contract TestDineroV2 is Dinero {
    uint256 public state;

    function initializeV2(uint256 _state) external onlyRole(DEVELOPER_ROLE) {
        state = _state;
    }

    function version() external pure returns (string memory) {
        return "V2";
    }
}
