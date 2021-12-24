import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  CasaDePapel,
  InterestToken,
  MockERC20,
  StakedInterestToken,
} from '../typechain';
import {
  advanceBlock,
  calculateUserPendingRewards,
  deploy,
  makeCalculateAccruedInt,
  multiDeploy,
} from './lib/test-utils';

const { parseEther } = ethers.utils;

const { constants, provider, BigNumber } = ethers;

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
  let jose: SignerWithAddress;

  beforeEach(async () => {
    [
      [owner, developer, alice, bob, jose],
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
    ]);

    await Promise.all([
      // Approve to work with casa de papel
      interestToken
        .connect(alice)
        .approve(casaDePapel.address, constants.MaxUint256),
      interestToken
        .connect(bob)
        .approve(casaDePapel.address, constants.MaxUint256),
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
      // Tests if the we call updateAllPools
      expect(xFarm.lastRewardBlock).to.be.equal(xFarm1.lastRewardBlock);
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
      // Tests below here test the updateAllPools logic
      expect(xFarm2.lastRewardBlock.toNumber()).to.be.greaterThan(
        xFarm1.lastRewardBlock.toNumber()
      );
      expect(yFarm2.lastRewardBlock.toNumber()).to.be.greaterThan(
        yFarm1.lastRewardBlock.toNumber()
      );
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
    it('updates all other pools if requested', async () => {
      // Adding a pool to test
      await casaDePapel.connect(owner).addPool(1500, lpToken.address, false);

      const xFarm = await casaDePapel.pools(1);

      // Add a second pool to test if the first was updated
      await casaDePapel.connect(owner).addPool(2000, lpToken2.address, true);

      // Since we asked for an update the lastRewardBlock must have been updated
      const xFarm1 = await casaDePapel.pools(1);

      expect(xFarm.lastRewardBlock.toNumber()).to.be.lessThan(
        xFarm1.lastRewardBlock.toNumber()
      );
    });
    it('reverts if you add the same pool twice', async () => {
      await casaDePapel.connect(owner).addPool(1500, lpToken.address, false);
      await expect(
        casaDePapel.connect(owner).addPool(1500, lpToken.address, false)
      ).to.revertedWith('CP: poola already added');
    });
    it('sets the start block as the last reward block if the pool is added before the start block', async () => {
      // Need to redeploy casa de papel with longer start_block
      const contract: CasaDePapel = await deploy('CasaDePapel', [
        interestToken.address,
        sInterestToken.address,
        developer.address,
        INTEREST_TOKEN_PER_BLOCK,
        parseEther('1'), // last reward block should be this one. We need a very large number in case of test run delays
      ]);

      // Adding a pool to test
      await contract.connect(owner).addPool(1500, lpToken.address, false);

      const xFarm = await contract.pools(1);

      expect(xFarm.lastRewardBlock).to.be.equal(parseEther('1'));
    });
    it('adds a new pool', async () => {
      const [totalPools, totalAllocationPoints, interestPool] =
        await Promise.all([
          casaDePapel.getPoolsLength(),
          casaDePapel.totalAllocationPoints(),
          casaDePapel.pools(0),
        ]);

      expect(totalPools).to.be.equal(1);
      expect(totalAllocationPoints).to.be.equal(1000);
      expect(interestPool.allocationPoints).to.be.equal(1000);

      await casaDePapel.connect(owner).addPool(1500, lpToken.address, false);

      // Refresh the relevant state to ensure it was properly updated
      const [
        blockNumber,
        totalPools1,
        totalAllocationPoints1,
        interestPool1,
        xFarm,
      ] = await Promise.all([
        provider.getBlockNumber(),
        casaDePapel.getPoolsLength(),
        casaDePapel.totalAllocationPoints(),
        casaDePapel.pools(0),
        casaDePapel.pools(1),
      ]);

      expect(totalPools1).to.be.equal(2);
      expect(totalAllocationPoints1).to.be.equal(2000);
      expect(interestPool1.allocationPoints).to.be.equal(500);
      expect(xFarm.allocationPoints).to.be.equal(1500);
      expect(xFarm.lastRewardBlock).to.be.equal(blockNumber);
      expect(xFarm.stakingToken).to.be.equal(lpToken.address);
      expect(xFarm.accruedIntPerShare).to.be.equal(0);
      expect(xFarm.totalSupply).to.be.equal(0);
    });
  });
  describe('function: setIntPerBlock', () => {
    it('reverts if the caller is not the owner', async () => {
      await expect(
        casaDePapel.connect(alice).setIntPerBlock(parseEther('1'), false)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('updates all other pools if requested', async () => {
      const [interestPool, interestTokenPerBlock] = await Promise.all([
        casaDePapel.pools(0),
        casaDePapel.interestTokenPerBlock(),
      ]);

      await advanceBlock(ethers);

      await casaDePapel.connect(owner).setIntPerBlock(parseEther('1'), true);

      // last reward BEFORE update
      expect(interestPool.lastRewardBlock).to.be.equal(START_BLOCK);
      // last reward AFTER UPDATE
      expect(
        (await casaDePapel.pools(0)).lastRewardBlock.toNumber()
      ).to.be.greaterThan(START_BLOCK);

      // interest token per block BEFORE update
      expect(interestTokenPerBlock).to.be.equal(INTEREST_TOKEN_PER_BLOCK);
      // interest token per block AFTER update
      expect(await casaDePapel.interestTokenPerBlock()).to.be.equal(
        parseEther('1')
      );
    });
    it('updates interest token per block without updating the pools', async () => {
      const [interestPool, interestTokenPerBlock] = await Promise.all([
        casaDePapel.pools(0),
        casaDePapel.interestTokenPerBlock(),
      ]);

      await advanceBlock(ethers);

      await casaDePapel.connect(owner).setIntPerBlock(parseEther('1'), false);

      // last reward BEFORE update
      expect(interestPool.lastRewardBlock).to.be.equal(START_BLOCK);
      // last reward AFTER UPDATE
      expect(
        (await casaDePapel.pools(0)).lastRewardBlock.toNumber()
      ).to.be.equal(START_BLOCK);

      // interest token per block BEFORE update
      expect(interestTokenPerBlock).to.be.equal(INTEREST_TOKEN_PER_BLOCK);
      // interest token per block AFTER update
      expect(await casaDePapel.interestTokenPerBlock()).to.be.equal(
        parseEther('1')
      );
    });
  });
  describe('function: unstake', () => {
    it('reverts if the user tries to withdraw more than he deposited', async () => {
      await casaDePapel.connect(alice).stake(parseEther('1'));
      await expect(casaDePapel.unstake(parseEther('1.1'))).to.revertedWith(
        'CP: not enough tokens'
      );
    });
    it('returns only the rewards if the user chooses to', async () => {
      await casaDePapel.connect(alice).stake(parseEther('10'));

      // Spend some blocks to accrue rewards
      await advanceBlock(ethers);
      await advanceBlock(ethers);

      const [user, pool] = await Promise.all([
        casaDePapel.userInfo(0, alice.address),
        casaDePapel.pools(0),
      ]);

      await expect(casaDePapel.connect(alice).unstake(0))
        .to.emit(casaDePapel, 'Withdraw')
        .withArgs(alice.address, 0, 0);

      const [user1, pool1] = await Promise.all([
        casaDePapel.userInfo(0, alice.address),
        casaDePapel.pools(0),
      ]);

      expect(user.rewardsPaid).to.be.equal(0);
      expect(user1.amount).to.be.equal(parseEther('10'));
      expect(pool.totalSupply).to.be.equal(pool1.totalSupply);
      // Only one user so he was paid all rewards
      expect(user1.rewardsPaid).to.be.equal(
        // accruedIntPerShare has more decimal houses for precision
        pool1.accruedIntPerShare.mul(pool1.totalSupply).div(1e12)
      );
      expect(await interestToken.balanceOf(alice.address)).to.be.equal(
        calculateUserPendingRewards(
          parseEther('10'),
          pool1.accruedIntPerShare,
          BigNumber.from(0)
          // Need to add her initial balance of 500 minus the 10 deposited
        ).add(parseEther('490'))
      );
      expect(await sInterestToken.balanceOf(alice.address)).to.be.equal(
        parseEther('10')
      );
    });
    it('returns the rewards and the amounts', async () => {
      await casaDePapel.connect(alice).stake(parseEther('10'));
      // Spend some blocks to accrue rewards
      await advanceBlock(ethers);
      await advanceBlock(ethers);

      const [user, sInterestTokenBalance] = await Promise.all([
        casaDePapel.userInfo(0, alice.address),
        sInterestToken.balanceOf(alice.address),
        sInterestToken
          .connect(alice)
          .approve(casaDePapel.address, parseEther('4')),
      ]);

      await expect(casaDePapel.connect(alice).unstake(parseEther('4')))
        .to.emit(casaDePapel, 'Withdraw')
        .withArgs(alice.address, 0, parseEther('4'));

      const [user1, pool] = await Promise.all([
        casaDePapel.userInfo(0, alice.address),
        casaDePapel.pools(0),
      ]);

      expect(user.rewardsPaid).to.be.equal(0);
      expect(sInterestTokenBalance).to.be.equal(parseEther('10'));
      expect(await sInterestToken.balanceOf(alice.address)).to.be.equal(
        parseEther('6')
      );
      expect(user1.amount).to.be.equal(parseEther('6'));
      expect(pool.totalSupply).to.be.equal(parseEther('6'));
      // Only one user so he was paid all rewards
      expect(user1.rewardsPaid).to.be.equal(
        // accruedIntPerShare has more decimal houses for precision
        pool.accruedIntPerShare.mul(pool.totalSupply).div(1e12)
      );
      expect(await interestToken.balanceOf(alice.address)).to.be.equal(
        calculateUserPendingRewards(
          parseEther('10'),
          pool.accruedIntPerShare,
          BigNumber.from(0)
          // Need to add her initial balance of 500 minus the 10 deposited
        ).add(parseEther('494'))
      );
    });
  });
  describe('function: liquidate', () => {
    it('reverts if the from did not authorize the msg sender', async () => {
      await expect(
        casaDePapel.connect(alice).liquidate(bob.address, parseEther('1'))
      ).to.revertedWith('CP: no permission');
    });
    it('reverts if the msg sender does not pass an amount greater than 0', async () => {
      await expect(
        casaDePapel.connect(alice).liquidate(bob.address, 0)
      ).to.revertedWith('CP: no 0 amount');
    });
    it('reverts if the user does not have enough tokens to transfer', async () => {
      await casaDePapel.connect(bob).givePermission(alice.address);
      await expect(
        casaDePapel.connect(alice).liquidate(bob.address, parseEther('1'))
      ).to.revertedWith('CP: not enough tokens');
    });
    it('reverts if the msg.sender does not have enough staked interest tokens', async () => {
      await Promise.all([
        casaDePapel.connect(bob).givePermission(alice.address),
        casaDePapel.connect(bob).stake(parseEther('10')),
        sInterestToken
          .connect(alice)
          .approve(casaDePapel.address, parseEther('10')),
      ]);

      await expect(
        casaDePapel.connect(alice).liquidate(bob.address, parseEther('10'))
      ).to.revertedWith('ERC20: burn amount exceeds balance');
    });
    it('liquidates the debtor returning the rewards and Int to the msg.sender', async () => {
      await casaDePapel.connect(alice).stake(parseEther('10'));
      await Promise.all([
        sInterestToken.connect(alice).transfer(jose.address, parseEther('10')),
        sInterestToken
          .connect(jose)
          .approve(casaDePapel.address, parseEther('10')),
        casaDePapel.connect(alice).givePermission(jose.address),
      ]);

      const [aliceInfo, joseInfo, pool, joseIntBalance] = await Promise.all([
        casaDePapel.userInfo(0, alice.address),
        casaDePapel.userInfo(0, jose.address),
        casaDePapel.pools(0),
        interestToken.balanceOf(jose.address),
      ]);

      expect(aliceInfo.rewardsPaid).to.be.equal(0);
      expect(aliceInfo.amount).to.be.equal(parseEther('10'));
      expect(joseInfo.rewardsPaid).to.be.equal(0);
      expect(joseInfo.amount).to.be.equal(0);
      expect(joseIntBalance).to.be.equal(0);
      expect(pool.totalSupply).to.be.equal(parseEther('10'));

      await expect(
        casaDePapel.connect(jose).liquidate(alice.address, parseEther('10'))
      )
        .to.emit(casaDePapel, 'Liquidate')
        .withArgs(jose.address, alice.address, parseEther('10'));

      const [aliceInfo1, joseInfo1, pool1, joseIntBalance1, joseSIntBalance] =
        await Promise.all([
          casaDePapel.userInfo(0, alice.address),
          casaDePapel.userInfo(0, jose.address),
          casaDePapel.pools(0),
          interestToken.balanceOf(jose.address),
          sInterestToken.balanceOf(jose.address),
        ]);
      expect(pool1.totalSupply).to.be.equal(0);
      // Alice lost her rewards
      expect(aliceInfo1.rewardsPaid).to.be.equal(0);
      // Alice no longer has any staked tokens
      expect(aliceInfo1.amount).to.be.equal(0);
      expect(joseSIntBalance).to.be.equal(0);
      // Liquidator never staked or got rewards so his profile remains unchanged
      expect(joseInfo1.rewardsPaid).to.be.equal(0);
      expect(joseInfo.amount).to.be.equal(0);
      // Liquidator gets Alice staked tokens + rewards
      expect(joseIntBalance1).to.be.equal(
        calculateUserPendingRewards(
          parseEther('10'),
          pool1.accruedIntPerShare,
          BigNumber.from(0)
        ).add(parseEther('10'))
      );
    });
  });
});
