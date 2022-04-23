// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

interface IInterestMarketBNBV1 {
    function withdrawCollateral(address to, uint256 amount) external;

    function addCollateral(address to) external payable;

    function borrow(address to, uint256 amount) external;

    function request(uint8[] calldata requests, bytes[] calldata requestArgs)
        external
        payable;

    function liquidate(
        address[] calldata accounts,
        uint256[] calldata principals,
        address payable recipient,
        address[] calldata path
    ) external;
}

// solhint-disable

contract ReentrantInterestBNBMarketWithdrawCollateral {
    IInterestMarketBNBV1 public Contract;

    constructor(IInterestMarketBNBV1 _contract) {
        Contract = _contract;
    }

    function withdrawCollateral(address to, uint256 amount) external {
        Contract.withdrawCollateral(to, amount);
    }

    receive() external payable {
        Contract.withdrawCollateral(address(0), 0);
    }
}

contract ReentrantInterestBNBMarketLiquidate {
    IInterestMarketBNBV1 public Contract;

    constructor(IInterestMarketBNBV1 _contract) {
        Contract = _contract;
    }

    function liquidate(
        address[] calldata accounts,
        uint256[] calldata principals,
        address payable recipient,
        address[] calldata path
    ) external {
        Contract.liquidate(accounts, principals, recipient, path);
    }

    receive() external payable {
        address[] memory _array = new address[](0);

        Contract.liquidate(
            _array,
            new uint256[](0),
            payable(address(0)),
            _array
        );
    }
}

contract ReentrantInterestBNBMarketRequest {
    IInterestMarketBNBV1 public Contract;

    constructor(IInterestMarketBNBV1 _contract) {
        Contract = _contract;
    }

    function request(uint8[] calldata requests, bytes[] calldata requestArgs)
        external
        payable
    {
        Contract.request{value: msg.value}(requests, requestArgs);
    }

    function addCollateral(address to) external payable {
        Contract.addCollateral{value: msg.value}(to);
    }

    receive() external payable {
        Contract.request{value: msg.value}(new uint8[](0), new bytes[](0));
    }
}
