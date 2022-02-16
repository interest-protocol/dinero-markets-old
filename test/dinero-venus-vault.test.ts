import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  Dinero,
  DineroVenusVault,
  LiquidityRouter,
  MockERC20,
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
  let XVS: MockERC20;
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
          'MockERC20',
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
      XVS.mint(owner.address, parseEther('200000')),
      DAI.mint(owner.address, parseEther('1000000')),
      USDC.mint(owner.address, parseEther('1000000')),
      DAI.mint(alice.address, parseEther('1000000')),
      USDC.mint(alice.address, parseEther('1000000')),
      DAI.mint(bob.address, parseEther('1000000')),
      USDC.mint(bob.address, parseEther('1000000')),
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
    ]);

    await Promise.all([
      liquidityRouter.addLiquidity(
        XVS.address,
        USDC.address,
        parseEther('100000'), // 1 XVS = 10 USDC
        parseEther('1000000'),
        0,
        0,
        owner.address,
        0
      ),
      liquidityRouter.addLiquidity(
        XVS.address,
        DAI.address,
        parseEther('100000'), // 1 XVS = 10 DAI
        parseEther('1000000'),
        0,
        0,
        owner.address,
        0
      ),
      dineroVenusVault.connect(owner).addVToken(vUSDC.address),
      dineroVenusVault.connect(owner).addVToken(vDAI.address),
    ]);
  });

  describe('Owner functions', () => {
    it('updates the compoundDepth', async () => {
      await expect(
        dineroVenusVault.connect(alice).setCompoundDepth(0)
      ).to.revertedWith('Ownable: caller is not the owner');

      expect(await dineroVenusVault.compoundDepth()).to.be.equal(0);

      await expect(dineroVenusVault.connect(owner).setCompoundDepth(5))
        .to.emit(dineroVenusVault, 'CompoundDepth')
        .withArgs(0, 5);

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
});
