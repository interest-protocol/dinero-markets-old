import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  CakeToken,
  LPVault,
  MasterChef,
  MockERC20,
  SyrupBar,
} from '../typechain';
import { advanceBlock, deploy, multiDeploy } from './lib/test-utils';

const { parseEther } = ethers.utils;

const CAKE_PER_BLOCK = parseEther('40');

const START_BLOCK = 1;

describe('LPVault', () => {
  let cake: CakeToken;
  let syrup: SyrupBar;
  let masterChef: MasterChef;
  let lpVault: LPVault;
  let lpToken: MockERC20;
  let lpToken2: MockERC20;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let developer: SignerWithAddress;
  // @notice Market does not need to be an address for testing purposes
  let market: SignerWithAddress;

  beforeEach(async () => {
    [[owner, alice, bob, developer, market], cake] = await Promise.all([
      ethers.getSigners(),
      deploy('CakeToken'),
    ]);

    syrup = await deploy('SyrupBar', [cake.address]);

    masterChef = await deploy('MasterChef', [
      cake.address,
      syrup.address,
      developer.address,
      CAKE_PER_BLOCK,
      START_BLOCK,
    ]);

    [lpToken, lpToken2] = await multiDeploy(
      ['MockERC20', 'MockERC20'],
      [
        ['CAKE-LP', 'LP', parseEther('1000000')],
        ['CAKE-LP-2', 'LP-2', parseEther('1000000')],
      ]
    );

    lpVault = await deploy('LPVault', [
      masterChef.address,
      cake.address,
      lpToken.address,
      1,
      market.address,
    ]);

    await Promise.all([
      lpToken
        .connect(alice)
        .approve(lpVault.address, ethers.constants.MaxUint256),
      lpToken
        .connect(bob)
        .approve(lpVault.address, ethers.constants.MaxUint256),
      lpToken
        .connect(market)
        .approve(lpVault.address, ethers.constants.MaxUint256),
      lpToken.mint(bob.address, parseEther('10000')),
      lpToken.mint(alice.address, parseEther('10000')),
      lpToken.mint(market.address, parseEther('1000')),
      // Pool Id for lpToken becomes 1
      masterChef.connect(owner).add(800, lpToken.address, false),
      // Pool Id for lptoken2 becomes 2
      masterChef.connect(owner).add(1000, lpToken2.address, false),
      syrup.connect(owner).transferOwnership(masterChef.address),
      cake.connect(owner).transferOwnership(masterChef.address),
    ]);
  });

  it('shows the pending rewards in the CAKE and lp token pools', async () => {
    expect(await lpVault.getPendingRewards()).to.be.equal(0);

    await lpVault.connect(market).deposit(alice.address, parseEther('10'));

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    // to get Cake rewards
    await lpVault.compound();

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    expect(await lpVault.getPendingRewards()).to.be.equal(
      (await masterChef.pendingCake(0, lpVault.address)).add(
        await masterChef.pendingCake(1, lpVault.address)
      )
    );
  });
  it('increases allowance to masterchef for cake and staking token', async () => {
    await lpVault.connect(market).deposit(alice.address, parseEther('10'));

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    // to get Cake rewards
    await lpVault.compound();

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    const [lpTokenAllowance, cakeAllowance] = await Promise.all([
      lpToken.allowance(lpVault.address, masterChef.address),
      cake.allowance(lpVault.address, masterChef.address),
    ]);

    await expect(lpVault.approve(5, 10))
      .to.emit(lpToken, 'Approval')
      .withArgs(lpVault.address, masterChef.address, lpTokenAllowance.add(5))
      .to.emit(cake, 'Approval')
      .withArgs(lpVault.address, masterChef.address, cakeAllowance.add(10));
  });
  it('allows to see how many pending rewards a user has', async () => {
    expect(await lpVault.getUserPendingRewards(alice.address)).to.be.equal(0);

    await lpVault.connect(market).deposit(alice.address, parseEther('10'));

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    // to get Cake rewards
    await lpVault.compound();

    lpVault.connect(market).deposit(bob.address, parseEther('20'));

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    await Promise.all([
      lpVault.connect(market).deposit(alice.address, parseEther('20')),
      lpVault.connect(market).deposit(bob.address, parseEther('15')),
    ]);

    // to get Cake rewards
    await lpVault.compound();

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    const [
      totalAmount,
      totalRewardsPerAmount,
      pendingRewards,
      aliceInfo,
      bobInfo,
    ] = await Promise.all([
      lpVault.totalAmount(),
      lpVault.totalRewardsPerAmount(),
      lpVault.getPendingRewards(),
      lpVault.userInfo(alice.address),
      lpVault.userInfo(bob.address),
    ]);

    const rewardsPerAmount = totalRewardsPerAmount.add(
      pendingRewards.mul(1e12).div(totalAmount)
    );

    const aliceRewards = aliceInfo.rewards.add(
      rewardsPerAmount.mul(parseEther('30')).div(1e12).sub(aliceInfo.rewardDebt)
    );

    const bobRewards = bobInfo.rewards.add(
      rewardsPerAmount.mul(parseEther('35')).div(1e12).sub(bobInfo.rewardDebt)
    );

    expect(await lpVault.getUserPendingRewards(alice.address)).to.be.equal(
      aliceRewards
    );

    expect(await lpVault.getUserPendingRewards(bob.address)).to.be.equal(
      bobRewards
    );

    expect(await lpVault.getUserPendingRewards(owner.address)).to.be.equal(0);

    // @notice pending rewards need to account for current pending cake in the pool + the auto compounded cake
    expect(aliceRewards.add(bobRewards)).to.be.equal(
      totalRewardsPerAmount
        .add(pendingRewards.mul(1e12).div(totalAmount))
        .mul(parseEther('65'))
        .div(1e12)
        .sub(aliceInfo.rewardDebt)
        .sub(bobInfo.rewardDebt)
        .add(aliceInfo.rewards)
        .add(bobInfo.rewards)
    );
  });
  it('reinvests the Cake rewards from the farm and Cake pool back in the Cake pool', async () => {
    await Promise.all([
      lpVault.connect(market).deposit(alice.address, parseEther('10')),
      lpVault.connect(market).deposit(bob.address, parseEther('30')),
    ]);

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    const [pendingRewards, totalRewardsPerAmount, masterChefUserInfo] =
      await Promise.all([
        lpVault.getPendingRewards(),
        lpVault.totalRewardsPerAmount(),
        masterChef.userInfo(0, lpVault.address),
      ]);

    // There are pending rewards that can be compounded
    expect(pendingRewards).to.be.not.equal(0);
    expect(await cake.balanceOf(alice.address)).to.be.equal(0);

    await expect(lpVault.connect(alice).compound())
      .to.emit(lpVault, 'Compound')
      .to.emit(masterChef, 'Deposit')
      .to.emit(masterChef, 'Withdraw');

    const [
      pendingRewards2,
      totalRewardsPerAmount2,
      totalAmount,
      masterChefUserInfo2,
    ] = await Promise.all([
      lpVault.getPendingRewards(),
      lpVault.totalRewardsPerAmount(),
      lpVault.totalAmount(),
      masterChef.userInfo(0, lpVault.address),
    ]);

    // Due to delays it is possible that we already accumulated some rewards after compounding
    // So we test that there are less rewards after compounding
    expect(pendingRewards.gt(pendingRewards2)).to.be.equal(true);
    // Test that the `CAKE` pool amount increased more than the pending rewards before compound
    expect(
      masterChefUserInfo2.amount.gt(
        masterChefUserInfo.amount.add(pendingRewards)
      )
    ).to.be.equal(true);
    // Properly updated the totalRewardsPerAmount
    expect(totalRewardsPerAmount2).to.be.equal(
      totalRewardsPerAmount.add(
        masterChefUserInfo2.amount
          .sub(masterChefUserInfo.amount)
          .mul(1e12)
          .div(totalAmount)
      )
    );
    // Paid the `msg.sender`
    expect((await cake.balanceOf(alice.address)).gt(0)).to.be.equal(true);
  });
  describe('function: deposit', () => {
    it('reverts if the amount if smaller or 0', async () => {
      await expect(
        lpVault.connect(market).deposit(alice.address, 0)
      ).to.revertedWith('Vault: no zero amount');
    });
    it('reverts if the amount if smaller or 0', async () => {
      await expect(
        lpVault.connect(market).deposit(ethers.constants.AddressZero, 10)
      ).to.revertedWith('Vault: no zero address');
    });
    it('reverts if the user is not the market', async () => {
      await expect(
        lpVault.connect(owner).deposit(alice.address, 10)
      ).to.revertedWith('Vault: only market');
      await expect(
        lpVault.connect(alice).deposit(alice.address, 10)
      ).to.revertedWith('Vault: only market');
      await expect(
        lpVault.connect(bob).deposit(alice.address, 10)
      ).to.revertedWith('Vault: only market');
    });
    it('allows deposits', async () => {
      const [
        aliceInfo,
        totalAmount,
        totalRewardsPerAmount,
        masterChefCakePool,
        masterChefLpPool,
      ] = await Promise.all([
        lpVault.userInfo(alice.address),
        lpVault.totalAmount(),
        lpVault.totalRewardsPerAmount(),
        masterChef.userInfo(0, lpVault.address),
        masterChef.userInfo(1, lpVault.address),
      ]);

      expect(aliceInfo.rewardDebt).to.be.equal(0);
      expect(aliceInfo.rewards).to.be.equal(0);
      expect(aliceInfo.amount).to.be.equal(0);
      expect(totalAmount).to.be.equal(0);
      expect(totalRewardsPerAmount).to.be.equal(0);
      expect(masterChefCakePool.amount).to.be.equal(0);
      expect(masterChefLpPool.amount).to.be.equal(0);

      await expect(
        lpVault.connect(market).deposit(alice.address, parseEther('20'))
      )
        .to.emit(lpVault, 'Deposit')
        .withArgs(alice.address, parseEther('20'))
        .to.emit(masterChef, 'Deposit')
        .withArgs(lpVault.address, 1, parseEther('20'))
        .to.not.emit(cake, 'Transfer');

      const [
        aliceInfo2,
        totalAmount2,
        totalRewardsPerAmount2,
        masterChefCakePool2,
        masterChefLpPool2,
      ] = await Promise.all([
        lpVault.userInfo(alice.address),
        lpVault.totalAmount(),
        lpVault.totalRewardsPerAmount(),
        masterChef.userInfo(0, lpVault.address),
        masterChef.userInfo(1, lpVault.address),
      ]);

      expect(aliceInfo2.rewardDebt).to.be.equal(0);
      expect(aliceInfo2.rewards).to.be.equal(0);
      expect(aliceInfo2.amount).to.be.equal(parseEther('20'));
      expect(totalAmount2).to.be.equal(parseEther('20'));
      expect(totalRewardsPerAmount2).to.be.equal(0);
      expect(masterChefCakePool2.amount).to.be.equal(0);
      expect(masterChefLpPool2.amount).to.be.equal(parseEther('20'));

      await expect(
        lpVault.connect(market).deposit(alice.address, parseEther('10'))
      )
        .to.emit(lpVault, 'Deposit')
        .withArgs(alice.address, parseEther('10'))
        .to.emit(masterChef, 'Deposit')
        .withArgs(lpVault.address, 1, parseEther('10'))
        // Cake was deposited
        .to.emit(cake, 'Transfer')
        // Rewards were reinvested to Cake Pool
        .to.emit(masterChef, 'Deposit')
        // Rewards were taken from lpToken Farm
        .withArgs(lpVault.address, 1, 0);

      const [
        aliceInfo3,
        totalAmount3,
        totalRewardsPerAmount3,
        masterChefCakePool3,
        masterChefLpPool3,
      ] = await Promise.all([
        lpVault.userInfo(alice.address),
        lpVault.totalAmount(),
        lpVault.totalRewardsPerAmount(),
        masterChef.userInfo(0, lpVault.address),
        masterChef.userInfo(1, lpVault.address),
      ]);

      expect(aliceInfo3.rewardDebt).to.be.equal(
        totalRewardsPerAmount3.mul(parseEther('30')).div(1e12)
      );
      expect(aliceInfo3.rewards).to.be.equal(
        totalRewardsPerAmount3.mul(parseEther('20')).div(1e12)
      );
      expect(aliceInfo3.amount).to.be.equal(parseEther('30'));
      expect(totalAmount3).to.be.equal(parseEther('30'));
      expect(totalRewardsPerAmount3).to.be.equal(
        totalRewardsPerAmount2
          .add(masterChefCakePool3.amount)
          .mul(1e12)
          .div(totalAmount2)
      );
      // Hard to calculate precise Cake reward
      expect(masterChefCakePool3.amount.gt(0)).to.be.equal(true);
      expect(masterChefLpPool3.amount).to.be.equal(parseEther('30'));
    });
  });
});
