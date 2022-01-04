import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { StakedInterestToken } from '../typechain';
import { deploy } from './lib/test-utils';

const { parseEther } = ethers.utils;

describe('Staked Interest Token', () => {
  let stakedInterestToken: StakedInterestToken;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;

  beforeEach(async () => {
    [[owner, alice], stakedInterestToken] = await Promise.all([
      ethers.getSigners(),
      deploy('StakedInterestToken'),
    ]);
  });

  describe('function: mint', () => {
    it('reverts if the is not called by the owner', async () => {
      await expect(
        stakedInterestToken
          .connect(alice)
          .mint(alice.address, parseEther('100'))
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('mints tokens', async () => {
      expect(await stakedInterestToken.balanceOf(alice.address)).to.be.equal(0);
      await expect(
        stakedInterestToken
          .connect(owner)
          .mint(alice.address, parseEther('100'))
      )
        .to.emit(stakedInterestToken, 'Transfer')
        .withArgs(
          ethers.constants.AddressZero,
          alice.address,
          parseEther('100')
        );

      expect(await stakedInterestToken.balanceOf(alice.address)).to.be.equal(
        parseEther('100')
      );
    });
  });
  describe('function: burn', () => {
    it('reverts if the is not called by the owner', async () => {
      await expect(
        stakedInterestToken
          .connect(alice)
          .burn(alice.address, parseEther('100'))
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('burns tokens', async () => {
      await stakedInterestToken
        .connect(owner)
        .mint(alice.address, parseEther('100'));
      expect(await stakedInterestToken.balanceOf(alice.address)).to.be.equal(
        parseEther('100')
      );
      await expect(
        stakedInterestToken.connect(owner).burn(alice.address, parseEther('50'))
      )
        .to.emit(stakedInterestToken, 'Transfer')
        .withArgs(
          alice.address,
          ethers.constants.AddressZero,
          parseEther('50')
        );

      expect(await stakedInterestToken.balanceOf(alice.address)).to.be.equal(
        parseEther('50')
      );
    });
  });
});
