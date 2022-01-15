import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { CakeToken, CakeVault, MasterChef, SyrupBar } from '../typechain';
import { advanceBlock, deploy } from './lib/test-utils';

const { parseEther } = ethers.utils;

const CAKE_PER_BLOCK = parseEther('40');

const START_BLOCK = 1;

describe('CakeVault', () => {
  let cake: CakeToken;
  let syrup: SyrupBar;
  let masterChef: MasterChef;
  let cakeVault: CakeVault;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let developer: SignerWithAddress;
  // @notice Market does not need to be an address for testing purposes
  let market: SignerWithAddress;
  let recipient: SignerWithAddress;

  beforeEach(async () => {
    [[owner, alice, bob, developer, market, recipient], cake] =
      await Promise.all([ethers.getSigners(), deploy('CakeToken')]);
    syrup = await deploy('SyrupBar', [cake.address]);
    masterChef = await deploy('MasterChef', [
      cake.address,
      syrup.address,
      developer.address,
      CAKE_PER_BLOCK,
      START_BLOCK,
    ]);

    cakeVault = await deploy('CakeVault', [masterChef.address, cake.address]);

    await Promise.all([
      cake
        .connect(alice)
        .approve(cakeVault.address, ethers.constants.MaxUint256),
      cake.connect(bob).approve(cakeVault.address, ethers.constants.MaxUint256),

      cake
        .connect(owner)
        ['mint(address,uint256)'](alice.address, parseEther('100')),
      cake
        .connect(owner)
        ['mint(address,uint256)'](bob.address, parseEther('100')),
      syrup.connect(owner).transferOwnership(masterChef.address),
      cake.connect(owner).transferOwnership(masterChef.address),
      cakeVault.connect(owner).setMarket(market.address),
    ]);
  });

  describe('function: setMarket', () => {
    it('reverts if it is not called byt he owner', async () => {
      await expect(
        cakeVault.connect(alice).setMarket(bob.address)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if the market is already set', async () => {
      await expect(
        cakeVault.connect(owner).setMarket(bob.address)
      ).to.revertedWith('Vault: already set');
    });
  });

  it('shows the pending rewards in the CAKE pool', async () => {
    expect(await cakeVault.getPendingRewards()).to.be.equal(0);

    await cakeVault.connect(market).deposit(alice.address, parseEther('10'));

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    expect(await cakeVault.getPendingRewards()).to.be.equal(
      await masterChef.pendingCake(0, cakeVault.address)
    );
  });
  it('increases allowance to masterchef for cake', async () => {
    await cakeVault.connect(market).deposit(alice.address, parseEther('10'));

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    // to get Cake rewards
    await cakeVault.compound();

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    const cakeAllowance = await cake.allowance(
      cakeVault.address,
      masterChef.address
    );

    await expect(cakeVault.approve(5))
      .to.emit(cake, 'Approval')
      .withArgs(cakeVault.address, masterChef.address, cakeAllowance.add(5));
  });
  it('allows to see how many pending rewards a user has', async () => {
    expect(await cakeVault.getUserPendingRewards(alice.address)).to.be.equal(0);

    await cakeVault.connect(market).deposit(alice.address, parseEther('10'));

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    // to get Cake rewards
    await cakeVault.compound();

    cakeVault.connect(market).deposit(bob.address, parseEther('20'));

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    await Promise.all([
      cakeVault.connect(market).deposit(alice.address, parseEther('20')),
      cakeVault.connect(market).deposit(bob.address, parseEther('15')),
    ]);

    // to get Cake rewards
    await cakeVault.compound();

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
      cakeVault.totalAmount(),
      cakeVault.totalRewardsPerAmount(),
      cakeVault.getPendingRewards(),
      cakeVault.userInfo(alice.address),
      cakeVault.userInfo(bob.address),
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

    expect(await cakeVault.getUserPendingRewards(alice.address)).to.be.equal(
      aliceRewards
    );

    expect(await cakeVault.getUserPendingRewards(bob.address)).to.be.equal(
      bobRewards
    );

    expect(await cakeVault.getUserPendingRewards(owner.address)).to.be.equal(0);

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
  it('reinvests the Cake rewards from Cake pool back in the Cake pool', async () => {
    await Promise.all([
      cakeVault.connect(market).deposit(alice.address, parseEther('10')),
      cakeVault.connect(market).deposit(bob.address, parseEther('30')),
    ]);

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    const [
      pendingRewards,
      totalRewardsPerAmount,
      masterChefUserInfo,
      masterChefPendingCake,
      marketCakeBalance,
    ] = await Promise.all([
      cakeVault.getPendingRewards(),
      cakeVault.totalRewardsPerAmount(),
      masterChef.userInfo(0, cakeVault.address),
      masterChef.pendingCake(0, cakeVault.address),
      cake.balanceOf(market.address),
    ]);

    // There are pending rewards that can be compounded
    expect(pendingRewards).to.be.not.equal(0);
    expect(pendingRewards).to.be.equal(masterChefPendingCake);

    expect(marketCakeBalance).to.be.equal(0);

    await expect(cakeVault.connect(market).compound())
      .to.emit(cakeVault, 'Compound')
      .to.emit(masterChef, 'Deposit')
      .to.emit(masterChef, 'Withdraw')
      .withArgs(cakeVault.address, 0, 0);

    const [
      pendingRewards2,
      totalRewardsPerAmount2,
      totalAmount,
      masterChefUserInfo2,
    ] = await Promise.all([
      cakeVault.getPendingRewards(),
      cakeVault.totalRewardsPerAmount(),
      cakeVault.totalAmount(),
      masterChef.userInfo(0, cakeVault.address),
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
    expect((await cake.balanceOf(market.address)).gt(0)).to.be.equal(true);
  });
  describe('function: deposit', () => {
    it('reverts if the amount if smaller or 0', async () => {
      await expect(
        cakeVault.connect(market).deposit(alice.address, 0)
      ).to.revertedWith('Vault: no zero amount');
    });
    it('reverts if the account is the zero address', async () => {
      await expect(
        cakeVault.connect(market).deposit(ethers.constants.AddressZero, 10)
      ).to.revertedWith('Vault: no zero address');
    });
    it('reverts if the msg.sender is not the market', async () => {
      await expect(
        cakeVault.connect(owner).deposit(alice.address, 10)
      ).to.revertedWith('Vault: only market');
      await expect(
        cakeVault.connect(alice).deposit(alice.address, 10)
      ).to.revertedWith('Vault: only market');
      await expect(
        cakeVault.connect(bob).deposit(alice.address, 10)
      ).to.revertedWith('Vault: only market');
    });
    it('allows deposits', async () => {
      const [
        aliceInfo,
        totalAmount,
        totalRewardsPerAmount,
        masterChefCakePool,
      ] = await Promise.all([
        cakeVault.userInfo(alice.address),
        cakeVault.totalAmount(),
        cakeVault.totalRewardsPerAmount(),
        masterChef.userInfo(0, cakeVault.address),
      ]);

      expect(aliceInfo.rewardDebt).to.be.equal(0);
      expect(aliceInfo.rewards).to.be.equal(0);
      expect(aliceInfo.amount).to.be.equal(0);
      expect(totalAmount).to.be.equal(0);
      expect(totalRewardsPerAmount).to.be.equal(0);
      expect(masterChefCakePool.amount).to.be.equal(0);

      await expect(
        cakeVault.connect(market).deposit(alice.address, parseEther('20'))
      )
        .to.emit(cakeVault, 'Deposit')
        .withArgs(alice.address, parseEther('20'))
        .to.emit(masterChef, 'Deposit')
        .withArgs(cakeVault.address, 0, parseEther('20'))
        .to.emit(cake, 'Transfer')
        .withArgs(cakeVault.address, masterChef.address, parseEther('20'))
        .to.emit(cake, 'Transfer')
        .withArgs(alice.address, cakeVault.address, parseEther('20'));

      const [
        aliceInfo2,
        totalAmount2,
        totalRewardsPerAmount2,
        masterChefCakePool2,
      ] = await Promise.all([
        cakeVault.userInfo(alice.address),
        cakeVault.totalAmount(),
        cakeVault.totalRewardsPerAmount(),
        masterChef.userInfo(0, cakeVault.address),
      ]);

      // @notice first deposit has no rewards
      expect(aliceInfo2.rewardDebt).to.be.equal(0);
      expect(aliceInfo2.rewards).to.be.equal(0);
      expect(aliceInfo2.amount).to.be.equal(parseEther('20'));
      expect(totalAmount2).to.be.equal(parseEther('20'));
      expect(totalRewardsPerAmount2).to.be.equal(0);
      expect(masterChefCakePool2.amount).to.be.equal(parseEther('20'));

      await expect(
        cakeVault.connect(market).deposit(alice.address, parseEther('10'))
      )
        .to.emit(cakeVault, 'Deposit')
        .withArgs(alice.address, parseEther('10'))
        .to.emit(masterChef, 'Deposit')
        .to.emit(cake, 'Transfer')
        .withArgs(alice.address, cakeVault.address, parseEther('10'));

      const [
        aliceInfo3,
        totalAmount3,
        totalRewardsPerAmount3,
        masterChefCakePool3,
      ] = await Promise.all([
        cakeVault.userInfo(alice.address),
        cakeVault.totalAmount(),
        cakeVault.totalRewardsPerAmount(),
        masterChef.userInfo(0, cakeVault.address),
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
          .sub(parseEther('30'))
          .mul(1e12)
          .div(totalAmount2)
      );
      // Hard to calculate precise Cake reward. if it has more than the total amount it means rewards were compounded
      expect(masterChefCakePool3.amount.gt(parseEther('30'))).to.be.equal(true);
    });
  });
  describe('function: withdraw', () => {
    it('reverts if the amount is 0', async () => {
      await expect(
        cakeVault.connect(market).withdraw(alice.address, alice.address, 0)
      ).to.revertedWith('Vault: no zero amount');
    });
    it('reverts if the account that is withdrawing is the zero address', async () => {
      await expect(
        cakeVault
          .connect(market)
          .withdraw(ethers.constants.AddressZero, alice.address, 10)
      ).to.revertedWith('Vault: no zero address');
    });
    it('reverts if the recipient of the tokens and rewards is the zero address', async () => {
      await expect(
        cakeVault
          .connect(market)
          .withdraw(alice.address, ethers.constants.AddressZero, 10)
      ).to.revertedWith('Vault: no zero address');
    });
    it('reverts if the msg.sender is not the market', async () => {
      await expect(
        cakeVault.connect(owner).withdraw(alice.address, alice.address, 10)
      ).to.revertedWith('Vault: only market');
      await expect(
        cakeVault.connect(alice).withdraw(alice.address, alice.address, 10)
      ).to.revertedWith('Vault: only market');
      await expect(
        cakeVault.connect(bob).withdraw(alice.address, alice.address, 10)
      ).to.revertedWith('Vault: only market');
    });
    it('reverts if the msg.sender tries to withdraw more than the account has', async () => {
      await cakeVault.connect(market).deposit(alice.address, parseEther('20'));

      await expect(
        cakeVault
          .connect(market)
          .withdraw(alice.address, alice.address, parseEther('20.1'))
      ).to.revertedWith('Vault: not enough tokens');
    });
    it('market to withdraw assets', async () => {
      await Promise.all([
        cakeVault.connect(market).deposit(alice.address, parseEther('20')),
        cakeVault.connect(market).deposit(bob.address, parseEther('30')),
      ]);

      // accrue some cake
      await advanceBlock(ethers);
      await advanceBlock(ethers);
      await advanceBlock(ethers);
      await advanceBlock(ethers);

      const [
        aliceInfo,
        totalAmount,
        totalRewardsPerAmount,
        masterChefCakePool,
        recipientCakeBalance,
        aliceCakeBalance,
      ] = await Promise.all([
        cakeVault.userInfo(alice.address),
        cakeVault.totalAmount(),
        cakeVault.totalRewardsPerAmount(),
        masterChef.userInfo(0, cakeVault.address),
        cake.balanceOf(recipient.address),
        cake.balanceOf(alice.address),
      ]);

      expect(aliceInfo.amount).to.be.equal(parseEther('20'));
      expect(aliceInfo.rewardDebt).to.be.equal(0); // @notice she was the first to deposit
      expect(totalAmount).to.be.equal(parseEther('50'));
      expect(recipientCakeBalance).to.be.equal(0);
      // Cuz rewards got compounded
      expect(masterChefCakePool.amount.gt(parseEther('50'))).to.be.equal(true);

      await expect(
        cakeVault
          .connect(market)
          .withdraw(alice.address, recipient.address, parseEther('10'))
      )
        .to.emit(masterChef, 'Withdraw')
        .withArgs(cakeVault.address, 0, parseEther('10'))
        .to.emit(cake, 'Transfer')
        .withArgs(masterChef.address, cakeVault.address, parseEther('10'));

      const [
        aliceInfo2,
        totalAmount2,
        totalRewardsPerAmount2,
        masterChefCakePool2,
        recipientCakeBalance2,
        aliceCakeBalance2,
      ] = await Promise.all([
        cakeVault.userInfo(alice.address),
        cakeVault.totalAmount(),
        cakeVault.totalRewardsPerAmount(),
        masterChef.userInfo(0, cakeVault.address),
        cake.balanceOf(recipient.address),
        cake.balanceOf(alice.address),
      ]);

      expect(aliceInfo2.amount).to.be.equal(parseEther('10'));
      expect(aliceInfo2.rewardDebt).to.be.equal(
        totalRewardsPerAmount2.mul(parseEther('10')).div(1e12)
      );
      expect(aliceInfo2.rewards).to.be.equal(0);
      expect(totalRewardsPerAmount2.gt(totalRewardsPerAmount)).to.be.equal(
        true
      );
      expect(totalRewardsPerAmount2.isZero()).to.be.equal(false);
      // Means pool has rewards
      expect(masterChefCakePool2.amount.gt(totalAmount2)).to.be.equal(true);
      expect(totalAmount2).to.be.equal(parseEther('40'));
      // Means recipient got the cake amount + rewards
      expect(recipientCakeBalance2.eq(parseEther('10'))).to.be.equal(true);
      // Alice cake balance increase after withdraw it means she got the rewards
      expect(aliceCakeBalance2.gt(aliceCakeBalance)).to.be.equal(true);

      await Promise.all([
        cakeVault
          .connect(market)
          .withdraw(alice.address, recipient.address, parseEther('10')),
        cakeVault
          .connect(market)
          .withdraw(bob.address, recipient.address, parseEther('30')),
      ]);

      const [bobInfo, totalAmount3, totalRewardsPerAmount3] = await Promise.all(
        [
          cakeVault.userInfo(bob.address),
          cakeVault.totalAmount(),
          cakeVault.totalRewardsPerAmount(),
        ]
      );

      expect(bobInfo.rewardDebt).to.be.equal(0);
      expect(bobInfo.amount).to.be.equal(0);
      expect(totalAmount3).to.be.equal(0);
      expect(totalRewardsPerAmount3).to.be.equal(0);
    });
  });
});
