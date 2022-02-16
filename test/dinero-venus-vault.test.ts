import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
// import { expect } from 'chai';
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
      [XVS, WBNB, WETH, USDC, DAI, vUSDC, vDAI, dinero, safeVenus],
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
      dineroVenusVault.connect(owner).addUnderlying(USDC.address),
      dineroVenusVault.connect(owner).addUnderlying(DAI.address),
    ]);
  });
});
