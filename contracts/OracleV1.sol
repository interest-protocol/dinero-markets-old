/*


██╗███╗░░██╗████████╗███████╗██████╗░███████╗░██████╗████████╗  ░█████╗░██████╗░░█████╗░░█████╗░██╗░░░░░███████╗
██║████╗░██║╚══██╔══╝██╔════╝██╔══██╗██╔════╝██╔════╝╚══██╔══╝  ██╔══██╗██╔══██╗██╔══██╗██╔══██╗██║░░░░░██╔════╝
██║██╔██╗██║░░░██║░░░█████╗░░██████╔╝█████╗░░╚█████╗░░░░██║░░░  ██║░░██║██████╔╝███████║██║░░╚═╝██║░░░░░█████╗░░
██║██║╚████║░░░██║░░░██╔══╝░░██╔══██╗██╔══╝░░░╚═══██╗░░░██║░░░  ██║░░██║██╔══██╗██╔══██║██║░░██╗██║░░░░░██╔══╝░░
██║██║░╚███║░░░██║░░░███████╗██║░░██║███████╗██████╔╝░░░██║░░░  ╚█████╔╝██║░░██║██║░░██║╚█████╔╝███████╗███████╗
╚═╝╚═╝░░╚══╝░░░╚═╝░░░╚══════╝╚═╝░░╚═╝╚══════╝╚═════╝░░░░╚═╝░░░  ░╚════╝░╚═╝░░╚═╝╚═╝░░╚═╝░╚════╝░╚══════╝╚══════╝

*/

//SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "@openzeppelin/contracts/access/Ownable.sol";

import "./interfaces/AggregatorV3Interface.sol";
import "./interfaces/IPancakePair.sol";

import "./lib/Math.sol";

/**
 * @dev A wrapper around the Chainlink oracles to feed prices to the markets. It aims to house all oracle logic of the protocol.
 *
 * @notice Security of this contract relies on Chainlink.
 * @notice The exchange rate returned has a base unit of 1e18.
 * @notice It supports LP tokens.
 * @notice We intend to add a back up oracle using PCS TWAPS before main net release.
 * @notice It does not treat in case of a price of 0 or failure.
 * @notice Only supports tokens supported by Chainlink  https://docs.chain.link/docs/binance-smart-chain-addresses/.
 */
contract OracleV1 is Ownable {
    /*///////////////////////////////////////////////////////////////
                                ENUMS
    //////////////////////////////////////////////////////////////*/

    // To dictate if it is a BNB or USD feed.
    enum FeedType {
        USD,
        BNB
    }

    /*///////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    // solhint-disable-next-line var-name-mixedcase
    AggregatorV3Interface public immutable BNB_USD;

    // solhint-disable-next-line var-name-mixedcase
    address public immutable WBNB;

    // Token Address -> Chainlink feed with USD base.
    mapping(address => AggregatorV3Interface) public getUSDBaseFeeds;
    // Token Address -> Chainlink feed with BNB base.
    mapping(address => AggregatorV3Interface) public getBNBBaseFeeds;

    /*///////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @param bnb_usd The chainlink feed for bnb/usd.
     * @param wbnb The address for WBNB.
     */
    // solhint-disable-next-line var-name-mixedcase
    constructor(AggregatorV3Interface bnb_usd, address wbnb) {
        BNB_USD = bnb_usd;
        WBNB = wbnb;
    }

    /*///////////////////////////////////////////////////////////////
                            PRIVATE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Adjusts the price to have 18 decimal houses to work easier with most {ERC20}.
     *
     * @notice It converts int256 to uint256. Because of the chainlink price feed.
     *
     * @param price The price of the token
     * @param decimals The current decimals the price has
     * @return uint256 the new price supporting 18 decimal houses
     */
    function _scaleDecimals(int256 price, uint8 decimals)
        private
        pure
        returns (uint256)
    {
        uint256 baseDecimals = 18;
        uint256 _price = uint256(price);
        if (decimals < baseDecimals) {
            return _price * 10**uint256(baseDecimals - decimals);
        } else if (decimals > baseDecimals) {
            return _price / 10**uint256(decimals - baseDecimals);
        }
        return _price;
    }

    /*///////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev It returns usd value of {ERC20} tokens and checks if they are a PCS LP token or not.
     *
     * @notice Note the usd price has a base unit of 1e18.
     *
     * @param token The address of the {ERC20} token
     * @param amount The number of `token` to evaluate the USD amount
     * @return usdValue The value in usd.
     */
    function getUSDPrice(address token, uint256 amount)
        external
        view
        returns (uint256 usdValue)
    {
        // Check if it is a pancake pair.
        if (
            keccak256(abi.encodePacked(IPancakePair(token).symbol())) ==
            keccak256("Cake-LP")
        ) {
            (, usdValue) = getLPTokenPx(IPancakePair(token), amount);
        } else {
            usdValue = getTokenUSDPrice(token, amount);
        }
    }

    /**
     * @dev It calls chainlink to get the USD price of a token and adjusts the decimals.
     *
     * @param token The address of the token for the feed.
     * @param amount The number of tokens to calculate the value in USD.
     * @return uint256 The price of the token in USD.
     */
    function getTokenUSDPrice(address token, uint256 amount)
        public
        view
        returns (uint256)
    {
        require(token != address(0), "Oracle: no address zero");
        // BNB feed is not saved in a mapping for gas optimization.
        if (token == WBNB) return getBNBUSDPrice(amount);

        AggregatorV3Interface feed = getUSDBaseFeeds[token];
        (, int256 price, , , ) = feed.latestRoundData();
        // Since amount and price both have a base unit of 1e18, we need to divide by 1e18.
        return (_scaleDecimals(price, feed.decimals()) * amount) / 1 ether;
    }

    /**
     * @dev It returns the both price BNB and USD value for an amount of LP tokens based on the fair liquidity.
     *
     * @param pair The Pancake pair we wish to get the fair bnb value
     * @param amount The number of LPs we wish to have the value for
     * @return valueInBNB valueInUSD (uint256 , uint256) A pair with both the value in BNB and USD
     */
    function getLPTokenPx(IPancakePair pair, uint256 amount)
        public
        view
        returns (uint256 valueInBNB, uint256 valueInUSD)
    {
        uint256 fairBNBValue = getLPTokenBNBPrice(pair);
        // Since amount and price both have a base unit of 1e18, we need to divide by 1e18.
        valueInBNB = (fairBNBValue * amount) / 1 ether;
        // Since bnb and usd both have a base unit of 1e18, we need to divide by 1e18.
        valueInUSD = (valueInBNB * getBNBUSDPrice(1 ether)) / 1 ether;
    }

    /**
     * @dev It calculates the price in BNB for 1 lp token based on the K of the pair. Wanna thank Alpha Finance for this <3!
     *
     * @param pair The Pancakeswap pair to find it's fair BNB value.
     * @return uint256 price of 1 lp token in BNB
     *
     * The formula breakdown can be found in the links below:
     *
     * https://cmichel.io/pricing-lp-tokens/
     * https://blog.alphafinance.io/fair-lp-token-pricing/
     *
     * We changed the implementation from alpha finance to remove the Q112 encoding found here:
     * https://github.com/AlphaFinanceLab/alpha-homora-v2-contract/blob/master/contracts/oracle/UniswapV2Oracle.sol
     *
     */
    function getLPTokenBNBPrice(IPancakePair pair)
        public
        view
        returns (uint256)
    {
        address token0 = pair.token0();
        address token1 = pair.token1();
        uint256 totalSupply = pair.totalSupply();
        (uint256 reserve0, uint256 reserve1, ) = pair.getReserves();

        // Get square root of K
        uint256 sqrtK = Math.sqrt(reserve0 * (reserve1)) / totalSupply;

        // Relies on chainlink to get the token value in BNB
        uint256 price0 = getTokenBNBPrice(token0, 1 ether);
        uint256 price1 = getTokenBNBPrice(token1, 1 ether);

        // Get fair price of LP token in BNB by re-engineering the K formula.
        return (((sqrtK * 2 * (Math.sqrt(price0)))) * (Math.sqrt(price1)));
    }

    /**
     * @dev It returns the the price of a token in BNB terms.
     *
     * @param token The address of the token for the feed
     * @param amount The number of tokens to calculate the price with
     * @return uint256 The price of the token in BNB adjust to 18 decimals
     */
    function getTokenBNBPrice(address token, uint256 amount)
        public
        view
        returns (uint256)
    {
        // 1 BNB is always 1 BNB
        if (token == WBNB) return amount;
        require(token != address(0), "Oracle: no address zero");

        AggregatorV3Interface feed = getBNBBaseFeeds[token];
        (, int256 price, , , ) = feed.latestRoundData();
        return (_scaleDecimals(price, feed.decimals()) * amount) / 1 ether;
    }

    /**
     * @dev Get the current price of BNB in USD.
     *
     * @param amount How many BNB one wishes to get the price for
     * @return uint256 A pair that has the value price and the decimal houses in the right
     */
    function getBNBUSDPrice(uint256 amount) public view returns (uint256) {
        (, int256 price, , , ) = BNB_USD.latestRoundData();

        // @dev We increase the decimals of BNB value to 18 to work with {ERC20}
        return (_scaleDecimals(price, BNB_USD.decimals()) * amount) / 1 ether;
    }

    /*///////////////////////////////////////////////////////////////
                            OWNER ONLY FUNCTION
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Sets a chain link {AggregatorV3Interface} feed for an asset.
     *
     * @param asset The token that will be associated with a feed.
     * @param feed The address of the chain link oracle contract.
     * @param feedType A enum representing which kind of feed to update
     *
     * **** IMPORTANT ****
     * @notice This contract only supports tokens with 18 decimals.
     * @notice You can find the avaliable feeds here https://docs.chain.link/docs/binance-smart-chain-addresses/
     *
     * Requirements:
     *
     * - This function has the modifier {onlyOwner} because the whole protocol depends on the quality and veracity of these feeds. It will be behind a multisig and timelock as soon as possible.
     */
    function setFeed(
        address asset,
        AggregatorV3Interface feed,
        FeedType feedType
    ) external onlyOwner {
        if (feedType == FeedType.BNB) {
            getBNBBaseFeeds[asset] = feed;
        } else {
            getUSDBaseFeeds[asset] = feed;
        }
    }
}
