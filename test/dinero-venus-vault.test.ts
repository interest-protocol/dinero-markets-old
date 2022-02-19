import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  Dinero,
  DineroVenusVault,
  LiquidityRouter,
  MockERC20,
  MockNoInfiniteAllowanceERC20,
  MockSafeVenus,
  MockVenusToken,
  MockVenusTroller,
  PancakeFactory,
  PancakeRouter,
  WETH9,
} from '../typechain';
import { deploy, multiDeploy } from './lib/test-utils';

const { parseEther } = ethers.utils;

const INITIAL_SUPPLY = parseEther('10000');

describe('DineroVenusVault', () => {
  let dineroVenusVault: DineroVenusVault;
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

    dineroVenusVault = await deploy('DineroVenusVault', [
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
    it('can add and remove VTokens support', async () => {
      expect(
        await dineroVenusVault.isUnderlyingSupported(USDC.address)
      ).to.be.equal(true);

      expect(await dineroVenusVault.vTokenOf(USDC.address)).to.be.equal(
        vUSDC.address
      );

      await expect(dineroVenusVault.removeVToken(vUSDC.address))
        .to.emit(dineroVenusVault, 'RemoveVToken')
        .withArgs(vUSDC.address, USDC.address);

      expect(
        await dineroVenusVault.isUnderlyingSupported(USDC.address)
      ).to.be.equal(false);

      expect(await dineroVenusVault.vTokenOf(USDC.address)).to.be.equal(
        ethers.constants.AddressZero
      );

      await expect(dineroVenusVault.addVToken(vUSDC.address))
        .to.emit(dineroVenusVault, 'AddVToken')
        .withArgs(vUSDC.address, USDC.address);

      expect(
        await dineroVenusVault.isUnderlyingSupported(USDC.address)
      ).to.be.equal(true);

      expect(await dineroVenusVault.vTokenOf(USDC.address)).to.be.equal(
        vUSDC.address
      );
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
});
