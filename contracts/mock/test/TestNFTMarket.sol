//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

import "../../NFTMarket.sol";

//solhint-disable
contract TestNFTMarket is NFTMarket {
    function stealBNB() external {
        (bool s, ) = payable(msg.sender).call{value: address(this).balance}("");
        assert(s);
    }
}
