import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { InterestToken, TestInterestTokenV2 } from '../typechain';
import {
  DEFAULT_ADMIN_ROLE,
  DEVELOPER_ROLE,
  MINTER_ROLE,
} from './lib/constants';
import { deployUUPS, upgrade } from './lib/test-utils';

const { parseEther } = ethers.utils;

// We only need to test the mint function because the contracts from open zeppelin are already tested
describe('Interest Token', () => {
  let interestToken: InterestToken;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;

  beforeEach(async () => {
    [[owner, alice], interestToken] = await Promise.all([
      ethers.getSigners(),
      deployUUPS('InterestToken'),
    ]);
  });

  describe('function: initialize', () => {
    it('reverts if you try to initialize', async () => {
      await expect(interestToken.initialize()).to.revertedWith(
        'Initializable: contract is already initialized'
      );
    });

    it('grants developer role to the deployer', async () => {
      expect(
        await interestToken.hasRole(DEVELOPER_ROLE, owner.address)
      ).to.be.equal(true);
      expect(
        await interestToken.hasRole(DEFAULT_ADMIN_ROLE, owner.address)
      ).to.be.equal(true);
    });
  });

  describe('function: mint', () => {
    it('reverts if the caller does not have the MINTER ROLE', async () => {
      await expect(
        interestToken.connect(alice).mint(alice.address, 1000)
      ).to.revertedWith(
        'AccessControl: account 0x70997970c51812dc3a010c7d01b50e0d17dc79c8 is missing role 0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6'
      );
    });
    it('mints tokens if the caller has the role', async () => {
      expect(await interestToken.balanceOf(alice.address)).to.be.equal(0);

      await interestToken.connect(owner).grantRole(MINTER_ROLE, alice.address);

      await interestToken.connect(alice).mint(alice.address, parseEther('100'));

      expect(await interestToken.balanceOf(alice.address)).to.be.equal(
        parseEther('100')
      );
    });
  });

  it('updates to version 2', async () => {
    await interestToken.connect(owner).grantRole(MINTER_ROLE, alice.address);

    await interestToken.connect(alice).mint(alice.address, parseEther('100'));

    const interestTokenV2: TestInterestTokenV2 = await upgrade(
      interestToken,
      'TestInterestTokenV2'
    );

    const [version, balance, developerRole] = await Promise.all([
      interestTokenV2.version(),
      interestTokenV2.balanceOf(alice.address),
      interestTokenV2.DEVELOPER_ROLE(),
    ]);

    expect(version).to.be.equal('V2');
    expect(balance).to.be.equal(parseEther('100'));
    expect(developerRole).to.be.equal(DEVELOPER_ROLE);
  });
});
