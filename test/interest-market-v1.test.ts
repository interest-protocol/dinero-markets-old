import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  CakeToken,
  CakeVault,
  Dinero,
  InterestGovernorV1,
  InterestMarketV1,
  LiquidityRouter,
  MasterChef,
  MockChainLinkFeed,
  MockERC20,
  OracleV1,
  PancakeFactory,
  PancakeRouter,
  SyrupBar,
  WETH9,
} from '../typechain';
import { deploy, multiDeploy } from './lib/test-utils';

const { parseEther, defaultAbiCoder, keccak256 } = ethers.utils;

const CAKE_PER_BLOCK = parseEther('40');

const START_BLOCK = 1;

const BNB_USD_PRICE = ethers.BigNumber.from('50000000000'); // 500 USD

const CAKE_USD_PRICE = ethers.BigNumber.from('2000000000'); // 20 USD

describe('InterestMarketV1', () => {
  let cake: CakeToken;
  let syrup: SyrupBar;
  let masterChef: MasterChef;
  let cakeVault: CakeVault;
  let bnb: MockERC20;
  let dinero: Dinero;
  let governor: InterestGovernorV1;
  let factory: PancakeFactory;
  let router: PancakeRouter;
  let liquidityRouter: LiquidityRouter;
  let weth: WETH9;
  let masterMarket: InterestMarketV1;
  let cakeMarket: InterestMarketV1;
  let mockCakeUsdFeed: MockChainLinkFeed;
  let mockBnbUsdDFeed: MockChainLinkFeed;
  let oracle: OracleV1;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let developer: SignerWithAddress;
  let treasury: SignerWithAddress;

  beforeEach(async () => {
    [owner, alice, bob, developer, treasury] = await ethers.getSigners();

    [cake, dinero, factory, weth, bnb, mockCakeUsdFeed, mockBnbUsdDFeed] =
      await multiDeploy(
        [
          'CakeToken',
          'Dinero',
          'PancakeFactory',
          'WETH9',
          'MockERC20',
          'MockChainLinkFeed',
          'MockChainLinkFeed',
        ],
        [
          [],
          [],
          [developer.address],
          [],
          ['Wrapped BNB', 'WBNB', parseEther('10000000')],
          [8, 'CAKE/USD', 1],
          [8, 'BNB/USD', 1],
        ]
      );

    [syrup, governor, router, liquidityRouter, oracle] = await multiDeploy(
      [
        'SyrupBar',
        'InterestGovernorV1',
        'PancakeRouter',
        'LiquidityRouter',
        'OracleV1',
      ],
      [
        [cake.address],
        [dinero.address],
        [factory.address, weth.address],
        [factory.address, weth.address],
        [mockBnbUsdDFeed.address, bnb.address],
      ]
    );

    [masterChef] = await Promise.all([
      deploy('MasterChef', [
        cake.address,
        syrup.address,
        developer.address,
        CAKE_PER_BLOCK,
        START_BLOCK,
      ]),
      dinero
        .connect(owner)
        .grantRole(await dinero.MINTER_ROLE(), owner.address),
      dinero.connect(owner).mint(owner.address, parseEther('100000000')),
      dinero.approve(liquidityRouter.address, ethers.constants.MaxUint256),
      bnb.mint(owner.address, parseEther('300000')),
      bnb
        .connect(owner)
        .approve(liquidityRouter.address, ethers.constants.MaxUint256),
      cake
        .connect(owner)
        ['mint(address,uint256)'](owner.address, parseEther('2500000')),
      cake
        .connect(owner)
        ['mint(address,uint256)'](alice.address, parseEther('1000')),
      cake
        .connect(owner)
        ['mint(address,uint256)'](bob.address, parseEther('1000')),
      cake
        .connect(owner)
        .approve(liquidityRouter.address, ethers.constants.MaxUint256),
      governor.connect(owner).setFeeTo(treasury.address),
    ]);

    cakeVault = await deploy('CakeVault', [masterChef.address, cake.address]);

    [masterMarket] = await Promise.all([
      deploy('InterestMarketV1', [
        router.address,
        dinero.address,
        governor.address,
        oracle.address,
      ]),
      cake
        .connect(alice)
        .approve(cakeVault.address, ethers.constants.MaxUint256),
      cake.connect(bob).approve(cakeVault.address, ethers.constants.MaxUint256),
      syrup.connect(owner).transferOwnership(masterChef.address),
      cake.connect(owner).transferOwnership(masterChef.address),
      dinero
        .connect(owner)
        .grantRole(await dinero.DEFAULT_ADMIN_ROLE(), governor.address),
      mockBnbUsdDFeed.setAnswer(BNB_USD_PRICE),
      // 1 CAKE === ~12.67 USD
      mockCakeUsdFeed.setAnswer(CAKE_USD_PRICE),
      // BNB/DINERO Liquidity
      liquidityRouter
        .connect(owner)
        .addLiquidity(
          bnb.address,
          dinero.address,
          parseEther('200000'),
          parseEther('100000000'),
          parseEther('200000'),
          parseEther('100000000'),
          owner.address,
          ethers.constants.MaxUint256
        ),
      // BNB/CAKE
      liquidityRouter
        .connect(owner)
        .addLiquidity(
          bnb.address,
          cake.address,
          parseEther('10000'),
          parseEther('200000'),
          parseEther('10000'),
          parseEther('200000'),
          owner.address,
          ethers.constants.MaxUint256
        ),
      oracle.connect(owner).setFeed(bnb.address, mockBnbUsdDFeed.address, 0),
      oracle.connect(owner).setFeed(cake.address, mockCakeUsdFeed.address, 0),
    ]);

    const data = defaultAbiCoder.encode(
      ['address', 'address', 'uint64', 'uint256', 'uint256'],
      [
        cake.address,
        cakeVault.address,
        ethers.BigNumber.from(12e8),
        ethers.BigNumber.from(5e5),
        ethers.BigNumber.from(10e4),
      ]
    );

    const [cakeMarketAddress] = await Promise.all([
      governor.predictMarketAddress(masterMarket.address, keccak256(data)),
      governor
        .connect(owner)
        .createMarket(masterMarket.address, cake.address, data),
    ]);

    cakeMarket = (await ethers.getContractFactory('InterestMarketV1')).attach(
      cakeMarketAddress
    );

    await Promise.all([
      cakeMarket.updateExchangeRate(),
      cakeVault.connect(owner).setMarket(cakeMarket.address),
    ]);
  });

  describe('function: initialize', () => {
    it('reverts if you initialize the master contract', async () => {
      await expect(
        masterMarket.initialize(defaultAbiCoder.encode(['string'], ['random']))
      ).to.revertedWith('IMV1: not allowed');
    });
    it('reverts if you try to initialize more than once in the clone contract', async () => {
      await expect(
        cakeMarket.initialize(defaultAbiCoder.encode(['string'], ['random']))
      ).to.revertedWith('Initializable: contract is already initialized');
    });
  });
  it('allows the router allowance to be incremented', async () => {
    await cakeMarket.connect(alice).addCollateral(parseEther('51'));

    // We need to borrow and then liquidate in order to use some of router allowance to increase it
    await cakeMarket.connect(alice).borrow(alice.address, parseEther('500'));

    // Drop CAKE to 15 USD. Alice can now be liquidated
    await mockCakeUsdFeed.setAnswer(ethers.BigNumber.from('1500000000'));

    // Liquidate alice using the collateral so router will use some allowance
    await cakeMarket
      .connect(bob)
      .liquidate([alice.address], [parseEther('50')], bob.address, [
        cake.address,
        bnb.address,
        dinero.address,
      ]);

    const currentAllowance = await cake.allowance(
      cakeMarket.address,
      router.address
    );

    await expect(cakeMarket.approve(5))
      .to.emit(cake, 'Approval')
      .withArgs(cakeMarket.address, router.address, currentAllowance.add(5));

    expect(
      await cake.allowance(cakeMarket.address, router.address)
    ).to.be.equal(currentAllowance.add(5));
  });
  // it.only('sends the feesEarned ');
});
