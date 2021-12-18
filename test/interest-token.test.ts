import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { deploy } from '../lib/test-utils';
import { InterestToken } from '../typechain';

const { parseEther } = ethers.utils;

// We only need to test the mint function because the contracts from open zeppelin are already tested
describe('Interest Token', () => {
  let interestToken: InterestToken;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;

  beforeEach(async () => {
    [[owner, alice], interestToken] = await Promise.all([
      ethers.getSigners(),
      deploy('InterestToken'),
    ]);
  });

  describe('function: mint', () => {
    it('reverts if the caller is not the owner', async () => {
      await expect(
        interestToken.connect(alice).mint(alice.address, 1000)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('mints tokens if it called by the owner', async () => {
      expect(await interestToken.balanceOf(alice.address)).to.be.equal(0);
      await interestToken.connect(owner).mint(alice.address, parseEther('100'));
      expect(await interestToken.balanceOf(alice.address)).to.be.equal(
        parseEther('100')
      );
    });
  });
});
