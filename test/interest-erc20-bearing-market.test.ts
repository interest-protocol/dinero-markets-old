import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber, ContractTransaction } from 'ethers';
import { ethers, network } from 'hardhat';

import ERC20ABI from '../abi/erc20.json';
import PCSFactoryABI from '../abi/pcs-factory.json';
import PCSRouterABI from '../abi/pcs-router.json';
import vBTCABI from '../abi/vbtc.json';
import VenusControllerABI from '../abi/venus-controller.json';
import WBNBABI from '../abi/wbnb.json';
import {
  Dinero,
  ERC20,
  InterestERC20BearingMarket,
  LiquidityRouter,
  MockERC20,
  MockNoInfiniteAllowanceERC20,
  MockOracle,
  MockTWAP,
  MockVenusController,
  MockVenusToken,
  OracleV1,
  PancakeFactory,
  PancakeRouter,
  TestInterestERC20BearingMarketV2,
} from '../typechain';
import {
  BTC,
  BTC_USD_PRICE_FEED,
  BTC_WHALE_ONE,
  BTC_WHALE_THREE,
  BTC_WHALE_TWO,
  BURNER_ROLE,
  MINTER_ROLE,
  ONE_V_TOKEN,
  PCS_FACTORY,
  PCS_ROUTER,
  vBTC,
  VENUS_CONTROLLER,
  WBNB,
  WBNB_WHALE,
  XVS,
} from './lib/constants';
import {
  advanceBlock,
  advanceBlockAndTime,
  advanceTime,
  deploy,
  deployUUPS,
  impersonate,
  multiDeploy,
  toVBalance,
  upgrade,
} from './lib/test-utils';

const { parseEther } = ethers.utils;

const LIQUIDATION_FEE = ethers.BigNumber.from('100000000000000000');

const INTEREST_RATE = BigNumber.from(12e8);

// To be used only on liquidation tests if BTC is at 30_0000
const convertBorrowToLiquidationCollateral = (
  x: BigNumber,
  exchangeRate: BigNumber,
  time = 10_000
) =>
  x
    // Add interest paid
    .add(
      ethers.BigNumber.from(12e8)
        .mul(x)
        .mul(BigNumber.from(time))
        .div(parseEther('1'))
    )
    .add(x.mul(LIQUIDATION_FEE).div(parseEther('1')))
    // Convert Loan to BTC
    .mul(parseEther('1'))
    .div(parseEther('30000')) // Note BTC has dropped to 30_000 in  liquidations
    // convert BNB to VBTC
    .mul(parseEther('1'))
    .div(exchangeRate);

describe('Interest ERC20 Bearing Market', () => {
  let market: InterestERC20BearingMarket;
  let dinero: Dinero;
  let oracle: OracleV1;
  let mockOracle: MockOracle;

  const XVSContract = new ethers.Contract(XVS, ERC20ABI, ethers.provider);
  const VenusControllerContract = new ethers.Contract(
    VENUS_CONTROLLER,
    VenusControllerABI,
    ethers.provider
  );
  const vBTCContract = new ethers.Contract(vBTC, vBTCABI, ethers.provider);
  const BTCContract = new ethers.Contract(
    BTC,
    ERC20ABI,
    ethers.provider
  ) as ERC20;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let treasury: SignerWithAddress;
  let recipient: SignerWithAddress;

  before(async () => {
    [owner, treasury, recipient] = await ethers.getSigners();

    dinero = await deployUUPS('Dinero', []);

    await Promise.all([
      dinero.connect(owner).grantRole(MINTER_ROLE, owner.address),
      impersonate(BTC_WHALE_ONE),
      impersonate(WBNB_WHALE),
      impersonate(BTC_WHALE_TWO),
    ]);

    [alice, bob] = await Promise.all([
      ethers.getSigner(BTC_WHALE_ONE),
      ethers.getSigner(BTC_WHALE_TWO),
    ]);

    const wbnbWhaleSigner = await ethers.getSigner(WBNB_WHALE);
    const wbnb = new ethers.Contract(WBNB, WBNBABI, wbnbWhaleSigner);

    await Promise.all([
      dinero.connect(owner).mint(owner.address, parseEther('3000000')),
      dinero.connect(owner).mint(alice.address, parseEther('500000')),
      dinero.connect(owner).mint(WBNB_WHALE, parseEther('10000000')),
      dinero
        .connect(wbnbWhaleSigner)
        .approve(PCS_ROUTER, ethers.constants.MaxUint256),
      wbnb
        .connect(wbnbWhaleSigner)
        .approve(PCS_ROUTER, ethers.constants.MaxUint256),
      wbnb.deposit({ value: parseEther('22000') }),
      treasury.sendTransaction({
        to: alice.address,
        value: ethers.utils.parseEther('10'),
      }),
      treasury.sendTransaction({
        to: bob.address,
        value: ethers.utils.parseEther('10'),
      }),
    ]);

    const router = new ethers.Contract(
      PCS_ROUTER,
      PCSRouterABI,
      wbnbWhaleSigner
    );

    // BNB/DINERO Liquidity
    await router.addLiquidity(
      WBNB,
      dinero.address,
      parseEther('22200'),
      parseEther('10000000'),
      parseEther('22200'),
      parseEther('10000000'),
      owner.address,
      ethers.constants.MaxUint256
    );
  });

  beforeEach(async () => {
    const [mockTWAP, _mockOracle] = await multiDeploy(
      ['MockTWAP', 'MockOracle'],
      [[], []]
    );

    mockOracle = _mockOracle;

    oracle = await deployUUPS('OracleV1', [mockTWAP.address]);

    await oracle.connect(owner).setFeed(BTC, BTC_USD_PRICE_FEED, 0);

    market = await deployUUPS('InterestERC20BearingMarket', [
      dinero.address,
      treasury.address,
      oracle.address,
      BTC,
      vBTC,
      INTEREST_RATE,
      ethers.utils.parseEther('0.5'),
      LIQUIDATION_FEE,
    ]);

    await Promise.all([
      dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
      BTCContract.connect(alice).approve(
        market.address,
        ethers.constants.MaxUint256
      ),
      BTCContract.connect(bob).approve(
        market.address,
        ethers.constants.MaxUint256
      ),
      market.updateExchangeRate(),
    ]);
  });

  describe('function: initialize', () => {
    it('reverts if you call after deployment', async () => {
      await expect(
        market
          .connect(alice)
          .initialize(
            dinero.address,
            treasury.address,
            oracle.address,
            BTC,
            vBTC,
            INTEREST_RATE,
            ethers.utils.parseEther('0.5'),
            LIQUIDATION_FEE
          )
      ).to.revertedWith('Initializable: contract is already initialized');
    });
    it('reverts if you set a max tvl ratio out of bounds', async () => {
      await expect(
        deployUUPS('InterestERC20BearingMarket', [
          dinero.address,
          treasury.address,
          oracle.address,
          BTC,
          vBTC,
          INTEREST_RATE,
          ethers.utils.parseEther('0.91'),
          LIQUIDATION_FEE,
        ])
      ).to.revertedWith('MKT: ltc ratio out of bounds');
      await expect(
        deployUUPS('InterestERC20BearingMarket', [
          dinero.address,
          treasury.address,
          oracle.address,
          BTC,
          vBTC,
          INTEREST_RATE,
          ethers.utils.parseEther('0.49'),
          LIQUIDATION_FEE,
        ])
      ).to.revertedWith('MKT: ltc ratio out of bounds');
    });
    it('sets the initial state and approvals correctly', async () => {
      const [
        erc20RouterAllowance,
        vBTCAllowance,
        _dinero,
        _feeTo,
        _oracle,
        _collateral,
        _vToken,
        _loan,
        _maxLTVRatio,
        _liquidationFee,
        _owner,
      ] = await Promise.all([
        BTCContract.allowance(market.address, PCS_ROUTER),
        BTCContract.allowance(market.address, vBTCContract.address),
        market.DINERO(),
        market.FEE_TO(),
        market.ORACLE(),
        market.COLLATERAL(),
        market.VTOKEN(),
        market.loan(),
        market.maxLTVRatio(),
        market.liquidationFee(),
        market.owner(),
      ]);

      expect(erc20RouterAllowance).to.be.equal(ethers.constants.MaxUint256);
      expect(vBTCAllowance).to.be.equal(ethers.constants.MaxUint256);
      expect(_dinero).to.be.equal(dinero.address);
      expect(_feeTo).to.be.equal(treasury.address);
      expect(_oracle).to.be.equal(oracle.address);
      expect(_collateral).to.be.equal(BTC);
      expect(_vToken).to.be.equal(vBTC);
      expect(_loan.INTEREST_RATE).to.be.equal(INTEREST_RATE);
      expect(_maxLTVRatio).to.be.equal(
        ethers.BigNumber.from('500000000000000000')
      );
      expect(_liquidationFee).to.be.equal(LIQUIDATION_FEE);
      expect(_owner).to.be.equal(owner.address);
    });
  });

  it('maximizes the allowance for the router and vToken', async () => {
    const market = (await deployUUPS('InterestERC20BearingMarket', [
      dinero.address,
      treasury.address,
      mockOracle.address,
      BTC,
      vBTC,
      INTEREST_RATE,
      ethers.utils.parseEther('0.5'),
      LIQUIDATION_FEE,
    ])) as InterestERC20BearingMarket;

    await Promise.all([
      dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
      BTCContract.connect(alice).approve(
        market.address,
        ethers.constants.MaxUint256
      ),
      mockOracle.__setERC20Price(BTC, parseEther('42000')),
    ]);

    await market.updateExchangeRate();

    await market
      .connect(alice)
      .addCollateralAndBorrow(
        parseEther('10'),
        alice.address,
        parseEther('200000')
      );

    await mockOracle.__setERC20Price(BTC, parseEther('30000'));
    await market.updateExchangeRate();

    await market
      .connect(owner)
      .liquidate([alice.address], [parseEther('200000')], owner.address, true, [
        BTC,
        WBNB,
        dinero.address,
      ]);

    const [routerAllowance, vBTCAllowance] = await Promise.all([
      BTCContract.allowance(market.address, PCS_ROUTER),
      BTCContract.allowance(market.address, vBTC),
    ]);

    expect(routerAllowance).not.to.be.equal(ethers.constants.MaxUint256);
    expect(vBTCAllowance).not.to.be.equal(ethers.constants.MaxUint256);

    await market.approve();

    const [routerAllowance2, vBTCAllowance2] = await Promise.all([
      BTCContract.allowance(market.address, PCS_ROUTER),
      BTCContract.allowance(market.address, vBTC),
    ]);

    expect(routerAllowance2).to.be.equal(ethers.constants.MaxUint256);
    expect(vBTCAllowance2).to.be.equal(ethers.constants.MaxUint256);
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
      const market = (await deployUUPS('InterestERC20BearingMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        BTC,
        vBTC,
        INTEREST_RATE,
        ethers.utils.parseEther('0.5'),
        LIQUIDATION_FEE,
      ])) as InterestERC20BearingMarket;

      await mockOracle.__setERC20Price(BTC, 0);

      await expect(market.updateExchangeRate()).to.revertedWith(
        'DM: invalid exchange rate'
      );
    });
    it('updates the exchange rate for vBNB', async () => {
      const market = (await deployUUPS('InterestERC20BearingMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        BTC,
        vBTC,
        INTEREST_RATE,
        ethers.utils.parseEther('0.5'),
        LIQUIDATION_FEE,
      ])) as InterestERC20BearingMarket;

      await mockOracle.__setERC20Price(BTC, parseEther('50000'));

      await market.updateExchangeRate();

      const [exchangeRate, vBTCExchangeRate] = await Promise.all([
        market.exchangeRate(),
        vBTCContract.callStatic.exchangeRateCurrent(),
      ]);

      await mockOracle.__setERC20Price(BTC, parseEther('60000'));

      expect(exchangeRate).to.be.closeTo(
        parseEther('50000')
          .mul(vBTCExchangeRate)
          .div(parseEther('1'))
          .div(1e10),
        parseEther('0.00001')
      );

      await expect(market.updateExchangeRate()).to.emit(market, 'ExchangeRate');

      await mockOracle.__setERC20Price(BTC, parseEther('70000'));

      await network.provider.send('evm_setAutomine', [false]);

      const tx1: ContractTransaction = await market.updateExchangeRate();
      const tx2: ContractTransaction = await market.updateExchangeRate();

      await advanceBlock(ethers);

      const receipt1 = await tx1.wait();
      const receipt2 = await tx2.wait();

      expect(
        receipt1.events?.filter((x) => x.event === 'ExchangeRate').length
      ).to.be.equal(1);

      expect(
        receipt2.events?.filter((x) => x.event === 'ExchangeRate').length
      ).to.be.equal(0);

      await network.provider.send('evm_setAutomine', [true]);
    });
  });

  describe('function: addCollateral', async () => {
    it('reverts if it fails to mint vBTC', async () => {
      const errorVBTC = await deploy('MockMintErrorVBTC', []);

      const vBTCCode = await network.provider.send('eth_getCode', [vBTC]);

      const errorVBTCCode = await network.provider.send('eth_getCode', [
        errorVBTC.address,
      ]);

      await network.provider.send('hardhat_setCode', [vBTC, errorVBTCCode]);

      await expect(
        market.connect(alice).addCollateral(parseEther('1'))
      ).to.revertedWith('DV: failed to mint');

      await network.provider.send('hardhat_setCode', [vBTC, vBTCCode]);
    });
    it('accepts BTC deposits', async () => {
      const [
        aliceCollateral,
        totalRewardsPerVToken,
        totalVCollateral,
        aliceRewards,
        exchangeRate,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        vBTCContract.callStatic.exchangeRateCurrent(),
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
          parseEther('2').mul(parseEther('1')).div(exchangeRate)
        )
        .to.not.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.not.emit(XVSContract, 'Transfer');

      await expect(market.connect(bob).addCollateral(parseEther('1')))
        .to.emit(market, 'AddCollateral')
        .withArgs(
          bob.address,
          parseEther('1'),
          parseEther('1').mul(parseEther('1')).div(exchangeRate)
        )
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(XVSContract, 'Transfer');

      const [
        aliceCollateral2,
        totalRewardsPerVToken2,
        totalVCollateral2,
        aliceRewards2,
        bobRewards2,
        bobCollateral2,
        exchangeRate2,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        market.rewardsOf(bob.address),
        market.userCollateral(bob.address),
        vBTCContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral2).to.be.closeTo(
        parseEther('2').mul(parseEther('1')).div(exchangeRate2),
        1e4
      );
      expect(bobCollateral2).to.be.closeTo(
        parseEther('1').mul(parseEther('1')).div(exchangeRate2),
        1e4
      );

      expect(totalVCollateral2).to.be.closeTo(
        parseEther('3').mul(parseEther('1')).div(exchangeRate2),
        1e4
      );
      expect(aliceRewards2).to.be.equal(0);
      expect(bobRewards2).to.be.equal(
        bobCollateral2.mul(totalRewardsPerVToken2).div(ONE_V_TOKEN)
      );

      await expect(market.connect(alice).addCollateral(parseEther('1')))
        .to.emit(market, 'AddCollateral')
        .withArgs(
          alice.address,
          parseEther('1'),
          parseEther('1').mul(parseEther('1')).div(exchangeRate2)
        )
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(XVSContract, 'Transfer');

      const [
        aliceCollateral3,
        totalRewardsPerVToken3,
        totalVCollateral3,
        aliceRewards3,
        bobRewards3,
        bobCollateral3,
        exchangeRate3,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        market.rewardsOf(bob.address),
        market.userCollateral(bob.address),
        vBTCContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral3).to.be.closeTo(
        parseEther('3').mul(parseEther('1')).div(exchangeRate3),
        1e4
      );
      expect(bobCollateral3).to.be.closeTo(
        parseEther('1').mul(parseEther('1')).div(exchangeRate3),
        1e4
      );

      expect(totalVCollateral3).to.be.closeTo(
        parseEther('4').mul(parseEther('1')).div(exchangeRate3),
        1e4
      );
      expect(aliceRewards3).to.be.equal(
        aliceCollateral3.mul(totalRewardsPerVToken3).div(ONE_V_TOKEN)
      );
      expect(bobRewards3).to.be.equal(bobRewards2);
    });
  });

  describe('function: withdrawCollateral', () => {
    it('reverts if the user is insolvent', async () => {
      await market.connect(alice).addCollateral(parseEther('1'));

      await market.connect(alice).borrow(alice.address, parseEther('23000'));

      const exchangeRate = await vBTCContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(
            parseEther('0.1').mul(parseEther('1')).div(exchangeRate),
            false
          )
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('reverts if vBTC fails to redeem', async () => {
      const [errorBTC, mockVenus] = await multiDeploy(
        ['MockRedeemUnderlyingErrorVBTC', 'MockVenusControllerClaimVenus'],
        []
      );

      const [vBTCCode, controllerCode, errorVBTCCode, mockVenusCode] =
        await Promise.all([
          network.provider.send('eth_getCode', [vBTC]),
          network.provider.send('eth_getCode', [VENUS_CONTROLLER]),
          network.provider.send('eth_getCode', [errorBTC.address]),
          network.provider.send('eth_getCode', [mockVenus.address]),
        ]);

      await market.connect(alice).addCollateral(parseEther('2'));

      await Promise.all([
        network.provider.send('hardhat_setCode', [vBTC, errorVBTCCode]),
        network.provider.send('hardhat_setCode', [
          VENUS_CONTROLLER,
          mockVenusCode,
        ]),
      ]);

      await expect(
        market.connect(alice).withdrawCollateral(ONE_V_TOKEN, true)
      ).to.revertedWith('DV: failed to redeem');

      await Promise.all([
        network.provider.send('hardhat_setCode', [vBTC, vBTCCode]),
        network.provider.send('hardhat_setCode', [
          VENUS_CONTROLLER,
          controllerCode,
        ]),
      ]);
    });
    it('allows collateral to be withdrawn in vBTC', async () => {
      await market.connect(alice).addCollateral(parseEther('5'));

      await market.connect(alice).borrow(alice.address, parseEther('100'));

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      const exchangeRate = await vBTCContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(
            parseEther('2').mul(parseEther('1')).div(exchangeRate),
            false
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(vBTCContract, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          0,
          parseEther('2').mul(parseEther('1')).div(exchangeRate)
        )
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(XVSContract, 'Transfer')
        .to.not.emit(vBTCContract, 'Redeem');

      const [
        aliceCollateral,
        totalRewardsPerVToken,
        totalVCollateral,
        aliceRewards,
        exchangeRate2,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        vBTCContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral).to.be.closeTo(
        parseEther('3').mul(parseEther('1')).div(exchangeRate2),
        1e4
      );
      expect(totalVCollateral).to.be.closeTo(
        parseEther('3').mul(parseEther('1')).div(exchangeRate2),
        1e4
      );
      expect(aliceRewards).to.be.equal(
        totalRewardsPerVToken.mul(aliceCollateral).div(ONE_V_TOKEN)
      );

      await market.connect(bob).addCollateral(parseEther('10'));

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      const exchangeRate3 = await vBTCContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(
            parseEther('1').mul(parseEther('1')).div(exchangeRate3),
            false
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(vBTCContract, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          0,
          parseEther('1').mul(parseEther('1')).div(exchangeRate3)
        )
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(XVSContract, 'Transfer')
        .to.not.emit(vBTCContract, 'Redeem');

      const [
        aliceCollateral2,
        totalRewardsPerVToken2,
        totalVCollateral2,
        aliceRewards2,
        exchangeRate4,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        vBTCContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral2).to.be.closeTo(
        parseEther('2').mul(parseEther('1')).div(exchangeRate4),
        1e4
      );

      expect(totalVCollateral2).to.be.closeTo(
        parseEther('12').mul(parseEther('1')).div(exchangeRate4),
        1e4
      );
      expect(aliceRewards2).to.be.closeTo(
        totalRewardsPerVToken2.mul(aliceCollateral2).div(ONE_V_TOKEN),
        1e4
      );
    });
    it('allows BTC to be withdrawn', async () => {
      await market.connect(alice).addCollateral(parseEther('10'));

      await market.connect(alice).borrow(alice.address, parseEther('100'));

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      const exchangeRate = await vBTCContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(
            parseEther('2').mul(parseEther('1')).div(exchangeRate),
            true
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(vBTCContract, 'Redeem')
        .withArgs(parseEther('2'))
        .to.emit(market, 'WithdrawCollateral')
        .withArgs(
          alice.address,
          parseEther('2'),
          parseEther('2').mul(parseEther('1')).div(exchangeRate)
        )
        .to.emit(BTCContract, 'Transfer')
        .withArgs(market.address, alice.address, parseEther('2'))
        .to.emit(XVSContract, 'Transfer')
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus');

      const [
        aliceCollateral,
        totalRewardsPerVToken,
        totalVCollateral,
        aliceRewards,
        aliceVBTCBalance,
        exchangeRate2,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        vBTCContract.balanceOf(alice.address),
        vBTCContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral).to.be.closeTo(
        parseEther('8').mul(parseEther('1')).div(exchangeRate2),
        1e4
      );

      expect(totalVCollateral).to.be.equal(aliceCollateral);
      expect(aliceRewards).to.be.equal(
        totalRewardsPerVToken.mul(aliceCollateral).div(ONE_V_TOKEN)
      );

      await market.connect(bob).addCollateral(parseEther('5'));

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      const exchangeRate3 = await vBTCContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(
            parseEther('3').mul(parseEther('1')).div(exchangeRate3),
            true
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(vBTCContract, 'Redeem');

      const [
        aliceCollateral2,
        totalRewardsPerVToken2,
        totalVCollateral3,
        aliceRewards2,
        aliceVBTCBalance2,
        exchangeRate4,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        vBTCContract.balanceOf(alice.address),
        vBTCContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral2).to.be.closeTo(
        parseEther('5').mul(parseEther('1')).div(exchangeRate4),
        1e4
      );

      expect(totalVCollateral3).to.be.closeTo(
        parseEther('10').mul(parseEther('1')).div(exchangeRate4),
        1e4
      );
      expect(aliceRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(aliceCollateral2).div(ONE_V_TOKEN)
      );
      expect(aliceVBTCBalance2).to.be.equal(aliceVBTCBalance);
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
        market.connect(alice).borrow(bob.address, parseEther('47000'))
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('allows a user to borrow as long as he remains solvent', async () => {
      await market.connect(alice).addCollateral(parseEther('1'));

      const [totalLoan, aliceLoan, aliceDineroBalance, bobDineroBalance] =
        await Promise.all([
          market.totalLoan(),
          market.userLoan(alice.address),
          dinero.balanceOf(alice.address),
          dinero.balanceOf(bob.address),
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

      const [totalLoan2, aliceLoan2, aliceDineroBalance2, bobDineroBalance2] =
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
      expect(bobDineroBalance2).to.be.equal(
        parseEther('10000').add(bobDineroBalance)
      );

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
        bobDineroBalance3,
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
      expect(bobDineroBalance3).to.be.equal(bobDineroBalance2);
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
          .liquidate([], [], recipient.address, true, [alice.address])
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

      const exchangeRate = await vBTCContract.callStatic.exchangeRateCurrent();

      const principalToLiquidate = parseEther('10')
        .mul(parseEther('1'))
        .div(exchangeRate);

      await expect(
        market
          .connect(owner)
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
          .connect(owner)
          .liquidate([], [], recipient.address, true, [XVS, dinero.address])
      ).to.revertedWith('DM: not allowed to sell XVS');
    });
    it('reverts if the principal to liquidate is very low', async () => {
      await impersonate(BTC_WHALE_THREE);

      const jose = await ethers.getSigner(BTC_WHALE_THREE);

      const market = (await deployUUPS('InterestERC20BearingMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        BTC,
        vBTC,
        INTEREST_RATE,
        ethers.utils.parseEther('0.5'),
        LIQUIDATION_FEE,
      ])) as InterestERC20BearingMarket;

      await mockOracle.__setERC20Price(BTC, parseEther('50000'));

      await Promise.all([
        market.updateExchangeRate(),
        BTCContract.connect(jose).approve(
          market.address,
          ethers.constants.MaxUint256
        ),
        BTCContract.connect(bob).approve(
          market.address,
          ethers.constants.MaxUint256
        ),
        BTCContract.connect(alice).approve(
          market.address,
          ethers.constants.MaxUint256
        ),
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
      ]);

      await Promise.all([
        market.connect(alice).addCollateral(parseEther('2')),
        market.connect(bob).addCollateral(parseEther('2')),
        market.connect(jose).addCollateral(parseEther('1')),
      ]);

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('45000')),
        market.connect(bob).borrow(bob.address, parseEther('25000')),
        market.connect(jose).borrow(jose.address, parseEther('24000')),
      ]);

      // Drop BNB to 300. Alice and Jose can now be liquidated
      await mockOracle.__setERC20Price(BTC, parseEther('30000'));

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // 10_000 seconds

      const exchangeRate = await vBTCContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(recipient)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [
              100,
              toVBalance(exchangeRate, parseEther('10')),
              toVBalance(exchangeRate, parseEther('7')),
            ],
            recipient.address,
            true,
            [WBNB, dinero.address]
          )
      ).to.revertedWith('DM: principal too low');
    });
    it('rounds the loan on case of full liquidation', async () => {
      await impersonate(BTC_WHALE_THREE);

      const jose = await ethers.getSigner(BTC_WHALE_THREE);

      const market = (await deployUUPS('InterestERC20BearingMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        BTC,
        vBTC,
        INTEREST_RATE,
        ethers.utils.parseEther('0.5'),
        LIQUIDATION_FEE,
      ])) as InterestERC20BearingMarket;

      await mockOracle.__setERC20Price(BTC, parseEther('50000'));

      await Promise.all([
        market.updateExchangeRate(),
        BTCContract.connect(jose).approve(
          market.address,
          ethers.constants.MaxUint256
        ),
        BTCContract.connect(bob).approve(
          market.address,
          ethers.constants.MaxUint256
        ),
        BTCContract.connect(alice).approve(
          market.address,
          ethers.constants.MaxUint256
        ),
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
      ]);

      await market.connect(alice).addCollateral(parseEther('2'));

      await market.connect(alice).borrow(alice.address, parseEther('35000'));

      // Drop BTC to 30_000. Alice and Jose can now be liquidated
      await mockOracle.__setERC20Price(BTC, parseEther('30000'));

      await market
        .connect(owner)
        .liquidate(
          [alice.address],
          [parseEther('35000')],
          recipient.address,
          false,
          []
        );

      const totalLoan = await market.totalLoan();

      expect(totalLoan.base).to.be.equal(0);
      expect(totalLoan.elastic).to.be.equal(0);
    });
    it('liquidates a user by selling redeeming the collateral and burning the acquired dinero', async () => {
      await impersonate(BTC_WHALE_THREE);

      const jose = await ethers.getSigner(BTC_WHALE_THREE);

      const market = (await deployUUPS('InterestERC20BearingMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        BTC,
        vBTC,
        INTEREST_RATE,
        ethers.utils.parseEther('0.5'),
        LIQUIDATION_FEE,
      ])) as InterestERC20BearingMarket;

      await mockOracle.__setERC20Price(BTC, parseEther('50000'));

      await Promise.all([
        market.updateExchangeRate(),
        BTCContract.connect(jose).approve(
          market.address,
          ethers.constants.MaxUint256
        ),
        BTCContract.connect(bob).approve(
          market.address,
          ethers.constants.MaxUint256
        ),
        BTCContract.connect(alice).approve(
          market.address,
          ethers.constants.MaxUint256
        ),
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
      ]);

      await Promise.all([
        market.connect(alice).addCollateral(parseEther('2')),
        market.connect(bob).addCollateral(parseEther('2')),
        market.connect(jose).addCollateral(parseEther('1')),
      ]);

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('35000')),
        market.connect(bob).borrow(bob.address, parseEther('25000')),
        market.connect(jose).borrow(jose.address, parseEther('16000')),
      ]);

      // Drop BTC to 30_000. Alice and Jose can now be liquidated
      await mockOracle.__setERC20Price(BTC, parseEther('30000'));

      const factoryContract = new ethers.Contract(
        PCS_FACTORY,
        PCSFactoryABI,
        ethers.provider
      );

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
        exchangeRate,
        totalRewardsPerVToken,
      ] = await Promise.all([
        factoryContract.getPair(dinero.address, WBNB),
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
        vBTCContract.balanceOf(recipient.address),
        XVSContract.balanceOf(alice.address),
        XVSContract.balanceOf(bob.address),
        XVSContract.balanceOf(jose.address),
        BTCContract.balanceOf(recipient.address),
        market.loan(),
        vBTCContract.callStatic.exchangeRateCurrent(),
        market.totalRewardsPerVToken(),
      ]);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      expect(aliceLoan).to.be.equal(parseEther('35000'));
      // Bob in shares will be less than borrowed amount due to already accrued fees
      expect(bobLoan).to.be.closeTo(parseEther('25000'), parseEther('10'));

      expect(joseLoan).to.be.closeTo(parseEther('16000'), parseEther('50'));

      expect(aliceCollateral).to.be.closeTo(
        toVBalance(parseEther('2'), exchangeRate),
        1e4
      );

      expect(bobCollateral).to.be.closeTo(
        toVBalance(parseEther('2'), exchangeRate),
        1e4
      );

      expect(joseCollateral).to.be.closeTo(
        toVBalance(parseEther('1'), exchangeRate),
        1e4
      );

      expect(totalVCollateral).to.be.equal(
        bobCollateral.add(joseCollateral).add(aliceCollateral)
      );

      expect(aliceRewards).to.be.equal(0);
      expect(joseRewards).to.be.equal(
        joseCollateral.mul(totalRewardsPerVToken).div(ONE_V_TOKEN)
      );

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
            [BTC, WBNB, dinero.address]
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(XVSContract, 'Transfer')
        .to.emit(vBTCContract, 'Redeem')
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
        exchangeRate2,
        totalRewardsPerVToken2,
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
        XVSContract.balanceOf(alice.address),
        XVSContract.balanceOf(bob.address),
        XVSContract.balanceOf(jose.address),
        market.totalLoan(),
        recipient.getBalance(),
        BTCContract.balanceOf(recipient.address),
        vBTCContract.balanceOf(recipient.address),
        vBTCContract.callStatic.exchangeRateCurrent(),
        market.totalRewardsPerVToken(),
      ]);

      // Recipient got paid for liquidating
      expect(recipientDineroBalance2.gt(recipientDineroBalance)).to.be.equal(
        true
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
          convertBorrowToLiquidationCollateral(
            parseEther('35000'),
            exchangeRate2
          )
        ),
        1e7
      );

      expect(joseCollateral2).to.be.closeTo(
        joseCollateral.sub(
          convertBorrowToLiquidationCollateral(
            parseEther('12000'),
            exchangeRate2
          )
        ),
        1e7
      );

      expect(bobRewards2).to.be.equal(bobRewards);
      expect(aliceRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(aliceCollateral2).div(ONE_V_TOKEN)
      );
      expect(joseRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(joseCollateral2).div(ONE_V_TOKEN)
      );
      expect(aliceXVSBalance2).to.be.closeTo(
        totalRewardsPerVToken2
          .mul(aliceCollateral2)
          .div(ONE_V_TOKEN)
          .add(aliceXVSBalance),
        parseEther('0.1')
      );
      expect(bobXVSBalance2).to.be.equal(bobXVSBalance);

      expect(joseXVSBalance2).to.be.closeTo(
        totalRewardsPerVToken2
          .mul(joseCollateral2)
          .div(ONE_V_TOKEN)
          .add(joseXVSBalance),
        parseEther('0.1')
      );
      expect(totalVCollateral2).to.be.closeTo(
        totalVCollateral.sub(
          convertBorrowToLiquidationCollateral(
            parseEther('47000'),
            exchangeRate2
          )
        ),
        ONE_V_TOKEN
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
      ).to.be.equal(true);
      expect(recipientBNBBalance).closeTo(
        recipientBNBBalance2,
        parseEther('0.1') // tx fees not from liquidating
      );
      expect(recipientVBTCBalance2).to.be.equal(recipientVVBTCBalance);
      expect(recipientBTCBalance2).to.be.equal(recipientBTCBalance);
    });
    it('liquidates a user by receiving the underlying and using the liquidator dinero to repay the debt', async () => {
      await impersonate(BTC_WHALE_THREE);

      const jose = await ethers.getSigner(BTC_WHALE_THREE);

      const market = (await deployUUPS('InterestERC20BearingMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        BTC,
        vBTC,
        INTEREST_RATE,
        ethers.utils.parseEther('0.5'),
        LIQUIDATION_FEE,
      ])) as InterestERC20BearingMarket;

      await mockOracle.__setERC20Price(BTC, parseEther('50000'));

      await Promise.all([
        market.updateExchangeRate(),
        BTCContract.connect(jose).approve(
          market.address,
          ethers.constants.MaxUint256
        ),
        BTCContract.connect(bob).approve(
          market.address,
          ethers.constants.MaxUint256
        ),
        BTCContract.connect(alice).approve(
          market.address,
          ethers.constants.MaxUint256
        ),
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
      ]);

      await Promise.all([
        market.connect(alice).addCollateral(parseEther('2')),
        market.connect(bob).addCollateral(parseEther('2')),
        market.connect(jose).addCollateral(parseEther('1')),
      ]);

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('35000')),
        market.connect(bob).borrow(bob.address, parseEther('25000')),
        market.connect(jose).borrow(jose.address, parseEther('16000')),
      ]);

      // Drop BTC to 30_000. Alice and Jose can now be liquidated

      await mockOracle.__setERC20Price(BTC, parseEther('30000'));

      const factoryContract = new ethers.Contract(
        PCS_FACTORY,
        PCSFactoryABI,
        ethers.provider
      );

      const [
        pair,
        aliceLoan,
        bobLoan,
        joseLoan,
        aliceCollateral,
        bobCollateral,
        joseCollateral,
        bobRewards,
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
        exchangeRate,
      ] = await Promise.all([
        factoryContract.getPair(dinero.address, WBNB),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.userCollateral(jose.address),
        market.rewardsOf(bob.address),
        market.totalVCollateral(),
        XVSContract.balanceOf(alice.address),
        XVSContract.balanceOf(bob.address),
        XVSContract.balanceOf(jose.address),
        market.loan(),
        owner.getBalance(),
        BTCContract.balanceOf(owner.address),
        vBTCContract.balanceOf(owner.address),
        dinero.balanceOf(owner.address),
        BTCContract.balanceOf(recipient.address),
        vBTCContract.balanceOf(recipient.address),
        dinero.balanceOf(recipient.address),
        recipient.getBalance(),
        vBTCContract.callStatic.exchangeRateCurrent(),
      ]);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      expect(aliceLoan).to.be.equal(parseEther('35000'));
      // Bob in shares will be less than borrowed amount due to already accrued fees
      expect(bobLoan).to.be.closeTo(parseEther('25000'), parseEther('10'));
      expect(joseLoan).to.be.closeTo(parseEther('16000'), parseEther('50'));

      expect(aliceCollateral).to.be.closeTo(
        toVBalance(parseEther('2'), exchangeRate),
        ONE_V_TOKEN
      );
      expect(bobCollateral).to.be.closeTo(
        toVBalance(parseEther('2'), exchangeRate),
        ONE_V_TOKEN
      );
      expect(joseCollateral).to.be.closeTo(
        toVBalance(parseEther('1'), exchangeRate),
        ONE_V_TOKEN
      );
      expect(totalVCollateral).to.be.equal(
        bobCollateral.add(joseCollateral).add(aliceCollateral)
      );

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
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(XVS, 'Transfer')
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
        totalRewardsPerVToken2,
        exchangeRate2,
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
        XVSContract.balanceOf(alice.address),
        XVSContract.balanceOf(bob.address),
        XVSContract.balanceOf(jose.address),
        market.totalLoan(),
        owner.getBalance(),
        BTCContract.balanceOf(owner.address),
        vBTCContract.balanceOf(owner.address),
        dinero.balanceOf(owner.address),
        BTCContract.balanceOf(recipient.address),
        vBTCContract.balanceOf(recipient.address),
        dinero.balanceOf(recipient.address),
        recipient.getBalance(),
        market.totalRewardsPerVToken(),
        vBTCContract.callStatic.exchangeRateCurrent(),
      ]);

      // Recipient got paid for liquidating
      expect(recipientDineroBalance2).to.be.equal(recipientDineroBalance);
      expect(recipientBNBBalance).to.be.equal(recipientBNBBalance2);
      expect(recipientVBTCBalance2).to.be.equal(recipientVBTCBalance);
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
          convertBorrowToLiquidationCollateral(
            parseEther('35000'),
            exchangeRate2
          )
        ),
        1e7
      );
      expect(joseCollateral2).to.be.closeTo(
        joseCollateral.sub(
          convertBorrowToLiquidationCollateral(
            parseEther('12000'),
            exchangeRate2
          )
        ),
        1e7
      );

      expect(bobRewards2).to.be.equal(bobRewards);
      expect(aliceRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(aliceCollateral2).div(ONE_V_TOKEN)
      );
      expect(joseRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(joseCollateral2).div(ONE_V_TOKEN)
      );
      expect(aliceXVSBalance2).to.be.closeTo(
        aliceRewards2.add(aliceXVSBalance),
        parseEther('0.01')
      );
      expect(bobXVSBalance2).to.be.equal(bobXVSBalance);
      expect(joseXVSBalance2).to.be.closeTo(
        joseRewards2.add(joseXVSBalance),
        parseEther('0.01')
      );
      expect(totalVCollateral2).to.be.closeTo(
        totalVCollateral.sub(
          convertBorrowToLiquidationCollateral(
            parseEther('47000'),
            exchangeRate2
          )
        ),
        ONE_V_TOKEN
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
      ).to.be.equal(true);
    });
    it('liquidates a user by receiving vBTC and using the liquidator dinero to repay the debt', async () => {
      await impersonate(BTC_WHALE_THREE);

      const jose = await ethers.getSigner(BTC_WHALE_THREE);

      const market = (await deployUUPS('InterestERC20BearingMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        BTC,
        vBTC,
        INTEREST_RATE,
        ethers.utils.parseEther('0.5'),
        LIQUIDATION_FEE,
      ])) as InterestERC20BearingMarket;

      await mockOracle.__setERC20Price(BTC, parseEther('50000'));

      await Promise.all([
        market.updateExchangeRate(),
        BTCContract.connect(jose).approve(
          market.address,
          ethers.constants.MaxUint256
        ),
        BTCContract.connect(bob).approve(
          market.address,
          ethers.constants.MaxUint256
        ),
        BTCContract.connect(alice).approve(
          market.address,
          ethers.constants.MaxUint256
        ),
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
      ]);

      await Promise.all([
        market.connect(alice).addCollateral(parseEther('2')),
        market.connect(bob).addCollateral(parseEther('2')),
        market.connect(jose).addCollateral(parseEther('1')),
      ]);

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('35000')),
        market.connect(bob).borrow(bob.address, parseEther('25000')),
        market.connect(jose).borrow(jose.address, parseEther('16000')),
      ]);

      // Drop BTC to 30_000. Alice and Jose can now be liquidated
      await mockOracle.__setERC20Price(BTC, parseEther('30000'));

      const factoryContract = new ethers.Contract(
        PCS_FACTORY,
        PCSFactoryABI,
        ethers.provider
      );

      const [
        pair,
        aliceLoan,
        bobLoan,
        joseLoan,
        aliceCollateral,
        bobCollateral,
        joseCollateral,
        bobRewards,
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
        exchangeRate,
      ] = await Promise.all([
        factoryContract.getPair(WBNB, dinero.address),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.userCollateral(jose.address),
        market.rewardsOf(bob.address),
        market.totalVCollateral(),
        XVSContract.balanceOf(alice.address),
        XVSContract.balanceOf(bob.address),
        XVSContract.balanceOf(jose.address),
        market.loan(),
        owner.getBalance(),
        BTCContract.balanceOf(owner.address),
        vBTCContract.balanceOf(owner.address),
        dinero.balanceOf(owner.address),
        BTCContract.balanceOf(recipient.address),
        vBTCContract.balanceOf(recipient.address),
        dinero.balanceOf(recipient.address),
        recipient.getBalance(),
        vBTCContract.callStatic.exchangeRateCurrent(),
      ]);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      expect(aliceLoan).to.be.equal(parseEther('35000'));
      // Bob in shares will be less than borrowed amount due to already accrued fees
      expect(bobLoan).to.be.closeTo(parseEther('25000'), parseEther('10'));
      expect(joseLoan).to.be.closeTo(parseEther('16000'), parseEther('50'));

      expect(aliceCollateral).to.be.closeTo(
        toVBalance(parseEther('2'), exchangeRate),
        1e4
      );
      expect(bobCollateral).to.be.closeTo(
        toVBalance(parseEther('2'), exchangeRate),
        1e4
      );
      expect(joseCollateral).to.be.closeTo(
        toVBalance(parseEther('1'), exchangeRate),
        1e4
      );
      expect(totalVCollateral).to.be.equal(
        bobCollateral.add(joseCollateral).add(aliceCollateral)
      );

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
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(XVSContract, 'Transfer')
        .to.not.emit(pairContract, 'Swap')
        .to.not.emit(vBTCContract, 'Redeem');

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
        exchangeRate2,
        totalRewardsPerVToken2,
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
        XVSContract.balanceOf(alice.address),
        XVSContract.balanceOf(bob.address),
        XVSContract.balanceOf(jose.address),
        market.totalLoan(),
        owner.getBalance(),
        BTCContract.balanceOf(owner.address),
        vBTCContract.balanceOf(owner.address),
        dinero.balanceOf(owner.address),
        BTCContract.balanceOf(recipient.address),
        vBTCContract.balanceOf(recipient.address),
        dinero.balanceOf(recipient.address),
        recipient.getBalance(),
        vBTCContract.callStatic.exchangeRateCurrent(),
        market.totalRewardsPerVToken(),
      ]);

      // Recipient got paid for liquidating
      expect(recipientDineroBalance2).to.be.equal(recipientDineroBalance);
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
            .div(exchangeRate2)
        ),
        1e4
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
          convertBorrowToLiquidationCollateral(
            parseEther('35000'),
            exchangeRate2
          )
        ),
        1e7
      );
      expect(joseCollateral2).to.be.closeTo(
        joseCollateral.sub(
          convertBorrowToLiquidationCollateral(
            parseEther('12000'),
            exchangeRate2
          )
        ),
        1e7
      );

      expect(bobRewards2).to.be.equal(bobRewards);
      expect(aliceRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(aliceCollateral2).div(ONE_V_TOKEN)
      );
      expect(joseRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(joseCollateral2).div(ONE_V_TOKEN)
      );
      expect(aliceXVSBalance2.gt(aliceXVSBalance)).to.be.equal(true);
      expect(bobXVSBalance2).to.be.equal(bobXVSBalance);
      expect(joseXVSBalance2.gt(joseXVSBalance)).to.be.equal(true);
      expect(totalVCollateral2).to.be.closeTo(
        totalVCollateral.sub(
          convertBorrowToLiquidationCollateral(
            parseEther('47000'),
            exchangeRate2
          )
        ),
        ONE_V_TOKEN
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
      ).to.be.equal(true);
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

      const [aliceVBTCBalance, exchangeRate] = await Promise.all([
        vBTCContract.balanceOf(alice.address),
        vBTCContract.callStatic.exchangeRateCurrent(),
      ]);

      await marketV2
        .connect(alice)
        .withdrawCollateral(
          parseEther('5').mul(parseEther('1')).div(exchangeRate),
          false
        );

      const [version, aliceCollateral, aliceVBTCBalance2, exchangeRate2] =
        await Promise.all([
          marketV2.version(),
          marketV2.userCollateral(alice.address),
          vBTCContract.balanceOf(alice.address),
          vBTCContract.callStatic.exchangeRateCurrent(),
        ]);

      expect(version).to.be.equal('V2');
      expect(aliceCollateral).to.be.closeTo(
        parseEther('5').mul(parseEther('1')).div(exchangeRate2),
        1e4
      );
      expect(aliceVBTCBalance2).to.be.closeTo(
        parseEther('5')
          .mul(parseEther('1'))
          .div(exchangeRate2)
          .add(aliceVBTCBalance),
        1e4
      );
    });
  });
  describe('function: addCollateralAndBorrow', () => {
    it('reverts if you pass invalid arguments', async () => {
      await expect(
        market.addCollateralAndBorrow(0, ethers.constants.AddressZero, 0)
      ).to.revertedWith('DM: no zero collateral amount');
      await expect(
        market.addCollateralAndBorrow(1, ethers.constants.AddressZero, 0)
      ).to.revertedWith('DM: no zero address');
      await expect(
        market.addCollateralAndBorrow(1, alice.address, 0)
      ).to.revertedWith('DM: no zero borrowAmount');
    });
    it('reverts if the borrower is insolvent', async () => {
      await expect(
        market
          .connect(alice)
          .addCollateralAndBorrow(
            parseEther('1'),
            alice.address,
            parseEther('24000.1')
          )
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('allows a caller to add collateral and borrow in one call', async () => {
      const [
        totalLoan,
        aliceLoan,
        aliceDineroBalance,
        bobDineroBalance,
        aliceCollateral,
        totalRewardsPerVToken,
        totalVCollateral,
        aliceRewards,
        exchangeRate,
      ] = await Promise.all([
        market.totalLoan(),
        market.userLoan(alice.address),
        dinero.balanceOf(alice.address),
        dinero.balanceOf(bob.address),
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        vBTCContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(totalLoan.base).to.be.equal(0);
      expect(totalLoan.elastic).to.be.equal(0);
      expect(aliceLoan).to.be.equal(0);
      expect(aliceCollateral).to.be.equal(0);
      expect(totalRewardsPerVToken).to.be.equal(0);
      expect(totalVCollateral).to.be.equal(0);
      expect(aliceRewards).to.be.equal(0);

      await expect(
        market
          .connect(alice)
          .addCollateralAndBorrow(
            parseEther('2'),
            bob.address,
            parseEther('10000')
          )
      )
        .to.emit(dinero, 'Transfer')
        .withArgs(
          ethers.constants.AddressZero,
          bob.address,
          parseEther('10000')
        )
        .to.emit(market, 'AddCollateral')
        .withArgs(
          alice.address,
          parseEther('2'),
          parseEther('2').mul(parseEther('1')).div(exchangeRate)
        )
        .to.emit(market, 'Borrow')
        .to.not.emit(market, 'Accrue')
        .to.not.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.not.emit(XVSContract, 'Transfer');

      await market.connect(bob).addCollateral(parseEther('1'));

      const [
        totalLoan2,
        aliceLoan2,
        aliceDineroBalance2,
        bobDineroBalance2,
        aliceCollateral2,
        totalRewardsPerVToken2,
        totalVCollateral2,
        aliceRewards2,
        bobRewards2,
        bobCollateral2,
        exchangeRate2,
      ] = await Promise.all([
        market.totalLoan(),
        market.userLoan(alice.address),
        dinero.balanceOf(alice.address),
        dinero.balanceOf(bob.address),
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        market.rewardsOf(bob.address),
        market.userCollateral(bob.address),
        vBTCContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(totalLoan2.base).to.be.equal(parseEther('10000'));
      expect(totalLoan2.elastic).to.be.equal(parseEther('10000'));
      expect(aliceLoan2).to.be.equal(parseEther('10000'));
      expect(aliceDineroBalance2).to.be.equal(aliceDineroBalance);
      expect(bobDineroBalance2).to.be.equal(
        parseEther('10000').add(bobDineroBalance)
      );
      expect(aliceCollateral2).to.be.closeTo(
        parseEther('2').mul(parseEther('1')).div(exchangeRate2),
        1e4
      );
      expect(bobCollateral2).to.be.closeTo(
        parseEther('1').mul(parseEther('1')).div(exchangeRate2),
        1e4
      );

      expect(totalVCollateral2).to.be.closeTo(
        parseEther('3').mul(parseEther('1')).div(exchangeRate2),
        1e4
      );
      expect(aliceRewards2).to.be.equal(0);
      expect(bobRewards2).to.be.equal(
        bobCollateral2.mul(totalRewardsPerVToken2).div(ONE_V_TOKEN)
      );

      await advanceTime(10_000, ethers); // advance 10_000 seconds

      await expect(
        market
          .connect(alice)
          .addCollateralAndBorrow(
            parseEther('1'),
            alice.address,
            parseEther('9000')
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(dinero, 'Transfer')
        .withArgs(
          ethers.constants.AddressZero,
          alice.address,
          parseEther('9000')
        )
        .to.emit(market, 'Borrow')
        .to.emit(market, 'AddCollateral')
        .withArgs(
          alice.address,
          parseEther('1'),
          parseEther('1').mul(parseEther('1')).div(exchangeRate2)
        )
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(XVSContract, 'Transfer');

      const [
        totalLoan3,
        aliceLoan3,
        bobLoan,
        aliceDineroBalance3,
        bobDineroBalance3,
        aliceCollateral3,
        totalRewardsPerVToken3,
        totalVCollateral3,
        aliceRewards3,
        bobRewards3,
        bobCollateral3,
        exchangeRate4,
      ] = await Promise.all([
        market.totalLoan(),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        dinero.balanceOf(alice.address),
        dinero.balanceOf(bob.address),
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        market.rewardsOf(bob.address),
        market.userCollateral(bob.address),
        vBTCContract.callStatic.exchangeRateCurrent(),
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
      expect(bobDineroBalance3).to.be.equal(bobDineroBalance2);
      expect(bobLoan).to.be.equal(0);
      expect(aliceCollateral3).to.be.closeTo(
        parseEther('3').mul(parseEther('1')).div(exchangeRate4),
        1e4
      );
      expect(bobCollateral3).to.be.closeTo(
        parseEther('1').mul(parseEther('1')).div(exchangeRate4),
        1e4
      );

      expect(totalVCollateral3).to.be.closeTo(
        parseEther('4').mul(parseEther('1')).div(exchangeRate4),
        1e4
      );
      expect(aliceRewards3).to.be.equal(
        aliceCollateral3.mul(totalRewardsPerVToken3).div(ONE_V_TOKEN)
      );
      expect(bobRewards3).to.be.equal(bobRewards2);
    });
  });

  describe('function: repayAndWithdrawCollateral', () => {
    it('reverts if the caller passes invalid arguments', async () => {
      await expect(
        market
          .connect(alice)
          .repayAndWithdrawCollateral(ethers.constants.AddressZero, 0, 0, true)
      ).to.revertedWith('DM: no zero account');
      await expect(
        market
          .connect(alice)
          .repayAndWithdrawCollateral(alice.address, 0, 0, true)
      ).to.revertedWith('DM: no zero principal');
      await expect(
        market
          .connect(alice)
          .repayAndWithdrawCollateral(alice.address, 1, 0, true)
      ).to.revertedWith('DM: no zero withdrawl amount');
    });
    it('reverts if the user is insolvent', async () => {
      await market
        .connect(alice)
        .addCollateralAndBorrow(
          parseEther('2'),
          alice.address,
          parseEther('35000')
        );

      const exchangeRate = await vBTCContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(alice)
          .repayAndWithdrawCollateral(
            alice.address,
            parseEther('1000'),
            parseEther('1').mul(parseEther('1')).div(exchangeRate),
            false
          )
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('reverts if the there is no liquidity on Venus', async () => {
      await market
        .connect(alice)
        .addCollateralAndBorrow(
          parseEther('2'),
          alice.address,
          parseEther('35000')
        );

      const [errorBTC, mockVenus] = await multiDeploy(
        ['MockRedeemUnderlyingErrorVBTC', 'MockVenusControllerClaimVenus'],
        []
      );

      const [vBTCCode, controllerCode, errorVBTCCode, mockVenusCode] =
        await Promise.all([
          network.provider.send('eth_getCode', [vBTC]),
          network.provider.send('eth_getCode', [VENUS_CONTROLLER]),
          network.provider.send('eth_getCode', [errorBTC.address]),
          network.provider.send('eth_getCode', [mockVenus.address]),
        ]);

      const exchangeRate = await vBTCContract.callStatic.exchangeRateCurrent();

      await Promise.all([
        network.provider.send('hardhat_setCode', [vBTC, errorVBTCCode]),
        network.provider.send('hardhat_setCode', [
          VENUS_CONTROLLER,
          mockVenusCode,
        ]),
      ]);

      await expect(
        market
          .connect(alice)
          .repayAndWithdrawCollateral(
            alice.address,
            parseEther('1'),
            parseEther('1').mul(parseEther('1')).div(exchangeRate),
            true
          )
      ).to.revertedWith('DV: failed to redeem');

      await Promise.all([
        network.provider.send('hardhat_setCode', [vBTC, vBTCCode]),
        network.provider.send('hardhat_setCode', [
          VENUS_CONTROLLER,
          controllerCode,
        ]),
      ]);
    });
    it('allows a user to repay and withdraw collateral in vBTC on the same call', async () => {
      await market
        .connect(alice)
        .addCollateralAndBorrow(
          parseEther('5'),
          alice.address,
          parseEther('20000')
        );

      const [aliceDineroBalance, aliceLoan, totalLoan, aliceVBTCBalance] =
        await Promise.all([
          dinero.balanceOf(alice.address),
          market.userLoan(alice.address),
          market.totalLoan(),
          vBTCContract.balanceOf(alice.address),
          advanceTime(1000, ethers),
        ]);

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      const exchangeRate = await vBTCContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(alice)
          .repayAndWithdrawCollateral(
            alice.address,
            parseEther('15000'),
            parseEther('2').mul(parseEther('1')).div(exchangeRate),
            false
          )
      )
        .to.emit(dinero, 'Transfer')
        .to.emit(market, 'Repay')
        .to.emit(market, 'Accrue')
        .to.emit(vBTCContract, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          0,
          parseEther('2').mul(parseEther('1')).div(exchangeRate)
        )
        .to.emit(market, 'WithdrawCollateral')
        .withArgs(
          alice.address,
          0,
          parseEther('2').mul(parseEther('1')).div(exchangeRate)
        )
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(XVSContract, 'Transfer')
        .to.not.emit(vBTCContract, 'Redeem');

      const [
        aliceDineroBalance2,
        aliceLoan2,
        totalLoan2,
        aliceCollateral,
        totalRewardsPerVToken,
        totalVCollateral,
        aliceRewards,
        aliceVBTCBalance2,
        exchangeRate2,
      ] = await Promise.all([
        dinero.balanceOf(alice.address),
        market.userLoan(alice.address),
        market.totalLoan(),
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        vBTCContract.balanceOf(alice.address),
        vBTCContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral).to.be.closeTo(
        parseEther('3').mul(parseEther('1')).div(exchangeRate2),
        1e4
      );

      expect(totalVCollateral).to.be.closeTo(
        parseEther('3').mul(parseEther('1')).div(exchangeRate2),
        1e4
      );
      expect(aliceRewards).to.be.equal(
        totalRewardsPerVToken.mul(aliceCollateral).div(ONE_V_TOKEN)
      );

      expect(aliceDineroBalance2).to.be.closeTo(
        aliceDineroBalance.sub(parseEther('15000')),
        parseEther('2')
      );
      expect(aliceLoan).to.be.equal(parseEther('20000'));
      expect(aliceLoan2).to.be.closeTo(parseEther('5000'), parseEther('3'));
      expect(totalLoan.elastic).to.be.equal(parseEther('20000'));
      expect(totalLoan.base).to.be.equal(parseEther('20000'));
      expect(totalLoan2.base).to.be.equal(parseEther('5000'));
      expect(totalLoan2.elastic).closeTo(
        totalLoan.elastic.sub(parseEther('15000')),
        parseEther('2')
      );
      expect(aliceVBTCBalance2).to.be.closeTo(
        parseEther('2')
          .mul(parseEther('1'))
          .div(exchangeRate2)
          .add(aliceVBTCBalance),
        1e4
      );
    });
    it('allows a user to repay and withdraw as BTC', async () => {
      await market
        .connect(alice)
        .addCollateralAndBorrow(
          parseEther('5'),
          alice.address,
          parseEther('20000')
        );

      const [aliceDineroBalance, aliceLoan, totalLoan, aliceBTCBalance] =
        await Promise.all([
          dinero.balanceOf(alice.address),
          market.userLoan(alice.address),
          market.totalLoan(),
          BTCContract.balanceOf(alice.address),
          advanceTime(1000, ethers),
        ]);

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      const exchangeRate = await vBTCContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(alice)
          .repayAndWithdrawCollateral(
            alice.address,
            parseEther('15000'),
            parseEther('2').mul(parseEther('1')).div(exchangeRate),
            true
          )
      )
        .to.emit(dinero, 'Transfer')
        .to.emit(market, 'Repay')
        .to.emit(market, 'Accrue')
        .to.emit(vBTCContract, 'Transfer')
        .to.emit(BTCContract, 'Transfer')
        .withArgs(market.address, alice.address, parseEther('2'))
        .to.emit(market, 'WithdrawCollateral')
        .withArgs(
          alice.address,
          parseEther('2'),
          parseEther('2').mul(parseEther('1')).div(exchangeRate)
        )
        .to.emit(vBTCContract, 'Redeem')
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(XVSContract, 'Transfer');

      const [
        aliceDineroBalance2,
        aliceLoan2,
        totalLoan2,
        aliceCollateral,
        totalRewardsPerVToken,
        totalVCollateral,
        aliceRewards,
        aliceBTCBalance2,
        exchangeRate2,
      ] = await Promise.all([
        dinero.balanceOf(alice.address),
        market.userLoan(alice.address),
        market.totalLoan(),
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        BTCContract.balanceOf(alice.address),
        vBTCContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral).to.be.closeTo(
        parseEther('3').mul(parseEther('1')).div(exchangeRate2),
        1e4
      );
      expect(totalVCollateral).to.be.closeTo(
        parseEther('3').mul(parseEther('1')).div(exchangeRate2),
        1e4
      );
      expect(aliceRewards).to.be.equal(
        totalRewardsPerVToken.mul(aliceCollateral).div(ONE_V_TOKEN)
      );

      expect(aliceDineroBalance2).to.be.closeTo(
        aliceDineroBalance.sub(parseEther('15000')),
        parseEther('2')
      );
      expect(aliceLoan).to.be.equal(parseEther('20000'));
      expect(aliceLoan2).to.be.closeTo(parseEther('5000'), parseEther('3'));
      expect(totalLoan.elastic).to.be.equal(parseEther('20000'));
      expect(totalLoan.base).to.be.equal(parseEther('20000'));
      expect(totalLoan2.base).to.be.equal(parseEther('5000'));
      expect(totalLoan2.elastic).closeTo(
        totalLoan.elastic.sub(parseEther('15000')),
        parseEther('2')
      );
      expect(aliceBTCBalance2).to.be.closeTo(
        aliceBTCBalance.add(parseEther('2')),
        parseEther('0.0001')
      );
    });
  });
}).timeout(50_000);
