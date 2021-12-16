/*

▀█▀ █▀▀▄ ▀▀█▀▀ █▀▀ █▀▀█ █▀▀ █▀▀ ▀▀█▀▀ 　 ▒█▀▀▀ █▀▀█ █▀▀ ▀▀█▀▀ █▀▀█ █▀▀█ █░░█ 　 ▒█░░▒█ ▄█░ 
▒█░ █░░█ ░░█░░ █▀▀ █▄▄▀ █▀▀ ▀▀█ ░░█░░ 　 ▒█▀▀▀ █▄▄█ █░░ ░░█░░ █░░█ █▄▄▀ █▄▄█ 　 ░▒█▒█░ ░█░ 
▄█▄ ▀░░▀ ░░▀░░ ▀▀▀ ▀░▀▀ ▀▀▀ ▀▀▀ ░░▀░░ 　 ▒█░░░ ▀░░▀ ▀▀▀ ░░▀░░ ▀▀▀▀ ▀░▀▀ ▄▄▄█ 　 ░░▀▄▀░ ▄█▄

Copyright (c) 2021 Jose Cerqueira - All rights reserved

*/

//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

import "./interfaces/InterestMarketV1Interface.sol";

import "./Dinero.sol";

contract InterestFactoryV1 is Ownable {
    /**************************** EVENTS ****************************/

    event MarketCreated(
        address indexed collateralToken,
        address market,
        uint256 id
    );

    event StakerUpdated(address indexed market, address indexed staker);

    event FeeToUpdated(address indexed feeTo);

    /**************************** STATE ****************************/

    // solhint-disable-next-line var-name-mixedcase
    Dinero public immutable DINERO;

    // @notice The address that will get all fees accrued by the market contracts.
    address public feeTo;

    // @notice stores all markets created by this contract.
    address[] public allMarkets;

    mapping(address => bool) public isMarket;

    // @notice Returns the staker contract for a specific market.
    mapping(address => address) private _stakerMap;

    /**************************** CONSTRUCTOR ****************************/

    constructor(Dinero _dinero) {
        DINERO = _dinero;
    }

    /**************************** EXTERNAL FUNCTIONS ****************************/

    /**
     * @return The number of markets created by this factory.
     */
    function getAllMarketsLength() external view returns (uint256) {
        return allMarkets.length;
    }

    /**
     * @dev Returns the staker contract associated with a market.
     * @param market The account which we will find it's associated staker contract.
     * @return the associated staker contract to the `market`.
     *
     * Note that not all markets have associated staker contracts.
     *
     */
    function getStaker(address market) external view returns (address) {
        require(isMarket[market], "IFV1: not a market");
        return _stakerMap[market];
    }

    /**************************** ONLY OWNER FUNCTIONS ****************************/

    /**
     * @dev Sets a new staker contract for a market.
     * @param market The market to assign a new staker contract.
     * @param staker The new staker contract.
     *
     * This function has the modifier {onlyOwner} to ensure that only safe stakers are assigned.
     * It emits the event {StakerUpdated} with the new market and staker addresses
     *
     */
    function setStaker(address market, address staker) external onlyOwner {
        require(isMarket[market], "IFV1: not a market");
        _stakerMap[market] = staker;
        emit StakerUpdated(market, staker);
    }

    /**
     * @dev It assigns a new address to receive the accrued fees from the markets.
     * @param _feeTo The new address that will receive the fees.
     *
     * This funcion is guarded by the modifier {onlyOwner} to make sure funds are not mishandled.
     * It emits the event {FeeToUpdated} with the new address `_feeTo`.
     *
     */
    function setFeeTo(address _feeTo) external onlyOwner {
        require(_feeTo != address(0), "IFV1: not zero address");
        feeTo = _feeTo;
        emit FeeToUpdated(_feeTo);
    }

    /**
     * @dev This function allows for the creation of new markets via cloning using a master contract for gas optimization.
     * @param masterMarketContract The master implementation of a market contract.
     * @param collateralToken The {ERC20} that this market will support.
     * @param data The data required to initialize the clone contract.
     * @return market The address of the new market
     *
     * It emits the event {MarketCreated} with the market collateral token, market address and its id.
     * It is also guarded by the {onlyOwner} because these markets require trusted oracles and have the power of arbitrarly create and destroy {DINERO}
     *
     */
    function createMarket(
        address masterMarketContract,
        address collateralToken,
        bytes calldata data
    ) external onlyOwner returns (address market) {
        require(masterMarketContract != address(0), "IFV1: not zero address");
        require(collateralToken != address(0), "IFV1: not zero address");

        market = Clones.cloneDeterministic(
            masterMarketContract,
            keccak256(data)
        );

        InterestMarketV1Interface(market).initialize(data);

        DINERO.grantRole(DINERO.MINTER_ROLE(), market);
        DINERO.grantRole(DINERO.BURNER_ROLE(), market);
        isMarket[market] = true;
        allMarkets.push(market);

        emit MarketCreated(collateralToken, market, allMarkets.length);
    }
}
