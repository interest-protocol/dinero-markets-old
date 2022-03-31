// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract MockNFT is ERC721 {
    constructor(string memory name, string memory symbol)
        ERC721(name, symbol)
    //solhint-disable-next-line no-empty-blocks
    {

    }

    function mint(address to, uint256 tokenId) external {
        _safeMint(to, tokenId);
    }
}
