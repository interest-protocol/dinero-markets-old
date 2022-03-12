import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers, network } from 'hardhat';

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
import {
  advanceBlock,
  advanceBlockAndTime,
  advanceTime,
  deployUUPS,
  multiDeploy,
} from './lib/test-utils';

const BNB_USD_PRICE = ethers.BigNumber.from('50000000000'); // 500 USD

const BTC_USD_PRICE = ethers.BigNumber.from('4000000000000'); // 40_000 USD

const oneVToken = ethers.BigNumber.from(10).pow(8);

const VTOKEN_BTC_EXCHANGE_RATE = ethers.BigNumber.from(
  '202080916975526043899048590'
);

const VTOKEN_BNB_EXCHANGE_RATE = ethers.BigNumber.from(
  '216637139839702805713033895'
);

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
      BTC.mint(alice.address, parseEther('1000')),
      BTC.mint(bob.address, parseEther('1000')),
      vBTC.__setUnderlying(BTC.address),
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
        VTOKEN_BTC_EXCHANGE_RATE // Taken from vBTC in BSC on 11/03/2022
      ),
      vBNB.__setExchangeRateCurrent(
        VTOKEN_BNB_EXCHANGE_RATE // Taken from vBTC in BSC on 11/03/2022
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
      vBTC.__setCollateralFactor(parseEther('1')),
      vBNB.__setCollateralFactor(parseEther('1')),
    ]);
  });

  const deployERC20Market = async (): Promise<InterestBearingMarket> => {
    const market: InterestBearingMarket = await deployUUPS(
      'InterestBearingMarket',
      [
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
        ethers.BigNumber.from('100000000000000000'),
      ]
    );

    await Promise.all([
      BTC.connect(alice).approve(market.address, ethers.constants.MaxUint256),
      BTC.connect(bob).approve(market.address, ethers.constants.MaxUint256),
      dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
    ]);

    return market;
  };

  describe('function: initialize', () => {
    it('reverts if you call after deployment', async () => {
      await expect(
        interestBearingMarket
          .connect(alice)
          .initialize(
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
            ethers.BigNumber.from('100000000000000000')
          )
      ).to.revertedWith('Initializable: contract is already initialized');
    });
    it('reverts if you set a max tvl ratio out of bounds', async () => {
      await expect(
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
          ethers.BigNumber.from('900000000000000001'),
          ethers.BigNumber.from('100000000000000000'),
        ])
      ).to.revertedWith('MKT: ltc ratio out of bounds');
      await expect(
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
          ethers.BigNumber.from('490000000000000000'),
          ethers.BigNumber.from('100000000000000000'),
        ])
      ).to.revertedWith('MKT: ltc ratio out of bounds');
    });
    it('sets the initial state and approvals correctly', async () => {
      const market: InterestBearingMarket = await deployUUPS(
        'InterestBearingMarket',
        [
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
          ethers.BigNumber.from('100000000000000000'),
        ]
      );

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

  describe('function: approve', () => {
    it('reverts if you call on a BNB market', async () => {
      await expect(interestBearingMarket.approve()).to.revertedWith(
        'IM: not allowed'
      );
    });
    it('maximizes the allowance for the router and vToken', async () => {
      const market: InterestBearingMarket = await deployUUPS(
        'InterestBearingMarket',
        [
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
          ethers.BigNumber.from('100000000000000000'),
        ]
      );

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
    });
  });

  it('sends the fees earned to the feeTo address', async () => {
    await interestBearingMarket
      .connect(alice)
      .addCollateral(0, { value: parseEther('10') });

    await interestBearingMarket
      .connect(alice)
      .borrow(alice.address, parseEther('700'));

    // Pass time to accrue fees
    await advanceTime(10_000, ethers); // advance 10_000 seconds

    const debt = parseEther('700')
      .mul(ethers.BigNumber.from(12e8))
      .mul(10_000)
      .div(parseEther('1'));

    expect(await dinero.balanceOf(treasury.address)).to.be.equal(0);

    // Accrue has not been called
    expect((await interestBearingMarket.totalLoan()).elastic).to.be.equal(
      parseEther('700')
    );

    await expect(interestBearingMarket.getEarnings())
      .to.emit(interestBearingMarket, 'Accrue')
      .to.emit(interestBearingMarket, 'GetEarnings');

    expect((await interestBearingMarket.loan()).feesEarned).to.be.equal(0);
    expect((await dinero.balanceOf(treasury.address)).gte(debt)).to.be.equal(
      true
    );
    expect(
      (await interestBearingMarket.totalLoan()).elastic.gte(
        parseEther('700').add(debt)
      )
    );
  });
  describe('function: accrue', () => {
    it('does not accrue fees if there is no open loans', async () => {
      const loan = await interestBearingMarket.loan();
      expect((await interestBearingMarket.totalLoan()).base).to.be.equal(0);
      await expect(interestBearingMarket.accrue()).to.not.emit(
        interestBearingMarket,
        'Accrue'
      );
      const loan2 = await interestBearingMarket.loan();
      // It only updated the timestamp
      expect(loan.lastAccrued.lt(loan2.lastAccrued)).to.be.equal(true);
      expect(loan2.feesEarned).to.be.equal(0);
      expect((await interestBearingMarket.totalLoan()).base).to.be.equal(0);
    });
    it('does not update if no time has passed', async () => {
      await network.provider.send('evm_setAutomine', [false]);

      // Add 10 BNB as collateral
      await interestBearingMarket
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('10') });

      await advanceBlock(ethers);

      // Borrow 2000
      await interestBearingMarket
        .connect(alice)
        .borrow(alice.address, parseEther('2000'));

      await advanceBlock(ethers);

      await advanceBlockAndTime(50_000, ethers);

      const receipt = await interestBearingMarket.accrue();
      const receipt2 = await interestBearingMarket.accrue();

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
    it('accrues the interest rate', async () => {
      // Add 10 BNB as collateral
      await interestBearingMarket
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('10') });

      await interestBearingMarket
        .connect(alice)
        .borrow(alice.address, parseEther('1500'));
      const [loan, totalLoan] = await Promise.all([
        interestBearingMarket.loan(),
        interestBearingMarket.totalLoan(),
      ]);

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // advance 10_000 seconds
      const debt = parseEther('1500')
        .mul(ethers.BigNumber.from(12e8))
        .mul(10_000)
        .div(parseEther('1'));

      expect(interestBearingMarket.accrue()).to.emit(
        interestBearingMarket,
        'Accrue'
      );

      const [loan2, totalLoan2] = await Promise.all([
        interestBearingMarket.loan(),
        interestBearingMarket.totalLoan(),
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
      await mockBnbUsdDFeed.setAnswer(0);

      await expect(interestBearingMarket.updateExchangeRate()).to.revertedWith(
        'MKT: invalid exchange rate'
      );
    });
    it('updates the exchange rate for vBNB', async () => {
      const [exchangeRate] = await Promise.all([
        interestBearingMarket.exchangeRate(),
        mockBnbUsdDFeed.setAnswer(ethers.BigNumber.from('60000000000')),
      ]);

      expect(exchangeRate).to.be.equal(
        BNB_USD_PRICE.mul(1e10)
          .mul(VTOKEN_BNB_EXCHANGE_RATE)
          .div(parseEther('1'))
      );

      await expect(interestBearingMarket.updateExchangeRate())
        .to.emit(interestBearingMarket, 'ExchangeRate')
        .withArgs(
          ethers.BigNumber.from('60000000000')
            .mul(1e10)
            .mul(VTOKEN_BNB_EXCHANGE_RATE)
            .div(parseEther('1'))
        );

      await expect(interestBearingMarket.updateExchangeRate()).to.not.emit(
        interestBearingMarket,
        'ExchangeRate'
      );
    });
    it('updates the exchange rate for vERC20Token', async () => {
      const market = await deployERC20Market();

      await market.updateExchangeRate();

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
    it('reverts if it fails to mint vBNB or vBTC', async () => {
      const [market] = await Promise.all([
        deployERC20Market(),
        vBNB.__setMintReturn(1),
        vBTC.__setMintReturn(1),
      ]);

      await Promise.all([
        expect(
          market.connect(alice).addCollateral(parseEther('1'))
        ).to.revertedWith('DV: failed to mint'),
        expect(
          interestBearingMarket
            .connect(alice)
            .addCollateral(0, { value: parseEther('2') })
        ).to.revertedWith('DV: failed to mint'),
      ]);
    });
    it('accepts BNB deposits', async () => {
      const [
        aliceCollateral,
        totalRewardsPerVToken,
        totalVCollateral,
        aliceRewards,
      ] = await Promise.all([
        interestBearingMarket.userCollateral(alice.address),
        interestBearingMarket.totalRewardsPerVToken(),
        interestBearingMarket.totalVCollateral(),
        interestBearingMarket.rewardsOf(alice.address),
      ]);

      expect(aliceCollateral).to.be.equal(0);
      expect(totalRewardsPerVToken).to.be.equal(0);
      expect(totalVCollateral).to.be.equal(0);
      expect(aliceRewards).to.be.equal(0);

      await expect(
        interestBearingMarket
          .connect(alice)
          .addCollateral(0, { value: parseEther('10') })
      )
        .to.emit(interestBearingMarket, 'AddCollateral')
        .withArgs(
          alice.address,
          parseEther('10').mul(VTOKEN_BNB_EXCHANGE_RATE).div(parseEther('1')),
          parseEther('10').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
        )
        .to.not.emit(venusController, 'Claim')
        .to.not.emit(XVS, 'Transfer');

      await expect(
        interestBearingMarket
          .connect(bob)
          .addCollateral(0, { value: parseEther('5') })
      )
        .to.emit(interestBearingMarket, 'AddCollateral')
        .withArgs(
          alice.address,
          parseEther('5').mul(VTOKEN_BNB_EXCHANGE_RATE).div(parseEther('1')),
          parseEther('5').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
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
        interestBearingMarket.userCollateral(alice.address),
        interestBearingMarket.totalRewardsPerVToken(),
        interestBearingMarket.totalVCollateral(),
        interestBearingMarket.rewardsOf(alice.address),
        interestBearingMarket.rewardsOf(bob.address),
        interestBearingMarket.userCollateral(bob.address),
        venusController.__setClaimVenusValue(parseEther('100')),
      ]);

      expect(aliceCollateral2).to.be.equal(
        parseEther('10').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
      );
      expect(bobCollateral2).to.be.equal(
        parseEther('5').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
      );
      expect(totalRewardsPerVToken2).to.be.equal(0);
      expect(totalVCollateral2).to.be.closeTo(
        parseEther('15').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
        1
      );
      expect(aliceRewards2).to.be.equal(0);
      expect(bobRewards2).to.be.equal(0);

      await expect(
        interestBearingMarket
          .connect(alice)
          .addCollateral(0, { value: parseEther('5') })
      )
        .to.emit(interestBearingMarket, 'AddCollateral')
        .withArgs(
          alice.address,
          parseEther('5').mul(VTOKEN_BNB_EXCHANGE_RATE).div(parseEther('1')),
          parseEther('5').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
        )
        .to.emit(venusController, 'Claim')
        .to.emit(XVS, 'Transfer')
        .withArgs(
          interestBearingMarket.address,
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
        interestBearingMarket.userCollateral(alice.address),
        interestBearingMarket.totalRewardsPerVToken(),
        interestBearingMarket.totalVCollateral(),
        interestBearingMarket.rewardsOf(alice.address),
        interestBearingMarket.rewardsOf(bob.address),
        interestBearingMarket.userCollateral(bob.address),
        venusController.__setClaimVenusValue(parseEther('50')),
      ]);

      expect(aliceCollateral3).to.be.closeTo(
        parseEther('15').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
        1
      );
      expect(bobCollateral3).to.be.equal(
        parseEther('5').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
      );
      expect(totalRewardsPerVToken3).to.be.equal(
        parseEther('100').mul(oneVToken).div(totalVCollateral2)
      );
      expect(totalVCollateral3).to.be.closeTo(
        parseEther('20').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
        1
      );
      expect(aliceRewards3).to.be.equal(
        aliceCollateral3.mul(totalRewardsPerVToken3).div(oneVToken)
      );
      expect(bobRewards3).to.be.equal(0);

      await expect(
        interestBearingMarket
          .connect(alice)
          .addCollateral(0, { value: parseEther('5') })
      )
        .to.emit(XVS, 'Transfer')
        .withArgs(
          interestBearingMarket.address,
          alice.address,
          totalRewardsPerVToken3
            .add(parseEther('50').mul(oneVToken).div(totalVCollateral3))
            .mul(aliceCollateral3)
            .div(oneVToken)
            .sub(aliceRewards3)
        );

      const [totalRewardsPerVToken4, aliceRewards4] = await Promise.all([
        interestBearingMarket.totalRewardsPerVToken(),
        interestBearingMarket.rewardsOf(alice.address),
      ]);

      expect(totalRewardsPerVToken4).to.be.equal(
        totalRewardsPerVToken3.add(
          parseEther('50').mul(oneVToken).div(totalVCollateral3)
        )
      );
      expect(aliceRewards4).to.be.closeTo(
        parseEther('20')
          .mul(parseEther('1'))
          .div(VTOKEN_BNB_EXCHANGE_RATE)
          .mul(totalRewardsPerVToken4)
          .div(oneVToken),
        parseEther('1')
      );
    });
    it('accepts BTC deposits', async () => {
      const market = await deployERC20Market();

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

  it('reverts if anyone but the vToken sends BNB to it', async () => {
    await expect(
      alice.sendTransaction({
        to: interestBearingMarket.address,
        value: parseEther('3'),
      })
    ).to.revertedWith('IM: not allowed');
  });

  describe('function: withdraw', () => {
    it('reverts if the user is insolvent', async () => {
      await interestBearingMarket
        .connect(alice)
        .addCollateral(0, { value: parseEther('10') });

      await interestBearingMarket
        .connect(alice)
        .borrow(jose.address, parseEther('2000'));

      await expect(
        interestBearingMarket
          .connect(alice)
          .withdrawCollateral(
            parseEther('2.1')
              .mul(parseEther('1'))
              .div(VTOKEN_BNB_EXCHANGE_RATE),
            false
          )
      ).to.revertedWith('MKT: sender is insolvent');

      const market = await deployERC20Market();

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
    it('reverts if the vBNB and vBTC fail to redeem', async () => {
      const [market] = await Promise.all([
        deployERC20Market(),
        vBNB.__setRedeemReturn(1),
        vBTC.__setRedeemReturn(1),
      ]);

      await Promise.all([
        market.connect(alice).addCollateral(parseEther('2')),
        interestBearingMarket
          .connect(alice)
          .addCollateral(0, { value: parseEther('2') }),
      ]);

      await Promise.all([
        expect(
          market
            .connect(alice)
            .withdrawCollateral(
              parseEther('1')
                .mul(parseEther('1'))
                .div(VTOKEN_BTC_EXCHANGE_RATE),
              true
            )
        ).to.revertedWith('DV: failed to redeem'),
        expect(
          interestBearingMarket
            .connect(alice)
            .withdrawCollateral(
              parseEther('1')
                .mul(parseEther('1'))
                .div(VTOKEN_BNB_EXCHANGE_RATE),
              true
            )
        ).to.revertedWith('DV: failed to redeem'),
      ]);
    });
    it('allows collateral to be withdrawn in vBNB', async () => {
      await interestBearingMarket
        .connect(alice)
        .addCollateral(0, { value: parseEther('10') });

      await interestBearingMarket
        .connect(alice)
        .borrow(alice.address, parseEther('100'));

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      await expect(
        interestBearingMarket
          .connect(alice)
          .withdrawCollateral(
            parseEther('2').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
            false
          )
      )
        .to.emit(interestBearingMarket, 'Accrue')
        .to.emit(vBNB, 'Transfer')
        .withArgs(
          interestBearingMarket.address,
          alice.address,
          0,
          parseEther('2').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
        )
        .to.not.emit(venusController, 'Claim')
        .to.not.emit(XVS, 'Transfer')
        .to.not.emit(vBNB, 'Redeem');

      const [
        aliceCollateral,
        totalRewardsPerVToken,
        totalVCollateral,
        aliceRewards,
      ] = await Promise.all([
        interestBearingMarket.userCollateral(alice.address),
        interestBearingMarket.totalRewardsPerVToken(),
        interestBearingMarket.totalVCollateral(),
        interestBearingMarket.rewardsOf(alice.address),
      ]);

      expect(aliceCollateral).to.be.closeTo(
        parseEther('8').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
        1
      );
      expect(totalRewardsPerVToken).to.be.equal(0);
      expect(totalVCollateral).to.be.closeTo(
        parseEther('8').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
        1
      );
      expect(aliceRewards).to.be.equal(0);

      await Promise.all([
        interestBearingMarket
          .connect(bob)
          .addCollateral(0, { value: parseEther('5') }),
        venusController.__setClaimVenusValue(parseEther('100')),
      ]);

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      await expect(
        interestBearingMarket
          .connect(alice)
          .withdrawCollateral(
            parseEther('1').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
            false
          )
      )
        .to.emit(interestBearingMarket, 'Accrue')
        .to.emit(vBNB, 'Transfer')
        .withArgs(
          interestBearingMarket.address,
          alice.address,
          0,
          parseEther('1').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
        )
        .to.emit(venusController, 'Claim')
        .to.emit(XVS, 'Transfer')
        .withArgs(
          interestBearingMarket.address,
          alice.address,
          parseEther('100')
            .mul(oneVToken)
            .div(
              parseEther('13')
                .mul(parseEther('1'))
                .div(VTOKEN_BNB_EXCHANGE_RATE)
            )
            .mul(aliceCollateral)
            .div(oneVToken)
        )
        .to.not.emit(vBNB, 'Redeem');

      const [
        aliceCollateral2,
        totalRewardsPerVToken2,
        totalVCollateral2,
        aliceRewards2,
      ] = await Promise.all([
        interestBearingMarket.userCollateral(alice.address),
        interestBearingMarket.totalRewardsPerVToken(),
        interestBearingMarket.totalVCollateral(),
        interestBearingMarket.rewardsOf(alice.address),
      ]);

      expect(aliceCollateral2).to.be.closeTo(
        parseEther('7').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
        10
      );
      expect(totalRewardsPerVToken2).to.be.equal(
        parseEther('100')
          .mul(oneVToken)
          .div(
            parseEther('13').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
          )
      );
      expect(totalVCollateral2).to.be.closeTo(
        parseEther('12').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
        10
      );
      expect(aliceRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(aliceCollateral2).div(oneVToken)
      );
    });
    it('allows collateral to be withdrawn in vBTC', async () => {
      const market = await deployERC20Market();

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
          interestBearingMarket.address,
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
    it('allows BNB to be withdrawn', async () => {
      await interestBearingMarket
        .connect(alice)
        .addCollateral(0, { value: parseEther('10') });

      await interestBearingMarket
        .connect(alice)
        .borrow(alice.address, parseEther('100'));

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      const aliceBalance = await alice.getBalance();

      await expect(
        interestBearingMarket
          .connect(alice)
          .withdrawCollateral(
            parseEther('2').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
            true
          )
      )
        .to.emit(interestBearingMarket, 'Accrue')
        .to.emit(vBNB, 'Redeem')
        .withArgs(parseEther('2'))
        .to.emit(interestBearingMarket, 'WithdrawCollateral')
        .withArgs(
          alice.address,
          parseEther('2'),
          parseEther('2').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
        )
        .to.not.emit(XVS, 'Transfer')
        .to.not.emit(venusController, 'Claim');

      const [
        aliceCollateral,
        totalRewardsPerVToken,
        totalVCollateral,
        aliceRewards,
        aliceBalance2,
        aliceVBNBBalance,
      ] = await Promise.all([
        interestBearingMarket.userCollateral(alice.address),
        interestBearingMarket.totalRewardsPerVToken(),
        interestBearingMarket.totalVCollateral(),
        interestBearingMarket.rewardsOf(alice.address),
        alice.getBalance(),
        vBNB.balanceOf(alice.address),
      ]);

      expect(aliceCollateral).to.be.closeTo(
        parseEther('8').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
        5
      );
      expect(totalRewardsPerVToken).to.be.equal(0);
      expect(totalVCollateral).to.be.equal(aliceCollateral);
      expect(aliceRewards).to.be.equal(0);
      expect(aliceBalance2).to.be.closeTo(
        aliceBalance.add(parseEther('2')),
        parseEther('0.1') // TX fees
      );
      expect(aliceVBNBBalance).to.be.equal(0);

      await Promise.all([
        interestBearingMarket
          .connect(bob)
          .addCollateral(0, { value: parseEther('5') }),
        venusController.__setClaimVenusValue(parseEther('100')),
      ]);

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      await expect(
        interestBearingMarket
          .connect(alice)
          .withdrawCollateral(
            parseEther('3').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
            true
          )
      )
        .to.emit(interestBearingMarket, 'Accrue')
        .to.emit(venusController, 'Claim')
        .to.emit(vBNB, 'Redeem')
        .withArgs(parseEther('3'))
        .to.emit(interestBearingMarket, 'WithdrawCollateral')
        .withArgs(
          alice.address,
          parseEther('3'),
          parseEther('3').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
        )
        .to.emit(XVS, 'Transfer')
        .withArgs(
          interestBearingMarket.address,
          alice.address,
          parseEther('100')
            .mul(oneVToken)
            .div(
              parseEther('13')
                .mul(parseEther('1'))
                .div(VTOKEN_BNB_EXCHANGE_RATE)
            )
            .mul(aliceCollateral)
            .div(oneVToken)
        );

      const [
        aliceCollateral2,
        totalRewardsPerVToken2,
        totalVCollateral2,
        aliceRewards2,
        aliceBalance3,
        aliceVBNBBalance2,
      ] = await Promise.all([
        interestBearingMarket.userCollateral(alice.address),
        interestBearingMarket.totalRewardsPerVToken(),
        interestBearingMarket.totalVCollateral(),
        interestBearingMarket.rewardsOf(alice.address),
        alice.getBalance(),
        vBNB.balanceOf(alice.address),
      ]);

      expect(aliceCollateral2).to.be.closeTo(
        parseEther('5').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
        10
      );
      expect(totalRewardsPerVToken2).to.be.equal(
        parseEther('100')
          .mul(oneVToken)
          .div(
            parseEther('13').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
          )
      );
      expect(totalVCollateral2).to.be.closeTo(
        parseEther('10').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
        10
      );
      expect(aliceRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(aliceCollateral2).div(oneVToken)
      );
      expect(aliceBalance3).to.be.closeTo(
        aliceBalance2.add(parseEther('3')),
        parseEther('0.1') // TX tax
      );
      expect(aliceVBNBBalance2).to.be.equal(0);

      await expect(
        interestBearingMarket.connect(alice).withdrawCollateral(0, true)
      )
        .to.emit(XVS, 'Transfer')
        .withArgs(
          interestBearingMarket.address,
          alice.address,
          totalRewardsPerVToken2
            .add(parseEther('100').mul(oneVToken).div(totalVCollateral2))
            .mul(aliceCollateral2)
            .div(oneVToken)
            .sub(aliceRewards2)
        );
    });
    it.only('allows BTC to be withdrawn', async () => {
      const market = await deployERC20Market();

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
}).timeout(4000);
