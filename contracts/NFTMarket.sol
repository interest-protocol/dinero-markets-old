//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./lib/IntMath.sol";

contract NFTMarket is ERC721Holder, Context {
    /*///////////////////////////////////////////////////////////////
                            EVENTS
    //////////////////////////////////////////////////////////////*/

    event ProposeLoan(
        IERC721 indexed collection,
        address indexed borrower,
        uint256 indexed tokenId,
        IERC20 loanToken,
        uint128 principal,
        uint64 interestRate,
        uint64 maturity
    );

    event CounterOffer(
        IERC721 indexed collection,
        address indexed lender,
        uint256 indexed tokenId,
        IERC20 loanToken,
        uint128 principal,
        uint64 interestRate,
        uint64 maturity
    );

    event LenderStartLoan(
        IERC721 indexed collection,
        uint256 indexed tokenId,
        address indexed lender,
        address borrower
    );

    event BorrowerStartLoan(
        IERC721 indexed collection,
        uint256 indexed tokenId,
        address lender,
        address indexed borrower
    );

    event WithdrawNFT(
        IERC721 indexed collection,
        uint256 indexed tokenId,
        address indexed owner
    );

    event Liquidate(
        IERC721 indexed collection,
        uint256 indexed tokenId,
        address indexed lender,
        address borrower
    );

    /*///////////////////////////////////////////////////////////////
                            LIBRARIES
    //////////////////////////////////////////////////////////////*/

    using SafeCast for uint256;
    using IntMath for uint256;
    using EnumerableSet for EnumerableSet.UintSet;
    using EnumerableSet for EnumerableSet.AddressSet;
    using SafeERC20 for IERC20;

    /*///////////////////////////////////////////////////////////////
                                STRUCTS & ENUMS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice We use 2 uint64 and 1 uint128 for memory efficiency. These ranges should cover all cases.
     */
    struct Loan {
        address lender;
        address borrower;
        IERC20 loanToken;
        uint64 interestRate; // INTEREST_RATE is charged per second and has a base unit of 1e18.
        uint64 tokenId;
        uint64 maturity;
        uint64 startDate;
        uint256 principal;
    }

    struct Proposal {
        IERC20 loanToken;
        uint64 maturity;
        uint128 principal;
        uint64 interestRate;
        address lender;
    }

    /*///////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    //solhint-disable-next-line var-name-mixedcase
    address public immutable FEE_TO;

    /**
     * @dev It stores all the open  loans a user is currently in.
     *  collection -> User -> tokenId
     */
    mapping(address => mapping(address => EnumerableSet.UintSet))
        private _users;

    /**
     * @dev It stores the information pertaining to a loan.
     *  collection -> tokenId -> Loan
     */
    mapping(address => mapping(uint256 => Loan)) public loans;

    /**
     * @dev It stores all accounts that have offered a proposal for a loan
     *  collection -> tokenId -> []address
     */
    mapping(address => mapping(uint256 => EnumerableSet.AddressSet))
        private _allProposals;

    // collection -> tokenId -> Lender -> Offer
    mapping(address => mapping(uint256 => mapping(address => Proposal)))
        public proposals;

    /*///////////////////////////////////////////////////////////////
                                CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address feeTo) {
        FEE_TO = feeTo;
    }

    /*///////////////////////////////////////////////////////////////
                              VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function getUserLoansCount(address collection, address user)
        external
        view
        returns (uint256)
    {
        return _users[collection][user].length();
    }

    function getUserLoanId(
        address collection,
        address user,
        uint256 index
    ) external view returns (uint256) {
        return _users[collection][user].at(index);
    }

    function getTotalProposals(address collection, uint256 tokenId)
        external
        view
        returns (uint256)
    {
        return _allProposals[collection][tokenId].length();
    }

    function getProposalAddress(
        address collection,
        uint256 tokenId,
        uint256 index
    ) external view returns (address) {
        return _allProposals[collection][tokenId].at(index);
    }

    /*///////////////////////////////////////////////////////////////
                            MUTATIVE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function proposeLoan(
        IERC721 collection,
        IERC20 loanToken,
        uint256 tokenId,
        uint128 principal,
        uint64 interestRate,
        uint64 maturity
    ) external {
        require(
            collection.ownerOf(tokenId) == _msgSender(),
            "NFTM: must be nft owner"
        );
        require(interestRate > 0, "NFTM: no interest rate");
        require(maturity > 0, "NFTM: no maturity");
        require(principal > 0, "NFTM: no principal");

        collection.safeTransferFrom(_msgSender(), address(this), tokenId);

        assert(collection.ownerOf(tokenId) == address(this));

        Loan memory _loan = loans[address(collection)][tokenId];

        _loan.loanToken = loanToken;
        _loan.principal = principal;
        _loan.maturity = maturity;
        _loan.interestRate = interestRate;
        _loan.tokenId = tokenId.toUint64();
        _loan.borrower = _msgSender();

        loans[address(collection)][tokenId] = _loan;

        emit ProposeLoan(
            collection,
            _msgSender(),
            tokenId,
            loanToken,
            principal,
            interestRate,
            maturity
        );
    }

    function counterOffer(
        IERC721 collection,
        IERC20 loanToken,
        uint256 tokenId,
        uint128 principal,
        uint64 interestRate,
        uint64 maturity
    ) external {
        require(
            collection.ownerOf(tokenId) != _msgSender(),
            "NFTM: must be nft owner"
        );
        require(interestRate > 0, "NFTM: no interest rate");
        require(maturity > 0, "NFTM: no maturity");
        require(principal > 0, "NFTM: no principal");

        Loan memory _loan = loans[address(collection)][tokenId];

        require(_loan.borrower != address(0), "NFTM: no loan available");

        Proposal memory _proposal = proposals[address(collection)][tokenId][
            _msgSender()
        ];

        require(
            loanToken.allowance(_msgSender(), address(this)) >= principal &&
                loanToken.balanceOf(_msgSender()) >= principal,
            "NFTM: need approval"
        );

        _proposal.loanToken = loanToken;
        _proposal.principal = principal;
        _proposal.maturity = maturity;
        _proposal.interestRate = interestRate;
        _proposal.lender = _msgSender();

        proposals[address(collection)][tokenId][_msgSender()] = _proposal;
        _allProposals[address(collection)][tokenId].add(_msgSender());

        emit CounterOffer(
            collection,
            _msgSender(),
            tokenId,
            loanToken,
            principal,
            interestRate,
            maturity
        );
    }

    function lenderStartLoan(IERC721 collection, uint256 tokenId)
        external
        payable
    {
        Loan memory _loan = loans[address(collection)][tokenId];

        require(_loan.startDate == 0, "NFTM: loan in progress");
        require(
            _loan.borrower != _msgSender() && _loan.borrower != address(0),
            "NFTM: invalid borrower"
        );

        //solhint-disable-next-line not-rely-on-time
        _loan.startDate = block.timestamp.toUint64();
        _loan.lender = _msgSender();

        uint256 principalToSend = _loan.principal.bmul(0.995e18);

        if (_loan.loanToken == IERC20(address(0))) {
            require(msg.value >= _loan.principal, "NFTM: incorrect principal");
            //solhint-disable-next-line avoid-low-level-calls
            (bool success, ) = _loan.borrower.call{value: principalToSend}("");
            require(success, "NFTM: failed to send BNB");
        } else {
            _loan.loanToken.safeTransferFrom(
                _msgSender(),
                _loan.borrower,
                principalToSend
            );
        }

        delete _allProposals[address(collection)][tokenId];

        loans[address(collection)][tokenId] = _loan;

        emit LenderStartLoan(collection, tokenId, _loan.lender, _loan.borrower);
    }

    function borrowerStartLoan(
        IERC721 collection,
        uint256 tokenId,
        address proposer
    ) external {
        require(
            collection.ownerOf(tokenId) != _msgSender(),
            "NFTM: must be nft owner"
        );
        Loan memory _loan = loans[address(collection)][tokenId];

        require(_loan.startDate == 0, "NFTM: loan in progress");
        require(_loan.lender != address(0), "NFTM: no lender");

        Proposal memory _proposal = proposals[address(collection)][tokenId][
            proposer
        ];

        //solhint-disable-next-line not-rely-on-time
        _loan.startDate = block.timestamp.toUint64();
        _loan.lender = _proposal.lender;
        _loan.interestRate = _proposal.interestRate;
        _loan.principal = _proposal.principal;
        _loan.loanToken = _proposal.loanToken;
        _loan.maturity = _proposal.maturity;

        delete proposals[address(collection)][tokenId][proposer];
        delete _allProposals[address(collection)][tokenId];

        loans[address(collection)][tokenId] = _loan;

        _loan.loanToken.safeTransferFrom(
            _loan.lender,
            _loan.borrower,
            _loan.principal
        );

        emit BorrowerStartLoan(
            collection,
            tokenId,
            _loan.lender,
            _loan.borrower
        );
    }

    function withdrawNFT(IERC721 collection, uint256 tokenId) external {
        Loan memory _loan = loans[address(collection)][tokenId];
        require(_loan.startDate == 0, "NFTM: loan in progress");

        collection.safeTransferFrom(address(this), _loan.borrower, tokenId);

        delete loans[address(collection)][tokenId];
        delete _allProposals[address(collection)][tokenId];

        emit WithdrawNFT(collection, tokenId, _msgSender());
    }

    function liquidate(IERC721 collection, uint256 tokenId) external {
        Loan memory _loan = loans[address(collection)][tokenId];
        require(
            _loan.startDate > 0 &&
                //solhint-disable-next-line not-rely-on-time
                block.timestamp >= _loan.maturity,
            "NFTM: cannot be liquidated"
        );

        collection.safeTransferFrom(address(this), _loan.lender, tokenId);

        delete loans[address(collection)][tokenId];

        emit Liquidate(collection, tokenId, _loan.lender, _loan.borrower);
    }

    function getEarnings(IERC20 token) external {
        address feeTo = FEE_TO;

        token.safeTransfer(feeTo, token.balanceOf(address(this)));

        if (address(this).balance > 1 ether) {
            //solhint-disable-next-line avoid-low-level-calls
            (bool success, ) = feeTo.call{value: address(this).balance}("");
            require(success, "NFTM: failed to send BNB");
        }
    }

    function repay(IERC721 collection, uint256 tokenId) external payable {
        Loan memory _loan = loans[address(collection)][tokenId];

        require(_loan.startDate > 0, "NFTM: no loan");

        //solhint-disable-next-line not-rely-on-time
        uint256 timeElapsed = block.timestamp - _loan.startDate;
        uint256 total = uint256(timeElapsed * _loan.principal).bmul(
            _loan.interestRate
        );
        uint256 protocolFee = total.bmul(0.01e18);

        if (_loan.loanToken == IERC20(address(0))) {
            require(msg.value >= total + protocolFee, "NFTM: incorrect amount");
            //solhint-disable-next-line avoid-low-level-calls
            (bool success, ) = _loan.lender.call{value: total}("");
            require(success, "NFTM: failed to send BNB");
        } else {
            _loan.loanToken.safeTransferFrom(_msgSender(), _loan.lender, total);
            _loan.loanToken.safeTransferFrom(
                _msgSender(),
                address(this),
                protocolFee
            );
        }

        collection.safeTransferFrom(address(this), _loan.borrower, tokenId);

        delete loans[address(collection)][tokenId];
    }
}
