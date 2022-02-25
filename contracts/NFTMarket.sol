//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/utils/ERC721HolderUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import "./lib/IntMath.sol";

/**
 * @dev Peer to Peer lending market that allows any User to borrow any ERC20 or Native token from a second user using an NFT as collateral.
 * @notice The valuation of the NFT is decided by both parties
 * @notice For the version1 we will use a basic simple interest. Seconds * interest rate.
 * @notice The borrower can always repay the loan as long as the liquidator has not liquidated.
 * @notice After the maturity date the interest rate keeps accruing. It is up to the liquidator if he wishes to wait until repayment or redeem the NFT as collateral.
 * @notice The borrower, user with the NFT, needs to initiate the loan and deposit the NFT. So we make sure it is a valid request.
 * @notice The lenders can accept the terms of the borrower right away or do a counter offer.
 * @notice In the case of a counter offer, it is up to the borrower to decide, which proposal he will choose.
 * @notice Any ERC20 and NFT is allowed. It is up to the users to confirm on the validity of the assets to not exchange fakes.
 * @notice Interest protocol will not show fake collections nor unverified ERC20s. However, the contract is permissionless.
 * @notice The protocol charges a 0.5% fee once the loan starts and 1% on repayment. Note that liquidations have no fee.
 */
contract NFTMarket is
    Initializable,
    ERC721HolderUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    /*///////////////////////////////////////////////////////////////
                            EVENTS
    //////////////////////////////////////////////////////////////*/

    event ProposeLoan(
        IERC721Upgradeable indexed collection,
        address indexed borrower,
        uint256 indexed tokenId,
        IERC20Upgradeable loanToken,
        uint128 principal,
        uint64 interestRate,
        uint64 maturity
    );

    event CounterOffer(
        IERC721Upgradeable indexed collection,
        address indexed lender,
        uint256 indexed tokenId,
        IERC20Upgradeable loanToken,
        uint128 principal,
        uint64 interestRate,
        uint64 maturity
    );

    event LenderStartLoan(
        IERC721Upgradeable indexed collection,
        uint256 indexed tokenId,
        address indexed lender,
        address borrower,
        IERC20Upgradeable token,
        uint256 amount
    );

    event BorrowerStartLoan(
        IERC721Upgradeable indexed collection,
        uint256 indexed tokenId,
        address lender,
        address indexed borrower,
        IERC20Upgradeable token,
        uint256 amount
    );

    event WithdrawNFT(
        IERC721Upgradeable indexed collection,
        uint256 indexed tokenId,
        address indexed owner
    );

    event WithdrawBNB(
        IERC721Upgradeable indexed collection,
        uint256 indexed tokenId,
        address indexed proposer,
        uint256 amount
    );

    event Liquidate(
        IERC721Upgradeable indexed collection,
        uint256 indexed tokenId,
        address indexed lender,
        address borrower
    );

    event Repay(
        IERC721Upgradeable indexed collection,
        uint256 indexed tokenId,
        address lender,
        address indexed borrower,
        uint256 total,
        uint256 fee
    );

    /*///////////////////////////////////////////////////////////////
                            LIBRARIES
    //////////////////////////////////////////////////////////////*/

    using SafeCastUpgradeable for uint256;
    using IntMath for uint256;
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.UintSet;
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.AddressSet;
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /*///////////////////////////////////////////////////////////////
                                STRUCTS & ENUMS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice We use 2 uint64 and 1 uint128 for memory efficiency. These ranges should cover all cases.
     */
    struct Loan {
        address lender; // Person who will supply the {Loan.loanToken} to the {Loan.loantoken}.
        address borrower; // Person who owns the NFT id {Loan.tokenId}.
        IERC20Upgradeable loanToken; // The token that will be borrowed.
        uint64 interestRate; // Interest rate charged PER SECOND.
        uint64 tokenId; // NFT that will be used as collateral for the loan.
        uint64 maturity; // Will be used to calculate the timestamp in which the {Loan.lender} can liquidate the {Loan.borrower}.
        uint64 startDate; // Start date when a lender or borrower accept the terms and assets are exchanged.
        uint256 principal; // The amount of {Loan.loanToken} that will be lent to the {Loan.lender}. Please note he will get get 99.5% due to the protocol fee.
    }

    struct Proposal {
        IERC20Upgradeable loanToken; // The token that will be lent out.
        address lender; // The address of the lender.
        uint64 maturity; // It will be used to find the expiration date of the loan | startDate + maturity
        uint64 interestRate; // The rate to charge every second
        uint128 principal; // The amount of {Loan.loanToken} that will be lent to the {Loan.lender}. Please note he will get get 99.5% due to the protocol fee.
    }

    /*///////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    // The address that will collect all fees accrued by the protocol.
    //solhint-disable-next-line var-name-mixedcase
    address public FEE_TO;

    /**
     * @dev It stores all the open  loans a user is currently in.
     * @notice both for lenders and borrowers for UI purposes. We need to filter if tokenId actually has a loan
     *  collection -> User -> tokenId
     */
    mapping(address => mapping(address => EnumerableSetUpgradeable.UintSet))
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
    mapping(address => mapping(uint256 => EnumerableSetUpgradeable.AddressSet))
        private _allProposals;

    /**
     * @dev The data about a certain proposal. It is used in case the borrower needs to start the loan.
     */
    // collection -> tokenId -> Lender -> Offer
    mapping(address => mapping(uint256 => mapping(address => Proposal)))
        public proposals;

    /*///////////////////////////////////////////////////////////////
                                INITIALIZER
    //////////////////////////////////////////////////////////////*/

    /**
     * @param feeTo The address that will collect the fees.
     *
     * Requirements:
     *
     * - Can only be called at once and should be called during creation to prevent front running.
     */
    function initialize(address feeTo) external initializer {
        __UUPSUpgradeable_init();
        __Ownable_init();
        __ERC721Holder_init();

        FEE_TO = feeTo;
    }

    /*///////////////////////////////////////////////////////////////
                              VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Helper function for the UI to know how many loans a user is currently engaged in.
     * @notice It will nt differentiate between lender or borrower.
     *
     * @param collection The contract of the NFT
     * @param user The address of the user
     * @return uint256 The total number of loans a user has per collection
     */
    function getUserLoansCount(address collection, address user)
        external
        view
        returns (uint256)
    {
        return _users[collection][user].length();
    }

    /**
     * @dev Helper function to get the id of a specific loan of user per collection
     *
     * @param collection The address of the contract of the NFT
     * @param user The address of a specific user
     * @param index The index to query a loan from the array of loan ids
     * @return uint256 The id of a speicif loan per user by a collection
     */
    function getUserLoanId(
        address collection,
        address user,
        uint256 index
    ) external view returns (uint256) {
        return _users[collection][user].at(index);
    }

    /**
     * @dev Helper functions to know how many proposals an NFT has
     *
     * @param collection The address of the contract of the NFT
     * @param tokenId The id of the NFT
     * @return uint256 The total number of proposals a collection tokenId has.
     */
    function getTotalProposals(address collection, uint256 tokenId)
        external
        view
        returns (uint256)
    {
        return _allProposals[collection][tokenId].length();
    }

    /**
     * @dev Helper function to get the address of a proposer of a loan
     *
     * @param collection The address of the contract of the NFT
     * @param tokenId The id of the NFT
     * @param index The index to query a specific address of a current proposer
     * @return address The address of the proposer
     */
    function getAddressOfProposer(
        address collection,
        uint256 tokenId,
        uint256 index
    ) external view returns (address) {
        return _allProposals[collection][tokenId].at(index);
    }

    /*///////////////////////////////////////////////////////////////
                            MUTATIVE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Borrowers need to set up a loan by providing their NFT as collateral right away.
     *
     * @notice How the address(0) is an acceptable `loanToken` as it represents BNB.
     *
     * @param collection The address of the contract of the NFT
     * @param loanToken The underlyin token that will be lent tot he borrower
     * @param tokenId The id of the NFT
     * @param principal The amount of `loanToken` that will be borrowed.
     * @param interestRate The interest rate of the loan  per second with 18 mantissa
     * @param maturity This value will be added to the startDate to calculate when the loan can be liquidated
     *
     * Requirements:
     *
     * - The owner of the NFT must be the one initiating the loan.
     * - Key values of the loan such as principal, interest rate and maturity must be greater than 0.
     */
    function proposeLoan(
        IERC721Upgradeable collection,
        IERC20Upgradeable loanToken,
        uint256 tokenId,
        uint128 principal,
        uint64 interestRate,
        uint64 maturity
    ) external {
        // Loan needs to have the following values to function
        require(interestRate > 0, "NFTM: no interest rate");
        require(maturity > 0, "NFTM: no maturity");
        require(principal > 0, "NFTM: no principal");

        // Gets the NFT from the owner to store in the contract as collateral
        collection.safeTransferFrom(_msgSender(), address(this), tokenId);

        // Make sure the contract now has the NFT. Should never fail
        assert(collection.ownerOf(tokenId) == address(this));

        // Save state to memory to save gas
        Loan memory _loan = loans[address(collection)][tokenId];

        // Update the local state
        _loan.loanToken = loanToken;
        _loan.principal = principal;
        _loan.maturity = maturity;
        _loan.interestRate = interestRate;
        _loan.tokenId = tokenId.toUint64();
        _loan.borrower = _msgSender();

        // Update global state
        loans[address(collection)][tokenId] = _loan;
        _users[address(collection)][_msgSender()].add(tokenId);

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

    /**
     * @dev A lender can make a counter offer for the borrower
     *
     * @param collection The address of the contract of the NFT
     * @param loanToken The underlyin token that will be lent tot he borrower
     * @param tokenId The id of the NFT
     * @param principal The amount of `loanToken` that will be borrowed.
     * @param interestRate The interest rate of the loan  per second with 18 mantissa
     * @param maturity This value will be added to the startDate to calculate when the loan can be liquidated
     *
     * Requirements:
     *
     * - The `msg.sender` cannot be the NFT owner. It makes no sense to loan to yourself.
     * - Key values of the loan such as principal, interest rate and maturity must be greater than 0.
     * - Must propose to an existing loan this is done by checking if the borrower is the address(0).
     * - The proposer must have enough funds and allows this contract to use. This is to make sure it is a serious offer.
     */
    function counterOffer(
        IERC721Upgradeable collection,
        IERC20Upgradeable loanToken,
        uint256 tokenId,
        uint128 principal,
        uint64 interestRate,
        uint64 maturity
    ) external payable {
        // Loan needs to have the following values to function
        require(interestRate > 0, "NFTM: no interest rate");
        require(maturity > 0, "NFTM: no maturity");
        require(principal > 0, "NFTM: no principal");

        // Save state to memory to save gas
        Loan memory _loan = loans[address(collection)][tokenId];

        require(_loan.borrower != _msgSender(), "NFTM: not allowed");

        // Make sure this is an existing loan and has not started
        require(
            _loan.borrower != address(0) && _loan.startDate == 0,
            "NFTM: no loan available"
        );

        // Save state to memory to save gas
        Proposal memory _proposal = proposals[address(collection)][tokenId][
            _msgSender()
        ];

        // Update state in memory
        _proposal.loanToken = loanToken;
        _proposal.principal = principal;
        _proposal.maturity = maturity;
        _proposal.interestRate = interestRate;
        _proposal.lender = _msgSender();

        // Update global state
        proposals[address(collection)][tokenId][_msgSender()] = _proposal;
        _allProposals[address(collection)][tokenId].add(_msgSender());
        _users[address(collection)][_msgSender()].add(tokenId);

        if (_isBNB(loanToken)) {
            // Lender must send BNB to the contract before hand
            require(msg.value >= principal, "NFTM: not enough BNB");
        } else {
            // Make sure the lender has assets and gave us permission to start this loan in case the borrower accepts
            require(
                loanToken.allowance(_msgSender(), address(this)) >= principal &&
                    loanToken.balanceOf(_msgSender()) >= principal,
                "NFTM: need approval"
            );
        }

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

    /**
     * @dev The lender can accept the initial proposal by the borrower right away without any modifications.
     *
     * @notice This function is payable because we do support BNB!
     * @notice We assume the user has given approval
     *
     * @param collection The address of the contract of the NFT
     * @param tokenId The id of the NFT
     *
     * Requirements:
     *
     * - Can only start a loan that has not been started
     * - The loan must exist and lender cannot be the borrower
     */
    function lenderStartLoan(IERC721Upgradeable collection, uint256 tokenId)
        external
        payable
    {
        // Save state to memory to save gas
        Loan memory _loan = loans[address(collection)][tokenId];

        // Loan is not in progress. Means no one has accepted yet!
        require(_loan.startDate == 0, "NFTM: loan in progress");
        // Loan must exist. We check via the borrower
        require(
            _loan.borrower != _msgSender() && _loan.borrower != address(0),
            "NFTM: invalid borrower"
        );

        // Start the loan and set the lender
        //solhint-disable-next-line not-rely-on-time
        _loan.startDate = block.timestamp.toUint64();
        _loan.lender = _msgSender();

        // Charge a fee to the borrower.
        uint256 principalToSend = _loan.principal.bmul(0.995e18);

        // Update global state
        loans[address(collection)][tokenId] = _loan;
        _users[address(collection)][_msgSender()].add(tokenId);

        // Sent the assets from the `msg.sender` to the borrower.
        // Support BNB
        if (_isBNB(_loan.loanToken)) {
            require(msg.value >= _loan.principal, "NFTM: incorrect principal");
            _sendBNB(payable(_loan.borrower), principalToSend);
        } else {
            // Support ERC20
            _loan.loanToken.safeTransferFrom(
                _msgSender(),
                _loan.borrower,
                principalToSend
            );
        }

        emit LenderStartLoan(
            collection,
            tokenId,
            _msgSender(),
            _loan.borrower,
            _loan.loanToken,
            principalToSend
        );
    }

    /**
     * @dev The borrower can start the loan from a counter offer
     *
     * @param collection The address of the contract of the NFT
     * @param tokenId The id of the NFT
     * @param proposer The address of a specific proposer to find his/her proposal
     *
     * Requirements:
     *
     * - Loan must have not started.
     * - Only the borrower can accept a proposal
     */
    function borrowerStartLoan(
        IERC721Upgradeable collection,
        uint256 tokenId,
        address proposer
    ) external {
        Loan memory _loan = loans[address(collection)][tokenId];

        // Loan must not have started
        require(_loan.startDate == 0, "NFTM: loan in progress");
        // Only the borrower can start the loan
        // Loan must exist
        require(_loan.borrower == _msgSender(), "NFTM: no permission");

        // Save state to memory to save gas
        Proposal memory _proposal = proposals[address(collection)][tokenId][
            proposer
        ];

        // Check that the proposal exists
        // _proposal.lender will never be _msgSender because we already check above. But does not hurt to check again.
        require(
            _proposal.lender != address(0) && _proposal.lender != _msgSender(),
            "NFTM: proposal not found"
        );

        // Update state in memory using the proposal data
        //solhint-disable-next-line not-rely-on-time
        _loan.startDate = block.timestamp.toUint64();
        _loan.lender = _proposal.lender;
        _loan.interestRate = _proposal.interestRate;
        _loan.principal = _proposal.principal;
        _loan.loanToken = _proposal.loanToken;
        _loan.maturity = _proposal.maturity;

        // Update global state
        loans[address(collection)][tokenId] = _loan;

        // Calculate the principal to send by taking a fee of 0.5% of the principal
        uint256 principalToSend = _loan.principal.bmul(0.995e18);

        // Remove the proposal
        _allProposals[address(collection)][tokenId].remove(_proposal.lender);
        delete proposals[address(collection)][tokenId][_proposal.lender];

        // Send the principal. BNB supported
        if (_isBNB(_loan.loanToken)) {
            _sendBNB(payable(_loan.borrower), principalToSend);
        } else {
            _loan.loanToken.safeTransferFrom(
                _loan.lender,
                address(this),
                _loan.principal
            );

            _loan.loanToken.safeTransfer(_loan.borrower, principalToSend);
        }

        emit BorrowerStartLoan(
            collection,
            tokenId,
            _loan.lender,
            _loan.borrower,
            _loan.loanToken,
            principalToSend
        );
    }

    /**
     * @dev It allows a proposer to withdraw his BNB, if the borrower did not accept his proposal
     *
     * @param collection The address of the contract of the NFT
     * @param tokenId The id of the NFT
     * @param to The address that will receieve the BNB
     *
     * Requiments:
     *
     * - The proposal must exist
     * - Must be the creator of the proposal
     */
    function withdrawBNB(
        IERC721Upgradeable collection,
        uint256 tokenId,
        address payable to
    ) external {
        // Save state to memory to save gas
        Proposal memory _proposal = proposals[address(collection)][tokenId][
            _msgSender()
        ];

        // Only the lender can withdraw his money back
        // This also checks that the proposal not been accepted by the borrower yet
        require(_proposal.lender == _msgSender(), "NFTM: no permission");

        uint256 amount = _proposal.principal;

        // Remove the proposal
        _allProposals[address(collection)][tokenId].remove(_proposal.lender);
        delete proposals[address(collection)][tokenId][_proposal.lender];

        // Send BNB
        _sendBNB(to, amount);

        emit WithdrawBNB(collection, tokenId, to, amount);
    }

    /**
     * @dev Borrowers can withdraw their NFT assuming they are not part of any open loan
     *
     * @param collection The address of the contract of the NFT
     * @param tokenId The id of the NFT
     *
     * Requirements:
     *
     * - The `msg.sender` must be the borrower to avoid griefing
     * - The loan must not have started
     */
    function withdrawNFT(IERC721Upgradeable collection, uint256 tokenId)
        external
    {
        // Save gas
        Loan memory _loan = loans[address(collection)][tokenId];

        // Loan has not started yet
        require(_loan.startDate == 0, "NFTM: loan in progress");
        require(_loan.borrower == _msgSender(), "NFTM: no permission");

        // Delte the loan data from storage
        delete loans[address(collection)][tokenId];
        _users[address(collection)][_msgSender()].remove(tokenId);

        // Return the NFT to the owner
        collection.safeTransferFrom(address(this), _loan.borrower, tokenId);

        emit WithdrawNFT(collection, tokenId, _msgSender());
    }

    /**
     * @dev Lender can redeeem the collateral if the loan is past its maturity
     *
     * @notice Anyone can call this function.
     *
     * @param collection The address of the contract of the NFT
     * @param tokenId The id of the NFT
     *
     * Requirements:
     *
     * - The loan must have not been repaid past its maturity
     */
    function liquidate(IERC721Upgradeable collection, uint256 tokenId)
        external
    {
        // Save gas
        Loan memory _loan = loans[address(collection)][tokenId];
        // Loan must have started and be past the maturity date
        // Loan must exist as well
        require(
            _loan.startDate > 0 &&
                //solhint-disable-next-line not-rely-on-time
                block.timestamp >= _loan.startDate + _loan.maturity,
            "NFTM: cannot be liquidated"
        );

        // Remove loan from storage
        delete loans[address(collection)][tokenId];
        _users[address(collection)][_loan.borrower].remove(tokenId);
        _users[address(collection)][_loan.lender].remove(tokenId);

        // Send the NFT to the lender
        collection.safeTransferFrom(address(this), _loan.lender, tokenId);

        emit Liquidate(collection, tokenId, _loan.lender, _loan.borrower);
    }

    /**
     * @dev Function to send the fees to the {FEE_TO} address to reward the protocol
     *
     * @notice Anyone can call this function.
     * @notice It will not send BNB unless it has accrued more than 1 BNB.
     *
     * @param token The address of a specific ERC20.
     */
    function getEarnings(IERC20Upgradeable token) external {
        // Save gas
        address feeTo = FEE_TO;

        if (address(token) != address(0)) {
            // Send all ERC20 stored
            token.safeTransfer(feeTo, token.balanceOf(address(this)));
        }

        // Send BNB if it has more than 1 BNB in this contract's balance
        if (address(this).balance > 1 ether) {
            _sendBNB(payable(feeTo), address(this).balance);
        }
    }

    /**
     * @dev Borrower can repay its loan to receive his NFT back
     *
     * @notice BNB is supported
     * @notice He can pay after the maturity as long as he has not been liquidated
     *
     * @param collection The address of the contract of the NFT
     * @param tokenId The id of the NFT
     */
    function repay(IERC721Upgradeable collection, uint256 tokenId)
        external
        payable
    {
        // Save gas
        Loan memory _loan = loans[address(collection)][tokenId];

        // Loan has started and it exists
        require(_loan.startDate > 0, "NFTM: no loan");

        // Calculate the interest rate | (timeElaped * interest per second) + principal
        //solhint-disable-next-line not-rely-on-time
        uint256 timeElapsed = block.timestamp - _loan.startDate;
        uint256 fee = timeElapsed.bmul(_loan.interestRate);
        uint256 protocolFee = fee.bmul(0.02e18); // 2% of the fee
        uint256 total = _loan.principal + fee;

        // Remove loan from storage
        delete loans[address(collection)][tokenId];
        _users[address(collection)][_loan.borrower].remove(tokenId);
        _users[address(collection)][_loan.lender].remove(tokenId);

        // Get BNB or ERC20 to cover the loan + fee
        // Send the
        if (_isBNB(_loan.loanToken)) {
            // Must cover total owed + protocol fee
            require(msg.value >= total + protocolFee, "NFTM: incorrect amount");
            _sendBNB(payable(_loan.lender), total);
        } else {
            // Total owed
            _loan.loanToken.safeTransferFrom(_msgSender(), _loan.lender, total);
            // Protocol fee
            _loan.loanToken.safeTransferFrom(
                _msgSender(),
                address(this),
                protocolFee
            );
        }

        // Send the collateral
        collection.safeTransferFrom(address(this), _loan.borrower, tokenId);

        emit Repay(
            collection,
            tokenId,
            _loan.lender,
            _loan.borrower,
            total,
            protocolFee
        );
    }

    /*///////////////////////////////////////////////////////////////
                            PRIVATE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev A helper function to know if the token is BNB.
     *
     * @notice Contract assumes address(0) is BNB in terms of ERC20
     *
     * @param token The address to check if it is BNB agaisnt address(0)
     * @return bool
     */
    function _isBNB(IERC20Upgradeable token) private pure returns (bool) {
        return token == IERC20Upgradeable(address(0));
    }

    /**
     * @dev Helper functiont o safely send BNB to `to` address.
     *
     * @param to The address that will receive BNB
     * @param amount The number of BNB to send
     */
    function _sendBNB(address payable to, uint256 amount) private {
        require(address(this).balance >= amount, "NFTM: not enough BNB");
        //solhint-disable-next-line avoid-low-level-calls
        (bool success, ) = to.call{value: amount}("");
        require(success, "NFTM: failed to send BNB");
    }

    /*///////////////////////////////////////////////////////////////
                            ONLY OWNER
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev A hook to guard the address that can update the implementation of this contract. It must be the owner.
     */
    function _authorizeUpgrade(address)
        internal
        override
        onlyOwner
    //solhint-disable-next-line no-empty-blocks
    {

    }
}
