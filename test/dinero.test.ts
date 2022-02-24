import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { Dinero, TestDineroV2 } from '../typechain';
import { BURNER_ROLE, DEVELOPER_ROLE, MINTER_ROLE } from './lib/constants';
import { deployUUPS, upgrade } from './lib/test-utils';

const { parseEther } = ethers.utils;

// @dev We do not need to test the functions inherited by open zeppelin contracts as they are already tested and audited
// The burn and burnFrom functions were copied from open zeppelin so we do not need to test them as well
describe('Dinero', () => {
  let dinero: Dinero;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;

  beforeEach(async () => {
    [[owner, alice], dinero] = await Promise.all([
      ethers.getSigners(),
      deployUUPS('Dinero'),
    ]);
  });

  it('reverts if you try to initialize', async () => {
    await expect(dinero.initialize()).to.revertedWith(
      'Initializable: contract is already initialized'
    );
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

      // Admin needs to grant the `MINTER_ROLE`
      await dinero.connect(owner).grantRole(MINTER_ROLE, owner.address);

      await dinero.connect(owner).mint(alice.address, amount);

      expect(await dinero.balanceOf(alice.address)).to.be.equal(amount);
    });
  });
  describe('function: burn', () => {
    it('reverts if an account without the BURNER_ROLE calls it', async () => {
      const amount = parseEther('10');

      await expect(
        dinero.connect(alice).burn(alice.address, amount)
      ).to.revertedWith(
        'AccessControl: account 0x70997970c51812dc3a010c7d01b50e0d17dc79c8 is missing role 0x3c11d16cbaffd01df69ce1c404f6340ee057498f5f00246190ea54220576a848'
      );
    });
    it('creates new tokens', async () => {
      const amount = parseEther('10');
      await Promise.all([
        dinero.connect(owner).grantRole(BURNER_ROLE, owner.address),
        dinero.connect(owner).grantRole(MINTER_ROLE, owner.address),
      ]);

      await dinero.connect(owner).mint(alice.address, amount);

      expect(await dinero.balanceOf(alice.address)).to.be.equal(
        parseEther('10')
      );

      await expect(dinero.connect(owner).burn(alice.address, parseEther('8')))
        .to.emit(dinero, 'Transfer')
        .withArgs(alice.address, ethers.constants.AddressZero, parseEther('8'));

      expect(await dinero.balanceOf(alice.address)).to.be.equal(
        parseEther('2')
      );
    });
  });
  it('updates to version 2', async () => {
    await dinero.connect(owner).grantRole(MINTER_ROLE, owner.address);

    await dinero.connect(owner).mint(alice.address, parseEther('1000'));

    expect(await dinero.balanceOf(alice.address)).to.be.equal(
      parseEther('1000')
    );

    const dineroV2: TestDineroV2 = await upgrade(dinero, 'TestDineroV2');

    await dineroV2.connect(owner).initializeV2(1);

    await dineroV2.connect(owner).mint(alice.address, parseEther('250'));

    await expect(
      dineroV2.connect(alice).mint(alice.address, parseEther('111'))
    ).to.revertedWith(
      'AccessControl: account 0x70997970c51812dc3a010c7d01b50e0d17dc79c8 is missing role 0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6'
    );

    const [aliceBalance, state, version, developerRole] = await Promise.all([
      dineroV2.balanceOf(alice.address),
      dineroV2.state(),
      dineroV2.version(),
      dineroV2.DEVELOPER_ROLE(),
    ]);

    // Maintains the same state
    expect(aliceBalance).to.be.equal(parseEther('1250'));
    expect(state).to.be.equal(1);
    expect(version).to.be.equal('V2');
    expect(developerRole).to.be.equal(DEVELOPER_ROLE);
  });
});
