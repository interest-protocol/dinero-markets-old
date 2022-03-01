# :seedling: Welcome to Interest Protocol! :seedling:

Interest Protocol is a decentralised protocol designed to provide money markets to all asset classes including NFTs, interest-bearing tokens and liquidity-provider tokens with high security.

## :money_with_wings: Features :money_with_wings:

- Borrow/Lend
- High Yield Stable Vaults
- Liquidity Farming

## :fire: Technology :fire:

The core technologies used are:

 - [Typescript](https://www.typescriptlang.org/)
 - [Hardhat](https://hardhat.org/)
 - [Solidity](https://docs.soliditylang.org/)
 - [OpenZeppelin](https://openzeppelin.com/)

## Developers

**Available as a package**

``` yarn add @interest-protocol/contracts ```

**Useful commands**

```

  yarn compile
  yarn coverage

```

## Underlying Protocols

Interest Protocol integrates with popular DeFi protocols to maximize the returns for users. 

**BSC Network:**

- [PancakeSwap](https://pancakeswap.finance/)
- [Chainlink](https://chain.link/)



## BSC Test Net V1 Contracts

**Upgradeable contracts follow the UUPS pattern**

| Name | | | |
| :----------------| :-------------------------------: | :-----------------------------: | :----------------------------:
|Dinero|[Proxy](https://testnet.bscscan.com/address/0x57486681D2E0Bc9B0494446b8c5df35cd20D4E92)            |[Implementation](https://testnet.bscscan.com/address/0xd273f40b3b398b03428020329e430528793edcb3)     | [Code](https://github.com/interest-protocol/v1-core/blob/main/contracts/tokens/Dinero.sol)
|Interest Token          |[Proxy](https://testnet.bscscan.com/address/0x0D7747F1686d67824dc5a299AAc09F438dD6aef2)            |[Implementation](https://testnet.bscscan.com/address/0x9aced15124500d1fe9c2bc08c4b37762e066fc83)           | [Code](https://github.com/interest-protocol/v1-core/blob/main/contracts/tokens/InterestToken.sol)
|Staked Interest Token          |[Proxy](https://testnet.bscscan.com/address/0x9a7704D56FF363eD836Fc09C34bA2663A96C71f8)|[Implementation](https://testnet.bscscan.com/address/0xB63D84823e4FDD14ba41876Ce3E68Db531484cb6)| [Code](https://github.com/interest-protocol/v1-core/blob/main/contracts/tokens/StakedInterestToken.sol) 
|NFT         |N/A|[Implementation](https://testnet.bscscan.com/address/0x0f6E2bA02F7641134E34Ed4dA05E2b877BD8F6D6)| [Code](https://github.com/interest-protocol/test-net/blob/main/contracts/NFT.sol)
|NFTMarket         |[Proxy](https://testnet.bscscan.com/address/0x37d309ffc97ED67d1DbC11b2e5F05367b599b073)|[Implementation](https://testnet.bscscan.com/address/0x22bc4f605b7db522c99887b72b2fe32ec3ff4c61)| [Code](https://github.com/interest-protocol/v1-core/blob/main/contracts/NFTMarket.sol)
|Casa de papel         |[Proxy](https://testnet.bscscan.com/address/0x4702a58ebdE5E09459052340dD1C1d818FE47D8B)|[Implementation](https://testnet.bscscan.com/address/0xa67cdd9eee0320b2994558b52113c2138c54cb24)| [Code](https://github.com/interest-protocol/v1-core/blob/main/contracts/CasaDePapel.sol)
|Library Wrapper         |N/A|[Implementation](https://testnet.bscscan.com/address/0xdDbd8Fc4ef78bC8f9646d2550107b0bf03Ee8369)| [Code](https://github.com/interest-protocol/v1-core/blob/main/contracts/LibraryWrapper.sol)
|Pancake Swap TWAP         |[Proxy](https://testnet.bscscan.com/address/0x4a4D156a3F9b31eD3e4EdE58AAFf8D004355577A)|[Implementation](https://testnet.bscscan.com/address/0x57ea7c23a54c25122a056e1b548a2624bc1d9c77)| [Code](https://github.com/interest-protocol/v1-core/blob/main/contracts/PancakeOracle.sol)
|OracleV1         |[Proxy](https://testnet.bscscan.com/address/0x601543e1C59FE2485e8dbA4298Dd97423AA92f0B)|[Implementation](https://testnet.bscscan.com/address/0x0e0da3de7343c21ca6f17818d5484eb082932b58)| [Code](https://github.com/interest-protocol/v1-core/blob/main/contracts/OracleV1.sol)
|BNB Interest Market         |[Proxy](https://testnet.bscscan.com/address/0x42c0017e00219FC51405De1f47A7d85a885E56c5)|[Implementation](https://testnet.bscscan.com/address/0x70a29a73a473feaf5b4a668ff753757289733e3e)| [Code](https://github.com/interest-protocol/v1-core/blob/main/contracts/InterestBNBMarket.sol)
|BTC Interest Market         |[Proxy](https://testnet.bscscan.com/address/0x06b4A3622410270C40621D2E8E855386c54c323f)|[Implementation](https://testnet.bscscan.com/address/0x25bed97287be9838782587fb3c7c5fa7add7176f)| [Code](https://github.com/interest-protocol/v1-core/blob/main/contracts/InterestMarketV1.sol)

## :thought_balloon: Philosophy :thought_balloon:

We do not follow the famous Facebook mantra of “Move fast and break things". Interest Protocol contracts will **never** go live before tests, audits, a test net MVP and when possible combed by a formal verification tool.

We chose upgradeable contracts so assure security post deployment and tweak settings based on community proposals. Our contracts will never go from V1.0.0 to V2.0.0 through an upgrade. A whole new contract will be deployed.

## Resources

Learn more about the UUPS pattern here:

- [OZ Article](https://blog.openzeppelin.com/workshop-recap-deploying-more-efficient-upgradeable-contracts/)
- [EIP-1822](https://eips.ethereum.org/EIPS/eip-1822)

## Social Media

**Get in touch!**

- info@interestprotocol.com
- [Twitter](https://twitter.com/interest_dinero)
- [Medium](https://medium.com/@interestprotocol)
- [Reddit](https://www.reddit.com/user/InterestProtocol)
- [Telegram](https://t.me/interestprotocol)
