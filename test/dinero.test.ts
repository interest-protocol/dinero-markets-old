import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { deploy } from '../lib/test-utils';
import { Dinero } from '../typechain';

const { parseEther } = ethers.utils;

// @dev We do not need to test the functions inherited by open zeppelin contracts as they are already tested and audited
describe('Dinero', () => {
  let dinero: Dinero;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  beforeEach(async () => {
    [[owner, alice, bob], dinero] = await Promise.all([
      ethers.getSigners(),
      deploy('Dinero'),
    ]);

    // Grant alice the BURNER_ROLE
    await dinero
      .connect(owner)
      .grantRole(await dinero.BURNER_ROLE(), alice.address);
  });

  describe('function: mint', () => {
    it('reverts if an account without the MINTER_ROLE calls it', async () => {
      const amount = parseEther('10');

      await expect(
        dinero.connect(alice).mint(alice.address, amount)
      ).to.revertedWith(
        'AccessControl: account 0x70997970c51812dc3a010c7d01b50e0d17dc79c8 is missing role 0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6'
      );
    });
    it('creates new tokens', async () => {
      const amount = parseEther('10');

      expect(await dinero.balanceOf(alice.address)).to.be.equal(0);

      await dinero.connect(owner).mint(alice.address, amount);

      expect(await dinero.balanceOf(alice.address)).to.be.equal(amount);
    });
  });

  describe('function: forcedBurn', async () => {
    it('reverts if an account without the BURNER_ROLE calls it', async () => {
      const amount = parseEther('10');

      await dinero.connect(owner).mint(alice.address, amount);

      await expect(
        dinero.connect(owner).forcedBurn(alice.address, amount)
      ).to.revertedWith(
        'AccessControl: account 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266 is missing role 0x3c11d16cbaffd01df69ce1c404f6340ee057498f5f00246190ea54220576a848'
      );
    });
    it('destroys tokens', async () => {
      const amount = parseEther('10');

      await dinero.connect(owner).mint(bob.address, amount);

      expect(await dinero.balanceOf(bob.address)).to.be.equal(amount);

      await dinero.connect(alice).forcedBurn(bob.address, amount);

      expect(await dinero.balanceOf(bob.address)).to.be.equal(0);
    });
  });
});
