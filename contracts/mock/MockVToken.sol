//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "./MockERC20.sol";

//solhint-disable-next-line max-states-count
contract MockVenusToken is ERC20 {
    struct AccountSnapShot {
        uint256 error;
        uint256 vTokenBalance;
        uint256 borrowBalance;
        uint256 exchangeRateMantissa;
    }

    address public interestRateModel;

    uint256 public totalReserves;

    uint256 public reserveFactorMantissa;

    mapping(address => uint256) public balanceOfUnderlying;

    AccountSnapShot private _accountSnapShot;

    uint256 public borrowRatePerBlock;

    uint256 public supplyRatePerBlock;

    mapping(address => uint256) public borrowBalanceCurrent;

    mapping(address => uint256) public borrowBalanceStored;

    uint256 public exchangeRateCurrent;

    uint256 public exchangeRateStored;

    uint256 public getCash;

    uint256 public accrueInterest;

    uint256 private _seize;

    address public underlying;

    uint256 public totalBorrowsCurrent;

    struct ReturnValue {
        uint128 borrow;
        uint128 redeem;
        uint128 repay;
        uint128 mint;
    }

    struct MintValues {
        uint128 reddem;
        uint128 borrow;
    }

    MintValues public mintValues;

    ReturnValue public returnValues;

    constructor(
        string memory name,
        string memory symbol,
        uint256 initialSupply
    ) ERC20(name, symbol) {
        _mint(_msgSender(), initialSupply);
    }

    function getAccountSnapshot(address)
        external
        view
        returns (
            uint256,
            uint256,
            uint256,
            uint256
        )
    {
        return (
            _accountSnapShot.error,
            _accountSnapShot.vTokenBalance,
            _accountSnapShot.borrowBalance,
            _accountSnapShot.exchangeRateMantissa
        );
    }

    function seize(
        address,
        address,
        uint256
    ) external view returns (uint256) {
        return _seize;
    }

    function mint(uint256 amount) external returns (uint256) {
        uint256 value = returnValues.mint;

        if (value > 0) return value;

        _mint(_msgSender(), (amount * exchangeRateCurrent) / 1 ether);
        return 0;
    }

    function redeem(uint256) external view returns (uint256) {
        return returnValues.redeem;
    }

    function redeemUnderlying(uint256) external returns (uint256) {
        MockERC20(underlying).mint(msg.sender, mintValues.reddem);
        return returnValues.redeem;
    }

    function borrow(uint256) external returns (uint256) {
        MockERC20(underlying).mint(msg.sender, mintValues.borrow);
        return returnValues.borrow;
    }

    function repayBorrow(uint256 amount) external returns (uint256) {
        uint256 value = returnValues.repay;

        if (value > 0) return value;

        borrowBalanceCurrent[msg.sender] -= amount;

        return 0;
    }

    function repayBorrowBehalf(address, uint256)
        external
        pure
        returns (uint256)
    {
        return 0;
    }

    function liquidateBorrow(
        address,
        uint256,
        address
    ) external pure returns (uint256) {
        return 0;
    }

    function __setInterestRateModel(address _interestRateModel) external {
        interestRateModel = _interestRateModel;
    }

    function __setTotalReserves(uint256 _totalReserves) external {
        totalReserves = _totalReserves;
    }

    function __setReserveFactorMantissa(uint256 _reserveFactorMantissa)
        external
    {
        reserveFactorMantissa = _reserveFactorMantissa;
    }

    function __setBalanceOfUnderlying(address account, uint256 amount)
        external
    {
        balanceOfUnderlying[account] = amount;
    }

    function __setAccountSnapShot(
        uint256 err,
        uint256 vTokenBalance,
        uint256 borrowBalance,
        uint256 exchangeRateMantissa
    ) external {
        _accountSnapShot.error = err;
        _accountSnapShot.vTokenBalance = vTokenBalance;
        _accountSnapShot.vTokenBalance = borrowBalance;
        _accountSnapShot.exchangeRateMantissa = exchangeRateMantissa;
    }

    function __setBorrowRatePerBlock(uint256 _borrowRatePerBlock) external {
        borrowRatePerBlock = _borrowRatePerBlock;
    }

    function __setSupplyRatePerBlock(uint256 _supplyRatePerBlock) external {
        supplyRatePerBlock = _supplyRatePerBlock;
    }

    function __setBorrowBalanceCurrent(
        address account,
        uint256 _borrowBalanceCurrent
    ) external {
        borrowBalanceCurrent[account] = _borrowBalanceCurrent;
    }

    function __setBorrowBalanceStored(
        address account,
        uint256 _borrowBalanceStored
    ) external {
        borrowBalanceStored[account] = _borrowBalanceStored;
    }

    function __setExchangeRateCurrent(uint256 _exchangeRateCurrent) external {
        exchangeRateCurrent = _exchangeRateCurrent;
    }

    function __setExchangeRateStored(uint256 _exchangeRateStored) external {
        exchangeRateStored = _exchangeRateStored;
    }

    function __setCash(uint256 cash) external {
        getCash = cash;
    }

    function __setAccrueInterest(uint256 _accrueInterest) external {
        accrueInterest = _accrueInterest;
    }

    function __setSeize(uint256 amount) external {
        _seize = amount;
    }

    function __setUnderlying(address _underlying) external {
        underlying = _underlying;
    }

    function __setRedeemReturn(uint128 amount) external {
        returnValues.redeem = amount;
    }

    function __setTotalBorrowsCurrent(uint256 amount) external {
        totalBorrowsCurrent = amount;
    }

    function __setRedeemUnlderyingValue(uint128 amount) external {
        mintValues.reddem = amount;
    }

    function __setBorrowReturn(uint128 amount) external {
        returnValues.borrow = amount;
    }

    function __setMintBorrowValue(uint128 amount) external {
        mintValues.borrow = amount;
    }

    function __setRepayReturnValue(uint128 amount) external {
        returnValues.repay = amount;
    }
}
