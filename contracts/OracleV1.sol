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

// @important This oracle only supports tokens with 18 decimal houses
contract OracleV1 is Ownable {
    /****************************  ENUMS ****************************/

    enum FeedType {
        USD,
        BNB
    }

    /****************************  STATE ****************************/

    // solhint-disable-next-line var-name-mixedcase
    AggregatorV3Interface public immutable BNB_USD;

    // solhint-disable-next-line var-name-mixedcase
    address public immutable WBNB;

    mapping(address => AggregatorV3Interface) public getUSDBaseFeeds;
    mapping(address => AggregatorV3Interface) public getBNBBaseFeeds;

    /****************************  CONSTRUCTOR ****************************/

    // solhint-disable-next-line var-name-mixedcase
    constructor(AggregatorV3Interface bnb_usd, address wbnb) {
        BNB_USD = bnb_usd;
        WBNB = wbnb;
    }

    /****************************  PRIVATE FUNCTIONS ****************************/

    /**
     * @dev Adjusts the price to have 18 decimal houses to work easier with most {ERC20}
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

    /****************************  VIEW FUNCTIONS ****************************/

    /**
     * @dev This function returns usd value of {ERC20} tokens and checks if they are a PCS LP token or not
     * @param token The address of the {ERC20} token
     * @param amount The number of `token` to evaluate the USD amount
     * @return usdValue The value in usd supporting 18 decimal houses
     */
    function getUSDPrice(address token, uint256 amount)
        external
        view
        returns (uint256 usdValue)
    {
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
     * @dev This function returns the adjust price to 18 decimal houses for the caller
     * @param token The address of the token for the feed
     * @param amount How many tokens you want the price to be
     * @return uint256 The price of the token in USD adjust to 18 decimals
     *
     */
    function getTokenUSDPrice(address token, uint256 amount)
        public
        view
        returns (uint256)
    {
        require(token != address(0), "Oracle: no address zero");
        if (token == WBNB) return getBNBUSDPrice(amount);

        AggregatorV3Interface feed = getUSDBaseFeeds[token];
        (, int256 price, , , ) = feed.latestRoundData();
        return (_scaleDecimals(price, feed.decimals()) * amount) / 1 ether;
    }

    /**
     * @dev It returns the both price BNB and USD value for an amount of LP tokens based on it's pair
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
        valueInBNB = (fairBNBValue * amount) / 1 ether;
        valueInUSD = (valueInBNB * getBNBUSDPrice(1 ether)) / 1 ether;
    }

    /**
     * @dev calculates the price in BNB for 1 lp token based on the K of the pair. Wanna thank Alpha Finance for this <3!
     * @param pair The Pancakeswap pair to find it's fair BNB value.
     * @return uint256 price of 1 lp token in BNB
     *
     * The formula breakdown can be found in the links below
     * https://cmichel.io/pricing-lp-tokens/
     * https://blog.alphafinance.io/fair-lp-token-pricing/
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

        uint256 sqrtK = Math.sqrt(reserve0 * (reserve1)) / totalSupply;

        uint256 price0 = getTokenBNBPrice(token0, 1 ether);
        uint256 price1 = getTokenBNBPrice(token1, 1 ether);

        return (((sqrtK * 2 * (Math.sqrt(price0)))) * (Math.sqrt(price1)));
    }

    /**
     * @dev This function returns the adjust price to 18 decimal houses for the caller
     * @param token The address of the token for the feed
     * @param amount The number of tokens to calculate the price with
     * @return uint256 The price of the token in BNB adjust to 18 decimals
     *
     */
    function getTokenBNBPrice(address token, uint256 amount)
        public
        view
        returns (uint256)
    {
        if (token == WBNB) return amount;
        require(token != address(0), "Oracle: no address zero");

        AggregatorV3Interface feed = getBNBBaseFeeds[token];
        (, int256 price, , , ) = feed.latestRoundData();
        return (_scaleDecimals(price, feed.decimals()) * amount) / 1 ether;
    }

    /**
     * @param amount How many BNB one wishes to get the price for
     * @return uint256 A pair that has the value price and the decimal houses in the right
     *
     * This function returns the price of 1 BNB in USD
     *
     */
    function getBNBUSDPrice(uint256 amount) public view returns (uint256) {
        (, int256 price, , , ) = BNB_USD.latestRoundData();

        // @dev We increase the decimals of BNB value to 18 to work with {ERC20}
        return (_scaleDecimals(price, BNB_USD.decimals()) * amount) / 1 ether;
    }

    /****************************  OWNER ONLY FUNCTIONS ****************************/

    /**
     * @dev Sets a chain link {AggregatorV3Interface} feed for an asset.
     * @param asset The token that will be associated with a feed.
     * @param feed The address of the chain link oracle contract.
     * @param feedType A enum representing which kind of feed to update
     *
     * **** IMPORTANT **** nt this function only supports tokens with 18 decimals
     * This function has the modifier {onlyOwner} so an attacker cannot use a fraudalent oracle.
     * You can find the avaliable feeds here https://docs.chain.link/docs/binance-smart-chain-addresses/ .
     *
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
