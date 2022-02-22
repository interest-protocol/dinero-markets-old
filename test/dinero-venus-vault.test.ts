import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  Dinero,
  LiquidityRouter,
  MockERC20,
  MockNoInfiniteAllowanceERC20,
  MockSafeVenus,
  MockVenusToken,
  MockVenusTroller,
  PancakeFactory,
  PancakeRouter,
  TestDineroVenusVault,
  WETH9,
} from '../typechain';
import { deploy, multiDeploy } from './lib/test-utils';

const { parseEther } = ethers.utils;

const INITIAL_SUPPLY = parseEther('10000');

describe('DineroVenusVault', () => {
  let dineroVenusVault: TestDineroVenusVault;
  let dinero: Dinero;
  let XVS: MockNoInfiniteAllowanceERC20;
  let WBNB: MockERC20;
  let USDC: MockERC20;
  let DAI: MockERC20;
  let vUSDC: MockVenusToken;
  let vDAI: MockVenusToken;
  let liquidityRouter: LiquidityRouter;
  let router: PancakeRouter;
  let WETH: WETH9;
  let factory: PancakeFactory;
  let venusController: MockVenusTroller;
  let safeVenus: MockSafeVenus;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let feeTo: SignerWithAddress;

  beforeEach(async () => {
    [
      [owner, alice, bob, feeTo],
      [XVS, WBNB, USDC, DAI, vUSDC, vDAI, WETH, dinero, safeVenus],
    ] = await Promise.all([
      ethers.getSigners(),
      multiDeploy(
        [
          'MockNoInfiniteAllowanceERC20',
          'MockERC20',
          'MockERC20',
          'MockERC20',
          'MockVenusToken',
          'MockVenusToken',
          'WETH9',
          'Dinero',
          'MockSafeVenus',
        ],
        [
          ['Venus Token', 'XVS', INITIAL_SUPPLY],
          ['Wrapped BNB', 'WBNB', INITIAL_SUPPLY],
          ['USDC', 'USDC', INITIAL_SUPPLY],
          ['DAI', 'DAI', INITIAL_SUPPLY],
          ['Venus USDC', 'vUSDC', 0],
          ['Venus DAI', 'vDAI', 0],
          [],
          [],
          [],
          [],
        ]
      ),
    ]);

    [factory, venusController] = await multiDeploy(
      ['PancakeFactory', 'MockVenusTroller'],
      [[feeTo.address], [XVS.address]]
    );

    [liquidityRouter, router] = await multiDeploy(
      ['LiquidityRouter', 'PancakeRouter'],
      [
        [factory.address, WETH.address],
        [factory.address, WETH.address],
      ]
    );

    dineroVenusVault = await deploy('TestDineroVenusVault', [
      XVS.address,
      WBNB.address,
      router.address,
      venusController.address,
      dinero.address,
      safeVenus.address,
      feeTo.address,
    ]);

    await Promise.all([
      dinero
        .connect(owner)
        .grantRole(await dinero.MINTER_ROLE(), dineroVenusVault.address),
      XVS.mint(owner.address, parseEther('500000')),
      DAI.mint(owner.address, parseEther('1000000')),
      WBNB.mint(owner.address, parseEther('20000')),
      USDC.mint(owner.address, parseEther('1000000')),
      DAI.mint(alice.address, parseEther('1000000')),
      USDC.mint(alice.address, parseEther('1000000')),
      DAI.mint(bob.address, parseEther('1000000')),
      USDC.mint(bob.address, parseEther('1000000')),
      WBNB.connect(owner).approve(
        liquidityRouter.address,
        ethers.constants.MaxUint256
      ),
      XVS.connect(owner).approve(
        liquidityRouter.address,
        ethers.constants.MaxUint256
      ),
      DAI.connect(owner).approve(
        liquidityRouter.address,
        ethers.constants.MaxUint256
      ),
      USDC.connect(owner).approve(
        liquidityRouter.address,
        ethers.constants.MaxUint256
      ),
      USDC.connect(owner).approve(
        dineroVenusVault.address,
        ethers.constants.MaxUint256
      ),
      DAI.connect(alice).approve(
        dineroVenusVault.address,
        ethers.constants.MaxUint256
      ),
      USDC.connect(alice).approve(
        dineroVenusVault.address,
        ethers.constants.MaxUint256
      ),
      DAI.connect(bob).approve(
        dineroVenusVault.address,
        ethers.constants.MaxUint256
      ),
      USDC.connect(bob).approve(
        dineroVenusVault.address,
        ethers.constants.MaxUint256
      ),
      dineroVenusVault.connect(owner).setCollateralLimit(parseEther('0.5')),
      vDAI.__setUnderlying(DAI.address),
      vUSDC.__setUnderlying(USDC.address),
      vDAI.__setCollateralFactor(parseEther('0.8')),
      vUSDC.__setCollateralFactor(parseEther('0.9')),
      dineroVenusVault.connect(owner).setCompoundDepth(3),
    ]);

    await Promise.all([
      liquidityRouter.addLiquidity(
        XVS.address,
        WBNB.address,
        parseEther('200000'), // 1 XVS = 10 USD => 200_000 XVS is 1M usd
        parseEther('4000'), // 1 BNB = 500 USD => 4_000 BNB is 1M usd
        0,
        0,
        owner.address,
        0
      ),
      liquidityRouter.addLiquidity(
        WBNB.address,
        DAI.address,
        parseEther('4000'), // 1 BNB = 500 USD => 4_000 BNB is 1M usd
        parseEther('1000000'), // stable coin
        0,
        0,
        owner.address,
        0
      ),
      liquidityRouter.addLiquidity(
        WBNB.address,
        USDC.address,
        parseEther('4000'), // 1 BNB = 500 USD => 4_000 BNB is 1M usd
        parseEther('1000000'), // stable coin
        0,
        0,
        owner.address,
        0
      ),
      dineroVenusVault.connect(owner).addVToken(vUSDC.address),
      dineroVenusVault.connect(owner).addVToken(vDAI.address),
      // Taken from Venus https://bscscan.com/token/0xeca88125a5adbe82614ffc12d0db554e2e2867c8?a=0xea6f7275f790dd22efc363873ca9b35d3c196509#readProxyContract
      vUSDC.__setExchangeRateCurrent(
        ethers.BigNumber.from('213429808155036526652502393')
      ),
      vDAI.__setExchangeRateCurrent(
        ethers.BigNumber.from('210574688941918400320722412')
      ),
      safeVenus.__setVTokenCollateralFactor(vUSDC.address, parseEther('0.9')),
      safeVenus.__setVTokenCollateralFactor(vDAI.address, parseEther('0.8')),
    ]);
  });

  describe('Simple Owner functions', () => {
    it('updates the compoundDepth', async () => {
      await expect(
        dineroVenusVault.connect(alice).setCompoundDepth(0)
      ).to.revertedWith('Ownable: caller is not the owner');

      expect(await dineroVenusVault.compoundDepth()).to.be.equal(3);

      await expect(dineroVenusVault.connect(owner).setCompoundDepth(5))
        .to.emit(dineroVenusVault, 'CompoundDepth')
        .withArgs(3, 5);

      expect(await dineroVenusVault.compoundDepth()).to.be.equal(5);

      await expect(
        dineroVenusVault.connect(owner).setCompoundDepth(20)
      ).to.revertedWith('DV: must be lower than 20');

      await expect(
        dineroVenusVault.connect(owner).setCompoundDepth(21)
      ).to.revertedWith('DV: must be lower than 20');
    });
    it('updates the collateral limit', async () => {
      await expect(
        dineroVenusVault.connect(alice).setCollateralLimit(0)
      ).to.revertedWith('Ownable: caller is not the owner');

      expect(await dineroVenusVault.collateralLimit()).to.be.equal(
        parseEther('0.5')
      );

      await expect(
        dineroVenusVault.connect(owner).setCollateralLimit(parseEther('0.8'))
      )
        .to.emit(dineroVenusVault, 'CollateralLimit')
        .withArgs(parseEther('0.5'), parseEther('0.8'));

      expect(await dineroVenusVault.collateralLimit()).to.be.equal(
        parseEther('0.8')
      );

      await expect(
        dineroVenusVault.setCollateralLimit(parseEther('0.91'))
      ).to.revertedWith('DV: must be lower than 90%');
    });
    it('can pause and unpause the contract', async () => {
      expect(await dineroVenusVault.paused()).to.be.equal(false);

      await expect(dineroVenusVault.connect(owner).pause())
        .to.emit(dineroVenusVault, 'Paused')
        .withArgs(owner.address);

      expect(await dineroVenusVault.paused()).to.be.equal(true);

      await expect(dineroVenusVault.connect(owner).unpause())
        .to.emit(dineroVenusVault, 'Unpaused')
        .withArgs(owner.address);

      await expect(dineroVenusVault.connect(alice).unpause()).to.revertedWith(
        'Ownable: caller is not the owner'
      );

      await expect(dineroVenusVault.connect(alice).pause()).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });
  });
  describe('function: removeVToken', () => {
    it('reverts if it not called by the owner', async () => {
      await expect(
        dineroVenusVault.connect(alice).removeVToken(vUSDC.address)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if the venus controllers fails to exit the market', async () => {
      await venusController.__setExitMarketReturn(1);
      const [isUSDCSupported, vTokenOfUSDC] = await Promise.all([
        dineroVenusVault.isUnderlyingSupported(USDC.address),
        dineroVenusVault.vTokenOf(USDC.address),
      ]);

      expect(isUSDCSupported).to.be.equal(true);

      expect(vTokenOfUSDC).to.be.equal(vUSDC.address);

      await expect(
        dineroVenusVault.removeVToken(vUSDC.address)
      ).to.revertedWith('DV: failed to exit market');

      const [isUSDCSupported2, vTokenOfUSDC2] = await Promise.all([
        dineroVenusVault.isUnderlyingSupported(USDC.address),
        dineroVenusVault.vTokenOf(USDC.address),
      ]);

      expect(isUSDCSupported2).to.be.equal(true);

      expect(vTokenOfUSDC2).to.be.equal(vUSDC.address);
    });
    it('removes a VToken', async () => {
      const [isUSDCSupported, vTokenOfUSDC] = await Promise.all([
        dineroVenusVault.isUnderlyingSupported(USDC.address),
        dineroVenusVault.vTokenOf(USDC.address),
      ]);

      expect(isUSDCSupported).to.be.equal(true);

      expect(vTokenOfUSDC).to.be.equal(vUSDC.address);

      await expect(dineroVenusVault.connect(owner).removeVToken(vUSDC.address))
        .to.emit(dineroVenusVault, 'RemoveVToken')
        .withArgs(vUSDC.address, USDC.address)
        .to.emit(USDC, 'Approval')
        .withArgs(dineroVenusVault.address, vUSDC.address, 0)
        .to.emit(venusController, 'ExitMarket')
        .withArgs(vUSDC.address);

      const [isUSDCSupported2, vTokenOfUSDC2] = await Promise.all([
        dineroVenusVault.isUnderlyingSupported(USDC.address),
        dineroVenusVault.vTokenOf(USDC.address),
      ]);

      expect(isUSDCSupported2).to.be.equal(false);

      expect(vTokenOfUSDC2).to.be.equal(ethers.constants.AddressZero);
    });
  });
  describe('function: addVToken', () => {
    it('reverts if it not called by the owner', async () => {
      await expect(
        dineroVenusVault.connect(alice).addVToken(vUSDC.address)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if the venus controller fails to enter the market', async () => {
      await Promise.all([
        venusController.__setEnterMarketReturn(1),
        dineroVenusVault.removeVToken(vUSDC.address),
      ]);

      const [isUSDCSupported, vTokenOfUSDC] = await Promise.all([
        dineroVenusVault.isUnderlyingSupported(USDC.address),
        dineroVenusVault.vTokenOf(USDC.address),
      ]);

      expect(isUSDCSupported).to.be.equal(false);

      expect(vTokenOfUSDC).to.be.equal(ethers.constants.AddressZero);

      await expect(dineroVenusVault.addVToken(vUSDC.address)).to.revertedWith(
        'DV: failed to enter market'
      );

      const [isUSDCSupported2, vTokenOfUSDC2] = await Promise.all([
        dineroVenusVault.isUnderlyingSupported(USDC.address),
        dineroVenusVault.vTokenOf(USDC.address),
      ]);

      expect(isUSDCSupported2).to.be.equal(false);

      expect(vTokenOfUSDC2).to.be.equal(ethers.constants.AddressZero);
    });
    it('adds a vToken', async () => {
      // We need to remove so we can test the {addVToken}
      await dineroVenusVault.removeVToken(vUSDC.address);

      const [isUSDCSupported, vTokenOfUSDC] = await Promise.all([
        dineroVenusVault.isUnderlyingSupported(USDC.address),
        dineroVenusVault.vTokenOf(USDC.address),
      ]);

      expect(isUSDCSupported).to.be.equal(false);

      expect(vTokenOfUSDC).to.be.equal(ethers.constants.AddressZero);

      await expect(dineroVenusVault.addVToken(vUSDC.address))
        .to.emit(dineroVenusVault, 'AddVToken')
        .withArgs(vUSDC.address, USDC.address)
        .to.emit(venusController, 'EnterMarket')
        .withArgs(vUSDC.address)
        .to.emit(USDC, 'Approval')
        .withArgs(
          dineroVenusVault.address,
          vUSDC.address,
          ethers.constants.MaxUint256
        );

      const [isUSDCSupported2, vTokenOfUSDC2] = await Promise.all([
        dineroVenusVault.isUnderlyingSupported(USDC.address),
        dineroVenusVault.vTokenOf(USDC.address),
      ]);

      expect(isUSDCSupported2).to.be.equal(true);

      expect(vTokenOfUSDC2).to.be.equal(vUSDC.address);
    });
  });
  describe('function: emergencyRecovery', async () => {
    it('allows only the owner to call when it is paused', async () => {
      await expect(
        dineroVenusVault.connect(alice).emergencyRecovery()
      ).to.revertedWith('Ownable: caller is not the owner');

      await expect(
        dineroVenusVault.connect(owner).emergencyRecovery()
      ).to.revertedWith('Pausable: not paused');
    });
    it('reverts if it fails to redeem or repay', async () => {
      // vToken redeemUnderlying function will throw like Compound.
      await Promise.all([
        vUSDC.__setRedeemUnderlyingReturn(1),
        dineroVenusVault
          .connect(alice)
          .deposit(USDC.address, parseEther('100000')),
      ]);

      await dineroVenusVault.leverage(vUSDC.address);
      await dineroVenusVault.connect(owner).pause();

      await expect(
        dineroVenusVault.connect(owner).emergencyRecovery()
      ).to.revertedWith('DV: failed to redeem');

      // vToken redeemUnderlying function will throw like Compound.
      await Promise.all([
        vUSDC.__setRedeemUnderlyingReturn(0),
        vUSDC.__setRepayReturnValue(1),
      ]);
      await expect(
        dineroVenusVault.connect(owner).emergencyRecovery()
      ).to.revertedWith('DV: failed to repay');

      await Promise.all([
        vUSDC.__setRedeemReturn(1),
        vUSDC.__setRepayReturnValue(0),
      ]);

      await expect(
        dineroVenusVault.connect(owner).emergencyRecovery()
      ).to.revertedWith('DV: failed to redeem vtokens');
    });
    it('repays all USDC and DAI', async () => {
      // vToken redeemUnderlying function will throw like Compound.
      await Promise.all([
        dineroVenusVault
          .connect(alice)
          .deposit(USDC.address, parseEther('100000')),
        dineroVenusVault.connect(bob).deposit(DAI.address, parseEther('1000')),
      ]);

      const [vUSDCBalance, vDAIBalance] = await Promise.all([
        vUSDC.balanceOf(dineroVenusVault.address),
        vDAI.balanceOf(dineroVenusVault.address),
      ]);

      await dineroVenusVault.leverage(vUSDC.address);
      await dineroVenusVault.connect(owner).pause();

      await expect(dineroVenusVault.connect(owner).emergencyRecovery())
        .to.emit(dineroVenusVault, 'EmergencyRecovery')
        .withArgs(vUSDCBalance)
        .to.emit(dineroVenusVault, 'EmergencyRecovery')
        .withArgs(vDAIBalance);

      const [vUSDCBalance2, vDAIBalance2] = await Promise.all([
        vUSDC.balanceOf(dineroVenusVault.address),
        vDAI.balanceOf(dineroVenusVault.address),
      ]);

      expect(vUSDCBalance2).to.be.equal(0);
      expect(vDAIBalance2).to.be.equal(0);
    });
    it('repays all USDC and not DAI', async () => {
      // vToken redeemUnderlying function will throw like Compound.
      await dineroVenusVault
        .connect(alice)
        .deposit(USDC.address, parseEther('100000'));

      await dineroVenusVault.leverage(vUSDC.address);
      await dineroVenusVault.connect(owner).pause();

      const receipt = await dineroVenusVault.connect(owner).emergencyRecovery();

      const awaitedReceipt = await receipt.wait();

      expect(
        awaitedReceipt.events?.filter((x) => x.event === 'EmergencyRecovery')
          .length
      ).to.be.equal(1);

      expect(await vUSDC.balanceOf(dineroVenusVault.address)).to.be.equal(0);
    });
  });
  describe('function: repayAll', async () => {
    it('reverts if the caller is not the owner', async () => {
      await expect(
        dineroVenusVault.connect(alice).repayAll(vUSDC.address)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('does not repay if there if the vault did not borrow', async () => {
      await dineroVenusVault
        .connect(alice)
        .deposit(USDC.address, parseEther('100000'));

      const vUSDCBalance = await vUSDC.balanceOf(dineroVenusVault.address);

      await expect(
        dineroVenusVault.connect(owner).repayAll(vUSDC.address)
      ).to.not.emit(dineroVenusVault, 'RepayAndRedeem');

      expect(await vUSDC.balanceOf(dineroVenusVault.address)).to.be.equal(
        vUSDCBalance
      );
    });
    it('does not repay if there if the vault borrowed but safe redeem is 0', async () => {
      await dineroVenusVault
        .connect(alice)
        .deposit(USDC.address, parseEther('100000'));

      await Promise.all([
        dineroVenusVault.leverage(vUSDC.address),
        safeVenus.__setSafeRedeem(0),
      ]);

      const vUSDCBalance = await vUSDC.balanceOf(dineroVenusVault.address);

      await expect(
        dineroVenusVault.connect(owner).repayAll(vUSDC.address)
      ).to.not.emit(dineroVenusVault, 'RepayAndRedeem');

      expect(await vUSDC.balanceOf(dineroVenusVault.address)).to.be.equal(
        vUSDCBalance
      );
    });
    it('repays all debt', async () => {
      await dineroVenusVault
        .connect(alice)
        .deposit(USDC.address, parseEther('100000'));

      await dineroVenusVault.leverage(vUSDC.address);

      await safeVenus.safeRedeem(dineroVenusVault.address, vUSDC.address);

      const redeemAmount = await safeVenus.safeRedeemReturn();

      await expect(dineroVenusVault.connect(owner).repayAll(vUSDC.address))
        .to.emit(dineroVenusVault, 'RepayAndRedeem')
        .withArgs(vUSDC.address, redeemAmount);

      await safeVenus.borrowAndSupply(dineroVenusVault.address, vUSDC.address);

      const [borrowBalance, supplyBalance] = await Promise.all([
        safeVenus.borrowBalance(),
        safeVenus.supplyBalance(),
      ]);

      expect(borrowBalance).to.be.equal(0);
      expect(supplyBalance).to.be.equal(parseEther('100000'));
    });
    it('calls repay and redeem multiple times', async () => {
      await dineroVenusVault
        .connect(alice)
        .deposit(USDC.address, parseEther('100000'));

      await dineroVenusVault.leverage(vUSDC.address);

      const receipt = await dineroVenusVault
        .connect(owner)
        .repayAll(vUSDC.address);

      const awaitedReceipt = await receipt.wait();

      const array =
        awaitedReceipt.events?.filter((x) => x.event === 'RepayAndRedeem') ||
        [];

      expect(array.length > 1).to.be.equal(true);
    });
  });
  it('maximizes the allowance for PCS router for XVS', async () => {
    const [allowance] = await Promise.all([
      XVS.allowance(dineroVenusVault.address, router.address),
      venusController.__setClaimVenusValue(parseEther('10000')),
    ]);

    // dineroVenusVault sold XVS on PCS - decreasing its allowance
    await dineroVenusVault
      .connect(alice)
      .deposit(USDC.address, parseEther('10000'));

    expect(allowance).to.be.equal(ethers.constants.MaxUint256);
    // first deposit, the contract does not call {_investXVS}
    expect(
      await XVS.allowance(dineroVenusVault.address, router.address)
    ).to.be.equal(ethers.constants.MaxUint256);

    await dineroVenusVault
      .connect(alice)
      .deposit(USDC.address, parseEther('10000'));

    expect(
      await XVS.allowance(dineroVenusVault.address, router.address)
    ).to.be.equal(ethers.constants.MaxUint256.sub(parseEther('10000')));

    await expect(dineroVenusVault.connect(bob).approveXVS())
      .to.emit(XVS, 'Approval')
      .withArgs(
        dineroVenusVault.address,
        router.address,
        ethers.constants.MaxUint256
      );

    expect(
      await XVS.allowance(dineroVenusVault.address, router.address)
    ).to.be.equal(ethers.constants.MaxUint256);
  });
  describe('function: leverage', () => {
    it('does not borrow if the safe borrow amount is 500 USD or less', async () => {
      await dineroVenusVault
        .connect(alice)
        .deposit(USDC.address, parseEther('1000'));

      await expect(dineroVenusVault.connect(bob).leverage(vUSDC.address))
        .to.not.emit(vUSDC, 'Borrow')
        // Transfer is emitted when supplying an asset because it mints {vUSDC}.
        .to.not.emit(vUSDC, 'Transfer');
    });
    it('does not borrow if compoundDepth is 0', async () => {
      await Promise.all([
        dineroVenusVault.connect(owner).setCompoundDepth(0),
        dineroVenusVault
          .connect(alice)
          // 2000 USD deposit amount gives enough room to leverage
          .deposit(USDC.address, parseEther('2000')),
      ]);

      await expect(dineroVenusVault.connect(bob).leverage(vUSDC.address))
        .to.not.emit(vUSDC, 'Borrow')
        // Transfer is emitted when supplying an asset because it mints {vUSDC}.
        .to.not.emit(vUSDC, 'Transfer');
    });
    it('reverts if the vToken fails to borrow or supply', async () => {
      await Promise.all([
        vUSDC.__setBorrowReturn(2),
        dineroVenusVault
          .connect(alice)
          // 2000 USD deposit amount gives enough room to leverage
          .deposit(USDC.address, parseEther('2000')),
      ]);

      await expect(
        dineroVenusVault.connect(bob).leverage(vUSDC.address)
      ).to.revertedWith('DV: failed to borrow');

      await Promise.all([vUSDC.__setBorrowReturn(0), vUSDC.__setMintReturn(1)]);

      await expect(
        dineroVenusVault.connect(bob).leverage(vUSDC.address)
      ).to.revertedWith('DV: failed to mint');
    });
    it('borrows and supplies a maximum of compoundDepth times', async () => {
      const [compoundDepth] = await Promise.all([
        dineroVenusVault.compoundDepth(),
        dineroVenusVault
          .connect(alice)
          .deposit(USDC.address, parseEther('1000000')),
        dineroVenusVault
          .connect(bob)
          .deposit(USDC.address, parseEther('1000000')),
      ]);

      const [supply, borrow] = await Promise.all([
        vUSDC.balanceOfUnderlying(dineroVenusVault.address),
        vUSDC.borrowBalanceCurrent(dineroVenusVault.address),
      ]);

      // 2_000_000 USD should allow the vault to leverage more than 3x if it was not limited by the {compoundDepth}
      const receipt = await (
        await dineroVenusVault.connect(bob).leverage(vUSDC.address)
      ).wait();

      const [supply2, borrow2] = await Promise.all([
        vUSDC.balanceOfUnderlying(dineroVenusVault.address),
        vUSDC.borrowBalanceCurrent(dineroVenusVault.address),
      ]);

      expect(supply).to.be.equal(parseEther('2000000'));
      expect(borrow).to.be.equal(0);
      // START: 2_000_000
      // FIRST CYCLE: SUPPLY => 2_900_000 | BORROW => 900_000 | 2_000_000 * 0.45
      // SECOND CYCLE: SUPPLY => 3_305_00 | BORROW => 405_000 | 2_900_000 * 0.45 - 900_000
      // THIRD CYCLE: SUPPLY => 3_487_250 | BORROW => 182_250 | 3305000 * 0.45 - 900000 - 405000
      expect(borrow2).to.be.equal(parseEther('1487250')); // 900_000 + 405_000 + 182_250
      expect(supply2).to.be.equal(parseEther('3487250'));

      const borrowTopic = vUSDC.interface.getEventTopic(
        vUSDC.interface.getEvent('Borrow')
      );
      const supplyTopic = vUSDC.interface.getEventTopic(
        vUSDC.interface.getEvent('Transfer')
      );

      expect(
        receipt.events
          ?.filter((x) => x.topics.includes(borrowTopic))
          .filter(
            (x) =>
              x.address.toLocaleLowerCase() ===
              vUSDC.address.toLocaleLowerCase()
          ).length
      ).to.be.equal(compoundDepth);
      expect(
        receipt.events
          ?.filter((x) => x.topics.includes(supplyTopic))
          .filter(
            (x) =>
              x.address.toLocaleLowerCase() ===
              vUSDC.address.toLocaleLowerCase()
          ).length
      ).to.be.equal(compoundDepth);
    });
  });
  it('calls leverage in all listed assets', async () => {
    const [compoundDepth] = await Promise.all([
      dineroVenusVault.compoundDepth(),
      dineroVenusVault
        .connect(alice)
        .deposit(USDC.address, parseEther('1000000')),
      dineroVenusVault
        .connect(bob)
        .deposit(USDC.address, parseEther('1000000')),
      dineroVenusVault
        .connect(alice)
        .deposit(DAI.address, parseEther('1000000')),
      dineroVenusVault.connect(bob).deposit(DAI.address, parseEther('1000000')),
    ]);

    const receipt = await (
      await dineroVenusVault.connect(bob).leverageAll()
    ).wait();

    const USDCborrowTopic = vUSDC.interface.getEventTopic(
      vUSDC.interface.getEvent('Borrow')
    );
    const USDCsupplyTopic = vUSDC.interface.getEventTopic(
      vUSDC.interface.getEvent('Transfer')
    );

    const DAIborrowTopic = vDAI.interface.getEventTopic(
      vDAI.interface.getEvent('Borrow')
    );
    const DAIsupplyTopic = vDAI.interface.getEventTopic(
      vDAI.interface.getEvent('Transfer')
    );

    expect(
      receipt.events
        ?.filter((x) => x.topics.includes(USDCborrowTopic))
        .filter(
          (x) =>
            x.address.toLocaleLowerCase() === vUSDC.address.toLocaleLowerCase()
        ).length
    ).to.be.equal(compoundDepth);
    expect(
      receipt.events
        ?.filter((x) => x.topics.includes(USDCsupplyTopic))
        .filter(
          (x) =>
            x.address.toLocaleLowerCase() === vUSDC.address.toLocaleLowerCase()
        ).length
    ).to.be.equal(compoundDepth);

    expect(
      receipt.events
        ?.filter((x) => x.topics.includes(DAIborrowTopic))
        .filter(
          (x) =>
            x.address.toLocaleLowerCase() === vDAI.address.toLocaleLowerCase()
        ).length
    ).to.be.equal(compoundDepth);
    expect(
      receipt.events
        ?.filter((x) => x.topics.includes(DAIsupplyTopic))
        .filter(
          (x) =>
            x.address.toLocaleLowerCase() === vDAI.address.toLocaleLowerCase()
        ).length
    ).to.be.equal(compoundDepth);
  });
  describe('function: deleverage', () => {
    it('does nothing if the deleverage amount is 0', async () => {
      await expect(
        dineroVenusVault.connect(bob).deleverage(vUSDC.address)
      ).to.not.emit(vUSDC, 'Redeem');

      // Should not trigger a deleverage as it stays within the parameters
      // Deleveraged is triggered if parameters change or USDC price of underlying
      await dineroVenusVault.connect(bob).leverage(vUSDC.address);

      await expect(
        dineroVenusVault.connect(bob).deleverage(vUSDC.address)
      ).to.not.emit(vUSDC, 'Redeem');
    });
    it('reverts if redeemUnderlying or repayBorrow from vToken revert', async () => {
      // artificially set collateral ratio to 0.9 which will trigger a deleverage as our ratio is 0.45
      // Safe Venus relies in these values to decide o the deleverage amount
      await Promise.all([
        vUSDC.__setBalanceOfUnderlying(
          dineroVenusVault.address,
          parseEther('100000')
        ),
        vUSDC.__setBorrowBalanceCurrent(
          dineroVenusVault.address,
          parseEther('90000')
        ),
        // will trigger the error
        vUSDC.__setRedeemUnderlyingReturn(1),
      ]);

      await expect(
        dineroVenusVault.connect(bob).deleverage(vUSDC.address)
      ).to.revertedWith('DV: failed to redeem');

      await Promise.all([
        vUSDC.__setBalanceOfUnderlying(dineroVenusVault.address, 0),
        vUSDC.__setBorrowBalanceCurrent(dineroVenusVault.address, 0),
        vUSDC.__setRedeemUnderlyingReturn(0),
        vUSDC.__setRepayReturnValue(1),
      ]);

      await Promise.all([
        dineroVenusVault
          .connect(alice)
          .deposit(USDC.address, parseEther('1000000')),
        dineroVenusVault
          .connect(bob)
          .deposit(USDC.address, parseEther('1000000')),
      ]);

      await dineroVenusVault.connect(bob).leverage(vUSDC.address);

      await safeVenus.borrowAndSupply(dineroVenusVault.address, vUSDC.address);

      const [borrow, supply] = await Promise.all([
        safeVenus.borrowBalance(),
        safeVenus.supplyBalance(),
      ]);

      await Promise.all([
        // Manipulate the balances to be 0.9 collateral ratio
        // This will trigger a safeVenus.deleverage positive value and will call redeemUnderlying and then repayBorrow
        vUSDC.__setBorrowBalanceCurrent(
          dineroVenusVault.address,
          supply.mul(parseEther('0.9')).div(parseEther('1')).sub(borrow)
        ),
        vUSDC.__setRepayReturnValue(1),
      ]);

      await expect(
        dineroVenusVault.connect(bob).deleverage(vUSDC.address)
      ).to.revertedWith('DV: failed to repay');
    });
    it.only('deleverages the vault by redeeming and then repaying', async () => {
      await Promise.all([
        dineroVenusVault.connect(owner).setCollateralLimit(parseEther('0.8')),
        dineroVenusVault
          .connect(alice)
          .deposit(USDC.address, parseEther('1000000')),
      ]);

      // safe collateral ratio will be 0.9 * 0.8 = 0.72

      // We are supplying 1_000_000 and borrowing 800_000 => collateral ratio of 0.8 to trigger a deleverage
      await dineroVenusVault
        .connect(bob)
        .borrow(vUSDC.address, parseEther('800000'));

      await expect(dineroVenusVault.connect(bob).deleverage(vUSDC.address))
        .to.emit(vUSDC, 'RedeemUnderlying')
        // MAX SAFE BORROW => 720_000 (1_000_000 * 0.72)
        // BORROW => 800_000
        // CAP => 900_000
        .withArgs(parseEther('100000')) // 900_000 - 800_000
        .to.emit(vUSDC, 'RepayBorrow')
        .withArgs(parseEther('100000'));
      // MAX SAFE BORROW => 648_000 (900_000 * 0.72)
      // BORROW => 700_000
      // CAP => 900_000
    });
  });
});
