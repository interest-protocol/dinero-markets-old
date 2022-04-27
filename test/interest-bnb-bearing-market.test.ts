import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber, Contract, ContractTransaction } from 'ethers';
import { ethers, network } from 'hardhat';

import ERC20ABI from '../abi/erc20.json';
import PCSFactoryABI from '../abi/pcs-factory.json';
import PCSRouterABI from '../abi/pcs-router.json';
import VBNBABI from '../abi/vbnb.json';
import VenusControllerABI from '../abi/venus-controller.json';
import WBNBABI from '../abi/wbnb.json';
import {
  Dinero,
  ErrorInterestBearingSendBNBRequireMessage,
  ErrorInterestBearingSendBNBRequireNoMessage,
  InterestBNBBearingMarket,
  MockOracle,
  MockTWAP,
  Oracle,
  ReentrantInterestBearingBNBMarketLiquidate,
  ReentrantInterestBearingBNBMarketRequest,
  ReentrantInterestBearingBNBMarketWithdrawCollateral,
  TestInterestBNBBearingMarketV2,
} from '../typechain';
import {
  ADD_COLLATERAL_REQUEST,
  BORROW_REQUEST,
  BURNER_ROLE,
  MINTER_ROLE,
  ONE_V_TOKEN,
  PCS_FACTORY,
  PCS_ROUTER,
  REPAY_REQUEST,
  vBNB,
  VENUS_CONTROLLER,
  WBNB,
  WBNB_WHALE,
  WITHDRAW_COLLATERAL_REQUEST,
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
  upgrade,
} from './lib/test-utils';

const { parseEther, defaultAbiCoder } = ethers.utils;

const LIQUIDATION_FEE = parseEther('0.1');

const INTEREST_RATE = BigNumber.from(12e8);

const convertBorrowToLiquidationCollateral = (
  borrowAmount: BigNumber,
  exchangeRate: BigNumber,
  time = 10_000
) =>
  borrowAmount
    // Add interest paid
    .add(
      ethers.BigNumber.from(12e8)
        .mul(borrowAmount)
        .mul(BigNumber.from(time))
        .div(parseEther('1'))
    )
    .add(borrowAmount.mul(LIQUIDATION_FEE).div(parseEther('1')))
    // Convert Loan to BNB
    .mul(parseEther('1'))
    .div(parseEther('300'))
    // convert BNB to VBNB
    .mul(parseEther('1'))
    .div(exchangeRate);

describe('Interest BNB Bearing Market', () => {
  let market: InterestBNBBearingMarket;
  let dinero: Dinero;
  let oracle: Oracle;
  let mockTWAP: MockTWAP;
  let router: Contract;
  let mockOracle: MockOracle;
  let vBNBContract: Contract;
  const XVSContract = new ethers.Contract(XVS, ERC20ABI, ethers.provider);
  const VenusControllerContract = new ethers.Contract(
    VENUS_CONTROLLER,
    VenusControllerABI,
    ethers.provider
  );

  let owner: SignerWithAddress;
  let bob: SignerWithAddress;
  let alice: SignerWithAddress;
  let jose: SignerWithAddress;
  let treasury: SignerWithAddress;
  let recipient: SignerWithAddress;

  before(async () => {
    [owner, alice, bob, treasury, recipient, jose] = await ethers.getSigners();

    dinero = await deployUUPS('Dinero', []);
    await Promise.all([
      dinero.connect(owner).grantRole(MINTER_ROLE, owner.address),
      impersonate(WBNB_WHALE),
    ]);

    const wbnbWhaleSigner = await ethers.getSigner(WBNB_WHALE);

    router = new Contract(PCS_ROUTER, PCSRouterABI, wbnbWhaleSigner);
    vBNBContract = new Contract(vBNB, VBNBABI, ethers.provider);
    const wbnb = new Contract(WBNB, WBNBABI, wbnbWhaleSigner);

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
    ]);

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
    [mockTWAP, mockOracle] = await multiDeploy(
      ['MockTWAP', 'MockOracle'],
      [[], []]
    );

    oracle = await deployUUPS('Oracle', [mockTWAP.address]);

    market = await deployUUPS('InterestBNBBearingMarket', [
      dinero.address,
      treasury.address,
      oracle.address,
      INTEREST_RATE,
      ethers.BigNumber.from('500000000000000000'),
      ethers.BigNumber.from('100000000000000000'),
    ]);

    await Promise.all([
      dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
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
            INTEREST_RATE,
            ethers.BigNumber.from('500000000000000000'),
            LIQUIDATION_FEE
          )
      ).to.revertedWith('Initializable: contract is already initialized');
    });
    it('reverts if you set a max tvl ratio out of bounds', async () => {
      await expect(
        deployUUPS('InterestBNBBearingMarket', [
          dinero.address,
          treasury.address,
          oracle.address,
          INTEREST_RATE,
          ethers.BigNumber.from('900000000000000001'),
          LIQUIDATION_FEE,
        ])
      ).to.revertedWith('DM: ltc ratio out of bounds');
      await expect(
        deployUUPS('InterestBNBBearingMarket', [
          dinero.address,
          treasury.address,
          oracle.address,
          INTEREST_RATE,
          ethers.BigNumber.from('490000000000000000'),
          LIQUIDATION_FEE,
        ])
      ).to.revertedWith('DM: ltc ratio out of bounds');
    });
    it('sets the initial state', async () => {
      const [
        _dinero,
        _feeTo,
        _oracle,
        _loan,
        _maxLTVRatio,
        _liquidationFee,
        _owner,
      ] = await Promise.all([
        market.DINERO(),
        market.FEE_TO(),
        market.ORACLE(),
        market.loan(),
        market.maxLTVRatio(),
        market.liquidationFee(),
        market.owner(),
      ]);

      expect(_dinero).to.be.equal(dinero.address);
      expect(_feeTo).to.be.equal(treasury.address);
      expect(_oracle).to.be.equal(oracle.address);
      expect(_loan.INTEREST_RATE).to.be.equal(INTEREST_RATE);
      expect(_maxLTVRatio).to.be.equal(
        ethers.BigNumber.from('500000000000000000')
      );
      expect(_liquidationFee).to.be.equal(
        ethers.BigNumber.from('100000000000000000')
      );
      expect(_owner).to.be.equal(owner.address);
    });
  });

  it('sends the fees earned to the feeTo address', async () => {
    await market.connect(alice).addCollateral({ value: parseEther('10') });

    await market.connect(alice).borrow(alice.address, parseEther('700'));

    // Pass time to accrue fees
    await advanceTime(10_000, ethers); // advance 10_000 seconds

    const interestAccrued = parseEther('700')
      .mul(INTEREST_RATE)
      .mul(10_000)
      .div(parseEther('1'));

    expect(await dinero.balanceOf(treasury.address)).to.be.equal(0);

    // Accrue has not been called
    expect((await market.totalLoan()).elastic).to.be.equal(parseEther('700'));

    await expect(market.getEarnings())
      .to.emit(market, 'Accrue')
      .to.emit(market, 'GetEarnings');

    const [loan, treasuryDNRBalance, totalLoan] = await Promise.all([
      market.loan(),
      dinero.balanceOf(treasury.address),
      market.totalLoan(),
    ]);

    expect(loan.feesEarned).to.be.equal(0);
    expect(treasuryDNRBalance.gte(interestAccrued)).to.be.equal(true);
    expect(
      totalLoan.elastic.gte(parseEther('700').add(interestAccrued))
    ).to.be.equal(true);
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
      await market.connect(alice).addCollateral({ value: parseEther('10') });

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
      // Add 10 BNB as collateral
      await market.connect(alice).addCollateral({ value: parseEther('10') });

      await market.connect(alice).borrow(alice.address, parseEther('1500'));

      const [loan, totalLoan] = await Promise.all([
        market.loan(),
        market.totalLoan(),
      ]);

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // advance 10_000 seconds

      const debt = parseEther('1500')
        .mul(INTEREST_RATE)
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
      const market = await deployUUPS('InterestBNBBearingMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        INTEREST_RATE,
        ethers.BigNumber.from('500000000000000000'),
        ethers.BigNumber.from('100000000000000000'),
      ]);

      await expect(market.updateExchangeRate()).to.revertedWith(
        'DM: invalid exchange rate'
      );
    });
    it('updates the exchange rate for vBNB', async () => {
      const market = await deployUUPS('InterestBNBBearingMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        INTEREST_RATE,
        ethers.BigNumber.from('500000000000000000'),
        ethers.BigNumber.from('100000000000000000'),
      ]);

      advanceBlock(ethers);

      await mockOracle.__setBNBUSDPrice(parseEther('450'));

      await market.updateExchangeRate();

      const [exchangeRate, vBNBExchangeRate] = await Promise.all([
        market.exchangeRate(),
        vBNBContract.callStatic.exchangeRateCurrent(),
        mockOracle.__setBNBUSDPrice(parseEther('600')),
      ]);

      expect(exchangeRate).to.be.closeTo(
        parseEther('450').mul(vBNBExchangeRate).div(parseEther('1')).div(1e10),
        parseEther('0.00001')
      );

      await expect(market.updateExchangeRate()).to.emit(market, 'ExchangeRate');

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
    it('reverts if it fails to mint vBNB', async () => {
      const receiveErrorContract = await deploy('MockReceiveErrorVBNB', []);

      const vBNBCode = await network.provider.send('eth_getCode', [vBNB]);

      const code = await network.provider.send('eth_getCode', [
        receiveErrorContract.address,
      ]);

      await network.provider.send('hardhat_setCode', [vBNB, code]);

      await expect(
        market.connect(alice).addCollateral({ value: parseEther('2') })
      ).to.revertedWith('DM: unable to send bnb');

      await network.provider.send('hardhat_setCode', [vBNB, vBNBCode]);
    });
    it.only('accepts BNB deposits', async () => {
      const [
        aliceCollateral,
        totalRewardsPerVToken,
        totalVCollateral,
        aliceRewards,
        vBNBExchangeRate,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        vBNBContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral).to.be.equal(0);
      expect(totalRewardsPerVToken).to.be.equal(0);
      expect(totalVCollateral).to.be.equal(0);
      expect(aliceRewards).to.be.equal(0);

      await expect(
        market.connect(alice).addCollateral({ value: parseEther('10') })
      )
        .to.emit(market, 'AddCollateral')
        .withArgs(
          alice.address,
          parseEther('10'),
          parseEther('10').mul(parseEther('1')).div(vBNBExchangeRate)
        );

      const vBNBExchangeRate2 =
        await vBNBContract.callStatic.exchangeRateCurrent();

      await expect(
        market.connect(bob).addCollateral({ value: parseEther('5') })
      )
        .to.emit(market, 'AddCollateral')
        .withArgs(
          alice.address,
          parseEther('5'),
          parseEther('5').mul(parseEther('1')).div(vBNBExchangeRate2)
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
        vBNBExchangeRate3,
        bobCollateral,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        market.rewardsOf(bob.address),
        market.userCollateral(bob.address),
        vBNBContract.callStatic.exchangeRateCurrent(),
        market.userCollateral(bob.address),
      ]);

      expect(aliceCollateral2).to.be.closeTo(
        parseEther('10').mul(parseEther('1')).div(vBNBExchangeRate3),
        1e5
      );
      expect(bobCollateral2).to.be.closeTo(
        parseEther('5').mul(parseEther('1')).div(vBNBExchangeRate3),
        1e5
      );
      expect(totalRewardsPerVToken2.gt(0)).to.be.equal(true);

      expect(totalVCollateral2).to.be.closeTo(
        parseEther('15').mul(parseEther('1')).div(vBNBExchangeRate3),
        1e5
      );
      expect(aliceRewards2).to.be.equal(0);
      expect(bobRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(bobCollateral).div(ONE_V_TOKEN)
      );

      await expect(
        market.connect(alice).addCollateral({ value: parseEther('5') })
      )
        .to.emit(market, 'AddCollateral')
        .withArgs(
          alice.address,
          parseEther('5'),
          parseEther('5').mul(parseEther('1')).div(vBNBExchangeRate3)
        )
        .to.emit(VenusControllerContract, 'Claim')
        .to.emit(XVSContract, 'Transfer');

      const [
        aliceCollateral3,
        totalRewardsPerVToken3,
        totalVCollateral3,
        aliceRewards3,
        bobRewards3,
        bobCollateral3,
        vBNBExchangeRate4,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        market.rewardsOf(bob.address),
        market.userCollateral(bob.address),
        vBNBContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral3).to.be.closeTo(
        parseEther('15').mul(parseEther('1')).div(vBNBExchangeRate4),
        1e5
      );
      expect(bobCollateral3).to.be.closeTo(
        parseEther('5').mul(parseEther('1')).div(vBNBExchangeRate4),
        1e5
      );

      expect(totalVCollateral3).to.be.closeTo(
        parseEther('20').mul(parseEther('1')).div(vBNBExchangeRate4),
        1e5
      );

      expect(aliceRewards3).to.be.equal(
        aliceCollateral3.mul(totalRewardsPerVToken3).div(ONE_V_TOKEN)
      );

      expect(bobRewards3).to.be.equal(
        totalRewardsPerVToken2.mul(bobCollateral2).div(ONE_V_TOKEN)
      );

      await expect(
        market.connect(alice).addCollateral({ value: parseEther('5') })
      ).to.emit(XVSContract, 'Transfer');

      const [totalRewardsPerVToken4, aliceRewards4] = await Promise.all([
        market.totalRewardsPerVToken(),
        market.rewardsOf(alice.address),
      ]);

      expect(aliceRewards4).to.be.closeTo(
        parseEther('20')
          .mul(parseEther('1'))
          .div(vBNBExchangeRate4)
          .mul(totalRewardsPerVToken4)
          .div(ONE_V_TOKEN),
        parseEther('1')
      );
    });
  });

  it('reverts if anyone but the vToken sends BNB to it', async () => {
    await expect(
      alice.sendTransaction({
        to: market.address,
        value: parseEther('3'),
      })
    ).to.revertedWith('DM: not allowed');
  });

  describe('function: withdrawCollateral', () => {
    it('reverts if the user is insolvent', async () => {
      await market.connect(alice).addCollateral({ value: parseEther('10') });

      await market.connect(alice).borrow(bob.address, parseEther('2000'));

      const vBNBExchangeRate =
        await vBNBContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(
            parseEther('2.1').mul(parseEther('1')).div(vBNBExchangeRate),
            false
          )
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('reverts if vBNB fails to redeem the underlying', async () => {
      const [errorVBNB, mockVenus] = await multiDeploy(
        ['MockRedeemUnderlyingErrorVBNB', 'MockVenusControllerClaimVenus'],
        []
      );

      const [vBNBCode, controllerCode, errorVBNbCode, mockVenusCode] =
        await Promise.all([
          network.provider.send('eth_getCode', [vBNB]),
          network.provider.send('eth_getCode', [VENUS_CONTROLLER]),
          network.provider.send('eth_getCode', [errorVBNB.address]),
          network.provider.send('eth_getCode', [mockVenus.address]),
        ]);

      await market.connect(alice).addCollateral({ value: parseEther('2') });

      await Promise.all([
        network.provider.send('hardhat_setCode', [vBNB, errorVBNbCode]),
        network.provider.send('hardhat_setCode', [
          VENUS_CONTROLLER,
          mockVenusCode,
        ]),
      ]);

      await expect(
        market.connect(alice).withdrawCollateral(ONE_V_TOKEN, true)
      ).to.revertedWith('DM: failed to redeem');

      await Promise.all([
        network.provider.send('hardhat_setCode', [vBNB, vBNBCode]),
        network.provider.send('hardhat_setCode', [
          VENUS_CONTROLLER,
          controllerCode,
        ]),
      ]);
    });
    it('allows collateral to be withdrawn in vBNB', async () => {
      await market.connect(alice).addCollateral({ value: parseEther('10') });

      await market.connect(alice).borrow(alice.address, parseEther('100'));

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      const exchangeRate = await vBNBContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(
            parseEther('2').mul(parseEther('1')).div(exchangeRate),
            false
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(vBNBContract, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          0,
          parseEther('2').mul(parseEther('1')).div(exchangeRate)
        )
        .to.emit(XVS, 'Transfer')
        .to.emit(vBNBContract, 'Transfer')
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.not.emit(vBNBContract, 'Redeem');

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
        vBNBContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral).to.be.closeTo(
        parseEther('8').mul(parseEther('1')).div(exchangeRate2),
        1e5
      );
      expect(totalVCollateral).to.be.closeTo(
        parseEther('8').mul(parseEther('1')).div(exchangeRate2),
        1e5
      );
      expect(aliceRewards).to.be.equal(
        aliceCollateral.mul(totalRewardsPerVToken).div(ONE_V_TOKEN)
      );

      await market.connect(bob).addCollateral({ value: parseEther('5') });

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(
            parseEther('1').mul(parseEther('1')).div(exchangeRate2),
            false
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(vBNBContract, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          0,
          parseEther('1').mul(parseEther('1')).div(exchangeRate2)
        )
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(XVSContract, 'Transfer')
        .to.not.emit(vBNBContract, 'Redeem');

      const [
        aliceCollateral2,
        totalRewardsPerVToken2,
        totalVCollateral2,
        aliceRewards2,
        exchangeRate3,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        vBNBContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral2).to.be.closeTo(
        parseEther('7').mul(parseEther('1')).div(exchangeRate3),
        1e5
      );

      expect(totalVCollateral2).to.be.closeTo(
        parseEther('12').mul(parseEther('1')).div(exchangeRate3),
        1e5
      );
      expect(aliceRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(aliceCollateral2).div(ONE_V_TOKEN)
      );
    });

    it('allows BNB to be withdrawn', async () => {
      await market.connect(alice).addCollateral({ value: parseEther('10') });

      await market.connect(alice).borrow(alice.address, parseEther('100'));

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      const [aliceBalance, exchangeRate, aliceVBNBBalance] = await Promise.all([
        alice.getBalance(),
        vBNBContract.callStatic.exchangeRateCurrent(),
        vBNBContract.balanceOf(alice.address),
      ]);

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(
            parseEther('2').mul(parseEther('1')).div(exchangeRate),
            true
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(vBNBContract, 'Redeem')
        .withArgs(parseEther('2'))
        .to.emit(market, 'WithdrawCollateral')
        .withArgs(
          alice.address,
          parseEther('2'),
          parseEther('2').mul(parseEther('1')).div(exchangeRate)
        )
        .to.emit(XVSContract, 'Transfer')
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus');

      const [
        aliceCollateral,
        totalRewardsPerVToken,
        totalVCollateral,
        aliceRewards,
        aliceBalance2,
        aliceVBNBBalance2,
        exchangeRate2,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        alice.getBalance(),
        vBNBContract.balanceOf(alice.address),
        vBNBContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral).to.be.closeTo(
        parseEther('8').mul(parseEther('1')).div(exchangeRate2),
        1e4
      );

      expect(totalVCollateral).to.be.equal(aliceCollateral);
      expect(aliceRewards).to.be.closeTo(
        totalRewardsPerVToken.mul(aliceCollateral).div(ONE_V_TOKEN),
        1e4
      );
      expect(aliceBalance2).to.be.closeTo(
        aliceBalance.add(parseEther('2')),
        parseEther('0.1') // TX fees
      );
      expect(aliceVBNBBalance2).to.be.equal(aliceVBNBBalance);

      await market.connect(bob).addCollateral({ value: parseEther('5') });

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      const exchangeRate3 = await vBNBContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(
            parseEther('3').mul(parseEther('1')).div(exchangeRate3),
            true
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(vBNBContract, 'Redeem')
        .withArgs(parseEther('3'))
        .to.emit(market, 'WithdrawCollateral')
        .withArgs(
          alice.address,
          parseEther('3'),
          parseEther('3').mul(parseEther('1')).div(exchangeRate3)
        )
        .to.emit(XVSContract, 'Transfer');

      const [
        aliceCollateral2,
        totalRewardsPerVToken2,
        totalVCollateral2,
        aliceRewards2,
        aliceBalance3,
        aliceVBNBBalance3,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        alice.getBalance(),
        vBNBContract.balanceOf(alice.address),
      ]);

      expect(aliceCollateral2).to.be.closeTo(
        parseEther('5').mul(parseEther('1')).div(exchangeRate3),
        1e4
      );

      expect(totalVCollateral2).to.be.closeTo(
        parseEther('10').mul(parseEther('1')).div(exchangeRate3),
        1e4
      );
      expect(aliceRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(aliceCollateral2).div(ONE_V_TOKEN)
      );
      expect(aliceBalance3).to.be.closeTo(
        aliceBalance2.add(parseEther('3')),
        parseEther('0.1') // TX tax
      );
      expect(aliceVBNBBalance3).to.be.equal(aliceVBNBBalance2);

      await expect(market.connect(alice).withdrawCollateral(0, true))
        .to.emit(XVS, 'Transfer')
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus');
    });
  });
  describe('function: borrow', () => {
    it('reverts if you borrow to the zero address', async () => {
      await expect(
        market.connect(alice).borrow(ethers.constants.AddressZero, 1)
      ).to.revertedWith('MKT: no zero address');
    });
    it('reverts if the user is insolvent', async () => {
      await market.connect(alice).addCollateral({ value: parseEther('2') });

      await expect(
        market.connect(alice).borrow(bob.address, parseEther('500'))
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('allows a user to borrow as long as he remains solvent', async () => {
      await market.connect(alice).addCollateral({ value: parseEther('2') });

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

      await expect(market.connect(alice).borrow(bob.address, parseEther('200')))
        .to.emit(dinero, 'Transfer')
        .withArgs(ethers.constants.AddressZero, bob.address, parseEther('200'))
        .to.emit(market, 'Borrow')
        .to.not.emit(market, 'Accrue');

      const [totalLoan2, aliceLoan2, aliceDineroBalance2, bobDineroBalance2] =
        await Promise.all([
          market.totalLoan(),
          market.userLoan(alice.address),
          dinero.balanceOf(alice.address),
          dinero.balanceOf(bob.address),
        ]);

      expect(totalLoan2.base).to.be.equal(parseEther('200'));
      expect(totalLoan2.elastic).to.be.equal(parseEther('200'));
      expect(aliceLoan2).to.be.equal(parseEther('200'));
      expect(aliceDineroBalance2).to.be.equal(aliceDineroBalance);
      expect(bobDineroBalance2).to.be.equal(
        bobDineroBalance.add(parseEther('200'))
      );

      await advanceTime(10_000, ethers); // advance 10_000 seconds

      await expect(
        market.connect(alice).borrow(alice.address, parseEther('199'))
      )
        .to.emit(market, 'Accrue')
        .to.emit(dinero, 'Transfer')
        .withArgs(
          ethers.constants.AddressZero,
          alice.address,
          parseEther('199')
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
      expect(
        totalLoan3.base.gt(totalLoan2.base.add(parseEther('190')))
      ).to.be.equal(true); // Interest rate makes it hard to calculate the exact value
      expect(
        totalLoan3.elastic.gte(totalLoan2.elastic.add(parseEther('199')))
      ).to.be.equal(true);
      expect(aliceLoan3.gt(aliceLoan2.add(parseEther('190')))).to.be.equal(
        true
      ); // Interest rate makes it hard to calculate the exact value
      expect(aliceDineroBalance3).to.be.equal(
        aliceDineroBalance2.add(parseEther('199'))
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
      await market.connect(alice).addCollateral({ value: parseEther('2') });

      await market.connect(alice).borrow(alice.address, parseEther('300'));

      const [ownerDineroBalance, aliceLoan, totalLoan] = await Promise.all([
        dinero.balanceOf(owner.address),
        market.userLoan(alice.address),
        market.totalLoan(),
        advanceTime(1000, ethers),
      ]);

      await expect(
        market.connect(owner).repay(alice.address, parseEther('150'))
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
        ownerDineroBalance2.lte(ownerDineroBalance.sub(parseEther('150')))
      ).to.be.equal(true);
      expect(aliceLoan).to.be.equal(parseEther('300'));
      expect(aliceLoan2).to.be.equal(parseEther('150'));
      expect(totalLoan.elastic).to.be.equal(parseEther('300'));
      expect(totalLoan.base).to.be.equal(parseEther('300'));
      expect(totalLoan2.base).to.be.equal(parseEther('150'));
      expect(
        totalLoan2.elastic.gt(totalLoan.elastic.sub(parseEther('150')))
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
  it('reverts if it sends BNB to a contract without receive', async () => {
    const [errorRequireMessage, errorRequireNoMessage]: [
      ErrorInterestBearingSendBNBRequireMessage,
      ErrorInterestBearingSendBNBRequireNoMessage
    ] = await multiDeploy(
      [
        'ErrorInterestBearingSendBNBRequireMessage',
        'ErrorInterestBearingSendBNBRequireNoMessage',
      ],
      [[], []]
    );

    await Promise.all([
      errorRequireMessage
        .connect(alice)
        .addCollateral(market.address, { value: parseEther('10') }),
      errorRequireNoMessage
        .connect(alice)
        .addCollateral(market.address, { value: parseEther('10') }),
    ]);

    const exchangeRate = await vBNBContract.callStatic.exchangeRateCurrent();

    await Promise.all([
      expect(
        errorRequireNoMessage.withdrawCollateral(
          market.address,
          parseEther('2').mul(parseEther('1')).div(exchangeRate)
        )
      ).to.revertedWith('DM: unable to send bnb'),
      expect(
        errorRequireMessage.withdrawCollateral(
          market.address,
          parseEther('2').mul(parseEther('1')).div(exchangeRate)
        )
      ).to.revertedWith('test error'),
    ]);
  });
  describe('function: liquidate', () => {
    it('reverts if the last element on path is not dinero', async () => {
      await expect(
        market
          .connect(alice)
          .liquidate([], [], recipient.address, true, [
            alice.address,
            alice.address,
          ])
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
        market.connect(alice).addCollateral({ value: parseEther('10') }),
        market.connect(bob).addCollateral({ value: parseEther('10') }),
      ]);

      // Collateral should allow them to borrow up to 2500
      const [exchangeRate] = await Promise.all([
        vBNBContract.callStatic.exchangeRateCurrent(),
        market.connect(alice).borrow(alice.address, parseEther('2200')),
        market.connect(bob).borrow(bob.address, parseEther('2200')),
      ]);

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
      const market: InterestBNBBearingMarket = await deployUUPS(
        'InterestBNBBearingMarket',
        [
          dinero.address,
          treasury.address,
          mockOracle.address,
          INTEREST_RATE,
          ethers.BigNumber.from('500000000000000000'),
          ethers.BigNumber.from('100000000000000000'),
        ]
      );

      await mockOracle.__setBNBUSDPrice(parseEther('500'));

      await market.updateExchangeRate();

      await Promise.all([
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
        market.connect(alice).addCollateral({ value: parseEther('10') }),
        market.connect(bob).addCollateral({ value: parseEther('10') }),
        market.connect(jose).addCollateral({ value: parseEther('7') }),
      ]);

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('1600')),
        market.connect(bob).borrow(bob.address, parseEther('500')),
        market.connect(jose).borrow(jose.address, parseEther('1200')),
      ]);

      // Drop BNB to 300. Alice and Jose can now be liquidated
      await mockOracle.__setBNBUSDPrice(parseEther('300'));

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // 10_000 seconds

      const exchangeRate = await vBNBContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(recipient)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [
              1,
              parseEther('10').mul(parseEther('1')).div(exchangeRate),
              parseEther('7').mul(parseEther('1')).div(exchangeRate),
            ],
            recipient.address,
            true,
            [WBNB, dinero.address]
          )
      ).to.revertedWith('DM: principal too low');
    });
    it('allows for full liquidation', async () => {
      const market: InterestBNBBearingMarket = await deployUUPS(
        'InterestBNBBearingMarket',
        [
          dinero.address,
          treasury.address,
          mockOracle.address,
          INTEREST_RATE,
          ethers.BigNumber.from('500000000000000000'),
          ethers.BigNumber.from('100000000000000000'),
        ]
      );

      await mockOracle.__setBNBUSDPrice(parseEther('500'));

      await Promise.all([
        market.updateExchangeRate(),
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      ]);

      await market.connect(alice).addCollateral({ value: parseEther('10') });

      await market.connect(alice).borrow(alice.address, parseEther('2200'));

      // Drop BNB to 300. Alice and Jose can now be liquidated
      await mockOracle.__setBNBUSDPrice(parseEther('300'));

      await market
        .connect(owner)
        .liquidate(
          [alice.address],
          [parseEther('2200')],
          recipient.address,
          false,
          []
        );

      const totalLoan = await market.totalLoan();

      expect(totalLoan.base).to.be.equal(0);
      expect(totalLoan.elastic).to.be.equal(0);
    });
    it('liquidates a user by selling redeeming the collateral and burning the acquired dinero', async () => {
      const market: InterestBNBBearingMarket = await deployUUPS(
        'InterestBNBBearingMarket',
        [
          dinero.address,
          treasury.address,
          mockOracle.address,
          INTEREST_RATE,
          ethers.BigNumber.from('500000000000000000'),
          ethers.BigNumber.from('100000000000000000'),
        ]
      );

      await mockOracle.__setBNBUSDPrice(parseEther('500'));

      await Promise.all([
        market.updateExchangeRate(),
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      ]);

      await Promise.all([
        market.connect(alice).addCollateral({ value: parseEther('10') }),
        market.connect(bob).addCollateral({ value: parseEther('10') }),
        market.connect(jose).addCollateral({ value: parseEther('7') }),
      ]);

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('2200')),
        market.connect(bob).borrow(bob.address, parseEther('500')),
        market.connect(jose).borrow(jose.address, parseEther('1500')),
      ]);

      // Drop BNB to 300. Alice and Jose can now be liquidated
      await mockOracle.__setBNBUSDPrice(parseEther('300'));

      const factoryContract = new ethers.Contract(
        PCS_FACTORY,
        PCSFactoryABI,
        ethers.provider
      );

      const [
        wbnbDNRPair,
        recipientDineroBalance,
        aliceLoan,
        bobLoan,
        joseLoan,
        aliceCollateral,
        bobCollateral,
        joseCollateral,
        bobRewards,
        joseRewards,
        totalVCollateral,
        recipientBNBBalance,
        recipientVBNBBalance,
        aliceXVSBalance,
        bobXVSBalance,
        joseXVSBalance,
        loan,
        exchangeRate,
      ] = await Promise.all([
        factoryContract.getPair(dinero.address, WBNB),
        dinero.balanceOf(recipient.address),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.userCollateral(jose.address),
        market.rewardsOf(bob.address),
        market.rewardsOf(jose.address),
        market.totalVCollateral(),
        recipient.getBalance(),
        vBNBContract.balanceOf(recipient.address),
        XVSContract.balanceOf(alice.address),
        XVSContract.balanceOf(bob.address),
        XVSContract.balanceOf(jose.address),
        market.loan(),
        vBNBContract.callStatic.exchangeRateCurrent(),
      ]);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(wbnbDNRPair);

      expect(recipientDineroBalance).to.be.equal(0);
      expect(aliceLoan).to.be.equal(parseEther('2200'));

      // Bob in shares will owe less than 500 due to accumulated fees
      expect(bobLoan).to.be.closeTo(parseEther('500'), parseEther('1'));
      expect(joseLoan).to.be.closeTo(parseEther('1500'), parseEther('1'));

      expect(aliceCollateral).to.be.closeTo(
        parseEther('10').mul(parseEther('1')).div(exchangeRate),
        1e4
      );
      expect(bobCollateral).to.be.closeTo(
        parseEther('10').mul(parseEther('1')).div(exchangeRate),
        1e4
      );
      expect(joseCollateral).to.be.closeTo(
        parseEther('7').mul(parseEther('1')).div(exchangeRate),
        1e4
      );
      expect(totalVCollateral).to.be.equal(
        bobCollateral.add(joseCollateral).add(aliceCollateral)
      );

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // 10_000 seconds

      await expect(
        market
          .connect(recipient)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [parseEther('2200'), parseEther('500'), parseEther('1200')],
            recipient.address,
            true,
            [WBNB, dinero.address]
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(XVSContract, 'Transfer')
        .to.emit(vBNBContract, 'Redeem')
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
        exchangeRate2,
        totalRewards,
        recipientVBNBBalance2,
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
        vBNBContract.callStatic.exchangeRateCurrent(),
        market.totalRewardsPerVToken(),
        vBNBContract.balanceOf(recipient.address),
      ]);

      // Recipient got paid for liquidating
      expect(recipientDineroBalance2.gt(0)).to.be.equal(true);

      // Alice got fully liquidated
      expect(aliceLoan2).to.be.equal(0);
      // Bob did not get liquidated
      expect(bobLoan2).to.be.equal(bobLoan);
      // Jose got partially liquidated
      expect(joseLoan2).to.be.equal(joseLoan.sub(parseEther('1200')));

      expect(bobCollateral2).to.be.equal(bobCollateral);
      // Alice collateral 2 must be lower than collateral 1 minus loan liquidated + 10% due to fees
      expect(aliceCollateral2).to.be.closeTo(
        aliceCollateral.sub(
          convertBorrowToLiquidationCollateral(
            parseEther('2200'),
            exchangeRate2
          )
        ),
        1e7
      );
      expect(joseCollateral2).to.be.closeTo(
        joseCollateral.sub(
          convertBorrowToLiquidationCollateral(
            parseEther('1200'),
            exchangeRate2
          )
        ),
        1e7
      );

      expect(bobRewards2).to.be.equal(bobRewards);
      expect(aliceRewards2).to.be.equal(
        totalRewards.mul(aliceCollateral2).div(ONE_V_TOKEN)
      );
      expect(joseRewards2).to.be.equal(
        totalRewards.mul(joseCollateral2).div(ONE_V_TOKEN)
      );
      expect(aliceXVSBalance2).to.be.equal(
        totalRewards.mul(aliceCollateral).div(ONE_V_TOKEN).add(aliceXVSBalance)
      );
      expect(bobXVSBalance2).to.be.equal(bobXVSBalance);

      expect(joseXVSBalance2).to.be.equal(
        totalRewards
          .mul(joseCollateral)
          .div(ONE_V_TOKEN)
          .sub(joseRewards)
          .add(joseXVSBalance)
      );

      expect(totalVCollateral2).to.be.closeTo(
        totalVCollateral.sub(
          convertBorrowToLiquidationCollateral(
            parseEther('3400'),
            exchangeRate2
          )
        ),
        1e7
      );
      expect(totalLoan2.base).to.be.equal(
        aliceLoan2.add(joseLoan2).add(bobLoan2)
      );
      expect(totalLoan2.elastic).to.be.closeTo(
        parseEther('800'),
        parseEther('2') // 2 DNR to account for fees
      );

      // Fees earned have to be greater than prev fees plus loan accrued fees.
      expect(
        loan2.feesEarned.gt(
          loan.feesEarned.add(
            ethers.BigNumber.from(12e8)
              .mul(parseEther('3400'))
              .mul(BigNumber.from(10_000))
              .div(parseEther('1'))
          )
        )
      );
      expect(recipientBNBBalance).closeTo(
        recipientBNBBalance2,
        parseEther('0.1') // tx fees not from liquidation rewards
      );
      expect(recipientVBNBBalance2).to.be.equal(recipientVBNBBalance);
    });
    it('liquidates a user by using the caller dinero and getting the underlying as a reward', async () => {
      const market: InterestBNBBearingMarket = await deployUUPS(
        'InterestBNBBearingMarket',
        [
          dinero.address,
          treasury.address,
          mockOracle.address,
          INTEREST_RATE,
          ethers.BigNumber.from('500000000000000000'),
          ethers.BigNumber.from('100000000000000000'),
        ]
      );

      await mockOracle.__setBNBUSDPrice(parseEther('500'));

      await Promise.all([
        market.updateExchangeRate(),
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      ]);

      await Promise.all([
        market.connect(alice).addCollateral({ value: parseEther('10') }),
        market.connect(bob).addCollateral({ value: parseEther('10') }),
        market.connect(jose).addCollateral({ value: parseEther('7') }),
      ]);

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('2450')),
        market.connect(bob).borrow(bob.address, parseEther('500')),
        market.connect(jose).borrow(jose.address, parseEther('1500')),
      ]);

      // Drop BNB to 300. Alice and Jose can now be liquidated
      await mockOracle.__setBNBUSDPrice(parseEther('300'));

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
        aliceRewards,
        bobRewards,
        joseRewards,
        totalVCollateral,
        aliceXVSBalance,
        bobXVSBalance,
        joseXVSBalance,
        loan,
        ownerDineroBalance,
        ownerBNBBalance,
        recipientBNBBalance,
        exchangeRate,
        recipientVBNBBalance,
      ] = await Promise.all([
        factoryContract.getPair(dinero.address, WBNB),
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
        XVSContract.balanceOf(alice.address),
        XVSContract.balanceOf(bob.address),
        XVSContract.balanceOf(jose.address),
        market.loan(),
        dinero.balanceOf(owner.address),
        owner.getBalance(),
        recipient.getBalance(),
        vBNBContract.callStatic.exchangeRateCurrent(),
        vBNBContract.balanceOf(recipient.address),
      ]);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      expect(aliceLoan).to.be.equal(parseEther('2450'));
      // Bob in shares will owe less than 500 due to fees
      expect(bobLoan.lte(parseEther('500'))).to.be.equal(true);
      expect(joseLoan.lte(parseEther('1500'))).to.be.equal(true);
      expect(aliceCollateral).to.be.closeTo(
        parseEther('10').mul(parseEther('1')).div(exchangeRate),
        1e4
      );
      expect(bobCollateral).to.be.closeTo(
        parseEther('10').mul(parseEther('1')).div(exchangeRate),
        1e4
      );
      expect(joseCollateral).to.be.closeTo(
        parseEther('7').mul(parseEther('1')).div(exchangeRate),
        1e4
      );
      expect(totalVCollateral).to.be.equal(
        bobCollateral.add(joseCollateral).add(aliceCollateral)
      );

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // 10_000 seconds

      await expect(
        market
          .connect(owner)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [parseEther('2450'), parseEther('500'), parseEther('1200')],
            recipient.address,
            true,
            []
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(XVSContract, 'Transfer')
        .to.emit(vBNB, 'Redeem')
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
        ownerDineroBalance2,
        ownerBNBBalance2,
        ownerVBNBBalance,
        recipientBNBBalance2,
        recipientVBNBBalance2,
        exchangeRate2,
        totalRewards,
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
        dinero.balanceOf(owner.address),
        owner.getBalance(),
        vBNBContract.balanceOf(owner.address),
        recipient.getBalance(),
        vBNBContract.balanceOf(recipient.address),
        vBNBContract.callStatic.exchangeRateCurrent(),
        market.totalRewardsPerVToken(),
      ]);

      expect(ownerDineroBalance2).to.be.closeTo(
        ownerDineroBalance.sub(
          parseEther('3650')
            .add(
              ethers.BigNumber.from(12e8)
                .mul(parseEther('3650'))
                .mul(BigNumber.from(10_000))
                .div(parseEther('1'))
            )
            .add(
              parseEther('3650')
                .add(
                  ethers.BigNumber.from(12e8)
                    .mul(parseEther('3650'))
                    .mul(BigNumber.from(10_000))
                    .div(parseEther('1'))
                )
                .mul(parseEther('0.01'))
                .div(parseEther('1'))
            )
        ),
        parseEther('2')
      );

      // Alice got fully liquidated
      expect(aliceLoan2).to.be.equal(0);
      // Bob did not get liquidated
      expect(bobLoan2).to.be.equal(bobLoan);
      // Jose got partially liquidated
      expect(joseLoan2).to.be.equal(joseLoan.sub(parseEther('1200')));

      expect(bobCollateral2).to.be.equal(bobCollateral);
      // Alice collateral 2 must be lower than collateral 1 minus loan liquidated + 10% due to fees
      expect(aliceCollateral2).to.be.closeTo(
        aliceCollateral.sub(
          convertBorrowToLiquidationCollateral(
            parseEther('2450'),
            exchangeRate2
          )
        ),
        1e7
      );
      expect(joseCollateral2).to.be.closeTo(
        joseCollateral.sub(
          convertBorrowToLiquidationCollateral(
            parseEther('1200'),
            exchangeRate2
          )
        ),
        1e7
      );

      expect(bobRewards2).to.be.equal(bobRewards);
      expect(aliceRewards2).to.be.equal(
        totalRewards.mul(aliceCollateral2).div(ONE_V_TOKEN)
      );
      expect(joseRewards2).to.be.equal(
        totalRewards.mul(joseCollateral2).div(ONE_V_TOKEN)
      );
      expect(aliceXVSBalance2).to.be.equal(
        totalRewards
          .mul(aliceCollateral)
          .div(ONE_V_TOKEN)
          .add(aliceXVSBalance)
          .sub(aliceRewards)
      );

      expect(bobXVSBalance2).to.be.equal(bobXVSBalance);
      expect(joseXVSBalance2).to.be.equal(
        totalRewards
          .mul(joseCollateral)
          .div(ONE_V_TOKEN)
          .add(joseXVSBalance)
          .sub(joseRewards)
      );
      expect(totalVCollateral2).to.be.closeTo(
        totalVCollateral.sub(
          convertBorrowToLiquidationCollateral(
            parseEther('3650'),
            exchangeRate2
          )
        ),
        ONE_V_TOKEN
      );
      expect(totalLoan2.base).to.be.equal(
        aliceLoan2.add(joseLoan2).add(bobLoan2)
      );
      expect(totalLoan2.elastic).to.be.closeTo(
        parseEther('800'),
        parseEther('2') // 2 DNR to account for fees
      );
      // Fees earned have to be greater than prev fees plus loan accrued fees.
      expect(
        loan2.feesEarned.gt(
          loan.feesEarned.add(
            ethers.BigNumber.from(12e8)
              .mul(parseEther('3650'))
              .mul(BigNumber.from(10_000))
              .div(parseEther('1'))
          )
        )
      );

      // liquidator got rewarded in BNB
      expect(ownerBNBBalance2).closeTo(
        ownerBNBBalance,
        parseEther('0.1') // fees
      );

      // liquidator got rewarded in BNB
      expect(recipientBNBBalance2).closeTo(
        recipientBNBBalance.add(
          // Principal + Interest
          parseEther('3650')
            .add(
              ethers.BigNumber.from(12e8)
                .mul(parseEther('3650'))
                .mul(BigNumber.from(10_000))
                .div(parseEther('1'))
            )
            // 10% fee
            .add(
              parseEther('3650')
                .add(
                  ethers.BigNumber.from(12e8)
                    .mul(parseEther('3650'))
                    .mul(BigNumber.from(10_000))
                    .div(parseEther('1'))
                )
                .mul(parseEther('0.1'))
                .div(parseEther('1'))
            )
            // Convert to BNB
            .mul(parseEther('1'))
            .div(parseEther('300'))
        ),
        parseEther('0.001') // Rounding of debt interest rate
      );
      expect(recipientVBNBBalance2).to.be.equal(recipientVBNBBalance);
      expect(ownerVBNBBalance).to.be.equal(0);
    });
    it('liquidates a user by using the caller dinero and getting VBNB as a reward', async () => {
      const market: InterestBNBBearingMarket = await deployUUPS(
        'InterestBNBBearingMarket',
        [
          dinero.address,
          treasury.address,
          mockOracle.address,
          INTEREST_RATE,
          ethers.BigNumber.from('500000000000000000'),
          ethers.BigNumber.from('100000000000000000'),
        ]
      );

      await mockOracle.__setBNBUSDPrice(parseEther('500'));

      await Promise.all([
        market.updateExchangeRate(),
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      ]);

      await Promise.all([
        market.connect(alice).addCollateral({ value: parseEther('10') }),
        market.connect(bob).addCollateral({ value: parseEther('10') }),
        market.connect(jose).addCollateral({ value: parseEther('7') }),
      ]);

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('2450')),
        market.connect(bob).borrow(bob.address, parseEther('500')),
        market.connect(jose).borrow(jose.address, parseEther('1500')),
      ]);

      // Drop BNB to 300. Alice and Jose can now be liquidated
      await mockOracle.__setBNBUSDPrice(parseEther('300'));

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
        aliceRewards,
        bobRewards,
        joseRewards,
        totalVCollateral,
        aliceXVSBalance,
        bobXVSBalance,
        joseXVSBalance,
        loan,
        ownerDineroBalance,
        ownerBNBBalance,
        recipientBNBBalance,
        exchangeRate,
        recipientVBNBBalance,
      ] = await Promise.all([
        factoryContract.getPair(dinero.address, WBNB),
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
        XVSContract.balanceOf(alice.address),
        XVSContract.balanceOf(bob.address),
        XVSContract.balanceOf(jose.address),
        market.loan(),
        dinero.balanceOf(owner.address),
        owner.getBalance(),
        recipient.getBalance(),
        vBNBContract.callStatic.exchangeRateCurrent(),
        vBNBContract.balanceOf(recipient.address),
      ]);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      expect(aliceLoan).to.be.equal(parseEther('2450'));
      // Bob in shares will owe less than 500 due to fees
      expect(bobLoan.lte(parseEther('500'))).to.be.equal(true);
      expect(joseLoan.lte(parseEther('1500'))).to.be.equal(true);
      expect(aliceCollateral).to.be.closeTo(
        parseEther('10').mul(parseEther('1')).div(exchangeRate),
        1e4
      );
      expect(bobCollateral).to.be.closeTo(
        parseEther('10').mul(parseEther('1')).div(exchangeRate),
        1e4
      );
      expect(joseCollateral).to.be.closeTo(
        parseEther('7').mul(parseEther('1')).div(exchangeRate),
        1e4
      );
      expect(totalVCollateral).to.be.equal(
        bobCollateral.add(joseCollateral).add(aliceCollateral)
      );

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // 10_000 seconds

      await expect(
        market
          .connect(owner)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [parseEther('2450'), parseEther('500'), parseEther('1200')],
            recipient.address,
            false,
            []
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(XVSContract, 'Transfer')
        .to.not.emit(pairContract, 'Swap')
        .to.not.emit(vBNBContract, 'Redeem');

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
        ownerDineroBalance2,
        ownerBNBBalance2,
        ownerVBNBBalance,
        recipientBNBBalance2,
        recipientVBNBBalance2,
        exchangeRate2,
        totalRewards,
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
        dinero.balanceOf(owner.address),
        owner.getBalance(),
        vBNBContract.balanceOf(owner.address),
        recipient.getBalance(),
        vBNBContract.balanceOf(recipient.address),
        vBNBContract.callStatic.exchangeRateCurrent(),
        market.totalRewardsPerVToken(),
      ]);

      expect(ownerDineroBalance2).to.be.closeTo(
        ownerDineroBalance.sub(
          parseEther('3650')
            .add(
              ethers.BigNumber.from(12e8)
                .mul(parseEther('3650'))
                .mul(BigNumber.from(10_000))
                .div(parseEther('1'))
            )
            .add(
              parseEther('3650')
                .add(
                  ethers.BigNumber.from(12e8)
                    .mul(parseEther('3650'))
                    .mul(BigNumber.from(10_000))
                    .div(parseEther('1'))
                )
                .mul(parseEther('0.01'))
                .div(parseEther('1'))
            )
        ),
        parseEther('2')
      );

      // Alice got fully liquidated
      expect(aliceLoan2).to.be.equal(0);
      // Bob did not get liquidated
      expect(bobLoan2).to.be.equal(bobLoan);
      // Jose got partially liquidated
      expect(joseLoan2).to.be.equal(joseLoan.sub(parseEther('1200')));

      expect(bobCollateral2).to.be.equal(bobCollateral);
      // Alice collateral 2 must be lower than collateral 1 minus loan liquidated + 10% due to fees
      expect(aliceCollateral2).to.be.closeTo(
        aliceCollateral.sub(
          convertBorrowToLiquidationCollateral(
            parseEther('2450'),
            exchangeRate2
          )
        ),
        1e7
      );
      expect(joseCollateral2).to.be.closeTo(
        joseCollateral.sub(
          convertBorrowToLiquidationCollateral(
            parseEther('1200'),
            exchangeRate2
          )
        ),
        1e7
      );

      expect(bobRewards2).to.be.equal(bobRewards);
      expect(aliceRewards2).to.be.equal(
        totalRewards.mul(aliceCollateral2).div(ONE_V_TOKEN)
      );
      expect(joseRewards2).to.be.equal(
        totalRewards.mul(joseCollateral2).div(ONE_V_TOKEN)
      );
      expect(aliceXVSBalance2).to.be.equal(
        totalRewards
          .mul(aliceCollateral)
          .div(ONE_V_TOKEN)
          .add(aliceXVSBalance)
          .sub(aliceRewards)
      );
      expect(bobXVSBalance2).to.be.equal(bobXVSBalance);
      expect(joseXVSBalance2).to.be.equal(
        totalRewards
          .mul(joseCollateral)
          .div(ONE_V_TOKEN)
          .add(joseXVSBalance)
          .sub(joseRewards)
      );
      expect(totalVCollateral2).to.be.closeTo(
        totalVCollateral.sub(
          convertBorrowToLiquidationCollateral(
            parseEther('3650'),
            exchangeRate2
          )
        ),
        ONE_V_TOKEN
      );
      expect(totalLoan2.base).to.be.equal(
        aliceLoan2.add(joseLoan2).add(bobLoan2)
      );
      expect(totalLoan2.elastic).to.be.closeTo(
        parseEther('800'),
        parseEther('2') // 2 DNR to account for fees
      );
      // Fees earned have to be greater than prev fees plus loan accrued fees.
      expect(
        loan2.feesEarned.gt(
          loan.feesEarned.add(
            ethers.BigNumber.from(12e8)
              .mul(parseEther('3650'))
              .mul(BigNumber.from(10_000))
              .div(parseEther('1'))
          )
        )
      );

      // liquidator got rewarded in BNB
      expect(ownerBNBBalance2).closeTo(
        ownerBNBBalance,
        parseEther('0.1') // fees
      );

      expect(recipientBNBBalance2).to.be.equal(recipientBNBBalance);
      expect(recipientVBNBBalance2).to.be.closeTo(
        // Principal + Interest
        parseEther('3650')
          .add(
            ethers.BigNumber.from(12e8)
              .mul(parseEther('3650'))
              .mul(BigNumber.from(10_000))
              .div(parseEther('1'))
          )
          // 10% fee
          .add(
            parseEther('3650')
              .add(
                ethers.BigNumber.from(12e8)
                  .mul(parseEther('3650'))
                  .mul(BigNumber.from(10_000))
                  .div(parseEther('1'))
              )
              .mul(parseEther('0.1'))
              .div(parseEther('1'))
          )
          // Convert to BNB
          .mul(parseEther('1'))
          .div(parseEther('300'))
          // Convert to VBNB
          .mul(parseEther('1'))
          .div(exchangeRate2)
          .add(recipientVBNBBalance),
        1e4
      );
      expect(ownerVBNBBalance).to.be.equal(0);
    });
  });
  describe('update functionality', () => {
    it('reverts if a non-owner tries to update it', async () => {
      await market.connect(owner).renounceOwnership();

      await expect(
        upgrade(market, 'TestInterestBNBBearingMarketV2')
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('upgrades to version 2', async () => {
      await market.connect(alice).addCollateral({ value: parseEther('10') });

      const marketV2: TestInterestBNBBearingMarketV2 = await upgrade(
        market,
        'TestInterestBNBBearingMarketV2'
      );

      const [exchangeRate, aliceVBNBBalance] = await Promise.all([
        vBNBContract.callStatic.exchangeRateCurrent(),
        vBNBContract.balanceOf(alice.address),
      ]);

      await marketV2
        .connect(alice)
        .withdrawCollateral(
          parseEther('5').mul(parseEther('1')).div(exchangeRate),
          false
        );

      const [version, aliceCollateral, aliceVBNBBalance2, exchangeRate2] =
        await Promise.all([
          marketV2.version(),
          marketV2.userCollateral(alice.address),
          vBNBContract.balanceOf(alice.address),
          vBNBContract.callStatic.exchangeRateCurrent(),
        ]);

      expect(version).to.be.equal('V2');
      expect(aliceCollateral).to.be.closeTo(
        parseEther('5').mul(parseEther('1')).div(exchangeRate2),
        1e3
      );
      expect(aliceVBNBBalance2).to.be.closeTo(
        parseEther('5')
          .mul(parseEther('1'))
          .div(exchangeRate2)
          .add(aliceVBNBBalance),
        1e4
      );
    });
  });

  it('reverts if you pass an unknown request', async () => {
    await expect(
      market
        .connect(alice)
        .request(
          [7],
          [defaultAbiCoder.encode(['uint256'], [parseEther('2')])],
          { value: parseEther('2') }
        )
    ).to.be.revertedWith('DM: invalid request');
  });

  describe('function: request addCollateral', () => {
    it('reverts if you try to abuse the msg.value', async () => {
      await expect(
        market
          .connect(alice)
          .request(
            [ADD_COLLATERAL_REQUEST, ADD_COLLATERAL_REQUEST],
            [
              defaultAbiCoder.encode(['uint256'], [parseEther('2')]),
              defaultAbiCoder.encode(['uint256'], [parseEther('2')]),
            ],
            { value: parseEther('2') }
          )
      ).to.reverted;
    });
    it('reverts if it fails to mint vBNB', async () => {
      const receiveErrorContract = await deploy('MockReceiveErrorVBNB', []);

      const vBNBCode = await network.provider.send('eth_getCode', [vBNB]);

      const code = await network.provider.send('eth_getCode', [
        receiveErrorContract.address,
      ]);

      await network.provider.send('hardhat_setCode', [vBNB, code]);

      await expect(
        market
          .connect(alice)
          .request(
            [ADD_COLLATERAL_REQUEST],
            [defaultAbiCoder.encode(['uint256'], [parseEther('2')])],
            { value: parseEther('2') }
          )
      ).to.revertedWith('DM: unable to send bnb');

      await network.provider.send('hardhat_setCode', [vBNB, vBNBCode]);
    });
    it('accepts BNB deposits', async () => {
      const [
        aliceCollateral,
        totalRewardsPerVToken,
        totalVCollateral,
        aliceRewards,
        vBNBExchangeRate,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        vBNBContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral).to.be.equal(0);
      expect(totalRewardsPerVToken).to.be.equal(0);
      expect(totalVCollateral).to.be.equal(0);
      expect(aliceRewards).to.be.equal(0);

      await expect(
        market
          .connect(alice)
          .request(
            [ADD_COLLATERAL_REQUEST],
            [defaultAbiCoder.encode(['uint256'], [parseEther('10')])],
            { value: parseEther('10') }
          )
      )
        .to.emit(market, 'AddCollateral')
        .withArgs(
          alice.address,
          parseEther('10'),
          parseEther('10').mul(parseEther('1')).div(vBNBExchangeRate)
        );

      const vBNBExchangeRate2 =
        await vBNBContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(bob)
          .request(
            [ADD_COLLATERAL_REQUEST],
            [defaultAbiCoder.encode(['uint256'], [parseEther('5')])],
            { value: parseEther('5') }
          )
      )
        .to.emit(market, 'AddCollateral')
        .withArgs(
          alice.address,
          parseEther('5'),
          parseEther('5').mul(parseEther('1')).div(vBNBExchangeRate2)
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
        vBNBExchangeRate3,
        bobCollateral,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        market.rewardsOf(bob.address),
        market.userCollateral(bob.address),
        vBNBContract.callStatic.exchangeRateCurrent(),
        market.userCollateral(bob.address),
      ]);

      expect(aliceCollateral2).to.be.closeTo(
        parseEther('10').mul(parseEther('1')).div(vBNBExchangeRate3),
        1e5
      );
      expect(bobCollateral2).to.be.closeTo(
        parseEther('5').mul(parseEther('1')).div(vBNBExchangeRate3),
        1e5
      );
      expect(totalRewardsPerVToken2.gt(0)).to.be.equal(true);

      expect(totalVCollateral2).to.be.closeTo(
        parseEther('15').mul(parseEther('1')).div(vBNBExchangeRate3),
        1e5
      );
      expect(aliceRewards2).to.be.equal(0);
      expect(bobRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(bobCollateral).div(ONE_V_TOKEN)
      );

      await expect(
        market
          .connect(alice)
          .request(
            [ADD_COLLATERAL_REQUEST],
            [defaultAbiCoder.encode(['uint256'], [parseEther('5')])],
            { value: parseEther('5') }
          )
      )
        .to.emit(market, 'AddCollateral')
        .withArgs(
          alice.address,
          parseEther('5'),
          parseEther('5').mul(parseEther('1')).div(vBNBExchangeRate3)
        )
        .to.emit(VenusControllerContract, 'Claim')
        .to.emit(XVSContract, 'Transfer');

      const [
        aliceCollateral3,
        totalRewardsPerVToken3,
        totalVCollateral3,
        aliceRewards3,
        bobRewards3,
        bobCollateral3,
        vBNBExchangeRate4,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        market.rewardsOf(bob.address),
        market.userCollateral(bob.address),
        vBNBContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral3).to.be.closeTo(
        parseEther('15').mul(parseEther('1')).div(vBNBExchangeRate4),
        1e5
      );
      expect(bobCollateral3).to.be.closeTo(
        parseEther('5').mul(parseEther('1')).div(vBNBExchangeRate4),
        1e5
      );

      expect(totalVCollateral3).to.be.closeTo(
        parseEther('20').mul(parseEther('1')).div(vBNBExchangeRate4),
        1e5
      );

      expect(aliceRewards3).to.be.equal(
        aliceCollateral3.mul(totalRewardsPerVToken3).div(ONE_V_TOKEN)
      );

      expect(bobRewards3).to.be.equal(
        totalRewardsPerVToken2.mul(bobCollateral2).div(ONE_V_TOKEN)
      );

      await expect(
        market
          .connect(alice)
          .request(
            [ADD_COLLATERAL_REQUEST],
            [defaultAbiCoder.encode(['uint256'], [parseEther('5')])],
            { value: parseEther('5') }
          )
      ).to.emit(XVSContract, 'Transfer');

      const [totalRewardsPerVToken4, aliceRewards4] = await Promise.all([
        market.totalRewardsPerVToken(),
        market.rewardsOf(alice.address),
      ]);

      expect(aliceRewards4).to.be.closeTo(
        parseEther('20')
          .mul(parseEther('1'))
          .div(vBNBExchangeRate4)
          .mul(totalRewardsPerVToken4)
          .div(ONE_V_TOKEN),
        parseEther('1')
      );
    });
  });

  describe('function: request withdraw collateral', () => {
    it('reverts if the user is insolvent', async () => {
      await market.connect(alice).addCollateral({ value: parseEther('10') });

      await market.connect(alice).borrow(bob.address, parseEther('2000'));

      const vBNBExchangeRate =
        await vBNBContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(alice)
          .request(
            [WITHDRAW_COLLATERAL_REQUEST],
            [
              defaultAbiCoder.encode(
                ['uint256', 'bool'],
                [
                  parseEther('2.1').mul(parseEther('1')).div(vBNBExchangeRate),
                  false,
                ]
              ),
            ]
          )
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('reverts if vBNB fails to redeem the underlying', async () => {
      const [errorVBNB, mockVenus] = await multiDeploy(
        ['MockRedeemUnderlyingErrorVBNB', 'MockVenusControllerClaimVenus'],
        []
      );

      const [vBNBCode, controllerCode, errorVBNbCode, mockVenusCode] =
        await Promise.all([
          network.provider.send('eth_getCode', [vBNB]),
          network.provider.send('eth_getCode', [VENUS_CONTROLLER]),
          network.provider.send('eth_getCode', [errorVBNB.address]),
          network.provider.send('eth_getCode', [mockVenus.address]),
        ]);

      await market.connect(alice).addCollateral({ value: parseEther('2') });

      await Promise.all([
        network.provider.send('hardhat_setCode', [vBNB, errorVBNbCode]),
        network.provider.send('hardhat_setCode', [
          VENUS_CONTROLLER,
          mockVenusCode,
        ]),
      ]);

      await expect(
        market
          .connect(alice)
          .request(
            [WITHDRAW_COLLATERAL_REQUEST],
            [defaultAbiCoder.encode(['uint256', 'bool'], [ONE_V_TOKEN, true])]
          )
      ).to.revertedWith('DM: failed to redeem');

      await Promise.all([
        network.provider.send('hardhat_setCode', [vBNB, vBNBCode]),
        network.provider.send('hardhat_setCode', [
          VENUS_CONTROLLER,
          controllerCode,
        ]),
      ]);
    });
    it('allows collateral to be withdrawn in vBNB', async () => {
      await market.connect(alice).addCollateral({ value: parseEther('10') });

      await market.connect(alice).borrow(alice.address, parseEther('100'));

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      const exchangeRate = await vBNBContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(alice)
          .request(
            [WITHDRAW_COLLATERAL_REQUEST],
            [
              defaultAbiCoder.encode(
                ['uint256', 'bool'],
                [parseEther('2').mul(parseEther('1')).div(exchangeRate), false]
              ),
            ]
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(vBNBContract, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          0,
          parseEther('2').mul(parseEther('1')).div(exchangeRate)
        )
        .to.emit(XVS, 'Transfer')
        .to.emit(vBNBContract, 'Transfer')
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.not.emit(vBNBContract, 'Redeem');

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
        vBNBContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral).to.be.closeTo(
        parseEther('8').mul(parseEther('1')).div(exchangeRate2),
        1e5
      );
      expect(totalVCollateral).to.be.closeTo(
        parseEther('8').mul(parseEther('1')).div(exchangeRate2),
        1e5
      );
      expect(aliceRewards).to.be.equal(
        aliceCollateral.mul(totalRewardsPerVToken).div(ONE_V_TOKEN)
      );

      await market.connect(bob).addCollateral({ value: parseEther('5') });

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      await expect(
        market
          .connect(alice)
          .request(
            [WITHDRAW_COLLATERAL_REQUEST],
            [
              defaultAbiCoder.encode(
                ['uint256', 'bool'],
                [parseEther('1').mul(parseEther('1')).div(exchangeRate2), false]
              ),
            ]
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(vBNBContract, 'Transfer')
        .withArgs(
          market.address,
          alice.address,
          0,
          parseEther('1').mul(parseEther('1')).div(exchangeRate2)
        )
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(XVSContract, 'Transfer')
        .to.not.emit(vBNBContract, 'Redeem');

      const [
        aliceCollateral2,
        totalRewardsPerVToken2,
        totalVCollateral2,
        aliceRewards2,
        exchangeRate3,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        vBNBContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral2).to.be.closeTo(
        parseEther('7').mul(parseEther('1')).div(exchangeRate3),
        1e5
      );

      expect(totalVCollateral2).to.be.closeTo(
        parseEther('12').mul(parseEther('1')).div(exchangeRate3),
        1e5
      );
      expect(aliceRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(aliceCollateral2).div(ONE_V_TOKEN)
      );
    });

    it('allows BNB to be withdrawn', async () => {
      await market.connect(alice).addCollateral({ value: parseEther('10') });

      await market.connect(alice).borrow(alice.address, parseEther('100'));

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      const [aliceBalance, exchangeRate, aliceVBNBBalance] = await Promise.all([
        alice.getBalance(),
        vBNBContract.callStatic.exchangeRateCurrent(),
        vBNBContract.balanceOf(alice.address),
      ]);

      await expect(
        market
          .connect(alice)
          .request(
            [WITHDRAW_COLLATERAL_REQUEST],
            [
              defaultAbiCoder.encode(
                ['uint256', 'bool'],
                [parseEther('2').mul(parseEther('1')).div(exchangeRate), true]
              ),
            ]
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(vBNBContract, 'Redeem')
        .withArgs(parseEther('2'))
        .to.emit(market, 'WithdrawCollateral')
        .withArgs(
          alice.address,
          parseEther('2'),
          parseEther('2').mul(parseEther('1')).div(exchangeRate)
        )
        .to.emit(XVSContract, 'Transfer')
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus');

      const [
        aliceCollateral,
        totalRewardsPerVToken,
        totalVCollateral,
        aliceRewards,
        aliceBalance2,
        aliceVBNBBalance2,
        exchangeRate2,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        alice.getBalance(),
        vBNBContract.balanceOf(alice.address),
        vBNBContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(aliceCollateral).to.be.closeTo(
        parseEther('8').mul(parseEther('1')).div(exchangeRate2),
        1e4
      );

      expect(totalVCollateral).to.be.equal(aliceCollateral);
      expect(aliceRewards).to.be.closeTo(
        totalRewardsPerVToken.mul(aliceCollateral).div(ONE_V_TOKEN),
        1e4
      );
      expect(aliceBalance2).to.be.closeTo(
        aliceBalance.add(parseEther('2')),
        parseEther('0.1') // TX fees
      );
      expect(aliceVBNBBalance2).to.be.equal(aliceVBNBBalance);

      await market.connect(bob).addCollateral({ value: parseEther('5') });

      // Make sure accrue gets called
      await advanceTime(100, ethers); // advance 100 seconds

      const exchangeRate3 = await vBNBContract.callStatic.exchangeRateCurrent();

      await expect(
        market
          .connect(alice)
          .request(
            [WITHDRAW_COLLATERAL_REQUEST],
            [
              defaultAbiCoder.encode(
                ['uint256', 'bool'],
                [parseEther('3').mul(parseEther('1')).div(exchangeRate3), true]
              ),
            ]
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus')
        .to.emit(vBNBContract, 'Redeem')
        .withArgs(parseEther('3'))
        .to.emit(market, 'WithdrawCollateral')
        .withArgs(
          alice.address,
          parseEther('3'),
          parseEther('3').mul(parseEther('1')).div(exchangeRate3)
        )
        .to.emit(XVSContract, 'Transfer');

      const [
        aliceCollateral2,
        totalRewardsPerVToken2,
        totalVCollateral2,
        aliceRewards2,
        aliceBalance3,
        aliceVBNBBalance3,
      ] = await Promise.all([
        market.userCollateral(alice.address),
        market.totalRewardsPerVToken(),
        market.totalVCollateral(),
        market.rewardsOf(alice.address),
        alice.getBalance(),
        vBNBContract.balanceOf(alice.address),
      ]);

      expect(aliceCollateral2).to.be.closeTo(
        parseEther('5').mul(parseEther('1')).div(exchangeRate3),
        1e4
      );

      expect(totalVCollateral2).to.be.closeTo(
        parseEther('10').mul(parseEther('1')).div(exchangeRate3),
        1e4
      );
      expect(aliceRewards2).to.be.equal(
        totalRewardsPerVToken2.mul(aliceCollateral2).div(ONE_V_TOKEN)
      );
      expect(aliceBalance3).to.be.closeTo(
        aliceBalance2.add(parseEther('3')),
        parseEther('0.1') // TX tax
      );
      expect(aliceVBNBBalance3).to.be.equal(aliceVBNBBalance2);

      await expect(
        market
          .connect(alice)
          .request(
            [WITHDRAW_COLLATERAL_REQUEST],
            [defaultAbiCoder.encode(['uint256', 'bool'], [0, true])]
          )
      )
        .to.emit(XVS, 'Transfer')
        .to.emit(VenusControllerContract, 'DistributedSupplierVenus');
    });
  });

  describe('nonReentrancy', () => {
    it('reverts if you reenter the withdraw collateral function', async () => {
      const reenterContract = (await deploy(
        'ReentrantInterestBearingBNBMarketWithdrawCollateral',
        [market.address]
      )) as ReentrantInterestBearingBNBMarketWithdrawCollateral;

      await reenterContract
        .connect(bob)
        .addCollateral({ value: parseEther('5') });

      await expect(
        reenterContract.connect(bob).withdrawCollateral(ONE_V_TOKEN, true)
      ).to.revertedWith('ReentrancyGuard: reentrant call');
    });

    it('reverts if you reenter the request function', async () => {
      const reenterContract = (await deploy(
        'ReentrantInterestBearingBNBMarketRequest',
        [market.address]
      )) as ReentrantInterestBearingBNBMarketRequest;

      await reenterContract
        .connect(bob)
        .addCollateral({ value: parseEther('5') });

      await expect(
        reenterContract
          .connect(bob)
          .request(
            [WITHDRAW_COLLATERAL_REQUEST],
            [defaultAbiCoder.encode(['uint256', 'bool'], [ONE_V_TOKEN, true])]
          )
      ).to.revertedWith('ReentrancyGuard: reentrant call');
    });

    it('reverts if you reenter the liquidate function', async () => {
      const market: InterestBNBBearingMarket = await deployUUPS(
        'InterestBNBBearingMarket',
        [
          dinero.address,
          treasury.address,
          mockOracle.address,
          INTEREST_RATE,
          ethers.BigNumber.from('500000000000000000'),
          ethers.BigNumber.from('100000000000000000'),
        ]
      );

      await mockOracle.__setBNBUSDPrice(parseEther('500'));

      await Promise.all([
        market.updateExchangeRate(),
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      ]);

      await market.connect(alice).addCollateral({ value: parseEther('10') });

      await market.connect(alice).borrow(alice.address, parseEther('2200'));

      // Drop BNB to 300. Alice and Jose can now be liquidated
      await mockOracle.__setBNBUSDPrice(parseEther('300'));

      const reenterContract = (await deploy(
        'ReentrantInterestBearingBNBMarketLiquidate',
        [market.address]
      )) as ReentrantInterestBearingBNBMarketLiquidate;

      await dinero
        .connect(owner)
        .mint(reenterContract.address, parseEther('7000000'));

      await expect(
        reenterContract
          .connect(owner)
          .liquidate(
            [alice.address],
            [parseEther('2200')],
            reenterContract.address,
            true,
            []
          )
      ).to.revertedWith('ReentrancyGuard: reentrant call');
    });
  });

  describe('function: request borrow', () => {
    it('reverts if you borrow to the zero address', async () => {
      await expect(
        market
          .connect(alice)
          .request(
            [BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [ethers.constants.AddressZero, 1]
              ),
            ]
          )
      ).to.revertedWith('MKT: no zero address');
    });
    it('reverts if the user is insolvent', async () => {
      await market.connect(alice).addCollateral({ value: parseEther('2') });

      await expect(
        market
          .connect(alice)
          .request(
            [BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [bob.address, parseEther('500')]
              ),
            ]
          )
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('allows a user to borrow as long as he remains solvent', async () => {
      await market.connect(alice).addCollateral({ value: parseEther('2') });

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
        market
          .connect(alice)
          .request(
            [BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [bob.address, parseEther('200')]
              ),
            ]
          )
      )
        .to.emit(dinero, 'Transfer')
        .withArgs(ethers.constants.AddressZero, bob.address, parseEther('200'))
        .to.emit(market, 'Borrow')
        .to.not.emit(market, 'Accrue');

      const [totalLoan2, aliceLoan2, aliceDineroBalance2, bobDineroBalance2] =
        await Promise.all([
          market.totalLoan(),
          market.userLoan(alice.address),
          dinero.balanceOf(alice.address),
          dinero.balanceOf(bob.address),
        ]);

      expect(totalLoan2.base).to.be.equal(parseEther('200'));
      expect(totalLoan2.elastic).to.be.equal(parseEther('200'));
      expect(aliceLoan2).to.be.equal(parseEther('200'));
      expect(aliceDineroBalance2).to.be.equal(aliceDineroBalance);
      expect(bobDineroBalance2).to.be.equal(
        bobDineroBalance.add(parseEther('200'))
      );

      await advanceTime(10_000, ethers); // advance 10_000 seconds

      await expect(
        market
          .connect(alice)
          .request(
            [BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('199')]
              ),
            ]
          )
      )
        .to.emit(market, 'Accrue')
        .to.emit(dinero, 'Transfer')
        .withArgs(
          ethers.constants.AddressZero,
          alice.address,
          parseEther('199')
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
      expect(
        totalLoan3.base.gt(totalLoan2.base.add(parseEther('190')))
      ).to.be.equal(true); // Interest rate makes it hard to calculate the exact value
      expect(
        totalLoan3.elastic.gte(totalLoan2.elastic.add(parseEther('199')))
      ).to.be.equal(true);
      expect(aliceLoan3.gt(aliceLoan2.add(parseEther('190')))).to.be.equal(
        true
      ); // Interest rate makes it hard to calculate the exact value
      expect(aliceDineroBalance3).to.be.equal(
        aliceDineroBalance2.add(parseEther('199'))
      );
      expect(bobDineroBalance3).to.be.equal(bobDineroBalance2);
      expect(bobLoan).to.be.equal(0);
    });
  });

  describe('function: request repay', () => {
    it('reverts if you pass zero address or 0 principal', async () => {
      await expect(
        market.request(
          [REPAY_REQUEST],
          [
            defaultAbiCoder.encode(
              ['address', 'uint256'],
              [ethers.constants.AddressZero, 1]
            ),
          ]
        )
      ).to.revertedWith('MKT: no zero address');
      await expect(
        market.request(
          [REPAY_REQUEST],
          [defaultAbiCoder.encode(['address', 'uint256'], [alice.address, 0])]
        )
      ).to.revertedWith('MKT: principal cannot be 0');
    });
    it('allows a user to repay a debt', async () => {
      await market
        .connect(alice)
        .request(
          [ADD_COLLATERAL_REQUEST, BORROW_REQUEST],
          [
            defaultAbiCoder.encode(['uint256'], [parseEther('2')]),
            defaultAbiCoder.encode(
              ['address', 'uint256'],
              [alice.address, parseEther('300')]
            ),
          ],
          { value: parseEther('2') }
        );

      const [ownerDineroBalance, aliceLoan, totalLoan] = await Promise.all([
        dinero.balanceOf(owner.address),
        market.userLoan(alice.address),
        market.totalLoan(),
        advanceTime(1000, ethers),
      ]);

      await expect(
        market
          .connect(owner)
          .request(
            [REPAY_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('150')]
              ),
            ]
          )
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
        ownerDineroBalance2.lte(ownerDineroBalance.sub(parseEther('150')))
      ).to.be.equal(true);
      expect(aliceLoan).to.be.equal(parseEther('300'));
      expect(aliceLoan2).to.be.equal(parseEther('150'));
      expect(totalLoan.elastic).to.be.equal(parseEther('300'));
      expect(totalLoan.base).to.be.equal(parseEther('300'));
      expect(totalLoan2.base).to.be.equal(parseEther('150'));
      expect(
        totalLoan2.elastic.gt(totalLoan.elastic.sub(parseEther('150')))
      ).to.be.equal(true);
    });
  });
}).timeout(40_000);
