import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { StakedInterestToken, TestStakedInterestTokenV2 } from '../typechain';
import {
  BURNER_ROLE,
  DEFAULT_ADMIN_ROLE,
  DEVELOPER_ROLE,
  MINTER_ROLE,
} from './lib/constants';
import { deployUUPS, upgrade } from './lib/test-utils';

const { parseEther } = ethers.utils;

describe('Staked Interest Token', () => {
  let stakedInterestToken: StakedInterestToken;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;

  beforeEach(async () => {
    [[owner, alice], stakedInterestToken] = await Promise.all([
      ethers.getSigners(),
      deployUUPS('StakedInterestToken'),
    ]);
  });

  describe('function: initialize', () => {
    it('reverts if you try to initialize', async () => {
      await expect(stakedInterestToken.initialize()).to.revertedWith(
        'Initializable: contract is already initialized'
      );
    });

    it('grants the deployer the right roles', async () => {
      expect(
        await stakedInterestToken.hasRole(DEVELOPER_ROLE, owner.address)
      ).to.be.equal(true);
      expect(
        await stakedInterestToken.hasRole(DEFAULT_ADMIN_ROLE, owner.address)
      ).to.be.equal(true);
    });
  });

  describe('function: mint', () => {
    it('reverts it is called by a caller without the MINTER_ROLE', async () => {
      await expect(
        stakedInterestToken
          .connect(alice)
          .mint(alice.address, parseEther('100'))
      ).to.revertedWith(
        'AccessControl: account 0x70997970c51812dc3a010c7d01b50e0d17dc79c8 is missing role 0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6'
      );
    });
    it('mints tokens', async () => {
      await stakedInterestToken
        .connect(owner)
        .grantRole(MINTER_ROLE, alice.address);

      expect(await stakedInterestToken.balanceOf(alice.address)).to.be.equal(0);

      await expect(
        stakedInterestToken
          .connect(alice)
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
      ).to.revertedWith(
        'AccessControl: account 0x70997970c51812dc3a010c7d01b50e0d17dc79c8 is missing role 0x3c11d16cbaffd01df69ce1c404f6340ee057498f5f00246190ea54220576a848'
      );
    });
    it('burns tokens', async () => {
      await Promise.all([
        stakedInterestToken
          .connect(owner)
          .grantRole(BURNER_ROLE, owner.address),
        stakedInterestToken
          .connect(owner)
          .grantRole(MINTER_ROLE, owner.address),
      ]);

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

  describe('Upgrade functionality', () => {
    it('reverts if a caller without the developer role tries to upgrade', async () => {
      await stakedInterestToken
        .connect(owner)
        .renounceRole(DEVELOPER_ROLE, owner.address);

      expect(
        upgrade(stakedInterestToken, 'TestStakedInterestTokenV2')
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('upgrades to version 2', async () => {
      await stakedInterestToken
        .connect(owner)
        .grantRole(MINTER_ROLE, alice.address);

      await stakedInterestToken
        .connect(alice)
        .mint(alice.address, parseEther('100'));

      const stakedInterestTokenV2: TestStakedInterestTokenV2 = await upgrade(
        stakedInterestToken,
        'TestStakedInterestTokenV2'
      );

      const [developerRole, version, aliceBalance] = await Promise.all([
        stakedInterestTokenV2.DEVELOPER_ROLE(),
        stakedInterestTokenV2.version(),
        stakedInterestTokenV2.balanceOf(alice.address),
      ]);

      expect(developerRole).to.be.equal(DEVELOPER_ROLE);
      expect(version).to.be.equal('V2');
      expect(aliceBalance).to.be.equal(parseEther('100'));
    });
  });
}).timeout(5000);
