// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

interface IInterestBearingBNBMarket {
    function withdrawCollateral(uint256 amount, bool inUnderlying) external;

    function addCollateral() external payable;

    function borrow(address to, uint256 amount) external;

    function request(uint8[] calldata requests, bytes[] calldata requestArgs)
        external
        payable;

    function liquidate(
        address[] calldata accounts,
        uint256[] calldata principals,
        address recipient,
        bool inUnderlying,
        address[] calldata path
    ) external;
}

// solhint-disable

contract ReentrantInterestBearingBNBMarketWithdrawCollateral {
    IInterestBearingBNBMarket public Contract;

    constructor(IInterestBearingBNBMarket _contract) {
        Contract = _contract;
    }

    function addCollateral() external payable {
        Contract.addCollateral{value: msg.value}();
    }

    function withdrawCollateral(uint256 amount, bool inUnderlying) external {
        Contract.withdrawCollateral(amount, inUnderlying);
    }

    receive() external payable {
        Contract.withdrawCollateral(0, false);
    }
}

contract ReentrantInterestBearingBNBMarketLiquidate {
    IInterestBearingBNBMarket public Contract;

    constructor(IInterestBearingBNBMarket _contract) {
        Contract = _contract;
    }

    function liquidate(
        address[] calldata accounts,
        uint256[] calldata principals,
        address recipient,
        bool inUnderlying,
        address[] calldata path
    ) external {
        Contract.liquidate(accounts, principals, recipient, inUnderlying, path);
    }

    receive() external payable {
        address[] memory _array = new address[](0);

        Contract.liquidate(
            _array,
            new uint256[](0),
            payable(address(0)),
            false,
            _array
        );
    }
}

contract ReentrantInterestBearingBNBMarketRequest {
    IInterestBearingBNBMarket public Contract;

    constructor(IInterestBearingBNBMarket _contract) {
        Contract = _contract;
    }

    function request(uint8[] calldata requests, bytes[] calldata requestArgs)
        external
        payable
    {
        Contract.request{value: msg.value}(requests, requestArgs);
    }

    function addCollateral() external payable {
        Contract.addCollateral{value: msg.value}();
    }

    receive() external payable {
        Contract.request{value: msg.value}(new uint8[](0), new bytes[](0));
    }
}
