import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers, network } from 'hardhat';

import {
  Dinero,
  InterestERC20BearingMarket,
  LiquidityRouter,
  MockChainLinkFeed,
  MockERC20,
  MockNoInfiniteAllowanceERC20,
  MockTWAP,
  MockVenusController,
  MockVenusToken,
  OracleV1,
  PancakeFactory,
  PancakeRouter,
  TestInterestERC20BearingMarketV2,
  WETH9,
} from '../typechain';
import { BURNER_ROLE, MINTER_ROLE } from './lib/constants';
import {
  advanceBlock,
  advanceBlockAndTime,
  advanceTime,
  deployUUPS,
  multiDeploy,
  upgrade,
} from './lib/test-utils';

const BNB_USD_PRICE = ethers.BigNumber.from('50000000000'); // 500 USD

const BTC_USD_PRICE = ethers.BigNumber.from('4000000000000'); // 40_000 USD

const oneVToken = ethers.BigNumber.from(10).pow(8);

const VTOKEN_BTC_EXCHANGE_RATE = ethers.BigNumber.from(
  '202080916975526043899048590'
);

const { parseEther } = ethers.utils;

const toVBalance = (x: BigNumber): BigNumber =>
  x.mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE);

const LIQUIDATION_FEE = ethers.BigNumber.from('100000000000000000');

// To be used only on liquidation tests if BTC is at 30_0000
const convertBorrowToLiquidationCollateral = (x: BigNumber) =>
  x
    // Add interest paid
    .add(
      ethers.BigNumber.from(12e8)
        .mul(x)
        .mul(BigNumber.from(10_000))
        .div(parseEther('1'))
    )
    .add(x.mul(LIQUIDATION_FEE).div(parseEther('1')))
    // Convert Loan to BTC
    .mul(parseEther('1'))
    .div(parseEther('30000')) // Note BTC has dropped to 30_000 in  liquidations
    // convert BNB to VBTC
    .mul(parseEther('1'))
    .div(VTOKEN_BTC_EXCHANGE_RATE);

describe('Interest ERC20 Bearing Market', () => {
  let market: InterestERC20BearingMarket;
  let dinero: Dinero;
  let oracle: OracleV1;
  let mockBnbUsdDFeed: MockChainLinkFeed;
  let mockBTCUsdDFeed: MockChainLinkFeed;
  let WETH: WETH9;
  let factory: PancakeFactory;
  let liquidityRouter: LiquidityRouter;
  let erc20Router: PancakeRouter;
  let mockTWAP: MockTWAP;
  let BTC: MockNoInfiniteAllowanceERC20;
  let XVS: MockNoInfiniteAllowanceERC20;
  let BUSD: MockERC20;
  let vBTC: MockVenusToken;
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
          ['Venus BTC', 'vBTC', 0],
        ]
      ),
    ]);

    [oracle, [liquidityRouter, erc20Router, venusController]] =
      await Promise.all([
        deployUUPS('OracleV1', [
          mockTWAP.address,
          mockBnbUsdDFeed.address,
          WETH.address,
          BUSD.address,
        ]),
        multiDeploy(
          ['LiquidityRouter', 'PancakeRouter', 'MockVenusController'],
          [
            [factory.address, WETH.address],
            [factory.address, WETH.address],
            [XVS.address],
          ]
        ),
      ]);

    [market] = await Promise.all([
      deployUUPS('InterestERC20BearingMarket', [
        erc20Router.address,
        dinero.address,
        treasury.address,
        oracle.address,
        venusController.address,
        XVS.address,
        BTC.address,
        vBTC.address,
        ethers.BigNumber.from(12e8),
        ethers.BigNumber.from('500000000000000000'),
        LIQUIDATION_FEE,
      ]),
      mockBnbUsdDFeed.setAnswer(BNB_USD_PRICE),
      mockBTCUsdDFeed.setAnswer(BTC_USD_PRICE),
      oracle.connect(owner).setFeed(WETH.address, mockBnbUsdDFeed.address, 0),
      oracle.connect(owner).setFeed(BTC.address, mockBTCUsdDFeed.address, 0),
      WETH.approve(liquidityRouter.address, ethers.constants.MaxUint256),
      WETH.connect(owner).mint(parseEther('100000')),
      BTC.approve(liquidityRouter.address, ethers.constants.MaxUint256),
      BTC.mint(alice.address, parseEther('1000')),
      BTC.mint(bob.address, parseEther('1000')),
      BTC.mint(jose.address, parseEther('1000')),
      vBTC.__setExchangeRateCurrent(
        VTOKEN_BTC_EXCHANGE_RATE // Taken from vBTC in BSC on 11/03/2022
      ),
    ]);

    await Promise.all([
      BTC.connect(alice).approve(market.address, ethers.constants.MaxUint256),
      BTC.connect(bob).approve(market.address, ethers.constants.MaxUint256),
      BTC.connect(jose).approve(market.address, ethers.constants.MaxUint256),
      vBTC.__setUnderlying(BTC.address),
      dinero.connect(owner).grantRole(MINTER_ROLE, owner.address),
      dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
    ]);

    await dinero.mint(owner.address, parseEther('2000000'));
    await Promise.all([
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
      market.updateExchangeRate(),
      vBTC.__setCollateralFactor(parseEther('1')),
    ]);
  });

  describe('function: initialize', () => {
    it('reverts if you call after deployment', async () => {
      await expect(
        market
          .connect(alice)
          .initialize(
            erc20Router.address,
            dinero.address,
            treasury.address,
            oracle.address,
            venusController.address,
            XVS.address,
            BTC.address,
            vBTC.address,
            ethers.BigNumber.from(12e8),
            ethers.BigNumber.from('500000000000000000'),
            LIQUIDATION_FEE
          )
      ).to.revertedWith('Initializable: contract is already initialized');
    });
    it('reverts if you set a max tvl ratio out of bounds', async () => {
      await expect(
        deployUUPS('InterestERC20BearingMarket', [
          erc20Router.address,
          dinero.address,
          treasury.address,
          oracle.address,
          venusController.address,
          XVS.address,
          BTC.address,
          vBTC.address,
          ethers.BigNumber.from(12e8),
          ethers.BigNumber.from('900000000000000001'),
          LIQUIDATION_FEE,
        ])
      ).to.revertedWith('MKT: ltc ratio out of bounds');
      await expect(
        deployUUPS('InterestERC20BearingMarket', [
          erc20Router.address,
          dinero.address,
          treasury.address,
          oracle.address,
          venusController.address,
          XVS.address,
          BTC.address,
          vBTC.address,
          ethers.BigNumber.from(12e8),
          ethers.BigNumber.from('490000000000000000'),
          LIQUIDATION_FEE,
        ])
      ).to.revertedWith('MKT: ltc ratio out of bounds');
    });
    it('sets the initial state and approvals correctly', async () => {
      const [
        erc20RouterAllowance,
        vBTCAllowance,
        _router,
        _dinero,
        _feeTo,
        _oracle,
        _venusController,
        _xvs,
        _collateral,
        _vToken,
        _loan,
        _maxLTVRatio,
        _liquidationFee,
        _owner,
      ] = await Promise.all([
        BTC.allowance(market.address, erc20Router.address),
        BTC.allowance(market.address, vBTC.address),
        market.ROUTER(),
        market.DINERO(),
        market.FEE_TO(),
        market.ORACLE(),
        market.VENUS_CONTROLLER(),
        market.XVS(),
        market.COLLATERAL(),
        market.VTOKEN(),
        market.loan(),
        market.maxLTVRatio(),
        market.liquidationFee(),
        market.owner(),
      ]);

      expect(erc20RouterAllowance).to.be.equal(ethers.constants.MaxUint256);
      expect(vBTCAllowance).to.be.equal(ethers.constants.MaxUint256);
      expect(_router).to.be.equal(erc20Router.address);
      expect(_dinero).to.be.equal(dinero.address);
      expect(_feeTo).to.be.equal(treasury.address);
      expect(_oracle).to.be.equal(oracle.address);
      expect(_venusController).to.be.equal(venusController.address);
      expect(_xvs).to.be.equal(XVS.address);
      expect(_collateral).to.be.equal(BTC.address);
      expect(_vToken).to.be.equal(vBTC.address);
      expect(_loan.INTEREST_RATE).to.be.equal(ethers.BigNumber.from(12e8));
      expect(_maxLTVRatio).to.be.equal(
        ethers.BigNumber.from('500000000000000000')
      );
      expect(_liquidationFee).to.be.equal(
        ethers.BigNumber.from('100000000000000000')
      );
      expect(_owner).to.be.equal(owner.address);
    });
  });

  it('maximizes the allowance for the router and vToken', async () => {
    const newAllowance = ethers.constants.MaxUint256.sub(
      ethers.BigNumber.from('500000000000000000')
    );

    await Promise.all([
      BTC.setAllowance(market.address, erc20Router.address, newAllowance),
      BTC.setAllowance(market.address, vBTC.address, newAllowance.sub(10)),
    ]);

    await expect(market.approve())
      .to.emit(BTC, 'Approval')
      .withArgs(
        market.address,
        erc20Router.address,
        ethers.constants.MaxUint256
      )
      .to.emit(BTC, 'Approval')
      .withArgs(market.address, vBTC.address, ethers.constants.MaxUint256);

    const [routerAllowance, vBTCAllowance] = await Promise.all([
      BTC.allowance(market.address, erc20Router.address),
      BTC.allowance(market.address, vBTC.address),
    ]);

    expect(routerAllowance).to.be.equal(ethers.constants.MaxUint256);
    expect(vBTCAllowance).to.be.equal(ethers.constants.MaxUint256);
  });

  it('sends the fees earned to the feeTo address', async () => {
    await market.connect(alice).addCollateral(parseEther('1'));

    await market.connect(alice).borrow(alice.address, parseEther('700'));

    // Pass time to accrue fees
    await advanceTime(10_000, ethers); // advance 10_000 seconds

    const debt = parseEther('700')
      .mul(ethers.BigNumber.from(12e8))
      .mul(10_000)
      .div(parseEther('1'));

    expect(await dinero.balanceOf(treasury.address)).to.be.equal(0);

    // Accrue has not been called
    expect((await market.totalLoan()).elastic).to.be.equal(parseEther('700'));

    await expect(market.getEarnings())
      .to.emit(market, 'Accrue')
      .to.emit(market, 'GetEarnings');

    const [loan, treasuryDineroBalance, totalLoan] = await Promise.all([
      market.loan(),
      dinero.balanceOf(treasury.address),
      market.totalLoan(),
    ]);

    expect(loan.feesEarned).to.be.equal(0);
    expect(treasuryDineroBalance.gte(debt)).to.be.equal(true);
    expect(totalLoan.elastic.gte(parseEther('700').add(debt)));
  });
  describe('function: accrue', () => {
    it('does not accrue fees if there is no open loans', async () => {
      const [loan, totalLoan] = await Promise.all([
        market.loan(),
        market.totalLoan(),
      ]);

      expect(totalLoan.base).to.be.equal(0);

      await expect(market.accrue()).to.not.emit(market, 'Accrue');

      const [loan2, totalLoan2] = await Promise.all([
        market.loan(),
        market.totalLoan(),
      ]);

      // It only updated the timestamp
      expect(loan.lastAccrued.lt(loan2.lastAccrued)).to.be.equal(true);
      expect(loan2.feesEarned).to.be.equal(0);
      expect(totalLoan2.base).to.be.equal(0);
    });
    it('does not update if no time has passed', async () => {
      await network.provider.send('evm_setAutomine', [false]);

      // Add 10 BNB as collateral
      await market.connect(alice).addCollateral(parseEther('10'));

      await advanceBlock(ethers);

      // Borrow 2000
      await market.connect(alice).borrow(alice.address, parseEther('2000'));

      await advanceBlock(ethers);

      await advanceBlockAndTime(50_000, ethers);

      const receipt = await market.accrue();
      const receipt2 = await market.accrue();

      await advanceBlock(ethers);

      const [awaitedReceipt, awaitedReceipt2] = await Promise.all([
        receipt.wait(),
        receipt2.wait(),
      ]);

      expect(
        awaitedReceipt.events?.filter((x) => x.event === 'Accrue').length
      ).to.be.equal(1);

      expect(
        awaitedReceipt2.events?.filter((x) => x.event === 'Accrue').length
      ).to.be.equal(0);

      await network.provider.send('evm_setAutomine', [true]);
    });
    // TODO check this test
    it('accrues the interest rate', async () => {
      // Add 10 BTC as collateral
      await market.connect(alice).addCollateral(parseEther('10'));

      await market.connect(alice).borrow(alice.address, parseEther('1500'));

      const [loan, totalLoan] = await Promise.all([
        market.loan(),
        market.totalLoan(),
      ]);

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // advance 10_000 seconds
      const debt = parseEther('1500')
        .mul(ethers.BigNumber.from(12e8))
        .mul(10_000)
        .div(parseEther('1'));

      await expect(market.accrue()).to.emit(market, 'Accrue');

      const [loan2, totalLoan2] = await Promise.all([
        market.loan(),
        market.totalLoan(),
      ]);

      expect(loan.feesEarned).to.be.equal(0);
      expect(loan2.lastAccrued.gt(0)).to.be.equal(true);
      expect(totalLoan2.base).to.be.equal(totalLoan.base);
      expect(totalLoan2.elastic.gte(totalLoan.elastic.add(debt))).to.be.equal(
        true
      );
      expect(loan2.lastAccrued.gt(loan.lastAccrued)).to.be.equal(true);
    });
  });

  describe('function: updateExchangeRate', () => {
    it('reverts if the exchange rate is 0', async () => {
      await mockBTCUsdDFeed.setAnswer(0);

      await expect(market.updateExchangeRate()).to.revertedWith(
        'DM: invalid exchange rate'
      );
    });
    it('updates the exchange rate for vBTC', async () => {
      const [exchangeRate] = await Promise.all([
        market.exchangeRate(),
        mockBTCUsdDFeed.setAnswer(ethers.BigNumber.from('5000000000000')),
      ]);

      expect(exchangeRate).to.be.equal(
        BTC_USD_PRICE.mul(1e10)
          .mul(VTOKEN_BTC_EXCHANGE_RATE)
          .div(parseEther('1'))
      );

      await expect(market.updateExchangeRate())
        .to.emit(market, 'ExchangeRate')
        .withArgs(
          ethers.BigNumber.from('5000000000000')
            .mul(1e10)
            .mul(VTOKEN_BTC_EXCHANGE_RATE)
            .div(parseEther('1'))
        );

      await expect(market.updateExchangeRate()).to.not.emit(
        market,
        'ExchangeRate'
      );
    });
  });

  describe('function: addCollateral', async () => {
    it('reverts if it fails to mint vBTC', async () => {
      await vBTC.__setMintReturn(1);

      await expect(
        market.connect(alice).addCollateral(parseEther('1'))
      ).to.revertedWith('DV: failed to mint');
    });
    it('accepts BTC deposits', async () => {
      const [
        aliceCollateral,
        totalRewardsPerVToken,
        totalVCollateral,
        aliceRewards,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        BTC.connect(alice).approve(market.address, ethers.constants.MaxUint256),
        BTC.connect(bob).approve(market.address, ethers.constants.MaxUint256),
      ]);

      expect(aliceCollateral).to.be.equal(0);
      expect(totalRewardsPerVToken).to.be.equal(0);
      expect(totalVCollateral).to.be.equal(0);
      expect(aliceRewards).to.be.equal(0);

      await expect(market.connect(alice).addCollateral(parseEther('2')))
        .to.emit(market, 'AddCollateral')
        .withArgs(
          alice.address,
          parseEther('2'),
          parseEther('2').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE)
        )
        .to.not.emit(venusController, 'Claim')
        .to.not.emit(XVS, 'Transfer');

      await expect(market.connect(bob).addCollateral(parseEther('1')))
        .to.emit(market, 'AddCollateral')
        .withArgs(
          alice.address,
          parseEther('1'),
          parseEther('1').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE)
        )
        .to.not.emit(venusController, 'Claim')
        .to.not.emit(XVS, 'Transfer');

      const [
        aliceCollateral2,
        totalRewardsPerVToken2,
        totalVCollateral2,
        aliceRewards2,
        bobRewards2,
        bobCollateral2,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        market.rewardsOf(bob.address),
        market.userCollateral(bob.address),
        venusController.__setClaimVenusValue(parseEther('100')),
      ]);

      expect(aliceCollateral2).to.be.equal(
        parseEther('2').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE)
      );
      expect(bobCollateral2).to.be.equal(
        parseEther('1').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE)
      );
      expect(totalRewardsPerVToken2).to.be.equal(0);
      expect(totalVCollateral2).to.be.closeTo(
        parseEther('3').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
        1
      );
      expect(aliceRewards2).to.be.equal(0);
      expect(bobRewards2).to.be.equal(0);

      await expect(market.connect(alice).addCollateral(parseEther('1')))
        .to.emit(market, 'AddCollateral')
        .withArgs(
          alice.address,
          parseEther('1'),
          parseEther('1').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE)
        )
        .to.emit(venusController, 'Claim')
        .to.emit(XVS, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          parseEther('100')
            .mul(oneVToken)
            .div(totalVCollateral2)
            .mul(aliceCollateral2)
            .div(oneVToken)
        );

      const [
        aliceCollateral3,
        totalRewardsPerVToken3,
        totalVCollateral3,
        aliceRewards3,
        bobRewards3,
        bobCollateral3,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        market.rewardsOf(bob.address),
        market.userCollateral(bob.address),
        venusController.__setClaimVenusValue(parseEther('50')),
      ]);

      expect(aliceCollateral3).to.be.closeTo(
        parseEther('3').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
        1
      );
      expect(bobCollateral3).to.be.equal(
        parseEther('1').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE)
      );
      expect(totalRewardsPerVToken3).to.be.equal(
        parseEther('100').mul(oneVToken).div(totalVCollateral2)
      );
      expect(totalVCollateral3).to.be.closeTo(
        parseEther('4').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
        10
      );
      expect(aliceRewards3).to.be.equal(
        aliceCollateral3.mul(totalRewardsPerVToken3).div(oneVToken)
      );
      expect(bobRewards3).to.be.equal(0);

      await expect(market.connect(alice).addCollateral(parseEther('3')))
        .to.emit(XVS, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          totalRewardsPerVToken3
            .add(parseEther('50').mul(oneVToken).div(totalVCollateral3))
            .mul(aliceCollateral3)
            .div(oneVToken)
            .sub(aliceRewards3)
        );

      const [totalRewardsPerVToken4, aliceRewards4] = await Promise.all([
        market.totalRewardsPerVToken(),
        market.rewardsOf(alice.address),
      ]);

      expect(totalRewardsPerVToken4).to.be.equal(
        totalRewardsPerVToken3.add(
          parseEther('50').mul(oneVToken).div(totalVCollateral3)
        )
      );
      expect(aliceRewards4).to.be.closeTo(
        parseEther('6')
          .mul(parseEther('1'))
          .div(VTOKEN_BTC_EXCHANGE_RATE)
          .mul(totalRewardsPerVToken4)
          .div(oneVToken),
        parseEther('1')
      );
    });
  });

  describe('function: withdrawCollateral', () => {
    it('reverts if the user is insolvent', async () => {
      await market.connect(alice).addCollateral(parseEther('1'));

      await market.connect(alice).borrow(jose.address, parseEther('19990'));

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(
            parseEther('0.1')
              .mul(parseEther('1'))
              .div(VTOKEN_BTC_EXCHANGE_RATE),
            false
          )
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('reverts if vBTC fails to redeem', async () => {
      await Promise.all([
        vBTC.__setRedeemReturn(1),
        market.connect(alice).addCollateral(parseEther('2')),
      ]);

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(
            parseEther('1').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
            true
          )
      ).to.revertedWith('DV: failed to redeem');
    });
    it('allows collateral to be withdrawn in vBTC', async () => {
      await market.connect(alice).addCollateral(parseEther('5'));

      await market.connect(alice).borrow(alice.address, parseEther('100'));

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(
            parseEther('2').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
            false
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(vBTC, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          0,
          parseEther('2').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE)
        )
        .to.not.emit(venusController, 'Claim')
        .to.not.emit(XVS, 'Transfer')
        .to.not.emit(vBTC, 'Redeem');

      const [
        aliceCollateral,
        totalRewardsPerVToken,
        totalVCollateral,
        aliceRewards,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
      ]);

      expect(aliceCollateral).to.be.closeTo(
        parseEther('3').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
        1
      );
      expect(totalRewardsPerVToken).to.be.equal(0);
      expect(totalVCollateral).to.be.closeTo(
        parseEther('3').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
        1
      );
      expect(aliceRewards).to.be.equal(0);

      await Promise.all([
        market.connect(bob).addCollateral(parseEther('10')),
        venusController.__setClaimVenusValue(parseEther('100')),
      ]);

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(
            parseEther('1').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
            false
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(vBTC, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          0,
          parseEther('1').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE)
        )
        .to.emit(venusController, 'Claim')
        .to.emit(XVS, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          parseEther('100')
            .mul(oneVToken)
            .div(
              parseEther('13')
                .mul(parseEther('1'))
                .div(VTOKEN_BTC_EXCHANGE_RATE)
            )
            .mul(aliceCollateral)
            .div(oneVToken)
        )
        .to.not.emit(vBTC, 'Redeem');

      const [
        aliceCollateral2,
        totalRewardsPerVToken2,
        totalVCollateral2,
        aliceRewards2,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
      ]);

      expect(aliceCollateral2).to.be.closeTo(
        parseEther('2').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
        10
      );

      expect(totalRewardsPerVToken2).to.be.closeTo(
        parseEther('100')
          .mul(oneVToken)
          .div(
            parseEther('13').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE)
          ),
        10_000_000
      );
      expect(totalVCollateral2).to.be.closeTo(
        parseEther('12').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
        10
      );
      expect(aliceRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(aliceCollateral2).div(oneVToken)
      );
    });
    it('allows BTC to be withdrawn', async () => {
      await market.connect(alice).addCollateral(parseEther('10'));

      await market.connect(alice).borrow(alice.address, parseEther('100'));

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(
            parseEther('2').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
            true
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(vBTC, 'Redeem')
        .withArgs(parseEther('2'))
        .to.emit(market, 'WithdrawCollateral')
        .withArgs(
          alice.address,
          parseEther('2'),
          parseEther('2').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE)
        )
        .to.emit(BTC, 'Transfer')
        .withArgs(market.address, alice.address, parseEther('2'))
        .to.not.emit(XVS, 'Transfer')
        .to.not.emit(venusController, 'Claim');

      const [
        aliceCollateral,
        totalRewardsPerVToken,
        totalVCollateral,
        aliceRewards,
        aliceVBTCBalance,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        vBTC.balanceOf(alice.address),
      ]);

      expect(aliceCollateral).to.be.closeTo(
        parseEther('8').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
        5
      );
      expect(totalRewardsPerVToken).to.be.equal(0);
      expect(totalVCollateral).to.be.equal(aliceCollateral);
      expect(aliceRewards).to.be.equal(0);
      expect(aliceVBTCBalance).to.be.equal(0);

      await Promise.all([
        market.connect(bob).addCollateral(parseEther('5')),
        venusController.__setClaimVenusValue(parseEther('100')),
      ]);

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      const totalVCollateral2 = await market.totalVCollateral();

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(
            parseEther('3').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
            true
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(venusController, 'Claim')
        .to.emit(vBTC, 'Redeem')
        .withArgs(parseEther('3'))
        .to.emit(market, 'WithdrawCollateral')
        .withArgs(
          alice.address,
          parseEther('3'),
          parseEther('3').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE)
        )
        .to.emit(BTC, 'Transfer')
        .withArgs(market.address, alice.address, parseEther('3'))
        .to.emit(XVS, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          parseEther('100')
            .mul(oneVToken)
            .div(totalVCollateral2)
            .mul(aliceCollateral)
            .div(oneVToken)
        );

      const [
        aliceCollateral2,
        totalRewardsPerVToken2,
        totalVCollateral3,
        aliceRewards2,
        aliceVBTCBalance2,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        vBTC.balanceOf(alice.address),
      ]);

      expect(aliceCollateral2).to.be.closeTo(
        parseEther('5').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
        10
      );
      expect(totalRewardsPerVToken2).to.be.equal(
        parseEther('100').mul(oneVToken).div(totalVCollateral2)
      );
      expect(totalVCollateral3).to.be.closeTo(
        parseEther('10').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
        10
      );
      expect(aliceRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(aliceCollateral2).div(oneVToken)
      );
      expect(aliceVBTCBalance2).to.be.equal(0);

      await expect(market.connect(alice).withdrawCollateral(0, true))
        .to.emit(XVS, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          totalRewardsPerVToken2
            .add(parseEther('100').mul(oneVToken).div(totalVCollateral3))
            .mul(aliceCollateral2)
            .div(oneVToken)
            .sub(aliceRewards2)
        );
    });
  });
  describe('function: borrow', () => {
    it('reverts if you borrow to the zero address', async () => {
      await expect(
        market.connect(alice).borrow(ethers.constants.AddressZero, 1)
      ).to.revertedWith('MKT: no zero address');
    });
    it('reverts if the user is insolvent', async () => {
      await market.connect(alice).addCollateral(parseEther('2'));

      await expect(
        market.connect(alice).borrow(bob.address, parseEther('40001'))
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('allows a user to borrow as long as he remains solvent', async () => {
      await market.connect(alice).addCollateral(parseEther('1'));

      const [totalLoan, aliceLoan, aliceDineroBalance] = await Promise.all([
        market.totalLoan(),
        market.userLoan(alice.address),
        dinero.balanceOf(alice.address),
      ]);

      expect(totalLoan.base).to.be.equal(0);
      expect(totalLoan.elastic).to.be.equal(0);
      expect(aliceLoan).to.be.equal(0);

      await expect(
        market.connect(alice).borrow(bob.address, parseEther('10000'))
      )
        .to.emit(dinero, 'Transfer')
        .withArgs(
          ethers.constants.AddressZero,
          bob.address,
          parseEther('10000')
        )
        .to.emit(market, 'Borrow')
        .to.not.emit(market, 'Accrue');

      const [totalLoan2, aliceLoan2, aliceDineroBalance2, bobDineroBalance] =
        await Promise.all([
          market.totalLoan(),
          market.userLoan(alice.address),
          dinero.balanceOf(alice.address),
          dinero.balanceOf(bob.address),
        ]);

      expect(totalLoan2.base).to.be.equal(parseEther('10000'));
      expect(totalLoan2.elastic).to.be.equal(parseEther('10000'));
      expect(aliceLoan2).to.be.equal(parseEther('10000'));
      expect(aliceDineroBalance2).to.be.equal(aliceDineroBalance);
      expect(bobDineroBalance).to.be.equal(parseEther('10000'));

      await advanceTime(10_000, ethers); // advance 10_000 seconds

      await expect(
        market.connect(alice).borrow(alice.address, parseEther('9000'))
      )
        .to.emit(market, 'Accrue')
        .to.emit(dinero, 'Transfer')
        .withArgs(
          ethers.constants.AddressZero,
          alice.address,
          parseEther('9000')
        )
        .to.emit(market, 'Borrow');

      const [
        totalLoan3,
        aliceLoan3,
        bobLoan,
        aliceDineroBalance3,
        bobDineroBalance2,
      ] = await Promise.all([
        market.totalLoan(),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        dinero.balanceOf(alice.address),
        dinero.balanceOf(bob.address),
      ]);
      expect(totalLoan3.base).to.be.closeTo(
        totalLoan2.base.add(parseEther('9000')),
        parseEther('50') // 50 DNR for approximation
      );
      expect(totalLoan3.elastic).to.be.closeTo(
        totalLoan2.elastic.add(parseEther('9000')),
        parseEther('10')
      );
      expect(aliceLoan3).to.be.closeTo(
        totalLoan2.base.add(parseEther('9000')),
        parseEther('50') // 50 DNR for approximation
      ); // Interest rate makes it hard to calculate the exact value

      expect(aliceDineroBalance3).to.be.equal(
        aliceDineroBalance2.add(parseEther('9000'))
      );
      expect(bobDineroBalance2).to.be.equal(parseEther('10000'));
      expect(bobLoan).to.be.equal(0);
    });
  });

  describe('function: repay', () => {
    it('reverts if you pass zero address or 0 principal', async () => {
      await expect(
        market.repay(ethers.constants.AddressZero, 1)
      ).to.revertedWith('MKT: no zero address');
      await expect(market.repay(alice.address, 0)).to.revertedWith(
        'MKT: principal cannot be 0'
      );
    });
    it('allows a user to repay a debt', async () => {
      await market.connect(alice).addCollateral(parseEther('1'));

      await market.connect(alice).borrow(alice.address, parseEther('15300'));

      const [ownerDineroBalance, aliceLoan, totalLoan] = await Promise.all([
        dinero.balanceOf(owner.address),
        market.userLoan(alice.address),
        market.totalLoan(),
        advanceTime(1000, ethers),
      ]);

      await expect(
        market.connect(owner).repay(alice.address, parseEther('15000'))
      )
        .to.emit(market, 'Accrue')
        .to.emit(dinero, 'Transfer')
        .to.emit(market, 'Repay');

      const [ownerDineroBalance2, aliceLoan2, totalLoan2] = await Promise.all([
        dinero.balanceOf(owner.address),
        market.userLoan(alice.address),
        market.totalLoan(),
      ]);

      expect(
        ownerDineroBalance2.lte(ownerDineroBalance.sub(parseEther('15000')))
      ).to.be.equal(true);
      expect(aliceLoan).to.be.equal(parseEther('15300'));
      expect(aliceLoan2).to.be.equal(parseEther('300'));
      expect(totalLoan.elastic).to.be.equal(parseEther('15300'));
      expect(totalLoan.base).to.be.equal(parseEther('15300'));
      expect(totalLoan2.base).to.be.equal(parseEther('300'));
      expect(
        totalLoan2.elastic.gt(totalLoan.elastic.sub(parseEther('15000')))
      ).to.be.equal(true);
    });
  });
  describe('function: setMaxLTVRatio', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(market.connect(alice).setMaxLTVRatio(0)).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });
    it('reverts if we set a collateral higher than 9e5', async () => {
      await expect(
        market
          .connect(owner)
          .setMaxLTVRatio(ethers.BigNumber.from('900000000000000001'))
      ).to.revertedWith('MKT: too high');
    });
    it('updates the max tvl ratio', async () => {
      expect(await market.maxLTVRatio()).to.be.equal(
        ethers.BigNumber.from('500000000000000000')
      );

      await market
        .connect(owner)
        .setMaxLTVRatio(ethers.BigNumber.from('900000000000000000'));

      expect(await market.maxLTVRatio()).to.be.equal(
        ethers.BigNumber.from('900000000000000000')
      );
    });
  });
  describe('function: setLiquidationFee', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(market.connect(alice).setLiquidationFee(0)).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });
    it('reverts if we set a liquidation fee higher than 15e4', async () => {
      await expect(
        market
          .connect(owner)
          .setLiquidationFee(ethers.BigNumber.from('150000000000000001'))
      ).to.revertedWith('MKT: too high');
    });
    it('updates the liquidation fee', async () => {
      expect(await market.liquidationFee()).to.be.equal(
        ethers.BigNumber.from('100000000000000000')
      );

      await market
        .connect(owner)
        .setLiquidationFee(ethers.BigNumber.from('150000000000000000'));

      expect(await market.liquidationFee()).to.be.equal(
        ethers.BigNumber.from('150000000000000000')
      );
    });
  });
  describe('function: setInterestRate', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(market.connect(alice).setInterestRate(0)).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });
    it('reverts if we set a liquidation fee higher than 15e4', async () => {
      await expect(
        market
          .connect(owner)
          .setInterestRate(ethers.BigNumber.from(13e8).add(1))
      ).to.revertedWith('MKT: too high');
    });
    it('updates the liquidation fee', async () => {
      expect((await market.loan()).INTEREST_RATE).to.be.equal(
        ethers.BigNumber.from(12e8)
      );

      await market.connect(owner).setInterestRate(ethers.BigNumber.from(13e8));

      expect((await market.loan()).INTEREST_RATE).to.be.equal(
        ethers.BigNumber.from(13e8)
      );
    });
  });
  describe('function: liquidate', () => {
    it('reverts if the last element on path is not dinero', async () => {
      await expect(
        market
          .connect(alice)
          .liquidate([], [], recipient.address, true, [jose.address])
      ).to.revertedWith('DM: no dinero at last index');
    });
    it('reverts if there is a path and underlying is false', async () => {
      await expect(
        market
          .connect(alice)
          .liquidate([], [], recipient.address, false, [dinero.address])
      ).to.revertedWith('DM: cannot sell VTokens');
    });
    it('reverts if there are no positions to liquidate', async () => {
      await Promise.all([
        market.connect(alice).addCollateral(parseEther('10')),
        market.connect(bob).addCollateral(parseEther('10')),
      ]);

      // Collateral should allow them to borrow up to 2500
      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('2450')),
        market.connect(bob).borrow(bob.address, parseEther('2450')),
      ]);

      const principalToLiquidate = parseEther('10')
        .mul(parseEther('1'))
        .div(VTOKEN_BTC_EXCHANGE_RATE);

      await expect(
        market
          .connect(jose)
          .liquidate(
            [alice.address, bob.address],
            [principalToLiquidate, principalToLiquidate],
            recipient.address,
            false,
            []
          )
      ).to.revertedWith('DM: no liquidations');
    });
    it('reverts if you try to sell XVS', async () => {
      await expect(
        market
          .connect(jose)
          .liquidate([], [], recipient.address, true, [
            XVS.address,
            dinero.address,
          ])
      ).to.revertedWith('DM: not allowed to sell XVS');
    });
    it('reverts if the principal to liquidate is very low', async () => {
      await Promise.all([
        market.connect(alice).addCollateral(parseEther('2')),
        market.connect(bob).addCollateral(parseEther('2')),
        market.connect(jose).addCollateral(parseEther('1')),
      ]);

      await venusController.__setClaimVenusValue(parseEther('100'));

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('31000')),
        market.connect(bob).borrow(bob.address, parseEther('25000')),
        market.connect(jose).borrow(jose.address, parseEther('14000')),
      ]);

      // Drop BNB to 300. Alice and Jose can now be liquidated
      await mockBTCUsdDFeed.setAnswer(ethers.BigNumber.from('300000000000'));

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // 10_000 seconds

      await expect(
        market
          .connect(recipient)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [100, toVBalance(parseEther('10')), toVBalance(parseEther('7'))],
            recipient.address,
            true,
            [WETH.address, dinero.address]
          )
      ).to.revertedWith('DM: principal too low');
    });
    it('liquidates a user by selling redeeming the collateral and burning the acquired dinero', async () => {
      await Promise.all([
        market.connect(alice).addCollateral(parseEther('2')),
        market.connect(bob).addCollateral(parseEther('2')),
        market.connect(jose).addCollateral(parseEther('1')),
      ]);

      await venusController.__setClaimVenusValue(parseEther('100'));

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('35000')),
        market.connect(bob).borrow(bob.address, parseEther('25000')),
        market.connect(jose).borrow(jose.address, parseEther('16000')),
      ]);

      // Drop BTC to 30_000. Alice and Jose can now be liquidated
      await mockBTCUsdDFeed.setAnswer(ethers.BigNumber.from('3000000000000'));

      const [
        pair,
        recipientDineroBalance,
        aliceLoan,
        bobLoan,
        joseLoan,
        aliceCollateral,
        bobCollateral,
        joseCollateral,
        aliceRewards,
        bobRewards,
        joseRewards,
        totalVCollateral,
        recipientBNBBalance,
        recipientVVBTCBalance,
        aliceXVSBalance,
        bobXVSBalance,
        joseXVSBalance,
        recipientBTCBalance,
        loan,
      ] = await Promise.all([
        factory.getPair(dinero.address, WETH.address),
        dinero.balanceOf(recipient.address),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.userCollateral(jose.address),
        market.rewardsOf(alice.address),
        market.rewardsOf(bob.address),
        market.rewardsOf(jose.address),
        market.totalVCollateral(),
        recipient.getBalance(),
        vBTC.balanceOf(recipient.address),
        XVS.balanceOf(alice.address),
        XVS.balanceOf(bob.address),
        XVS.balanceOf(jose.address),
        BTC.balanceOf(recipient.address),
        market.loan(),
      ]);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      expect(recipientDineroBalance).to.be.equal(0);
      expect(recipientBTCBalance).to.be.equal(0);
      expect(recipientVVBTCBalance).to.be.equal(0);
      expect(aliceLoan).to.be.equal(parseEther('35000'));
      // Bob in shares will be less than borrowed amount due to already accrued fees
      expect(bobLoan).to.be.closeTo(parseEther('25000'), parseEther('10'));
      expect(joseLoan).to.be.closeTo(parseEther('16000'), parseEther('50'));

      expect(aliceCollateral).to.be.equal(toVBalance(parseEther('2')));
      expect(bobCollateral).to.be.equal(toVBalance(parseEther('2')));
      expect(joseCollateral).to.be.equal(toVBalance(parseEther('1')));
      expect(totalVCollateral).to.be.equal(
        bobCollateral.add(joseCollateral).add(aliceCollateral)
      );
      expect(aliceXVSBalance).to.be.equal(0);
      expect(bobXVSBalance).to.be.equal(0);
      expect(joseXVSBalance).to.be.equal(0);

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // 10_000 seconds

      await expect(
        market
          .connect(recipient)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [parseEther('35000'), parseEther('25000'), parseEther('12000')],
            recipient.address,
            true,
            [BTC.address, WETH.address, dinero.address]
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(venusController, 'Claim')
        .to.emit(XVS, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          parseEther('100')
            .mul(oneVToken)
            .div(totalVCollateral)
            .mul(aliceCollateral)
            .div(oneVToken)
            .sub(aliceRewards)
        )
        .to.emit(XVS, 'Transfer')
        .withArgs(
          market.address,
          jose.address,
          parseEther('100')
            .mul(oneVToken)
            .div(totalVCollateral)
            .mul(joseCollateral)
            .div(oneVToken)
            .sub(joseRewards)
        )
        .to.emit(vBTC, 'Redeem')
        .withArgs(aliceCollateral)
        .to.emit(pairContract, 'Swap');

      const [
        recipientDineroBalance2,
        aliceLoan2,
        bobLoan2,
        joseLoan2,
        aliceCollateral2,
        bobCollateral2,
        joseCollateral2,
        loan2,
        aliceRewards2,
        bobRewards2,
        joseRewards2,
        totalVCollateral2,
        aliceXVSBalance2,
        bobXVSBalance2,
        joseXVSBalance2,
        totalLoan2,
        recipientBNBBalance2,
        recipientBTCBalance2,
        recipientVBTCBalance2,
      ] = await Promise.all([
        dinero.balanceOf(recipient.address),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.userCollateral(jose.address),
        market.loan(),
        market.rewardsOf(alice.address),
        market.rewardsOf(bob.address),
        market.rewardsOf(jose.address),
        market.totalVCollateral(),
        XVS.balanceOf(alice.address),
        XVS.balanceOf(bob.address),
        XVS.balanceOf(jose.address),
        market.totalLoan(),
        recipient.getBalance(),
        BTC.balanceOf(recipient.address),
        vBTC.balanceOf(recipient.address),
      ]);

      // Recipient got paid for liquidating
      expect(recipientDineroBalance2.gt(0)).to.be.equal(true);
      // Alice got fully liquidated
      expect(aliceLoan2).to.be.equal(0);
      // Bob did not get liquidated
      expect(bobLoan2).to.be.equal(bobLoan);
      // Jose got partially liquidated
      expect(joseLoan2).to.be.equal(joseLoan.sub(parseEther('12000')));

      expect(bobCollateral2).to.be.equal(bobCollateral);
      // Alice collateral 2 must be lower than collateral 1 minus loan liquidated + 10% due to fees
      expect(aliceCollateral2).to.be.closeTo(
        aliceCollateral.sub(
          convertBorrowToLiquidationCollateral(parseEther('35000'))
        ),
        ethers.BigNumber.from(10).pow(7) // 0.1 VToken
      );
      expect(joseCollateral2).to.be.closeTo(
        joseCollateral.sub(
          convertBorrowToLiquidationCollateral(parseEther('12000'))
        ),
        ethers.BigNumber.from(10).pow(7) // 0.1 VToken
      );

      expect(bobRewards2).to.be.equal(bobRewards);
      expect(aliceRewards2).to.be.equal(
        parseEther('100')
          .mul(oneVToken)
          .div(totalVCollateral)
          .mul(aliceCollateral2)
          .div(oneVToken)
      );
      expect(joseRewards2).to.be.equal(
        parseEther('100')
          .mul(oneVToken)
          .div(totalVCollateral)
          .mul(joseCollateral2)
          .div(oneVToken)
      );
      expect(aliceXVSBalance2).to.be.equal(
        parseEther('100')
          .mul(oneVToken)
          .div(totalVCollateral)
          .mul(aliceCollateral)
          .div(oneVToken)
          .sub(aliceRewards)
      );
      expect(bobXVSBalance2).to.be.equal(0);
      expect(joseXVSBalance2).to.be.equal(
        parseEther('100')
          .mul(oneVToken)
          .div(totalVCollateral)
          .mul(joseCollateral)
          .div(oneVToken)
          .sub(joseRewards)
      );
      expect(totalVCollateral2).to.be.closeTo(
        totalVCollateral.sub(
          convertBorrowToLiquidationCollateral(parseEther('47000'))
        ),
        oneVToken
      );
      expect(totalLoan2.base).to.be.equal(
        aliceLoan2.add(joseLoan2).add(bobLoan2)
      );
      expect(totalLoan2.elastic).to.be.closeTo(
        parseEther('29000'),
        parseEther('2') // 2 DNR to account for fees
      );
      // Fees earned have to be greater than prev fees plus loan accrued fees.
      expect(
        loan2.feesEarned.gt(
          loan.feesEarned.add(
            ethers.BigNumber.from(12e8)
              .mul(parseEther('29000'))
              .mul(BigNumber.from(10_000))
              .div(parseEther('1'))
          )
        )
      );
      expect(recipientBNBBalance).closeTo(
        recipientBNBBalance2,
        parseEther('0.1') // tx fees not from liquidating
      );
      expect(recipientVBTCBalance2).to.be.equal(0);
      expect(recipientBTCBalance2).to.be.equal(0);
    });
    it('liquidates a user by receiving the underlying and using the liquidator dinero to repay the debt', async () => {
      await Promise.all([
        market.connect(alice).addCollateral(parseEther('2')),
        market.connect(bob).addCollateral(parseEther('2')),
        market.connect(jose).addCollateral(parseEther('1')),
      ]);

      await venusController.__setClaimVenusValue(parseEther('100'));

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('35000')),
        market.connect(bob).borrow(bob.address, parseEther('25000')),
        market.connect(jose).borrow(jose.address, parseEther('16000')),
      ]);

      // Drop BTC to 30_000. Alice and Jose can now be liquidated
      await mockBTCUsdDFeed.setAnswer(ethers.BigNumber.from('3000000000000'));

      const [
        pair,
        aliceLoan,
        bobLoan,
        joseLoan,
        aliceCollateral,
        bobCollateral,
        joseCollateral,
        aliceRewards,
        bobRewards,
        joseRewards,
        totalVCollateral,
        aliceXVSBalance,
        bobXVSBalance,
        joseXVSBalance,
        loan,
        ownerBNBBalance,
        ownerBTCBalance,
        ownerVBTCBalance,
        ownerDineroBalance,
        recipientBTCBalance,
        recipientVBTCBalance,
        recipientDineroBalance,
        recipientBNBBalance,
      ] = await Promise.all([
        factory.getPair(dinero.address, WETH.address),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.userCollateral(jose.address),
        market.rewardsOf(alice.address),
        market.rewardsOf(bob.address),
        market.rewardsOf(jose.address),
        market.totalVCollateral(),
        XVS.balanceOf(alice.address),
        XVS.balanceOf(bob.address),
        XVS.balanceOf(jose.address),
        market.loan(),
        owner.getBalance(),
        BTC.balanceOf(owner.address),
        vBTC.balanceOf(owner.address),
        dinero.balanceOf(owner.address),
        BTC.balanceOf(recipient.address),
        vBTC.balanceOf(recipient.address),
        dinero.balanceOf(recipient.address),
        recipient.getBalance(),
      ]);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      expect(recipientDineroBalance).to.be.equal(0);
      expect(recipientBTCBalance).to.be.equal(0);
      expect(recipientVBTCBalance).to.be.equal(0);
      expect(aliceLoan).to.be.equal(parseEther('35000'));
      // Bob in shares will be less than borrowed amount due to already accrued fees
      expect(bobLoan).to.be.closeTo(parseEther('25000'), parseEther('10'));
      expect(joseLoan).to.be.closeTo(parseEther('16000'), parseEther('50'));

      expect(aliceCollateral).to.be.equal(toVBalance(parseEther('2')));
      expect(bobCollateral).to.be.equal(toVBalance(parseEther('2')));
      expect(joseCollateral).to.be.equal(toVBalance(parseEther('1')));
      expect(totalVCollateral).to.be.equal(
        bobCollateral.add(joseCollateral).add(aliceCollateral)
      );
      expect(aliceXVSBalance).to.be.equal(0);
      expect(bobXVSBalance).to.be.equal(0);
      expect(joseXVSBalance).to.be.equal(0);

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // 10_000 seconds

      const totalLoan = await market.totalLoan();

      await expect(
        market
          .connect(owner)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [parseEther('35000'), parseEther('25000'), parseEther('12000')],
            recipient.address,
            true,
            []
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(venusController, 'Claim')
        .to.emit(XVS, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          parseEther('100')
            .mul(oneVToken)
            .div(totalVCollateral)
            .mul(aliceCollateral)
            .div(oneVToken)
            .sub(aliceRewards)
        )
        .to.emit(XVS, 'Transfer')
        .withArgs(
          market.address,
          jose.address,
          parseEther('100')
            .mul(oneVToken)
            .div(totalVCollateral)
            .mul(joseCollateral)
            .div(oneVToken)
            .sub(joseRewards)
        )
        .to.emit(vBTC, 'Redeem')
        .withArgs(aliceCollateral)
        .to.not.emit(pairContract, 'Swap');

      const [
        aliceLoan2,
        bobLoan2,
        joseLoan2,
        aliceCollateral2,
        bobCollateral2,
        joseCollateral2,
        loan2,
        aliceRewards2,
        bobRewards2,
        joseRewards2,
        totalVCollateral2,
        aliceXVSBalance2,
        bobXVSBalance2,
        joseXVSBalance2,
        totalLoan2,
        ownerBNBBalance2,
        ownerBTCBalance2,
        ownerVBTCBalance2,
        ownerDineroBalance2,
        recipientBTCBalance2,
        recipientVBTCBalance2,
        recipientDineroBalance2,
        recipientBNBBalance2,
      ] = await Promise.all([
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.userCollateral(jose.address),
        market.loan(),
        market.rewardsOf(alice.address),
        market.rewardsOf(bob.address),
        market.rewardsOf(jose.address),
        market.totalVCollateral(),
        XVS.balanceOf(alice.address),
        XVS.balanceOf(bob.address),
        XVS.balanceOf(jose.address),
        market.totalLoan(),
        owner.getBalance(),
        BTC.balanceOf(owner.address),
        vBTC.balanceOf(owner.address),
        dinero.balanceOf(owner.address),
        BTC.balanceOf(recipient.address),
        vBTC.balanceOf(recipient.address),
        dinero.balanceOf(recipient.address),
        recipient.getBalance(),
      ]);

      // Recipient got paid for liquidating
      expect(recipientDineroBalance2).to.be.equal(0);
      expect(recipientBNBBalance).to.be.equal(recipientBNBBalance2);
      expect(recipientVBTCBalance2).to.be.equal(0);
      // liquidator got rewarded in BTC
      expect(recipientBTCBalance2).closeTo(
        recipientBTCBalance.add(
          // Principal + Interest
          parseEther('47000')
            .add(
              ethers.BigNumber.from(12e8)
                .mul(parseEther('47000'))
                .mul(BigNumber.from(10_000))
                .div(parseEther('1'))
            )
            // 10% fee
            .add(
              parseEther('47000')
                .add(
                  ethers.BigNumber.from(12e8)
                    .mul(parseEther('47000'))
                    .mul(BigNumber.from(10_000))
                    .div(parseEther('1'))
                )
                .mul(parseEther('0.1'))
                .div(parseEther('1'))
            )
            // Convert to BTC
            .mul(parseEther('1'))
            .div(parseEther('30000'))
        ),
        parseEther('0.00001') // Rounding of debt interest rate
      );

      // owner does not get anything
      expect(ownerBTCBalance2).to.be.equal(ownerBTCBalance);
      expect(ownerVBTCBalance2).to.be.equal(ownerVBTCBalance);
      expect(ownerDineroBalance2).to.be.closeTo(
        ownerDineroBalance.sub(
          totalLoan.elastic
            .sub(totalLoan2.elastic)
            .add(
              totalLoan.elastic
                .sub(totalLoan2.elastic)
                .mul(parseEther('0.01'))
                .div(parseEther('1'))
            )
        ),
        parseEther('1') // in case of rounding issues
      );
      expect(ownerBNBBalance2).to.be.closeTo(
        ownerBNBBalance,
        parseEther('0.1') // TX fee
      );

      // Alice got fully liquidated
      expect(aliceLoan2).to.be.equal(0);
      // Bob did not get liquidated
      expect(bobLoan2).to.be.equal(bobLoan);
      // Jose got partially liquidated
      expect(joseLoan2).to.be.equal(joseLoan.sub(parseEther('12000')));

      expect(bobCollateral2).to.be.equal(bobCollateral);
      // Alice collateral 2 must be lower than collateral 1 minus loan liquidated + 10% due to fees
      expect(aliceCollateral2).to.be.closeTo(
        aliceCollateral.sub(
          convertBorrowToLiquidationCollateral(parseEther('35000'))
        ),
        ethers.BigNumber.from(10).pow(7) // 0.1 VToken
      );
      expect(joseCollateral2).to.be.closeTo(
        joseCollateral.sub(
          convertBorrowToLiquidationCollateral(parseEther('12000'))
        ),
        ethers.BigNumber.from(10).pow(7) // 0.1 VToken
      );

      expect(bobRewards2).to.be.equal(bobRewards);
      expect(aliceRewards2).to.be.equal(
        parseEther('100')
          .mul(oneVToken)
          .div(totalVCollateral)
          .mul(aliceCollateral2)
          .div(oneVToken)
      );
      expect(joseRewards2).to.be.equal(
        parseEther('100')
          .mul(oneVToken)
          .div(totalVCollateral)
          .mul(joseCollateral2)
          .div(oneVToken)
      );
      expect(aliceXVSBalance2).to.be.equal(
        parseEther('100')
          .mul(oneVToken)
          .div(totalVCollateral)
          .mul(aliceCollateral)
          .div(oneVToken)
          .sub(aliceRewards)
      );
      expect(bobXVSBalance2).to.be.equal(0);
      expect(joseXVSBalance2).to.be.equal(
        parseEther('100')
          .mul(oneVToken)
          .div(totalVCollateral)
          .mul(joseCollateral)
          .div(oneVToken)
          .sub(joseRewards)
      );
      expect(totalVCollateral2).to.be.closeTo(
        totalVCollateral.sub(
          convertBorrowToLiquidationCollateral(parseEther('47000'))
        ),
        oneVToken
      );
      expect(totalLoan2.base).to.be.equal(
        aliceLoan2.add(joseLoan2).add(bobLoan2)
      );
      expect(totalLoan2.elastic).to.be.closeTo(
        parseEther('29000'),
        parseEther('2') // 2 DNR to account for fees
      );
      // Fees earned have to be greater than prev fees plus loan accrued fees.
      expect(
        loan2.feesEarned.gt(
          loan.feesEarned.add(
            ethers.BigNumber.from(12e8)
              .mul(parseEther('29000'))
              .mul(BigNumber.from(10_000))
              .div(parseEther('1'))
          )
        )
      );
    });
    it('liquidates a user by receiving vBTC and using the liquidator dinero to repay the debt', async () => {
      await Promise.all([
        market.connect(alice).addCollateral(parseEther('2')),
        market.connect(bob).addCollateral(parseEther('2')),
        market.connect(jose).addCollateral(parseEther('1')),
      ]);

      await venusController.__setClaimVenusValue(parseEther('100'));

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('35000')),
        market.connect(bob).borrow(bob.address, parseEther('25000')),
        market.connect(jose).borrow(jose.address, parseEther('16000')),
      ]);

      // Drop BTC to 30_000. Alice and Jose can now be liquidated
      await mockBTCUsdDFeed.setAnswer(ethers.BigNumber.from('3000000000000'));

      const [
        pair,
        aliceLoan,
        bobLoan,
        joseLoan,
        aliceCollateral,
        bobCollateral,
        joseCollateral,
        aliceRewards,
        bobRewards,
        joseRewards,
        totalVCollateral,
        aliceXVSBalance,
        bobXVSBalance,
        joseXVSBalance,
        loan,
        ownerBNBBalance,
        ownerBTCBalance,
        ownerVBTCBalance,
        ownerDineroBalance,
        recipientBTCBalance,
        recipientVBTCBalance,
        recipientDineroBalance,
        recipientBNBBalance,
      ] = await Promise.all([
        factory.getPair(dinero.address, WETH.address),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.userCollateral(jose.address),
        market.rewardsOf(alice.address),
        market.rewardsOf(bob.address),
        market.rewardsOf(jose.address),
        market.totalVCollateral(),
        XVS.balanceOf(alice.address),
        XVS.balanceOf(bob.address),
        XVS.balanceOf(jose.address),
        market.loan(),
        owner.getBalance(),
        BTC.balanceOf(owner.address),
        vBTC.balanceOf(owner.address),
        dinero.balanceOf(owner.address),
        BTC.balanceOf(recipient.address),
        vBTC.balanceOf(recipient.address),
        dinero.balanceOf(recipient.address),
        recipient.getBalance(),
      ]);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      expect(recipientDineroBalance).to.be.equal(0);
      expect(recipientBTCBalance).to.be.equal(0);
      expect(recipientVBTCBalance).to.be.equal(0);
      expect(aliceLoan).to.be.equal(parseEther('35000'));
      // Bob in shares will be less than borrowed amount due to already accrued fees
      expect(bobLoan).to.be.closeTo(parseEther('25000'), parseEther('10'));
      expect(joseLoan).to.be.closeTo(parseEther('16000'), parseEther('50'));

      expect(aliceCollateral).to.be.equal(toVBalance(parseEther('2')));
      expect(bobCollateral).to.be.equal(toVBalance(parseEther('2')));
      expect(joseCollateral).to.be.equal(toVBalance(parseEther('1')));
      expect(totalVCollateral).to.be.equal(
        bobCollateral.add(joseCollateral).add(aliceCollateral)
      );
      expect(aliceXVSBalance).to.be.equal(0);
      expect(bobXVSBalance).to.be.equal(0);
      expect(joseXVSBalance).to.be.equal(0);

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // 10_000 seconds

      const totalLoan = await market.totalLoan();

      await expect(
        market
          .connect(owner)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [parseEther('35000'), parseEther('25000'), parseEther('12000')],
            recipient.address,
            false,
            []
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(venusController, 'Claim')
        .to.emit(XVS, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          parseEther('100')
            .mul(oneVToken)
            .div(totalVCollateral)
            .mul(aliceCollateral)
            .div(oneVToken)
            .sub(aliceRewards)
        )
        .to.emit(XVS, 'Transfer')
        .withArgs(
          market.address,
          jose.address,
          parseEther('100')
            .mul(oneVToken)
            .div(totalVCollateral)
            .mul(joseCollateral)
            .div(oneVToken)
            .sub(joseRewards)
        )
        .to.not.emit(pairContract, 'Swap')
        .to.not.emit(vBTC, 'Redeem');

      const [
        aliceLoan2,
        bobLoan2,
        joseLoan2,
        aliceCollateral2,
        bobCollateral2,
        joseCollateral2,
        loan2,
        aliceRewards2,
        bobRewards2,
        joseRewards2,
        totalVCollateral2,
        aliceXVSBalance2,
        bobXVSBalance2,
        joseXVSBalance2,
        totalLoan2,
        ownerBNBBalance2,
        ownerBTCBalance2,
        ownerVBTCBalance2,
        ownerDineroBalance2,
        recipientBTCBalance2,
        recipientVBTCBalance2,
        recipientDineroBalance2,
        recipientBNBBalance2,
      ] = await Promise.all([
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.userCollateral(jose.address),
        market.loan(),
        market.rewardsOf(alice.address),
        market.rewardsOf(bob.address),
        market.rewardsOf(jose.address),
        market.totalVCollateral(),
        XVS.balanceOf(alice.address),
        XVS.balanceOf(bob.address),
        XVS.balanceOf(jose.address),
        market.totalLoan(),
        owner.getBalance(),
        BTC.balanceOf(owner.address),
        vBTC.balanceOf(owner.address),
        dinero.balanceOf(owner.address),
        BTC.balanceOf(recipient.address),
        vBTC.balanceOf(recipient.address),
        dinero.balanceOf(recipient.address),
        recipient.getBalance(),
      ]);

      // Recipient got paid for liquidating
      expect(recipientDineroBalance2).to.be.equal(0);
      expect(recipientBNBBalance).to.be.equal(recipientBNBBalance2);
      // liquidator got rewarded in VBTC
      expect(recipientVBTCBalance2).to.be.closeTo(
        recipientVBTCBalance.add(
          // Principal + Interest
          parseEther('47000')
            .add(
              ethers.BigNumber.from(12e8)
                .mul(parseEther('47000'))
                .mul(BigNumber.from(10_000))
                .div(parseEther('1'))
            )
            // 10% fee
            .add(
              parseEther('47000')
                .add(
                  ethers.BigNumber.from(12e8)
                    .mul(parseEther('47000'))
                    .mul(BigNumber.from(10_000))
                    .div(parseEther('1'))
                )
                .mul(parseEther('0.1'))
                .div(parseEther('1'))
            )
            // Convert to BTC
            .mul(parseEther('1'))
            .div(parseEther('30000'))
            .mul(parseEther('1'))
            .div(VTOKEN_BTC_EXCHANGE_RATE)
        ),
        ethers.BigNumber.from(10).pow(4)
      );
      expect(recipientBTCBalance2).to.be.equal(recipientBTCBalance);

      // owner does not get anything
      expect(ownerBTCBalance2).to.be.equal(ownerBTCBalance);
      expect(ownerVBTCBalance2).to.be.equal(ownerVBTCBalance);
      expect(ownerDineroBalance2).to.be.closeTo(
        ownerDineroBalance.sub(
          totalLoan.elastic
            .sub(totalLoan2.elastic)
            .add(
              totalLoan.elastic
                .sub(totalLoan2.elastic)
                .mul(parseEther('0.01'))
                .div(parseEther('1'))
            )
        ),
        parseEther('1') // in case of rounding issues
      );
      expect(ownerBNBBalance2).to.be.closeTo(
        ownerBNBBalance,
        parseEther('0.1') // TX fee
      );

      // Alice got fully liquidated
      expect(aliceLoan2).to.be.equal(0);
      // Bob did not get liquidated
      expect(bobLoan2).to.be.equal(bobLoan);
      // Jose got partially liquidated
      expect(joseLoan2).to.be.equal(joseLoan.sub(parseEther('12000')));

      expect(bobCollateral2).to.be.equal(bobCollateral);
      // Alice collateral 2 must be lower than collateral 1 minus loan liquidated + 10% due to fees
      expect(aliceCollateral2).to.be.closeTo(
        aliceCollateral.sub(
          convertBorrowToLiquidationCollateral(parseEther('35000'))
        ),
        ethers.BigNumber.from(10).pow(7) // 0.1 VToken
      );
      expect(joseCollateral2).to.be.closeTo(
        joseCollateral.sub(
          convertBorrowToLiquidationCollateral(parseEther('12000'))
        ),
        ethers.BigNumber.from(10).pow(7) // 0.1 VToken
      );

      expect(bobRewards2).to.be.equal(bobRewards);
      expect(aliceRewards2).to.be.equal(
        parseEther('100')
          .mul(oneVToken)
          .div(totalVCollateral)
          .mul(aliceCollateral2)
          .div(oneVToken)
      );
      expect(joseRewards2).to.be.equal(
        parseEther('100')
          .mul(oneVToken)
          .div(totalVCollateral)
          .mul(joseCollateral2)
          .div(oneVToken)
      );
      expect(aliceXVSBalance2).to.be.equal(
        parseEther('100')
          .mul(oneVToken)
          .div(totalVCollateral)
          .mul(aliceCollateral)
          .div(oneVToken)
          .sub(aliceRewards)
      );
      expect(bobXVSBalance2).to.be.equal(0);
      expect(joseXVSBalance2).to.be.equal(
        parseEther('100')
          .mul(oneVToken)
          .div(totalVCollateral)
          .mul(joseCollateral)
          .div(oneVToken)
          .sub(joseRewards)
      );
      expect(totalVCollateral2).to.be.closeTo(
        totalVCollateral.sub(
          convertBorrowToLiquidationCollateral(parseEther('47000'))
        ),
        oneVToken
      );
      expect(totalLoan2.base).to.be.equal(
        aliceLoan2.add(joseLoan2).add(bobLoan2)
      );
      expect(totalLoan2.elastic).to.be.closeTo(
        parseEther('29000'),
        parseEther('2') // 2 DNR to account for fees
      );
      // Fees earned have to be greater than prev fees plus loan accrued fees.
      expect(
        loan2.feesEarned.gt(
          loan.feesEarned.add(
            ethers.BigNumber.from(12e8)
              .mul(parseEther('29000'))
              .mul(BigNumber.from(10_000))
              .div(parseEther('1'))
          )
        )
      );
    });
  });
  describe('function: upgrade functionality', () => {
    it('reverts if a non-owner tries to update it', async () => {
      await market.connect(owner).renounceOwnership();

      await expect(
        upgrade(market, 'TestInterestERC20BearingMarketV2')
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('upgrades to version 2', async () => {
      await market.connect(alice).addCollateral(parseEther('10'));

      const marketV2: TestInterestERC20BearingMarketV2 = await upgrade(
        market,
        'TestInterestERC20BearingMarketV2'
      );

      await marketV2
        .connect(alice)
        .withdrawCollateral(
          parseEther('5').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
          false
        );

      const [version, aliceCollateral, aliceVBTCBalance] = await Promise.all([
        marketV2.version(),
        marketV2.userCollateral(alice.address),
        vBTC.balanceOf(alice.address),
      ]);

      expect(version).to.be.equal('V2');
      expect(aliceCollateral).to.be.closeTo(
        parseEther('5').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
        ethers.BigNumber.from(10).pow(3)
      );
      expect(aliceVBTCBalance).to.be.closeTo(
        parseEther('5').mul(parseEther('1')).div(VTOKEN_BTC_EXCHANGE_RATE),
        ethers.BigNumber.from(10).pow(3)
      );
    });
  });
}).timeout(4000);
