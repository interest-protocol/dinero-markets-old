import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumberish } from 'ethers';
import { ethers } from 'hardhat';

import {
  advanceBlock,
  advanceTime,
  deploy,
  multiDeploy,
} from '../lib/test-utils';
import {
  CasaDePapel,
  InterestToken,
  MockERC20,
  StakedInterestToken,
} from '../typechain';

const { parseEther } = ethers.utils;

const { BigNumber, constants } = ethers;

const INTEREST_TOKEN_PER_BLOCK = 15;

const B = (x: BigNumberish) => BigNumber.from(x);

const calculateAccruedInt = (
  accruedInterest: BigNumberish,
  blocksElapsed: BigNumberish,
  allocationPoints: BigNumberish,
  totalAllocationPoints: BigNumberish,
  totalSupply: BigNumberish
) => {
  const rewards = B(blocksElapsed)
    .mul(B(INTEREST_TOKEN_PER_BLOCK).mul(B(allocationPoints)))
    .div(totalAllocationPoints);

  return B(accruedInterest).add(rewards.mul(1e12)).div(totalSupply);
};

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
        5,
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

  describe('function: setAllocationPoints', () => {
    it('reverts if the caller is not the owner', async () => {
      await expect(
        casaDePapel.connect(alice).setAllocationPoints(1, 500, false)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('updates a pool allocation points without updating all pools', async () => {
      await casaDePapel.connect(owner).addPool(1500, lpToken.address, false);
      const [pool0, pool1, totalAllocationPoints] = await Promise.all([
        casaDePapel.pools(0),
        casaDePapel.pools(1),
        casaDePapel.totalAllocationPoints(),
      ]);
      // Interest Pool gets 1/3 of 1500 (500) and adds it becoming it's allocation. So the total becomes 1500 + 2000
      expect(pool0.allocationPoints).to.be.equal(500);
      expect(pool1.allocationPoints).to.be.equal(1500);
      expect(totalAllocationPoints).to.be.equal(2000);

      await casaDePapel.connect(owner).setAllocationPoints(1, 3000, false);

      const [aPool0, aPool1, aTotalAllocationPoints] = await Promise.all([
        casaDePapel.pools(0),
        casaDePapel.pools(1),
        casaDePapel.totalAllocationPoints(),
      ]);

      // Interest Pool gets 1/3 of 1500 (500) and adds it becoming it's allocation. So the total becomes 1500 + 2000
      expect(aPool0.allocationPoints).to.be.equal(1000);
      expect(aPool1.allocationPoints).to.be.equal(3000);
      expect(aTotalAllocationPoints).to.be.equal(4000);
    });
    it.only('updates a pool allocation points and updates all pools data', async () => {
      await casaDePapel.connect(owner).addPool(1500, lpToken.address, false);
      await casaDePapel.connect(owner).addPool(1500, lpToken2.address, false);
      const [pool0, pool1, pool2, totalAllocationPoints] = await Promise.all([
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
      expect(pool0.allocationPoints).to.be.equal(1000);
      expect(pool1.allocationPoints).to.be.equal(1500);
      expect(pool2.allocationPoints).to.be.equal(1500);
      expect(totalAllocationPoints).to.be.equal(4000);
      expect(pool1.accruedIntPerShare).to.be.equal(0); // Start block has not happened yet
      expect(pool2.accruedIntPerShare).to.be.equal(0); // Start block has not happened yet

      await casaDePapel.connect(owner).setAllocationPoints(1, 3000, true);

      const [aPool0, aPool1, aPool2, aTotalAllocationPoints] =
        await Promise.all([
          casaDePapel.pools(0),
          casaDePapel.pools(1),
          casaDePapel.pools(2),
          casaDePapel.totalAllocationPoints(),
          // 2 minutos ~ 4 blocks.
          advanceTime(120_000, ethers),
          advanceBlock(ethers),
        ]);

      // Interest Pool gets 1/3 of 1500 (500) and adds it becoming it's allocation. So the total becomes 1500 + 2000
      expect(aPool0.allocationPoints).to.be.equal(1500);
      expect(aPool1.allocationPoints).to.be.equal(3000);
      expect(aPool2.allocationPoints).to.be.equal(1500);
      expect(aTotalAllocationPoints).to.be.equal(6000);
      expect(aPool1.accruedIntPerShare).to.be.equal(
        calculateAccruedInt(
          0,
          4,
          aPool1.allocationPoints,
          aTotalAllocationPoints,
          aPool1.totalSupply
        )
      );
      expect(aPool2.accruedIntPerShare).to.be.equal(
        calculateAccruedInt(
          0,
          4,
          aPool2.allocationPoints,
          aTotalAllocationPoints,
          aPool2.totalSupply
        )
      );
    });
  });
});
