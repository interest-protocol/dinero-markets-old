//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "./interfaces/IPancakeFactory.sol";
import "./interfaces/IPancakePair.sol";

import "./lib/FixedPoint.sol";
import "./lib/PancakeLibrary.sol";
import "./lib/UniswapV2OracleLibrary.sol";

/**
 * @notice This is a copy of the https://github.com/Uniswap/v2-periphery/blob/master/contracts/examples/ExampleSlidingWindowOracle.sol#L5
 * @notice We make the library a seperate contract to be able to test it properly.
 * It has some modifications for new solidity and changes to follow the UPPS pattern
 */
contract PancakeOracle is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    /*///////////////////////////////////////////////////////////////
                            LIBRARIES
    //////////////////////////////////////////////////////////////*/
    using FixedPoint for *;

    /*///////////////////////////////////////////////////////////////
                            EVENTS
    //////////////////////////////////////////////////////////////*/

    event Update(
        address indexed pair,
        uint256 price0Cumulative,
        uint256 price1Cumulative,
        uint256 timestamp
    );

    /*///////////////////////////////////////////////////////////////
                            STRUCTS
    //////////////////////////////////////////////////////////////*/

    struct Observation {
        uint256 timestamp;
        uint256 price0Cumulative;
        uint256 price1Cumulative;
    }

    /*///////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    // Pancake Swap Factory
    // solhint-disable-next-line var-name-mixedcase
    address internal constant FACTORY =
        0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;

    // Time that will be used to compute the window of the moving average. 24 hours is enough to make an attack impractical.
    // solhint-disable-next-line var-name-mixedcase
    uint256 public WINDOW_SIZE;
    // the number of observations stored for each pair, i.e. how many price observations are stored for the window.
    // as granularity increases from 1, more frequent updates are needed, but moving averages become more precise.
    // averages are computed over intervals with sizes in the range:
    //   [windowSize - (windowSize / granularity) * 2, windowSize]
    // e.g. if the window size is 24 hours, and the granularity is 24, the oracle will return the average price for
    //   the period:
    //   [now - [22 hours, 24 hours], now]
    // solhint-disable-next-line var-name-mixedcase
    uint8 public GRANULARITY;
    // this is redundant with granularity and windowSize, but stored for gas savings & informational purposes.
    // solhint-disable-next-line var-name-mixedcase
    uint256 public PERIOD_SIZE;

    // mapping from pair address to a list of price observations of that pair
    mapping(address => Observation[]) public pairObservations;

    /*///////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @param windowSize The time used to calculate the moving average.
     * @param granularity How many data points to record during the `windowSize`.
     *
     * Requirements:
     *
     * - Can only be called at once and should be called during creation to prevent front running.
     */
    function initialize(uint256 windowSize, uint8 granularity)
        external
        initializer
    {
        // `_granularity` lower than makes no sense in the context of moxing average: [windowSize - (windowSize / granularity) * 2, windowSize]
        require(granularity > 1, "PO: granularity > 1");
        // Make sure to use numbers that do not require rounding.
        assert(
            (PERIOD_SIZE = windowSize / granularity) * granularity == windowSize
        );

        __Ownable_init();

        WINDOW_SIZE = windowSize;
        GRANULARITY = granularity;
    }

    /*///////////////////////////////////////////////////////////////
                        VIEW PUBLIC FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev A helper function to find the index of a timestamp
     *
     * @param timestamp The function returns in which index the data for this timestamp is saved on {pairObservations}.
     * @return index The index of the `timestamp` in {pairObservations}.
     */
    function observationIndexOf(uint256 timestamp)
        public
        view
        returns (uint8 index)
    {
        // Split the total time by the period size to get a time slot.
        // If {WINDOW_SIZE} is 24 hours, {GRANULARITY} is 4 hours and {PERIOD_SIZE} is 6 hours.
        // E.g. In a `timestamp` of 72 hours, if we divide by a period size of 6 would give us 12.
        // 12 % 4 would give us index 0.
        return uint8((timestamp / PERIOD_SIZE) % GRANULARITY);
    }

    /*///////////////////////////////////////////////////////////////
                              MUTATIVE PUBLIC FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev This function will update the cumulative price for a given pair.
     *
     * @notice It has to be called once every {GRANULARITY}
     * @param tokenA the first token of the pair
     * @param tokenB the second token of the pair
     *
     * Requirements:
     *
     * - We require that the pair actually exists; otherwise, there is no point to update it.
     */
    function update(address tokenA, address tokenB) external {
        uint256 granularity = GRANULARITY;

        address pair = IPancakeFactory(FACTORY).getPair(tokenA, tokenB);
        require(pair != address(0), "PO: pair does not exist");

        // populate the array with empty observations (first call only)
        for (uint256 i = pairObservations[pair].length; i < granularity; i++) {
            pairObservations[pair].push();
        }

        //solhint-disable-next-line not-rely-on-time
        uint8 index = observationIndexOf(block.timestamp);

        // Get the old observation saved in the current timeslot
        Observation memory observation = pairObservations[pair][index];

        // How much time has passed
        //solhint-disable-next-line not-rely-on-time
        uint256 timeElapsed = block.timestamp - observation.timestamp;
        // we only want to commit updates once per period (i.e. windowSize / granularity)
        if (timeElapsed > PERIOD_SIZE) {
            (
                uint256 price0Cumulative,
                uint256 price1Cumulative,

            ) = UniswapV2OracleLibrary.currentCumulativePrices(pair);
            //solhint-disable-next-line not-rely-on-time
            observation.timestamp = block.timestamp;
            observation.price0Cumulative = price0Cumulative;
            observation.price1Cumulative = price1Cumulative;

            pairObservations[pair][index] = observation;

            emit Update(
                pair,
                price0Cumulative,
                price1Cumulative,
                //solhint-disable-next-line not-rely-on-time
                block.timestamp
            );
        }
    }

    /**
     * @dev The oracle function to get the current price of a token
     *
     * @notice This uses a sliding moving average formula. It means the prices will be computed based on {WINDOW_SIZE}.
     * And prices will be updated every {PERIOD_SIZE}.
     *
     * @param tokenIn The token X used to buy the token Y. Example swapping USDC for ETH.
     * @param amountIn How much amount i wish to swap. So how much USDC i want to swap for ETH.
     * @param tokenOut The token I wish to buy. In this case ETH.
     * @return amountOut how much `tokenOut` you will get for swapping `amountIn` of `tokenIn`.
     */
    function consult(
        address tokenIn,
        uint256 amountIn,
        address tokenOut
    ) external view returns (uint256 amountOut) {
        uint256 windowSize = WINDOW_SIZE;

        // Get pair based on the tokens
        address pair = PancakeLibrary.pairFor(FACTORY, tokenIn, tokenOut);

        // Get the first observation in the {WINDOW_SIZE}
        // If the window size is 24 hours. Get the observation made 24 hours ago.
        Observation memory firstObservation = _getFirstObservationInWindow(
            pair
        );

        //solhint-disable-next-line not-rely-on-time
        uint256 timeElapsed = block.timestamp - firstObservation.timestamp;

        // If the earliest observation for the window is larger than the window. It does not belong to this cycle
        // It is an oudated price, which means the oracle has not been updated
        require(windowSize >= timeElapsed, "PO: missing observation");
        // If the condition above passes and the require in the constructor as well. This should never happen.
        assert(timeElapsed >= windowSize - PERIOD_SIZE * 2);

        // Get current cumulative prices
        (
            uint256 price0Cumulative,
            uint256 price1Cumulative,

        ) = UniswapV2OracleLibrary.currentCumulativePrices(pair);
        // Need to sort tokens to know the correct price cumulative
        (address token0, ) = PancakeLibrary.sortTokens(tokenIn, tokenOut);

        return
            token0 == tokenIn
                ? _computeAmountOut(
                    firstObservation.price0Cumulative,
                    price0Cumulative,
                    timeElapsed,
                    amountIn
                )
                : _computeAmountOut(
                    firstObservation.price1Cumulative,
                    price1Cumulative,
                    timeElapsed,
                    amountIn
                );
    }

    /*///////////////////////////////////////////////////////////////
                              VIEW PRIVATE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev A helper function to first the first observation based on the current {block.timestamp}
     *
     * @param pair The address of the PCS pair we need to find the first observation
     */
    function _getFirstObservationInWindow(address pair)
        private
        view
        returns (Observation memory)
    {
        // Get the index of the current timestamp
        //solhint-disable-next-line not-rely-on-time
        uint8 index = observationIndexOf(block.timestamp);

        // If current index is 3 with granularity 4. We need to add one to properly find the first slot
        // E.g. 0-1-2-3 | 3 + 1 % 4 = 0. Which means at index 3 the first observation is stored at index 0
        // Following the same logic for index 2, the first observation is stored at index 3.
        return pairObservations[pair][(index + 1) % GRANULARITY];
    }

    /**
     * @dev A helper function to find the current price of a token
     *
     * @param priceCumulativeStart The cumulative price in the past
     * @param priceCumulativeEnd The current cumulative price
     * @param timeElapsed How much time has passed between `priceCumulativeStart` and `priceCumulativeEnd`
     * @param amountIn How much is being bought
     * @return the current price of the token based on an amount
     */
    function _computeAmountOut(
        uint256 priceCumulativeStart,
        uint256 priceCumulativeEnd,
        uint256 timeElapsed,
        uint256 amountIn
    ) private pure returns (uint256) {
        // overflow is desired.
        FixedPoint.uq112x112 memory priceAverage = FixedPoint.uq112x112(
            uint224((priceCumulativeEnd - priceCumulativeStart) / timeElapsed)
        );
        return priceAverage.mul(amountIn).decode144();
    }

    /*///////////////////////////////////////////////////////////////
                          OWNER ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev A hook to guard the address that can update the implementation of this contract. It must be the owner.
     */
    function _authorizeUpgrade(address)
        internal
        view
        override
        onlyOwner
    //solhint-disable-next-line no-empty-blocks
    {

    }
}
