import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers, network } from 'hardhat';

import {
  CasaDePapel,
  InterestToken,
  MockERC20,
  StakedInterestToken,
  TestCasaDePapelV2,
} from '../typechain-types';
import { BURNER_ROLE, MINTER_ROLE } from './lib/constants';
import {
  advanceBlock,
  calculateUserPendingRewards,
  deployUUPS,
  makeCalculateAccruedInt,
  multiDeploy,
  multiDeployUUPS,
  upgrade,
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
      [lpToken, lpToken2],
      [sInterestToken, interestToken],
    ] = await Promise.all([
      ethers.getSigners(),
      multiDeploy(
        ['MockERC20', 'MockERC20'],
        [
          ['CAKE-LP', 'LP', parseEther('1000')],
          ['CAKE-LP-2', 'LP-2', parseEther('1000')],
        ]
      ),
      multiDeployUUPS(['StakedInterestToken', 'InterestToken'], [[], []]),
    ]);

    await interestToken.grantRole(MINTER_ROLE, owner.address);

    [casaDePapel] = await Promise.all([
      deployUUPS('CasaDePapel', [
        interestToken.address,
        sInterestToken.address,
        developer.address,
        INTEREST_TOKEN_PER_BLOCK,
        START_BLOCK,
      ]),
      interestToken.connect(owner).grantRole(MINTER_ROLE, owner.address),
    ]);

    await Promise.all([
      interestToken.connect(owner).grantRole(MINTER_ROLE, casaDePapel.address),
      sInterestToken.connect(owner).grantRole(MINTER_ROLE, casaDePapel.address),
      sInterestToken.connect(owner).grantRole(BURNER_ROLE, casaDePapel.address),
      // Give enough tokens to deposit
      lpToken.mint(alice.address, parseEther('500')),
      lpToken.mint(bob.address, parseEther('500')),
      lpToken2.mint(alice.address, parseEther('500')),
      lpToken2.mint(bob.address, parseEther('500')),
      interestToken.connect(owner).mint(alice.address, parseEther('500')),
      interestToken.connect(owner).mint(bob.address, parseEther('500')),
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
    ]);
  });

  it('returns the total number of pools', async () => {
    expect(await casaDePapel.getPoolsLength()).to.be.equal(1);
    // Adds two pools
    await casaDePapel.connect(owner).addPool(1500, lpToken.address, false);
    expect(await casaDePapel.getPoolsLength()).to.be.equal(2);

    await casaDePapel.connect(owner).addPool(1500, lpToken2.address, false);
    expect(await casaDePapel.getPoolsLength()).to.be.equal(3);
  });

  describe('function: initialize', () => {
    it('reverts if you call after deployment', async () => {
      await expect(
        casaDePapel.initialize(
          interestToken.address,
          sInterestToken.address,
          developer.address,
          INTEREST_TOKEN_PER_BLOCK,
          START_BLOCK
        )
      ).to.revertedWith('Initializable: contract is already initialized');
    });

    it('properly updates the state', async () => {
      const [
        totalAllocationPoints,
        interesTokenPool,
        hasPool,
        _owner,
        _interestToken,
        _sInterestToken,
        _developmentAccount,
        _interestPerBlock,
        _startBlock,
      ] = await Promise.all([
        casaDePapel.totalAllocationPoints(),
        casaDePapel.pools(0),
        casaDePapel.hasPool(interestToken.address),
        casaDePapel.owner(),
        casaDePapel.INTEREST_TOKEN(),
        casaDePapel.STAKED_INTEREST_TOKEN(),
        casaDePapel.devAccount(),
        casaDePapel.interestTokenPerBlock(),
        casaDePapel.startBlock(),
      ]);

      expect(totalAllocationPoints).to.be.equal(1000);
      expect(interesTokenPool.stakingToken).to.be.equal(interestToken.address);
      expect(interesTokenPool.allocationPoints).to.be.equal(1000);
      expect(interesTokenPool.lastRewardBlock).to.be.equal(START_BLOCK);
      expect(interesTokenPool.accruedIntPerShare).to.be.equal(0);
      expect(interesTokenPool.totalSupply).to.be.equal(0);
      expect(hasPool).to.be.equal(true);
      expect(_owner).to.be.equal(owner.address);
      expect(_interestPerBlock).to.be.equal(INTEREST_TOKEN_PER_BLOCK);
      expect(_interestToken).to.be.equal(interestToken.address);
      expect(_sInterestToken).to.be.equal(sInterestToken.address);
      expect(_developmentAccount).to.be.equal(developer.address);
      expect(_startBlock).to.be.equal(START_BLOCK);
    });
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
    it("does not update the pool allocation if the points don't change", async () => {
      await casaDePapel.connect(owner).addPool(1500, lpToken.address, false);
      await expect(
        casaDePapel.connect(owner).setAllocationPoints(1, 3000, false)
      )
        .to.emit(casaDePapel, 'UpdatePoolAllocationPoint')
        .withArgs(1, 3000);

      await expect(
        casaDePapel.connect(owner).setAllocationPoints(1, 3000, false)
      ).to.not.emit(casaDePapel, 'UpdatePoolAllocationPoint');
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
      ).to.revertedWith('CP: pool already added');
    });
    it('sets the start block as the last reward block if the pool is added before the start block', async () => {
      // Need to redeploy casa de papel with longer start_block
      const contract: CasaDePapel = await deployUUPS('CasaDePapel', [
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
      await expect(
        casaDePapel
          .connect(alice)
          .unstake(alice.address, alice.address, parseEther('1.1'))
      ).to.revertedWith('CP: not enough tokens');
    });
    it('reverts if the account is not the msg.sender and does not have max uint256 allowance', async () => {
      await casaDePapel.connect(alice).stake(parseEther('10'));

      await expect(
        casaDePapel.connect(jose).unstake(alice.address, jose.address, 1)
      ).to.revertedWith('CP: no max allowance');

      await interestToken
        .connect(alice)
        .approve(jose.address, parseEther('999999999'));
      await expect(
        casaDePapel.connect(jose).unstake(alice.address, alice.address, 1)
      ).to.revertedWith('CP: no max allowance');
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

      await expect(
        casaDePapel.connect(alice).unstake(alice.address, alice.address, 0)
      )
        .to.emit(casaDePapel, 'Withdraw')
        .withArgs(alice.address, alice.address, 0, 0);

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
        pool1.accruedIntPerShare.mul(pool1.totalSupply).div(parseEther('1'))
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
    it('allows an user with max allowance to withdraw in behalf of an account', async () => {
      await casaDePapel.connect(alice).stake(parseEther('10'));
      // Mint some blocks to accrue rewards
      await advanceBlock(ethers);
      await advanceBlock(ethers);

      await sInterestToken
        .connect(alice)
        .transfer(jose.address, parseEther('10'));

      const [user, sInterestTokenBalance] = await Promise.all([
        casaDePapel.userInfo(0, alice.address),
        sInterestToken.balanceOf(jose.address),
        interestToken
          .connect(alice)
          .approve(jose.address, constants.MaxUint256),
      ]);

      await expect(
        casaDePapel
          .connect(jose)
          .unstake(alice.address, jose.address, parseEther('4'))
      )
        .to.emit(casaDePapel, 'Withdraw')
        .withArgs(alice.address, jose.address, 0, parseEther('4'));

      const [user1, pool] = await Promise.all([
        casaDePapel.userInfo(0, alice.address),
        casaDePapel.pools(0),
      ]);

      expect(user.rewardsPaid).to.be.equal(0);
      expect(sInterestTokenBalance).to.be.equal(parseEther('10'));
      expect(await sInterestToken.balanceOf(jose.address)).to.be.equal(
        parseEther('6')
      );
      expect(user1.amount).to.be.equal(parseEther('6'));
      expect(pool.totalSupply).to.be.equal(parseEther('6'));
      // Only one user so he was paid all rewards
      expect(user1.rewardsPaid).to.be.equal(
        // accruedIntPerShare has more decimal houses for precision
        pool.accruedIntPerShare.mul(pool.totalSupply).div(parseEther('1'))
      );
      expect(await interestToken.balanceOf(jose.address)).to.be.equal(
        calculateUserPendingRewards(
          parseEther('10'),
          pool.accruedIntPerShare,
          BigNumber.from(0)
          // Amount he just unstaked
        ).add(parseEther('4'))
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
      ]);

      await expect(
        casaDePapel
          .connect(alice)
          .unstake(alice.address, alice.address, parseEther('4'))
      )
        .to.emit(casaDePapel, 'Withdraw')
        .withArgs(alice.address, alice.address, 0, parseEther('4'));

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
        pool.accruedIntPerShare.mul(pool.totalSupply).div(parseEther('1'))
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
    it('does not mint rewards if the interest token block production is set to 0', async () => {
      const aliceIntBalance = await interestToken.balanceOf(alice.address);
      await casaDePapel.connect(owner).setIntPerBlock(0, true);
      await casaDePapel.connect(alice).stake(parseEther('10'));
      // Spend some blocks to accrue rewards
      await advanceBlock(ethers);
      await advanceBlock(ethers);

      await casaDePapel
        .connect(alice)
        .unstake(alice.address, alice.address, parseEther('10'));

      expect(await interestToken.balanceOf(alice.address)).to.be.equal(
        aliceIntBalance
      );
    });
  });

  describe('function: emergencyWithdraw', () => {
    it('allows a user to withdraw tokens from a pool without getting any rewards', async () => {
      await casaDePapel.connect(owner).addPool(1500, lpToken.address, false);
      const initialBalance = await lpToken.balanceOf(alice.address);
      await casaDePapel.connect(alice).deposit(1, parseEther('5'));

      const [userInfo, pool] = await Promise.all([
        casaDePapel.userInfo(1, alice.address),
        casaDePapel.pools(1),
        casaDePapel.updateAllPools(),
      ]);

      expect(userInfo.amount).to.be.equal(parseEther('5'));
      expect(userInfo.rewardsPaid).to.be.equal(0);
      expect(pool.totalSupply).to.be.equal(parseEther('5'));
      // Pool has rewards to be given but since this is an urgent withdraw they will not be given out
      expect(pool.accruedIntPerShare.gt(0)).to.equal(true);

      await expect(casaDePapel.connect(alice).emergencyWithdraw(1))
        .to.emit(casaDePapel, 'EmergencyWithdraw')
        .withArgs(alice.address, 1, parseEther('5'));

      const [userInfo1, pool1] = await Promise.all([
        casaDePapel.userInfo(1, alice.address),
        casaDePapel.pools(1),
      ]);

      expect(await lpToken.balanceOf(alice.address)).to.be.equal(
        initialBalance
      );
      expect(userInfo1.amount).to.be.equal(0);
      expect(userInfo1.rewardsPaid).to.be.equal(0);
      expect(pool1.totalSupply).to.be.equal(0);
    });
    it('reverts if the user does not have staked interest token', async () => {
      await casaDePapel.connect(alice).stake(parseEther('2'));
      await sInterestToken
        .connect(alice)
        .transfer(owner.address, parseEther('1'));
      await expect(
        casaDePapel.connect(alice).emergencyWithdraw(0)
      ).to.revertedWith('ERC20: burn amount exceeds balance');
    });
    it('allows a user to withdraw interest tokens from a pool without getting any rewards', async () => {
      const initialBalance = await interestToken.balanceOf(alice.address);
      await casaDePapel.connect(alice).stake(parseEther('5'));

      const [userInfo, pool] = await Promise.all([
        casaDePapel.userInfo(0, alice.address),
        casaDePapel.pools(0),
        casaDePapel.updateAllPools(),
      ]);

      expect(userInfo.amount).to.be.equal(parseEther('5'));
      expect(userInfo.rewardsPaid).to.be.equal(0);
      expect(pool.totalSupply).to.be.equal(parseEther('5'));
      // Pool has rewards to be given but since this is an urgent withdraw they will not be given out
      expect(pool.accruedIntPerShare.gt(0)).to.equal(true);

      await expect(casaDePapel.connect(alice).emergencyWithdraw(0))
        .to.emit(casaDePapel, 'EmergencyWithdraw')
        .withArgs(alice.address, 0, parseEther('5'));

      const [userInfo1, pool1] = await Promise.all([
        casaDePapel.userInfo(0, alice.address),
        casaDePapel.pools(0),
      ]);

      expect(await interestToken.balanceOf(alice.address)).to.be.equal(
        initialBalance
      );
      expect(userInfo1.amount).to.be.equal(0);
      expect(userInfo1.rewardsPaid).to.be.equal(0);
      expect(pool1.totalSupply).to.be.equal(0);
    });
  });
  it('allows to check how many pending rewards a user has in a specific pool', async () => {
    expect(await casaDePapel.pendingRewards(0, alice.address)).to.be.equal(0);

    await casaDePapel.connect(alice).stake(parseEther('5'));

    expect(await casaDePapel.pendingRewards(0, alice.address)).to.be.equal(0);

    await advanceBlock(ethers);
    await advanceBlock(ethers);

    const [block, pool, user, totalAllocationPoints] = await Promise.all([
      provider.getBlockNumber(),
      casaDePapel.pools(0),
      casaDePapel.userInfo(0, alice.address),
      casaDePapel.totalAllocationPoints(),
    ]);

    expect(await casaDePapel.pendingRewards(0, alice.address)).to.be.equal(
      calculateUserPendingRewards(
        user.amount,
        calculateAccruedInt(
          BigNumber.from(0),
          BigNumber.from(block).sub(pool.lastRewardBlock),
          pool.allocationPoints,
          totalAllocationPoints,
          pool.totalSupply
        ),
        user.rewardsPaid
      )
    );
  });
  describe('function: stake', () => {
    it('allows the user to only get the rewards by staking 0', async () => {
      await Promise.all([
        casaDePapel.connect(bob).stake(parseEther('20')),
        casaDePapel.connect(alice).stake(parseEther('5')),
      ]);

      const [pool, user, balance] = await Promise.all([
        casaDePapel.pools(0),
        casaDePapel.userInfo(0, alice.address),
        interestToken.balanceOf(alice.address),
      ]);

      expect(pool.totalSupply).to.be.equal(parseEther('25'));
      expect(user.amount).to.be.equal(parseEther('5'));
      expect(user.rewardsPaid).to.be.equal(
        parseEther('5').mul(pool.accruedIntPerShare).div(parseEther('1'))
      );

      // Accrue rewards
      await advanceBlock(ethers);
      await advanceBlock(ethers);

      await expect(casaDePapel.connect(alice).stake(0))
        .to.emit(casaDePapel, 'Deposit')
        .withArgs(alice.address, 0, 0);

      const [pool1, user1, balance1] = await Promise.all([
        casaDePapel.pools(0),
        casaDePapel.userInfo(0, alice.address),
        interestToken.balanceOf(alice.address),
      ]);

      // Balance changed because she asked for rewards only
      expect(balance1).to.be.equal(
        balance.add(
          user.amount
            .mul(pool1.accruedIntPerShare)
            .div(parseEther('1'))
            .sub(user.rewardsPaid)
        )
      );
      // Amount has not changed
      expect(user1.amount).to.be.equal(user.amount);
      expect(pool1.totalSupply).to.be.equal(parseEther('25'));
    });
    it('allows to stake', async () => {
      await casaDePapel.connect(alice).stake(parseEther('5'));

      const [pool, user, balance, sBalance] = await Promise.all([
        casaDePapel.pools(0),
        casaDePapel.userInfo(0, alice.address),
        interestToken.balanceOf(alice.address),
        sInterestToken.balanceOf(alice.address),
      ]);

      expect(pool.totalSupply).to.be.equal(parseEther('5'));
      expect(user.amount).to.be.equal(parseEther('5'));
      expect(user.rewardsPaid).to.be.equal(0);
      expect(sBalance).to.be.equal(parseEther('5'));

      // Accrue rewards
      await advanceBlock(ethers);
      await advanceBlock(ethers);

      await expect(casaDePapel.connect(alice).stake(parseEther('15')))
        .to.emit(casaDePapel, 'Deposit')
        .withArgs(alice.address, 0, parseEther('15'));

      const [pool1, user1, balance1, sBalance1] = await Promise.all([
        casaDePapel.pools(0),
        casaDePapel.userInfo(0, alice.address),
        interestToken.balanceOf(alice.address),
        sInterestToken.balanceOf(alice.address),
      ]);

      expect(pool1.totalSupply).to.be.equal(parseEther('20'));
      expect(user1.amount).to.be.equal(parseEther('20'));
      expect(user1.rewardsPaid).to.be.equal(
        parseEther('20').mul(pool1.accruedIntPerShare).div(parseEther('1'))
      );
      expect(balance1).to.be.equal(
        balance
          // + Rewards
          .add(user.amount.mul(pool1.accruedIntPerShare).div(parseEther('1')))
          // - Deposit
          .sub(parseEther('15'))
      );
      expect(sBalance1).to.be.equal(parseEther('20'));
    });
  });
  describe('function: withdraw', () => {
    it('reverts if  you try to withdraw from pool 0', async () => {
      await expect(casaDePapel.connect(alice).withdraw(0, 1)).to.revertedWith(
        'CP: use the unstake function'
      );
    });
    it('reverts if the user tries to withdraw more than what he has deposited', async () => {
      await casaDePapel.connect(owner).addPool(1500, lpToken.address, false);
      await casaDePapel.connect(alice).deposit(1, parseEther('2'));

      await expect(
        casaDePapel.connect(alice).withdraw(1, parseEther('2.1'))
      ).to.revertedWith('CP: not enough tokens');
    });
    it('allows to only get the pending rewards', async () => {
      await casaDePapel.connect(owner).addPool(1500, lpToken.address, false);
      await casaDePapel.connect(alice).deposit(1, parseEther('7'));

      const [pool, user, balance] = await Promise.all([
        casaDePapel.pools(1),
        casaDePapel.userInfo(1, alice.address),
        interestToken.balanceOf(alice.address),
      ]);

      // Accrue rewards
      await advanceBlock(ethers);
      await advanceBlock(ethers);

      await expect(casaDePapel.connect(alice).withdraw(1, 0))
        .to.emit(casaDePapel, 'Withdraw')
        .withArgs(alice.address, alice.address, 1, 0);

      const [pool1, user1, balance1] = await Promise.all([
        casaDePapel.pools(1),
        casaDePapel.userInfo(1, alice.address),
        interestToken.balanceOf(alice.address),
      ]);

      expect(user1.amount).to.be.equal(user.amount);
      expect(balance1).to.be.equal(
        balance.add(
          user.amount.mul(pool1.accruedIntPerShare).div(parseEther('1'))
        )
      );
      expect(pool1.totalSupply).to.be.equal(pool.totalSupply);
      expect(user1.rewardsPaid).to.be.equal(
        user1.amount.mul(pool1.accruedIntPerShare).div(parseEther('1'))
      );
    });
    it('allows to withdraw deposited tokens', async () => {
      await casaDePapel.connect(owner).addPool(1500, lpToken.address, false);
      await Promise.all([
        casaDePapel.connect(alice).deposit(1, parseEther('7')),
        casaDePapel.connect(bob).deposit(1, parseEther('8')),
      ]);

      const [pool, user, balance, lpBalance] = await Promise.all([
        casaDePapel.pools(1),
        casaDePapel.userInfo(1, alice.address),
        interestToken.balanceOf(alice.address),
        lpToken.balanceOf(alice.address),
      ]);

      // Accrue rewards
      await advanceBlock(ethers);
      await advanceBlock(ethers);

      expect(user.amount).to.be.equal(parseEther('7'));
      expect(user.rewardsPaid).to.be.equal(0);
      expect(pool.totalSupply).to.be.equal(parseEther('15'));

      await expect(casaDePapel.connect(alice).withdraw(1, parseEther('3')))
        .to.emit(casaDePapel, 'Withdraw')
        .withArgs(alice.address, alice.address, 1, parseEther('3'));

      const [pool1, user1, balance1, lpBalance1] = await Promise.all([
        casaDePapel.pools(1),
        casaDePapel.userInfo(1, alice.address),
        interestToken.balanceOf(alice.address),
        lpToken.balanceOf(alice.address),
      ]);

      expect(user1.amount).to.be.equal(parseEther('4'));
      expect(user1.rewardsPaid).to.be.equal(
        user1.amount.mul(pool1.accruedIntPerShare).div(parseEther('1'))
      );
      expect(pool1.totalSupply).to.be.equal(parseEther('12'));
      // Rewards are in Int Token
      expect(balance1).to.be.equal(
        balance.add(
          user.amount.mul(pool1.accruedIntPerShare).div(parseEther('1'))
        )
      );
      // Withdraw is on the pool token
      expect(lpBalance1).to.be.equal(lpBalance.add(parseEther('3')));
    });
    it('does not give pending rewards if interest block production is set to 0', async () => {
      const [aliceIntBalance] = await Promise.all([
        interestToken.balanceOf(alice.address),
        casaDePapel.connect(owner).addPool(1500, lpToken.address, false),
        casaDePapel.connect(owner).setIntPerBlock(0, false),
      ]);
      await casaDePapel.connect(alice).deposit(1, parseEther('7'));

      // Accrue rewards
      await advanceBlock(ethers);
      await advanceBlock(ethers);

      await casaDePapel.connect(alice).withdraw(1, parseEther('3'));

      expect(await interestToken.balanceOf(alice.address)).to.be.equal(
        aliceIntBalance
      );
    });
  });
  describe('function: deposit', () => {
    it('reverts if the user tries to deposit to the pool 0', async () => {
      await expect(casaDePapel.connect(alice).deposit(0, 1)).to.revertedWith(
        'CP: use the staking function'
      );
    });
    it('allows the user to only get the rewards', async () => {
      await casaDePapel.connect(owner).addPool(1500, lpToken.address, false);

      await Promise.all([
        casaDePapel.connect(bob).deposit(1, parseEther('10')),
        casaDePapel.connect(alice).deposit(1, parseEther('7')),
      ]);

      const [pool, user, balance, lpBalance] = await Promise.all([
        casaDePapel.pools(1),
        casaDePapel.userInfo(1, alice.address),
        interestToken.balanceOf(alice.address),
        lpToken.balanceOf(alice.address),
      ]);

      // Accrue rewards
      await advanceBlock(ethers);
      await advanceBlock(ethers);

      expect(pool.totalSupply).to.be.equal(parseEther('17'));
      expect(user.amount).to.be.equal(parseEther('7'));
      expect(user.rewardsPaid).to.be.equal(
        pool.accruedIntPerShare.mul(user.amount).div(parseEther('1'))
      );

      await expect(casaDePapel.connect(alice).deposit(1, 0))
        .to.emit(casaDePapel, 'Deposit')
        .withArgs(alice.address, 1, 0);

      const [pool1, user1, balance1, lpBalance1, sInterestBalance] =
        await Promise.all([
          casaDePapel.pools(1),
          casaDePapel.userInfo(1, alice.address),
          interestToken.balanceOf(alice.address),
          lpToken.balanceOf(alice.address),
          sInterestToken.balanceOf(alice.address),
        ]);

      expect(lpBalance).to.be.equal(lpBalance1);
      expect(sInterestBalance).to.be.equal(0);
      expect(user.amount).to.be.equal(user1.amount);
      expect(pool1.totalSupply).to.be.equal(pool.totalSupply);
      // Rewards paid in INT
      expect(balance1).to.be.equal(
        balance
          .add(user.amount.mul(pool1.accruedIntPerShare).div(parseEther('1')))
          .sub(user.rewardsPaid)
      );
    });
    it('allows for multiple deposits', async () => {
      await casaDePapel.connect(owner).addPool(1500, lpToken.address, false);

      await expect(casaDePapel.connect(alice).deposit(1, parseEther('6')))
        .to.emit(casaDePapel, 'Deposit')
        .withArgs(alice.address, 1, parseEther('6'));

      const [pool, user, balance, lpBalance] = await Promise.all([
        casaDePapel.pools(1),
        casaDePapel.userInfo(1, alice.address),
        interestToken.balanceOf(alice.address),
        lpToken.balanceOf(alice.address),
      ]);

      expect(pool.totalSupply).to.be.equal(parseEther('6'));
      expect(user.amount).to.be.equal(parseEther('6'));

      // Accrue rewards
      await advanceBlock(ethers);
      await advanceBlock(ethers);

      await expect(casaDePapel.connect(alice).deposit(1, parseEther('7')))
        .to.emit(casaDePapel, 'Deposit')
        .withArgs(alice.address, 1, parseEther('7'));

      const [pool1, user1, balance1, lpBalance1] = await Promise.all([
        casaDePapel.pools(1),
        casaDePapel.userInfo(1, alice.address),
        interestToken.balanceOf(alice.address),
        lpToken.balanceOf(alice.address),
      ]);

      expect(pool1.totalSupply).to.be.equal(parseEther('13'));
      expect(user1.amount).to.be.equal(parseEther('13'));
      expect(user1.rewardsPaid).to.be.equal(
        user1.amount.mul(pool1.accruedIntPerShare).div(parseEther('1'))
      );
      // Rewards r paid when depositing
      expect(balance1).to.be.equal(
        balance.add(
          user.amount
            .mul(pool1.accruedIntPerShare)
            .div(parseEther('1'))
            .sub(user.rewardsPaid)
        )
      );
      expect(lpBalance1).to.be.equal(lpBalance.sub(parseEther('7')));
    });
  });
  it('updates all pools', async () => {
    await Promise.all([
      casaDePapel.connect(owner).addPool(1500, lpToken.address, false),
      casaDePapel.connect(owner).addPool(1000, lpToken2.address, false),
    ]);

    const [pool, xFarm, yFarm] = await Promise.all([
      casaDePapel.pools(0),
      casaDePapel.pools(1),
      casaDePapel.pools(2),
    ]);

    expect(pool.lastRewardBlock).to.be.equal(START_BLOCK);

    expect(pool.accruedIntPerShare).to.be.equal(0);
    expect(xFarm.accruedIntPerShare).to.be.equal(0);
    expect(yFarm.accruedIntPerShare).to.be.equal(0);

    await Promise.all([
      casaDePapel.connect(alice).stake(parseEther('11')),
      casaDePapel.connect(alice).deposit(1, parseEther('6.5')),
      casaDePapel.connect(alice).deposit(2, parseEther('23')),
    ]);

    const [pool1, xFarm1, yFarm1] = await Promise.all([
      casaDePapel.pools(0),
      casaDePapel.pools(1),
      casaDePapel.pools(2),
    ]);

    await casaDePapel.updateAllPools();

    expect(pool1.lastRewardBlock.gt(pool.lastRewardBlock)).to.be.equal(true);
    expect(xFarm1.lastRewardBlock.gt(xFarm.lastRewardBlock)).to.be.equal(true);
    expect(yFarm1.lastRewardBlock.gt(yFarm.lastRewardBlock)).to.be.equal(true);

    const [pool2, xFarm2, yFarm2] = await Promise.all([
      casaDePapel.pools(0),
      casaDePapel.pools(1),
      casaDePapel.pools(2),
    ]);

    expect(pool2.lastRewardBlock.gt(pool1.lastRewardBlock)).to.be.equal(true);
    expect(xFarm2.lastRewardBlock.gt(xFarm1.lastRewardBlock)).to.be.equal(true);
    expect(yFarm2.lastRewardBlock.gt(yFarm1.lastRewardBlock)).to.be.equal(true);

    expect(pool2.accruedIntPerShare).to.be.equal(
      calculateAccruedInt(
        pool1.accruedIntPerShare,
        pool2.lastRewardBlock.sub(pool1.lastRewardBlock),
        pool2.allocationPoints,
        pool2.allocationPoints.add(2500),
        pool2.totalSupply
      )
    );
    expect(xFarm2.accruedIntPerShare).to.be.equal(
      calculateAccruedInt(
        xFarm1.accruedIntPerShare,
        xFarm2.lastRewardBlock.sub(xFarm1.lastRewardBlock),
        xFarm2.allocationPoints,
        pool2.allocationPoints.add(2500),
        xFarm2.totalSupply
      )
    );
    expect(yFarm2.accruedIntPerShare).to.be.equal(
      calculateAccruedInt(
        yFarm1.accruedIntPerShare,
        yFarm2.lastRewardBlock.sub(yFarm1.lastRewardBlock),
        yFarm2.allocationPoints,
        pool2.allocationPoints.add(2500),
        yFarm2.totalSupply
      )
    );
  });

  describe('function: updatePool', async () => {
    it('does not update a pool if it has already been updated in the same block', async () => {
      await network.provider.send('evm_setAutomine', [false]);
      await network.provider.send('evm_setIntervalMining', [5000]);

      await casaDePapel.connect(alice).stake(parseEther('50'));

      // Stake function updates the pool already and each block is getting mined every 5 seconds
      await expect(casaDePapel.updatePool(0)).to.not.emit(
        casaDePapel,
        'UpdatePool'
      );
      await network.provider.send('evm_setAutomine', [true]);
    });
    it('does not mint tokens to the account if there are no rewards', async () => {
      await casaDePapel.connect(owner).setIntPerBlock(0, false);

      const pool = await casaDePapel.pools(0);

      await expect(casaDePapel.updatePool(0)).to.not.emit(
        interestToken,
        'Transfer'
      );

      const pool2 = await casaDePapel.pools(0);

      expect(pool2.lastRewardBlock.gt(pool.lastRewardBlock)).to.be.equal(true);
    });
    it('updates one pool', async () => {
      const pool = await casaDePapel.pools(0);

      expect(pool.lastRewardBlock).to.be.equal(START_BLOCK);
      expect(pool.accruedIntPerShare).to.be.equal(0);

      await casaDePapel.connect(alice).stake(parseEther('50'));

      const pool1 = await casaDePapel.pools(0);
      expect(pool1.lastRewardBlock.gt(pool.lastRewardBlock)).to.be.equal(true);
      // No deposits yet
      expect(pool1.accruedIntPerShare).to.be.equal(0);

      await casaDePapel.updatePool(0);

      const pool2 = await casaDePapel.pools(0);

      expect(pool2.lastRewardBlock.gt(pool.lastRewardBlock)).to.be.equal(true);
      expect(pool2.accruedIntPerShare).to.be.equal(
        calculateAccruedInt(
          pool1.accruedIntPerShare,
          pool2.lastRewardBlock.sub(pool1.lastRewardBlock),
          BigNumber.from(1000),
          BigNumber.from(1000),
          pool2.totalSupply
        )
      );
    });
  });

  describe('Upgrade functionality', () => {
    it('reverts if a non owner tries to upgrade', async () => {
      await casaDePapel.connect(owner).transferOwnership(alice.address);

      await expect(upgrade(casaDePapel, 'TestCasaDePapelV2')).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });

    it('upgrades to version 2', async () => {
      await casaDePapel.connect(alice).stake(parseEther('5'));

      const casaDePapelV2: TestCasaDePapelV2 = await upgrade(
        casaDePapel,
        'TestCasaDePapelV2'
      );

      const [pool, user, version] = await Promise.all([
        casaDePapelV2.pools(0),
        casaDePapelV2.userInfo(0, alice.address),
        casaDePapelV2.version(),
      ]);

      expect(pool.totalSupply).to.be.equal(parseEther('5'));
      expect(user.amount).to.be.equal(parseEther('5'));
      expect(user.rewardsPaid).to.be.equal(0);
      expect(version).to.be.equal('V2');
    });
  });
});
