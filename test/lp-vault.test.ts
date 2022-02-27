import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  CakeToken,
  LPVault,
  MasterChef,
  MockERC20,
  SyrupBar,
  TestLPVaultV2,
} from '../typechain';
import {
  advanceBlock,
  deploy,
  deployUUPS,
  multiDeploy,
  upgrade,
} from './lib/test-utils';

const { parseEther } = ethers.utils;

const CAKE_PER_BLOCK = parseEther('40');

const START_BLOCK = 1;

describe('Master Chef LPVault', () => {
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

    [lpToken, lpToken2] = await multiDeploy(
      ['MockERC20', 'MockERC20'],
      [
        ['CAKE-LP', 'LP', parseEther('1000000')],
        ['CAKE-LP-2', 'LP-2', parseEther('1000000')],
      ]
    );

    lpVault = await deployUUPS('LPVault', [
      masterChef.address,
      cake.address,
      lpToken.address,
      1,
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
      lpVault.connect(owner).setMarket(market.address),
    ]);
  });

  describe('function: initialize', () => {
    it('reverts if you initialize after deployment', async () => {
      await expect(
        lpVault.initialize(masterChef.address, cake.address, lpToken.address, 1)
      ).to.revertedWith('Initializable: contract is already initialized');
    });

    it('gives maximum approval to the master chef', async () => {
      expect(
        await cake.allowance(lpVault.address, masterChef.address)
      ).to.be.equal(ethers.constants.MaxUint256);
      expect(
        await lpToken.allowance(lpVault.address, masterChef.address)
      ).to.be.equal(ethers.constants.MaxUint256);
    });

    it('reverts if the pool id is 0', async () => {
      expect(
        deployUUPS('LPVault', [
          masterChef.address,
          cake.address,
          lpToken.address,
          0,
        ])
      ).to.revertedWith('LPVault: this is a LP vault');
    });

    it('sets the initial state correctly', async () => {
      const [_masterChef, _cake, _stakingToken, _poolId] = await Promise.all([
        lpVault.CAKE_MASTER_CHEF(),
        lpVault.CAKE(),
        lpVault.STAKING_TOKEN(),
        lpVault.POOL_ID(),
      ]);

      expect(_masterChef).to.be.equal(masterChef.address);
      expect(_cake).to.be.equal(cake.address);
      expect(_stakingToken).to.be.equal(lpToken.address);
      expect(_poolId).to.be.equal(1);
    });
  });

  describe('function: setMarket', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        lpVault.connect(alice).setMarket(bob.address)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if we pass the address zero', async () => {
      await expect(
        lpVault.connect(owner).setMarket(ethers.constants.AddressZero)
      ).to.revertedWith('Vault: no zero address');
    });
    it('reverts if the market is already set', async () => {
      await expect(
        lpVault.connect(owner).setMarket(bob.address)
      ).to.revertedWith('Vault: already set');
    });
  });

  it('shows the pending rewards in the CAKE and lp token pools', async () => {
    expect(await lpVault.getPendingRewards()).to.be.equal(0);

    await lpVault
      .connect(market)
      .deposit(alice.address, alice.address, parseEther('10'));

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
    await lpVault
      .connect(market)
      .deposit(alice.address, alice.address, parseEther('10'));

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    // to get Cake rewards
    await Promise.all([
      lpVault.compound(),
      lpToken.setAllowance(lpVault.address, masterChef.address, 10_000),
    ]);
    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    const [lpTokenAllowance, cakeAllowance] = await Promise.all([
      lpToken.allowance(lpVault.address, masterChef.address),
      cake.allowance(lpVault.address, masterChef.address),
    ]);

    expect(cakeAllowance.lt(ethers.constants.MaxUint256)).to.be.equal(true);
    expect(lpTokenAllowance).to.be.equal(10_000);

    await expect(lpVault.approve())
      .to.emit(lpToken, 'Approval')
      .withArgs(
        lpVault.address,
        masterChef.address,
        ethers.constants.MaxUint256
      )
      .to.emit(cake, 'Approval')
      .withArgs(
        lpVault.address,
        masterChef.address,
        ethers.constants.MaxUint256
      );

    const [lpTokenAllowance2, cakeAllowance2] = await Promise.all([
      lpToken.allowance(lpVault.address, masterChef.address),
      cake.allowance(lpVault.address, masterChef.address),
    ]);

    expect(lpTokenAllowance2).to.be.equal(ethers.constants.MaxUint256);
    expect(cakeAllowance2).to.be.equal(ethers.constants.MaxUint256);
  });
  it('allows to see how many pending rewards a user has', async () => {
    expect(await lpVault.getUserPendingRewards(alice.address)).to.be.equal(0);

    await lpVault
      .connect(market)
      .deposit(alice.address, alice.address, parseEther('10'));

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    // to get Cake rewards
    await lpVault.compound();

    lpVault.connect(market).deposit(bob.address, bob.address, parseEther('20'));

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    await Promise.all([
      lpVault
        .connect(market)
        .deposit(alice.address, alice.address, parseEther('20')),
      lpVault
        .connect(market)
        .deposit(bob.address, bob.address, parseEther('15')),
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
      pendingRewards.mul(parseEther('1')).div(totalAmount)
    );

    const aliceRewards = aliceInfo.rewards.add(
      rewardsPerAmount
        .mul(parseEther('30'))
        .div(parseEther('1'))
        .sub(aliceInfo.rewardDebt)
    );

    const bobRewards = bobInfo.rewards.add(
      rewardsPerAmount
        .mul(parseEther('35'))
        .div(parseEther('1'))
        .sub(bobInfo.rewardDebt)
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
        .add(pendingRewards.mul(parseEther('1')).div(totalAmount))
        .mul(parseEther('65'))
        .div(parseEther('1'))
        .sub(aliceInfo.rewardDebt)
        .sub(bobInfo.rewardDebt)
        .add(aliceInfo.rewards)
        .add(bobInfo.rewards)
    );
  });
  it('reinvests the Cake rewards from the farm and Cake pool back in the Cake pool', async () => {
    await Promise.all([
      lpVault
        .connect(market)
        .deposit(alice.address, alice.address, parseEther('10')),
      lpVault
        .connect(market)
        .deposit(bob.address, bob.address, parseEther('30')),
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
          .mul(parseEther('1'))
          .div(totalAmount)
      )
    );
    // Paid the `msg.sender`
    expect((await cake.balanceOf(alice.address)).gt(0)).to.be.equal(true);
  });
  describe('function: deposit', () => {
    it('reverts if the amount is smaller or 0', async () => {
      await expect(
        lpVault.connect(market).deposit(alice.address, alice.address, 0)
      ).to.revertedWith('Vault: no zero amount');
    });
    it('reverts if the first parameter is the zero address', async () => {
      await expect(
        lpVault
          .connect(market)
          .deposit(ethers.constants.AddressZero, alice.address, 10)
      ).to.revertedWith('Vault: no zero address');
    });
    it('reverts if the second parameter is the zero address', async () => {
      await expect(
        lpVault
          .connect(market)
          .deposit(alice.address, ethers.constants.AddressZero, 10)
      ).to.revertedWith('Vault: no zero address');
    });
    it('reverts if the msg.sender is not the market', async () => {
      await expect(
        lpVault.connect(owner).deposit(alice.address, alice.address, 10)
      ).to.revertedWith('Vault: only market');
      await expect(
        lpVault.connect(alice).deposit(alice.address, alice.address, 10)
      ).to.revertedWith('Vault: only market');
      await expect(
        lpVault.connect(bob).deposit(alice.address, alice.address, 10)
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
        lpVault
          .connect(market)
          .deposit(alice.address, alice.address, parseEther('20'))
      )
        .to.emit(lpVault, 'Deposit')
        .withArgs(alice.address, alice.address, parseEther('20'))
        .to.emit(masterChef, 'Deposit')
        .withArgs(lpVault.address, 1, parseEther('20'))
        .to.emit(lpToken, 'Transfer')
        .withArgs(alice.address, lpVault.address, parseEther('20'));

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
        lpVault
          .connect(market)
          .deposit(alice.address, alice.address, parseEther('10'))
      )
        .to.emit(lpVault, 'Deposit')
        .withArgs(alice.address, alice.address, parseEther('10'))
        .to.emit(masterChef, 'Deposit')
        .withArgs(lpVault.address, 1, parseEther('10'))
        // Rewards were reinvested to Cake Pool
        .to.emit(masterChef, 'Deposit')
        // Rewards were taken from lpToken Farm
        .withArgs(lpVault.address, 1, 0)
        .to.emit(lpToken, 'Transfer')
        .withArgs(alice.address, lpVault.address, parseEther('10'));

      const [
        aliceInfo3,
        bobInfo,
        totalAmount3,
        totalRewardsPerAmount3,
        masterChefCakePool3,
        masterChefLpPool3,
      ] = await Promise.all([
        lpVault.userInfo(alice.address),
        lpVault.userInfo(bob.address),
        lpVault.totalAmount(),
        lpVault.totalRewardsPerAmount(),
        masterChef.userInfo(0, lpVault.address),
        masterChef.userInfo(1, lpVault.address),
      ]);

      expect(aliceInfo3.rewardDebt).to.be.equal(
        totalRewardsPerAmount3.mul(parseEther('30')).div(parseEther('1'))
      );
      expect(aliceInfo3.rewards).to.be.equal(
        totalRewardsPerAmount3.mul(parseEther('20')).div(parseEther('1'))
      );
      expect(aliceInfo3.amount).to.be.equal(parseEther('30'));
      expect(totalAmount3).to.be.equal(parseEther('30'));
      expect(totalRewardsPerAmount3).to.be.equal(
        totalRewardsPerAmount2
          .add(masterChefCakePool3.amount)
          .mul(parseEther('1'))
          .div(totalAmount2)
      );
      // Hard to calculate precise Cake reward
      expect(masterChefCakePool3.amount.gt(0)).to.be.equal(true);
      expect(masterChefLpPool3.amount).to.be.equal(parseEther('30'));

      expect(bobInfo.amount).to.be.equal(0);
      expect(bobInfo.rewardDebt).to.be.equal(0);
      expect(bobInfo.rewards).to.be.equal(0);

      await expect(
        lpVault
          .connect(market)
          .deposit(alice.address, bob.address, parseEther('10'))
      )
        .to.emit(lpVault, 'Deposit')
        .withArgs(alice.address, bob.address, parseEther('10'))
        .to.emit(masterChef, 'Deposit')
        .withArgs(lpVault.address, 1, parseEther('10'))
        // Rewards were reinvested to Cake Pool
        .to.emit(masterChef, 'Deposit')
        // Rewards were taken from lpToken Farm
        .withArgs(lpVault.address, 1, 0)
        .to.emit(lpToken, 'Transfer')
        .withArgs(alice.address, lpVault.address, parseEther('10'));

      const [
        aliceInfo4,
        bobInfo2,
        totalAmount4,
        totalRewardsPerAmount4,
        masterChefCakePool4,
        masterChefLpPool4,
      ] = await Promise.all([
        lpVault.userInfo(alice.address),
        lpVault.userInfo(bob.address),
        lpVault.totalAmount(),
        lpVault.totalRewardsPerAmount(),
        masterChef.userInfo(0, lpVault.address),
        masterChef.userInfo(1, lpVault.address),
      ]);

      // Alice info does not change
      expect(aliceInfo3.rewardDebt).to.be.equal(aliceInfo4.rewardDebt);
      expect(aliceInfo3.rewards).to.be.equal(aliceInfo4.rewards);
      expect(aliceInfo3.amount).to.be.equal(aliceInfo4.amount);

      // Bob info gets updated
      expect(bobInfo2.amount).to.be.equal(parseEther('10'));
      expect(bobInfo2.rewards).to.be.equal(0);
      expect(bobInfo2.rewardDebt).to.be.equal(
        totalRewardsPerAmount4.mul(parseEther('10')).div(parseEther('1'))
      );
      expect(totalAmount4).to.be.equal(totalAmount3.add(parseEther('10')));
      expect(masterChefLpPool4.amount).to.be.equal(
        masterChefLpPool3.amount.add(parseEther('10'))
      );
      expect(totalRewardsPerAmount4).to.be.equal(
        totalRewardsPerAmount3.add(
          masterChefCakePool4.amount
            .sub(masterChefCakePool3.amount)
            .mul(parseEther('1'))
            .div(totalAmount3)
        )
      );
      expect(
        masterChefCakePool4.amount.gt(masterChefLpPool3.amount)
      ).to.be.equal(true);
    });
  });
  describe('function: withdraw', () => {
    it('reverts if the amount is 0', async () => {
      await expect(
        lpVault.connect(market).withdraw(alice.address, alice.address, 0)
      ).to.revertedWith('Vault: no zero amount');
    });
    it('reverts if the account that is withdrawing is the zero address', async () => {
      await expect(
        lpVault
          .connect(market)
          .withdraw(ethers.constants.AddressZero, alice.address, 10)
      ).to.revertedWith('Vault: no zero address');
    });
    it('reverts if the recipient of the tokens and rewards is the zero address', async () => {
      await expect(
        lpVault
          .connect(market)
          .withdraw(alice.address, ethers.constants.AddressZero, 10)
      ).to.revertedWith('Vault: no zero address');
    });
    it('reverts if there are no tokens deposited in the vault', async () => {
      await expect(
        lpVault.connect(market).withdraw(alice.address, alice.address, 10)
      ).to.revertedWith('Vault: no tokens');
    });
    it('reverts if the msg.sender is not the market', async () => {
      await expect(
        lpVault.connect(owner).withdraw(alice.address, alice.address, 10)
      ).to.revertedWith('Vault: only market');
      await expect(
        lpVault.connect(alice).withdraw(alice.address, alice.address, 10)
      ).to.revertedWith('Vault: only market');
      await expect(
        lpVault.connect(bob).withdraw(alice.address, alice.address, 10)
      ).to.revertedWith('Vault: only market');
    });
    it('reverts if the msg.sender tries to withdraw more than the account has', async () => {
      await lpVault
        .connect(market)
        .deposit(alice.address, alice.address, parseEther('20'));

      await expect(
        lpVault
          .connect(market)
          .withdraw(alice.address, alice.address, parseEther('20.1'))
      ).to.revertedWith('Vault: not enough tokens');
    });
    it('market to withdraw assets', async () => {
      await Promise.all([
        lpVault
          .connect(market)
          .deposit(alice.address, alice.address, parseEther('20')),
        lpVault
          .connect(market)
          .deposit(bob.address, bob.address, parseEther('30')),
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
        masterChefLpPool,
        recipientLpTokenBalance,
        aliceCakeBalance,
      ] = await Promise.all([
        lpVault.userInfo(alice.address),
        lpVault.totalAmount(),
        lpVault.totalRewardsPerAmount(),
        masterChef.userInfo(0, lpVault.address),
        masterChef.userInfo(1, lpVault.address),
        lpToken.balanceOf(recipient.address),
        cake.balanceOf(alice.address),
      ]);

      expect(aliceInfo.amount).to.be.equal(parseEther('20'));
      expect(aliceInfo.rewardDebt).to.be.equal(0); // @notice she was the first to deposit
      expect(totalAmount).to.be.equal(parseEther('50'));
      expect(masterChefLpPool.amount).to.be.equal(parseEther('50'));
      expect(recipientLpTokenBalance).to.be.equal(0);
      expect(aliceCakeBalance).to.be.equal(0);

      await expect(
        lpVault
          .connect(market)
          .withdraw(alice.address, recipient.address, parseEther('10'))
      )
        .to.emit(masterChef, 'Withdraw')
        .withArgs(lpVault.address, 0, 0)
        .to.emit(masterChef, 'Withdraw')
        .withArgs(lpVault.address, 1, parseEther('10'))
        .to.emit(cake, 'Transfer')
        .to.emit(lpToken, 'Transfer')
        .withArgs(lpVault.address, recipient.address, parseEther('10'));

      const [
        aliceInfo2,
        totalAmount2,
        totalRewardsPerAmount2,
        masterChefCakePool2,
        masterChefLpPool2,
        recipientLpTokenBalance2,
        aliceCakeBalance2,
      ] = await Promise.all([
        lpVault.userInfo(alice.address),
        lpVault.totalAmount(),
        lpVault.totalRewardsPerAmount(),
        masterChef.userInfo(0, lpVault.address),
        masterChef.userInfo(1, lpVault.address),
        lpToken.balanceOf(recipient.address),
        cake.balanceOf(alice.address),
      ]);

      expect(aliceInfo2.amount).to.be.equal(parseEther('10'));
      expect(aliceInfo2.rewardDebt).to.be.equal(
        totalRewardsPerAmount2.mul(parseEther('10')).div(parseEther('1'))
      );
      expect(aliceInfo2.rewards).to.be.equal(0);
      expect(totalRewardsPerAmount2.gt(totalRewardsPerAmount)).to.be.equal(
        true
      );
      expect(totalRewardsPerAmount2.isZero()).to.be.equal(false);
      expect(
        masterChefCakePool2.amount.gt(masterChefCakePool.amount)
      ).to.be.equal(true);
      expect(totalAmount2).to.be.equal(parseEther('40'));
      expect(masterChefLpPool2.amount).to.be.equal(parseEther('40'));
      expect(recipientLpTokenBalance2).to.be.equal(parseEther('10'));
      expect(aliceCakeBalance2.gt(0)).to.be.equal(true);

      await Promise.all([
        lpVault
          .connect(market)
          .withdraw(alice.address, recipient.address, parseEther('10')),
        lpVault
          .connect(market)
          .withdraw(bob.address, recipient.address, parseEther('30')),
      ]);

      const [bobInfo, totalAmount3, totalRewardsPerAmount3] = await Promise.all(
        [
          lpVault.userInfo(bob.address),
          lpVault.totalAmount(),
          lpVault.totalRewardsPerAmount(),
        ]
      );

      expect(bobInfo.rewardDebt).to.be.equal(0);
      expect(bobInfo.amount).to.be.equal(0);
      expect(totalAmount3).to.be.equal(0);
      expect(totalRewardsPerAmount3).to.be.equal(0);
    });
  });

  describe('Upgrade functionality', () => {
    it('reverts if a non-owner tries to update', async () => {
      await lpVault.connect(owner).transferOwnership(alice.address);

      await expect(upgrade(lpVault, 'TestLPVaultV2')).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });

    it('upgrades to version 2', async () => {
      expect(await lpVault.getUserPendingRewards(alice.address)).to.be.equal(0);

      await lpVault
        .connect(market)
        .deposit(alice.address, alice.address, parseEther('10'));

      // accrue some cake
      await advanceBlock(ethers);
      await advanceBlock(ethers);

      // to get Cake rewards
      await lpVault.compound();

      lpVault
        .connect(market)
        .deposit(bob.address, bob.address, parseEther('20'));

      // accrue some cake
      await advanceBlock(ethers);
      await advanceBlock(ethers);

      await Promise.all([
        lpVault
          .connect(market)
          .deposit(alice.address, alice.address, parseEther('20')),
        lpVault
          .connect(market)
          .deposit(bob.address, bob.address, parseEther('15')),
      ]);

      // to get Cake rewards
      await lpVault.compound();

      // accrue some cake
      await advanceBlock(ethers);
      await advanceBlock(ethers);
      await advanceBlock(ethers);

      const lpVaultV2: TestLPVaultV2 = await upgrade(lpVault, 'TestLPVaultV2');

      const [
        totalAmount,
        totalRewardsPerAmount,
        pendingRewards,
        aliceInfo,
        bobInfo,
      ] = await Promise.all([
        lpVaultV2.totalAmount(),
        lpVaultV2.totalRewardsPerAmount(),
        lpVaultV2.getPendingRewards(),
        lpVaultV2.userInfo(alice.address),
        lpVaultV2.userInfo(bob.address),
      ]);

      const rewardsPerAmount = totalRewardsPerAmount.add(
        pendingRewards.mul(parseEther('1')).div(totalAmount)
      );

      const aliceRewards = aliceInfo.rewards.add(
        rewardsPerAmount
          .mul(parseEther('30'))
          .div(parseEther('1'))
          .sub(aliceInfo.rewardDebt)
      );

      const bobRewards = bobInfo.rewards.add(
        rewardsPerAmount
          .mul(parseEther('35'))
          .div(parseEther('1'))
          .sub(bobInfo.rewardDebt)
      );

      const [
        alicePendingRewards,
        bobPendingRewards,
        ownerPendingRewards,
        version,
      ] = await Promise.all([
        lpVaultV2.getUserPendingRewards(alice.address),
        lpVaultV2.getUserPendingRewards(bob.address),
        lpVaultV2.getUserPendingRewards(owner.address),
        lpVaultV2.version(),
      ]);

      expect(alicePendingRewards).to.be.equal(aliceRewards);

      expect(bobPendingRewards).to.be.equal(bobRewards);

      expect(ownerPendingRewards).to.be.equal(0);

      // @notice pending rewards need to account for current pending cake in the pool + the auto compounded cake
      expect(aliceRewards.add(bobRewards)).to.be.equal(
        totalRewardsPerAmount
          .add(pendingRewards.mul(parseEther('1')).div(totalAmount))
          .mul(parseEther('65'))
          .div(parseEther('1'))
          .sub(aliceInfo.rewardDebt)
          .sub(bobInfo.rewardDebt)
          .add(aliceInfo.rewards)
          .add(bobInfo.rewards)
      );

      expect(version).to.be.equal('V2');
    });
  });
});
