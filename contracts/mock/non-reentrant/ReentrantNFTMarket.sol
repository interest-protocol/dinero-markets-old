// SPDX-License-Identifier: MIT
pragma solidity 0.8.12;

//solhint-disable

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";

interface INFTMarket {
    function lenderStartLoan(address collection, uint256 tokenId)
        external
        payable;

    function borrowerStartLoan(
        address collection,
        uint256 tokenId,
        address proposer
    ) external;

    function withdrawBNB(
        address collection,
        uint256 tokenId,
        address payable to
    ) external;

    function repay(address collection, uint256 tokenId) external payable;

    function proposeLoan(
        address collection,
        address loanToken,
        uint256 tokenId,
        uint128 principal,
        uint64 interestRate,
        uint64 maturity
    ) external;

    function counterOffer(
        address collection,
        address loanToken,
        uint256 tokenId,
        uint128 principal,
        uint64 interestRate,
        uint64 maturity
    ) external payable;
}

contract ReentrantNFTMarketLenderStartLoan {
    INFTMarket public Contract;

    constructor(INFTMarket _contract) {
        Contract = _contract;
    }

    function proposeLoan(
        address collection,
        address loanToken,
        uint256 tokenId,
        uint128 principal,
        uint64 interestRate,
        uint64 maturity
    ) external {
        ERC721Upgradeable(collection).approve(address(Contract), tokenId);

        Contract.proposeLoan(
            collection,
            loanToken,
            tokenId,
            principal,
            interestRate,
            maturity
        );
    }

    receive() external payable {
        Contract.lenderStartLoan(address(0), 1);
    }
}

contract ReentrantNFTMarketBorrowerStartLoan {
    INFTMarket public Contract;

    constructor(INFTMarket _contract) {
        Contract = _contract;
    }

    function proposeLoan(
        address collection,
        address loanToken,
        uint256 tokenId,
        uint128 principal,
        uint64 interestRate,
        uint64 maturity
    ) external {
        ERC721Upgradeable(collection).approve(address(Contract), tokenId);

        Contract.proposeLoan(
            collection,
            loanToken,
            tokenId,
            principal,
            interestRate,
            maturity
        );
    }

    function borrowerStartLoan(
        address collection,
        uint256 tokenId,
        address proposer
    ) external {
        Contract.borrowerStartLoan(collection, tokenId, proposer);
    }

    receive() external payable {
        Contract.borrowerStartLoan(address(0), 0, address(0));
    }
}

contract ReentrantNFTMarketWithdrawBNB {
    INFTMarket public Contract;

    constructor(INFTMarket _contract) {
        Contract = _contract;
    }

    function counterOffer(
        address collection,
        address loanToken,
        uint256 tokenId,
        uint128 principal,
        uint64 interestRate,
        uint64 maturity
    ) external payable {
        Contract.counterOffer{value: msg.value}(
            collection,
            loanToken,
            tokenId,
            principal,
            interestRate,
            maturity
        );
    }

    function withdrawBNB(
        address collection,
        uint256 tokenId,
        address payable to
    ) external {
        Contract.withdrawBNB(collection, tokenId, to);
    }

    receive() external payable {
        Contract.withdrawBNB(address(0), 0, payable(address(this)));
    }
}

contract ReentrantNFTMarketRepay {
    INFTMarket public Contract;

    constructor(INFTMarket _contract) {
        Contract = _contract;
    }

    function lenderStartLoan(address collection, uint256 tokenId)
        external
        payable
    {
        Contract.lenderStartLoan{value: msg.value}(collection, tokenId);
    }

    receive() external payable {
        Contract.repay(address(0), 0);
    }
}
