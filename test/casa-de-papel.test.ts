import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  CasaDePapel,
  InterestToken,
  MockERC20,
  StakedInterestToken,
} from '../typechain';
import { deploy, makeCalculateAccruedInt, multiDeploy } from './lib/test-utils';

const { parseEther } = ethers.utils;

const { constants } = ethers;

const INTEREST_TOKEN_PER_BLOCK = parseEther('15');

const START_BLOCK = 5;

const calculateAccruedInt = makeCalculateAccruedInt(INTEREST_TOKEN_PER_BLOCK);

describe('Case de Papel', () => {
  let casaDePapel: CasaDePapel;
  let lpToken: MockERC20;
  let lpToken2: MockERC20;
  let sInterestToken: StakedInterestToken;
  let interestToken: InterestToken;

  let owner: SignerWithAddress;
  let developer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  beforeEach(async () => {
    [
      [owner, developer, alice, bob],
      [lpToken, sInterestToken, interestToken, lpToken2],
    ] = await Promise.all([
      ethers.getSigners(),
      multiDeploy(
        ['MockERC20', 'StakedInterestToken', 'InterestToken', 'MockERC20'],
        [
          ['CAKE-LP', 'LP', parseEther('1000')],
          [],
          [],
          ['CAKE-LP-2', 'LP-2', parseEther('1000')],
        ]
      ),
    ]);

    [casaDePapel] = await Promise.all([
      deploy('CasaDePapel', [
        interestToken.address,
        sInterestToken.address,
        developer.address,
        INTEREST_TOKEN_PER_BLOCK,
        START_BLOCK,
      ]),
      // Give enough tokens to deposit
      lpToken.mint(alice.address, parseEther('500')),
      lpToken.mint(bob.address, parseEther('500')),
      lpToken2.mint(alice.address, parseEther('500')),
      lpToken2.mint(bob.address, parseEther('500')),
      interestToken.connect(owner).mint(alice.address, parseEther('500')),
      interestToken.connect(owner).mint(bob.address, parseEther('500')),
      sInterestToken.connect(owner).mint(alice.address, parseEther('500')),
      sInterestToken.connect(owner).mint(bob.address, parseEther('500')),
    ]);

    await Promise.all([
      // Approve to work with casa de papel
      lpToken.connect(alice).approve(casaDePapel.address, constants.MaxUint256),
      lpToken.connect(bob).approve(casaDePapel.address, constants.MaxUint256),
      lpToken2
        .connect(alice)
        .approve(casaDePapel.address, constants.MaxUint256),
      lpToken2.connect(bob).approve(casaDePapel.address, constants.MaxUint256),
      // Casa de papel can mint/burn
      interestToken.connect(owner).transferOwnership(casaDePapel.address),
      sInterestToken.connect(owner).transferOwnership(casaDePapel.address),
    ]);
  });

  describe('function: setDevAccount', () => {
    it('reverts if it not called by the developer account', async () => {
      await expect(
        casaDePapel.connect(owner).setDevAccount(alice.address)
      ).to.revertedWith('CP: only the dev');
    });
    it('updates the devAccount', async () => {
      expect(await casaDePapel.devAccount()).to.be.equal(developer.address);
      await casaDePapel.connect(developer).setDevAccount(alice.address);
      expect(await casaDePapel.devAccount()).to.be.equal(alice.address);
    });
  });

  // @important We test the full functionality of updateAll Modifier in this function. From here on now. We will only test that the devs got their tokens for the modifier portion
  describe('function: setAllocationPoints', () => {
    it('reverts if the caller is not the owner', async () => {
      await expect(
        casaDePapel.connect(alice).setAllocationPoints(1, 500, false)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('updates a pool allocation points without updating all pools', async () => {
      await casaDePapel.connect(owner).addPool(1500, lpToken.address, false);
      const [interesTokenPool, xFarm, totalAllocationPoints] =
        await Promise.all([
          casaDePapel.pools(0),
          casaDePapel.pools(1),
          casaDePapel.totalAllocationPoints(),
        ]);
      // Interest Pool gets 1/3 of 1500 (500) and adds it becoming it's allocation. So the total becomes 1500 + 2000
      expect(interesTokenPool.allocationPoints).to.be.equal(500);
      expect(xFarm.allocationPoints).to.be.equal(1500);
      expect(totalAllocationPoints).to.be.equal(2000);

      await casaDePapel.connect(owner).setAllocationPoints(1, 3000, false);

      const [interesTokenPool1, xFarm1, TotalAllocationPoints1] =
        await Promise.all([
          casaDePapel.pools(0),
          casaDePapel.pools(1),
          casaDePapel.totalAllocationPoints(),
        ]);

      // Interest Pool gets 1/3 of 1500 (500) and adds it becoming it's allocation. So the total becomes 1500 + 2000
      expect(interesTokenPool1.allocationPoints).to.be.equal(1000);
      expect(xFarm1.allocationPoints).to.be.equal(3000);
      expect(TotalAllocationPoints1).to.be.equal(4000);
    });
    it('updates a pool allocation points and updates all pools data', async () => {
      // Adds two pools
      await casaDePapel.connect(owner).addPool(1500, lpToken.address, false);
      await casaDePapel.connect(owner).addPool(1500, lpToken2.address, false);

      const [interestPool, xFarm, yFarm, totalAllocationPoints] =
        await Promise.all([
          casaDePapel.pools(0),
          casaDePapel.pools(1),
          casaDePapel.pools(2),
          casaDePapel.totalAllocationPoints(),
          casaDePapel.connect(alice).deposit(1, parseEther('100')),
          casaDePapel.connect(bob).deposit(1, parseEther('50')),
          casaDePapel.connect(alice).deposit(2, parseEther('100')),
          casaDePapel.connect(bob).deposit(2, parseEther('200')),
        ]);
      // Interest Pool gets 1/3 of 1500 (500) and adds it becoming it's allocation. So the total becomes 1500 + 2000
      expect(interestPool.allocationPoints).to.be.equal(1000);
      expect(xFarm.allocationPoints).to.be.equal(1500);
      expect(yFarm.allocationPoints).to.be.equal(1500);
      expect(totalAllocationPoints).to.be.equal(4000);
      expect(xFarm.accruedIntPerShare).to.be.equal(0); // Fetched before the deposit update
      expect(yFarm.accruedIntPerShare).to.be.equal(0); // Fetched before the deposit update

      // This is before the updateAllPools are called
      const [xFarm1, yFarm1, totalAllocationPoints1] = await Promise.all([
        casaDePapel.pools(1),
        casaDePapel.pools(2),
        casaDePapel.totalAllocationPoints(),
      ]);

      await casaDePapel.connect(owner).setAllocationPoints(1, 3000, true);

      const [interestPool2, xFarm2, yFarm2, totalAllocationPoints2] =
        await Promise.all([
          casaDePapel.pools(0),
          casaDePapel.pools(1),
          casaDePapel.pools(2),
          casaDePapel.totalAllocationPoints(),
        ]);

      // Interest Pool gets 1/3 of 1500 (500) and adds it becoming it's allocation. So the total becomes 1500 + 2000
      expect(interestPool2.allocationPoints).to.be.equal(1500);
      expect(xFarm2.allocationPoints).to.be.equal(3000);
      expect(yFarm2.allocationPoints).to.be.equal(1500);
      expect(totalAllocationPoints2).to.be.equal(6000);
      expect(xFarm2.accruedIntPerShare).to.be.equal(
        calculateAccruedInt(
          xFarm1.accruedIntPerShare,
          xFarm2.lastRewardBlock.sub(xFarm1.lastRewardBlock),
          xFarm1.allocationPoints,
          totalAllocationPoints1,
          xFarm1.totalSupply
        )
      );
      expect(yFarm2.accruedIntPerShare).to.be.equal(
        calculateAccruedInt(
          yFarm1.accruedIntPerShare,
          yFarm2.lastRewardBlock.sub(yFarm1.lastRewardBlock),
          yFarm1.allocationPoints,
          totalAllocationPoints1,
          yFarm1.totalSupply
        )
      );
    });
  });
  describe('function: addPool', () => {
    it('reverts if the caller is not the owner', async () => {
      await expect(
        casaDePapel.connect(alice).addPool(1000, lpToken.address, false)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
  });
});
