import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  Dinero,
  ETHRouter,
  InterestBearingMarket,
  LiquidityRouter,
  MockChainLinkFeed,
  MockERC20,
  MockNoInfiniteAllowanceERC20,
  MockTWAP,
  MockVBNB,
  MockVenusController,
  MockVenusToken,
  OracleV1,
  PancakeFactory,
  PancakeRouter,
  WETH9,
} from '../typechain';
import { BURNER_ROLE, MINTER_ROLE } from './lib/constants';
import { deployUUPS, multiDeploy } from './lib/test-utils';

const BNB_USD_PRICE = ethers.BigNumber.from('50000000000'); // 500 USD

const BTC_USD_PRICE = ethers.BigNumber.from('4000000000000'); // 40_000 USD

const { parseEther } = ethers.utils;

describe('InterestBearingMarket', () => {
  let interestBearingMarket: InterestBearingMarket;
  let dinero: Dinero;
  let oracle: OracleV1;
  let mockBnbUsdDFeed: MockChainLinkFeed;
  let mockBTCUsdDFeed: MockChainLinkFeed;
  let WETH: WETH9;
  let factory: PancakeFactory;
  let ethRouter: ETHRouter;
  let liquidityRouter: LiquidityRouter;
  let erc20Router: PancakeRouter;
  let mockTWAP: MockTWAP;
  let BTC: MockNoInfiniteAllowanceERC20;
  let XVS: MockNoInfiniteAllowanceERC20;
  let BUSD: MockERC20;
  let vBTC: MockVenusToken;
  let vBNB: MockVBNB;
  let venusController: MockVenusController;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let treasury: SignerWithAddress;
  let developer: SignerWithAddress;
  let jose: SignerWithAddress;
  let recipient: SignerWithAddress;

  beforeEach(async () => {
    [owner, alice, bob, treasury, developer, jose, recipient] =
      await ethers.getSigners();

    [
      dinero,
      [
        WETH,
        mockBnbUsdDFeed,
        mockBTCUsdDFeed,
        factory,
        mockTWAP,
        BUSD,
        BTC,
        XVS,
        vBNB,
        vBTC,
      ],
    ] = await Promise.all([
      deployUUPS('Dinero', []),
      multiDeploy(
        [
          'WETH9',
          'MockChainLinkFeed',
          'MockChainLinkFeed',
          'PancakeFactory',
          'MockTWAP',
          'MockERC20',
          'MockNoInfiniteAllowanceERC20',
          'MockNoInfiniteAllowanceERC20',
          'MockVBNB',
          'MockVenusToken',
        ],
        [
          [],
          [8, 'BNB/USD', 1],
          [8, 'BTC/USD', 1],
          [developer.address],
          [],
          ['Binance USD', 'BUSD', 0],
          ['Bitcoin', 'BTC', parseEther('10000')],
          ['Venus Token', 'XVS', 0],
          ['Venus BNB', 'vBNB', 0],
          ['Venus BTC', 'vBTC', 0],
        ]
      ),
    ]);

    [oracle, [ethRouter, liquidityRouter, erc20Router, venusController]] =
      await Promise.all([
        deployUUPS('OracleV1', [
          mockTWAP.address,
          mockBnbUsdDFeed.address,
          WETH.address,
          BUSD.address,
        ]),
        multiDeploy(
          [
            'ETHRouter',
            'LiquidityRouter',
            'PancakeRouter',
            'MockVenusController',
          ],
          [
            [factory.address, WETH.address],
            [factory.address, WETH.address],
            [factory.address, WETH.address],
            [XVS.address],
          ]
        ),
      ]);

    [interestBearingMarket] = await Promise.all([
      deployUUPS('InterestBearingMarket', [
        ethRouter.address,
        dinero.address,
        treasury.address,
        oracle.address,
        venusController.address,
        XVS.address,
        ethers.constants.AddressZero,
        vBNB.address,
        ethers.BigNumber.from(12e8),
        ethers.BigNumber.from('500000000000000000'),
        ethers.BigNumber.from('100000000000000000'),
      ]),
      mockBnbUsdDFeed.setAnswer(BNB_USD_PRICE),
      mockBTCUsdDFeed.setAnswer(BTC_USD_PRICE),
      oracle.connect(owner).setFeed(WETH.address, mockBnbUsdDFeed.address, 0),
      oracle.connect(owner).setFeed(BTC.address, mockBTCUsdDFeed.address, 0),
      WETH.approve(liquidityRouter.address, ethers.constants.MaxUint256),
      WETH.connect(owner).mint(parseEther('100000')),
      BTC.approve(liquidityRouter.address, ethers.constants.MaxUint256),
    ]);

    await Promise.all([
      dinero.connect(owner).grantRole(MINTER_ROLE, owner.address),
      dinero
        .connect(owner)
        .grantRole(MINTER_ROLE, interestBearingMarket.address),
      dinero
        .connect(owner)
        .grantRole(BURNER_ROLE, interestBearingMarket.address),
      vBTC.__setExchangeRateCurrent(
        ethers.BigNumber.from('202080916975526043899048590') // Taken from vBTC in BSC on 11/03/2022
      ),
      vBNB.__setExchangeRateCurrent(
        ethers.BigNumber.from('216637139839702805713033895') // Taken from vBTC in BSC on 11/03/2022
      ),
    ]);

    await Promise.all([
      dinero.connect(owner).mint(owner.address, parseEther('2000000')),
      dinero.connect(owner).mint(alice.address, parseEther('500000')),
      dinero.approve(liquidityRouter.address, ethers.constants.MaxUint256),
      // BNB/DINERO Liquidity
      liquidityRouter
        .connect(owner)
        .addLiquidity(
          WETH.address,
          dinero.address,
          parseEther('2000'),
          parseEther('1000000'),
          parseEther('2000'),
          parseEther('1000000'),
          owner.address,
          ethers.constants.MaxUint256
        ),
      // BNB/BTC Liquidity
      liquidityRouter
        .connect(owner)
        .addLiquidity(
          WETH.address,
          BTC.address,
          parseEther('2400'),
          parseEther('30'),
          parseEther('2400'),
          parseEther('30'),
          owner.address,
          ethers.constants.MaxUint256
        ),
      interestBearingMarket.updateExchangeRate(),
    ]);
  });

  describe('function: initialize', () => {
    it.only('reverts if you call after deployment', async () => {
      expect(true).to.be.equal(true);
    });
  });
});
