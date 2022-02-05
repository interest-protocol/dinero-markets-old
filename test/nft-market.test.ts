import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { MockERC20, MockNFT, NFTMarket } from '../typechain';
import { advanceBlockAndTime, deploy, multiDeploy } from './lib/test-utils';

const { parseEther } = ethers.utils;

describe('NFTMarket', () => {
  let btc: MockERC20;
  let usdc: MockERC20;
  let nft: MockNFT;
  let nftMarket: NFTMarket;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let feeTo: SignerWithAddress;

  beforeEach(async () => {
    [[btc, usdc, nft], [owner, alice, bob, feeTo]] = await Promise.all([
      multiDeploy(
        ['MockERC20', 'MockERC20', 'MockNFT'],
        [
          ['Bitcoin', 'BTC', parseEther('10000')],
          ['USDC', 'USDC', parseEther('10000')],
          ['Bored Ape Yatch Club', ' BAYC'],
        ]
      ),
      ethers.getSigners(),
    ]);

    nftMarket = await deploy('NFTMarket', [feeTo.address]);

    await Promise.all([
      nft.mint(alice.address, 1),
      nft.connect(alice).setApprovalForAll(nftMarket.address, true),
    ]);
  });

  describe('function: proposeLoan', () => {
    it.only('reverts if the msg.sender is not the owner of the NFT', async () => {
      await expect(
        nftMarket.connect(bob).proposeLoan(nft.address, btc.address, 1, 0, 0, 0)
      ).to.revertedWith('NFTM: must be nft owner');
    });
  });
});
