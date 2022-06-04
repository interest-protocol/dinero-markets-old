import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { Contract } from 'ethers';
import { ethers, network } from 'hardhat';

import PCSFactoryABI from '../abi/pcs-factory.json';
import PCSRouterABI from '../abi/pcs-router.json';
import WBNBABI from '../abi/wbnb.json';
import {
  Dinero,
  InterestBNBMarket,
  MockOracle,
  MockTWAP,
  Oracle,
  ReentrantInterestBNBMarketLiquidate,
  ReentrantInterestBNBMarketRequest,
  ReentrantInterestBNBMarketWithdrawCollateral,
  TestInterestBNBMarketV2,
} from '../typechain';
import {
  ADD_COLLATERAL_REQUEST,
  BORROW_REQUEST,
  BURNER_ROLE,
  MINTER_ROLE,
  PCS_FACTORY,
  PCS_ROUTER,
  REPAY_REQUEST,
  WBNB,
  WBNB_WHALE,
  WITHDRAW_COLLATERAL_REQUEST,
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

const INTEREST_RATE = ethers.BigNumber.from(12e8);

const MAX_LTV = ethers.BigNumber.from('500000000000000000');

const LIQUIDATION_FEE = ethers.BigNumber.from('100000000000000000');

const { parseEther, defaultAbiCoder } = ethers.utils;

describe('InterestBNBMarket', () => {
  let market: InterestBNBMarket;
  let dinero: Dinero;
  let oracle: Oracle;
  let router: Contract;
  let mockTWAP: MockTWAP;
  let mockOracle: MockOracle;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let treasury: SignerWithAddress;
  let jose: SignerWithAddress;
  let recipient: SignerWithAddress;

  before(async () => {
    [owner, alice, bob, treasury, recipient, jose] = await ethers.getSigners();

    dinero = await deployUUPS('Dinero', []);
    await Promise.all([
      dinero.connect(owner).grantRole(MINTER_ROLE, owner.address),
      impersonate(WBNB_WHALE),
    ]);

    const wbnbWhaleSigner = await ethers.getSigner(WBNB_WHALE);

    router = new ethers.Contract(PCS_ROUTER, PCSRouterABI, wbnbWhaleSigner);
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

    market = await deployUUPS('InterestBNBMarket', [
      dinero.address,
      treasury.address,
      oracle.address,
      INTEREST_RATE,
      MAX_LTV,
      LIQUIDATION_FEE,
      ethers.constants.MaxUint256,
    ]);

    await Promise.all([
      dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
      market.updateExchangeRate(),
    ]);
  });

  describe('function: initialize', () => {
    it('reverts if you initialize after deployment', async () => {
      await expect(
        market
          .connect(alice)
          .initialize(
            dinero.address,
            treasury.address,
            oracle.address,
            INTEREST_RATE,
            MAX_LTV,
            LIQUIDATION_FEE,
            ethers.constants.MaxUint256
          )
      ).to.revertedWith('Initializable: contract is already initialized');
    });

    it('sets the initial state correctly', async () => {
      const [
        _owner,
        _dinero,
        _feeTo,
        _oracle,
        _loan,
        _maxLTVRatio,
        _liquidationFee,
        maxBorrowAmount,
      ] = await Promise.all([
        market.owner(),
        market.DINERO(),
        market.FEE_TO(),
        market.ORACLE(),
        market.loan(),
        market.maxLTVRatio(),
        market.liquidationFee(),
        market.maxBorrowAmount(),
      ]);

      expect(_owner).to.be.equal(owner.address);
      expect(_dinero).to.be.equal(dinero.address);
      expect(_feeTo).to.be.equal(treasury.address);
      expect(_oracle).to.be.equal(oracle.address);
      expect(_loan.INTEREST_RATE).to.be.equal(INTEREST_RATE);
      expect(_maxLTVRatio).to.be.equal(MAX_LTV);
      expect(_liquidationFee).to.be.equal(LIQUIDATION_FEE);
      expect(maxBorrowAmount).to.be.equal(maxBorrowAmount);
    });
  });

  it('sends the fees earned to the feeTo address', async () => {
    await alice.sendTransaction({
      to: market.address,
      value: parseEther('3'),
    });

    await market.connect(alice).borrow(alice.address, parseEther('500'));

    // Pass time to accrue fees
    await advanceTime(10_000, ethers); // advance 10_000 seconds

    const debt = parseEther('500')
      .mul(ethers.BigNumber.from(12e8))
      .mul(10_000)
      .div(parseEther('1'));

    const [treasuryDineroBalance, totalLoan] = await Promise.all([
      dinero.balanceOf(treasury.address),
      market.totalLoan(),
    ]);

    expect(treasuryDineroBalance).to.be.equal(0);
    // Accrue has not been called
    expect(totalLoan.elastic).to.be.equal(parseEther('500'));
    expect(totalLoan.base).to.be.equal(parseEther('500'));

    await expect(market.getEarnings())
      .to.emit(market, 'Accrue')
      .to.emit(market, 'GetEarnings');

    const [loan2, totalLoan2, treasuryDineroBalance2] = await Promise.all([
      market.loan(),
      market.totalLoan(),
      dinero.balanceOf(treasury.address),
    ]);
    expect(loan2.feesEarned).to.be.equal(0);
    expect(
      treasuryDineroBalance2.gte(treasuryDineroBalance.add(debt))
    ).to.be.equal(true);
    expect(totalLoan2.elastic.gte(parseEther('700').add(debt)));
    expect(totalLoan2.base).to.be.equal(parseEther('500'));
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
      await market
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('10') });

      await advanceBlock(ethers);

      // Borrow 490 DINERO
      await market.connect(alice).borrow(alice.address, parseEther('490'));

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
      await alice.sendTransaction({
        to: market.address,
        value: parseEther('3'),
      });

      await market.connect(alice).borrow(alice.address, parseEther('500'));
      const [loan, totalLoan] = await Promise.all([
        market.loan(),
        market.totalLoan(),
      ]);

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // advance 10_000 seconds
      const debt = parseEther('500')
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
    it('reverts if the rate is 0', async () => {
      const market = await deployUUPS('InterestBNBMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        INTEREST_RATE,
        MAX_LTV,
        LIQUIDATION_FEE,
        ethers.constants.MaxUint256,
      ]);

      await expect(market.updateExchangeRate()).to.revertedWith(
        'MKT: invalid exchange rate'
      );
    });
    it('does not update the state if the interest rate is the same', async () => {
      const market = await deployUUPS('InterestBNBMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        INTEREST_RATE,
        MAX_LTV,
        LIQUIDATION_FEE,
        ethers.constants.MaxUint256,
      ]);

      await mockOracle.__setBNBUSDPrice(parseEther('500'));
      await market.updateExchangeRate();

      expect(await market.exchangeRate()).to.be.equal(parseEther('500'));

      await expect(market.updateExchangeRate()).to.not.emit(
        market,
        'ExchangeRate'
      );
      expect(await market.exchangeRate()).to.be.equal(parseEther('500'));
    });
    it('updates the exchange rate', async () => {
      const market = await deployUUPS('InterestBNBMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        INTEREST_RATE,
        MAX_LTV,
        LIQUIDATION_FEE,
        ethers.constants.MaxUint256,
      ]);

      await mockOracle.__setBNBUSDPrice(parseEther('500'));
      await market.updateExchangeRate();

      await mockOracle.__setBNBUSDPrice(parseEther('300'));

      await expect(market.updateExchangeRate())
        .to.emit(market, 'ExchangeRate')
        .withArgs(parseEther('300'));

      expect(await market.exchangeRate()).to.be.equal(parseEther('300'));
    });
  });

  describe('function: addCollateral', () => {
    it('reverts if the to address is the zero address', async () => {
      await expect(
        market.connect(alice).addCollateral(ethers.constants.AddressZero)
      ).to.revertedWith('DM: no zero address');
    });

    it('allows an account to add collateral', async () => {
      const [aliceCollateral, bobCollateral] = await Promise.all([
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
      ]);

      expect(aliceCollateral).to.be.equal(0);
      expect(bobCollateral).to.be.equal(0);

      await expect(
        market
          .connect(alice)
          .addCollateral(bob.address, { value: parseEther('5') })
      )
        .to.emit(market, 'AddCollateral')
        .withArgs(alice.address, bob.address, parseEther('5'));

      expect(await market.userCollateral(bob.address)).to.be.equal(
        parseEther('5')
      );

      await expect(
        market
          .connect(alice)
          .addCollateral(alice.address, { value: parseEther('2') })
      )
        .to.emit(market, 'AddCollateral')
        .withArgs(alice.address, alice.address, parseEther('2'));

      expect(await market.userCollateral(alice.address)).to.be.equal(
        parseEther('2')
      );

      await expect(
        alice.sendTransaction({
          to: market.address,
          value: parseEther('1'),
        })
      )
        .to.emit(market, 'AddCollateral')
        .withArgs(alice.address, alice.address, parseEther('1'));

      expect(await market.userCollateral(alice.address)).to.be.equal(
        parseEther('3')
      );
    });
  });

  describe('function: withdrawCollateral', () => {
    it('reverts if the caller is insolvent', async () => {
      await market
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

      await market.connect(alice).borrow(alice.address, parseEther('400'));

      await expect(
        market.connect(alice).withdrawCollateral(alice.address, parseEther('2'))
      ).to.revertedWith('MKT: sender is insolvent');

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(alice.address, parseEther('1.1'))
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('allows collateral to be withdrawn', async () => {
      const market = await deployUUPS('InterestBNBMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        INTEREST_RATE,
        MAX_LTV,
        LIQUIDATION_FEE,
        ethers.constants.MaxUint256,
      ]);

      await mockOracle.__setBNBUSDPrice(parseEther('500'));

      await Promise.all([
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
        market.updateExchangeRate(),
      ]);

      await market
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

      const [bobBalance, aliceCollateral] = await Promise.all([
        bob.getBalance(),
        market.userCollateral(alice.address),
        market.connect(alice).borrow(alice.address, parseEther('100')),
      ]);

      await mockOracle.__setBNBUSDPrice(parseEther('510'));

      await expect(
        market.connect(alice).withdrawCollateral(bob.address, parseEther('1.5'))
      )
        .to.emit(market, 'Accrue')
        .to.emit(market, 'ExchangeRate')
        .to.emit(market, 'WithdrawCollateral')
        .withArgs(alice.address, bob.address, parseEther('1.5'));

      const [bobBalance2, aliceCollateral2] = await Promise.all([
        bob.getBalance(),
        market.userCollateral(alice.address),
      ]);

      expect(bobBalance2).to.be.equal(bobBalance.add(parseEther('1.5')));
      expect(aliceCollateral.sub(parseEther('1.5'))).to.be.equal(
        aliceCollateral2
      );
    });
    it('reverts if the caller tries to reenter', async () => {
      const attackContract: ReentrantInterestBNBMarketWithdrawCollateral =
        await deploy('ReentrantInterestBNBMarketWithdrawCollateral', [
          market.address,
        ]);

      await market
        .connect(alice)
        .addCollateral(attackContract.address, { value: parseEther('2') });

      await expect(
        attackContract
          .connect(alice)
          .withdrawCollateral(attackContract.address, parseEther('1.5'))
      ).to.revertedWith('ReentrancyGuard: reentrant call');
    });
  });
  describe('function: borrow', () => {
    it('reverts if you borrow to the zero address', async () => {
      await expect(
        market.connect(alice).borrow(ethers.constants.AddressZero, 1)
      ).to.revertedWith('MKT: no zero address');
    });
    it('reverts if the user is insolvent', async () => {
      await market
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

      await expect(
        market.connect(alice).borrow(bob.address, parseEther('500'))
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('allows a user to borrow as long as he remains solvent', async () => {
      await market
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

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
        parseEther('200').add(bobDineroBalance)
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
      await market
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

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
  describe('function: liquidate', () => {
    it('reverts if you try to reenter', async () => {
      const market = await deployUUPS('InterestBNBMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        INTEREST_RATE,
        MAX_LTV,
        LIQUIDATION_FEE,
        ethers.constants.MaxUint256,
      ]);

      await mockOracle.__setBNBUSDPrice(parseEther('500'));

      await Promise.all([
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
        market.updateExchangeRate(),
      ]);

      await Promise.all([
        market
          .connect(alice)
          .addCollateral(alice.address, { value: parseEther('2') }),
        market
          .connect(bob)
          .addCollateral(bob.address, { value: parseEther('1') }),
        market
          .connect(jose)
          .addCollateral(jose.address, { value: parseEther('10') }),
      ]);

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('499')),
        market.connect(bob).borrow(bob.address, parseEther('200')),
        market.connect(jose).borrow(jose.address, parseEther('1000')),
      ]);

      const attackContract: ReentrantInterestBNBMarketLiquidate = await deploy(
        'ReentrantInterestBNBMarketLiquidate',
        [market.address]
      );

      // Drop BNB to 250. Alice and Bob can now be liquidated
      await Promise.all([
        dinero
          .connect(owner)
          .mint(attackContract.address, parseEther('7000000')),
        mockOracle.__setBNBUSDPrice(parseEther('250')),
      ]);

      // Pass time to accrue fees
      await advanceTime(63_113_904, ethers); // advance 2 years

      await expect(
        attackContract
          .connect(owner)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [parseEther('400'), parseEther('200'), parseEther('1000')],
            attackContract.address,
            []
          )
      ).to.revertedWith('ReentrancyGuard: reentrant call');
    });
    it('reverts if last item on path is not dinero', async () => {
      await expect(
        market
          .connect(owner)
          .liquidate([], [], owner.address, [bob.address, dinero.address, WBNB])
      ).to.revertedWith('MKT: no dinero at last index');
    });
    it('ignores accounts without opened loans', async () => {
      await market
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

      await expect(
        market.connect(owner).liquidate([alice.address], [0], owner.address, [])
      ).to.revertedWith('MKT: no liquidations');
    });
    it('reverts if there are no liquidations', async () => {
      await market
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

      await market.connect(alice).borrow(alice.address, parseEther('399'));

      await expect(
        market
          .connect(owner)
          .liquidate([alice.address], [parseEther('399')], owner.address, [])
      ).to.revertedWith('MKT: no liquidations');
    });
    it('liquidates users using caller dinero funds', async () => {
      const market = await deployUUPS('InterestBNBMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        INTEREST_RATE,
        MAX_LTV,
        LIQUIDATION_FEE,
        ethers.constants.MaxUint256,
      ]);

      await mockOracle.__setBNBUSDPrice(parseEther('500'));

      await Promise.all([
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
        market.updateExchangeRate(),
      ]);

      await Promise.all([
        market
          .connect(alice)
          .addCollateral(alice.address, { value: parseEther('2') }),
        market
          .connect(bob)
          .addCollateral(bob.address, { value: parseEther('1') }),
        market
          .connect(jose)
          .addCollateral(jose.address, { value: parseEther('10') }),
      ]);

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('499')),
        market.connect(bob).borrow(bob.address, parseEther('200')),
        market.connect(jose).borrow(jose.address, parseEther('1000')),
      ]);

      // Drop BNB to 250. Alice and Bob can now be liquidated
      await mockOracle.__setBNBUSDPrice(parseEther('250'));

      const factory = new ethers.Contract(
        PCS_FACTORY,
        PCSFactoryABI,
        ethers.provider
      );

      const [
        totalCollateral,
        aliceLoan,
        bobLoan,
        joseLoan,
        aliceCollateral,
        bobCollateral,
        joseCollateral,
        loan,
        ownerDineroBalance,
        pair,
        recipientBalance,
      ] = await Promise.all([
        ethers.provider.getBalance(market.address),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.userCollateral(jose.address),
        market.loan(),
        dinero.balanceOf(owner.address),
        factory.getPair(dinero.address, WBNB),
        recipient.getBalance(),
      ]);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      expect(totalCollateral).to.be.equal(parseEther('13'));
      expect(aliceLoan).to.be.equal(parseEther('499'));
      // Due to fees paid by alice their principal is lower than 99
      expect(bobLoan.lte(parseEther('200'))).to.be.equal(true);
      expect(joseLoan.lte(parseEther('1000'))).to.be.equal(true);

      // Pass time to accrue fees
      await advanceTime(63_113_904, ethers); // advance 2 years

      await expect(
        market
          .connect(owner)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [parseEther('400'), parseEther('200'), parseEther('1000')],
            recipient.address,
            []
          )
      )
        .to.emit(market, 'ExchangeRate')
        .to.emit(market, 'Accrue')
        .to.emit(market, 'WithdrawCollateral')
        .to.emit(market, 'Repay')
        .to.emit(dinero, 'Transfer')
        .to.not.emit(pairContract, 'Swap');

      const [
        totalLoan,
        totalCollateral2,
        aliceLoan2,
        bobLoan2,
        joseLoan2,
        aliceCollateral2,
        bobCollateral2,
        joseCollateral2,
        loan2,
        ownerDineroBalance2,
        recipientBalance2,
      ] = await Promise.all([
        market.totalLoan(),
        ethers.provider.getBalance(market.address),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.userCollateral(jose.address),
        market.loan(),
        dinero.balanceOf(owner.address),
        recipient.getBalance(),
      ]);

      const allCollateral = aliceCollateral
        .sub(aliceCollateral2)
        .add(bobCollateral.sub(bobCollateral2));

      // We calculate the debt by re-engineering the formula
      const aliceDebt = aliceCollateral
        .sub(aliceCollateral2)
        .mul(ethers.BigNumber.from(250).mul(parseEther('1')))
        .mul(ethers.BigNumber.from(1e6))
        .div(
          ethers.BigNumber.from(1e6)
            .add(ethers.BigNumber.from(10e4))
            .mul(parseEther('1'))
        );

      // We calculate the debt by re-engineering the formula
      const bobDebt = bobCollateral
        .sub(bobCollateral2)
        .mul(ethers.BigNumber.from(250).mul(parseEther('1')))
        .mul(ethers.BigNumber.from(1e6))
        .div(
          ethers.BigNumber.from(1e6)
            .add(ethers.BigNumber.from(10e4))
            .mul(parseEther('1'))
        );

      const allDebt = aliceDebt.add(bobDebt);

      const allFee = allDebt.mul(ethers.BigNumber.from(10e4)).div(1e6);

      const protocolFee = allFee
        .mul(ethers.BigNumber.from(100))
        .div(ethers.BigNumber.from(1000));

      expect(aliceLoan2).to.be.equal(aliceLoan.sub(parseEther('400')));
      expect(bobLoan2).to.be.equal(0);
      expect(joseLoan2).to.be.equal(joseLoan);
      expect(joseCollateral).to.be.equal(joseCollateral2);

      expect(totalCollateral.sub(totalCollateral2)).to.be.eq(allCollateral);

      expect(recipientBalance2.sub(recipientBalance)).to.be.equal(
        allCollateral
      );

      // Means loan2 feesEarned includes accrued + protocol fee
      expect(loan2.feesEarned.sub(protocolFee).gt(loan.feesEarned)).to.be.equal(
        true
      );

      // total loan principal was properly updated
      expect(totalLoan.base).to.be.equal(joseLoan.add(aliceLoan2));
      // We repaid debt for 600 DNR + interest rate. So the remaining debt should be for 1099 DNR + fees
      // While it is hard to get the exact number we know it has to be smaller 1320 DNR after 2 years at interest rate of 4%
      expect(totalLoan.elastic.lt(parseEther('1320'))).to.be.equal(true);

      // Need to remove the 4 last decimal houses for accuracy
      expect(ownerDineroBalance.sub(ownerDineroBalance2)).to.be.closeTo(
        allDebt.add(protocolFee),
        1e4
      );
    });
    it('liquidates a user using the collateral in the contract', async () => {
      const market = await deployUUPS('InterestBNBMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        INTEREST_RATE,
        MAX_LTV,
        LIQUIDATION_FEE,
        ethers.constants.MaxUint256,
      ]);

      await mockOracle.__setBNBUSDPrice(parseEther('500'));

      await Promise.all([
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
        market.updateExchangeRate(),
      ]);

      await Promise.all([
        market
          .connect(alice)
          .addCollateral(alice.address, { value: parseEther('2') }),
        market
          .connect(bob)
          .addCollateral(bob.address, { value: parseEther('1') }),
        market
          .connect(jose)
          .addCollateral(jose.address, { value: parseEther('10') }),
      ]);

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('499')),
        market.connect(bob).borrow(bob.address, parseEther('200')),
        market.connect(jose).borrow(jose.address, parseEther('1000')),
      ]);

      // Drop BNB to 250. Alice and Bob can now be liquidated
      await mockOracle.__setBNBUSDPrice(parseEther('250'));

      const factory = new ethers.Contract(
        PCS_FACTORY,
        PCSFactoryABI,
        ethers.provider
      );

      const [
        totalCollateral,
        aliceLoan,
        bobLoan,
        joseLoan,
        aliceCollateral,
        bobCollateral,
        joseCollateral,
        loan,
        ownerDineroBalance,
        pair,
        recipientDineroBalance,
      ] = await Promise.all([
        ethers.provider.getBalance(market.address),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.userCollateral(jose.address),
        market.loan(),
        dinero.balanceOf(owner.address),
        factory.getPair(WBNB, dinero.address),
        dinero.balanceOf(recipient.address),
      ]);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      expect(totalCollateral).to.be.equal(parseEther('13'));
      expect(aliceLoan).to.be.equal(parseEther('499'));
      // Due to fees paid by alice their principal is lower than 99
      expect(bobLoan.lte(parseEther('200'))).to.be.equal(true);
      expect(joseLoan.lte(parseEther('1000'))).to.be.equal(true);

      // Pass time to accrue fees
      await advanceTime(63_113_904, ethers); // advance 2 years

      await expect(
        market
          .connect(owner)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [parseEther('400'), parseEther('200'), parseEther('1000')],
            recipient.address,
            [WBNB, dinero.address]
          )
      )
        .to.emit(market, 'ExchangeRate')
        .to.emit(market, 'Accrue')
        .to.emit(market, 'WithdrawCollateral')
        .to.emit(market, 'Repay')
        .to.emit(dinero, 'Transfer')
        .to.emit(pairContract, 'Swap');

      const [
        totalLoan,
        totalCollateral2,
        aliceLoan2,
        bobLoan2,
        joseLoan2,
        aliceCollateral2,
        bobCollateral2,
        joseCollateral2,
        loan2,
        ownerDineroBalance2,
        recipientDineroBalance2,
      ] = await Promise.all([
        market.totalLoan(),
        ethers.provider.getBalance(market.address),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.userCollateral(jose.address),
        market.loan(),
        dinero.balanceOf(owner.address),
        dinero.balanceOf(recipient.address),
      ]);

      const allCollateral = aliceCollateral
        .sub(aliceCollateral2)
        .add(bobCollateral.sub(bobCollateral2));

      // We calculate the debt by re-engineering the formula
      const aliceDebt = aliceCollateral
        .sub(aliceCollateral2)
        .mul(ethers.BigNumber.from(250).mul(parseEther('1')))
        .mul(ethers.BigNumber.from(1e6))
        .div(
          ethers.BigNumber.from(1e6)
            .add(ethers.BigNumber.from(10e4))
            .mul(parseEther('1'))
        );

      // We calculate the debt by re-engineering the formula
      const bobDebt = bobCollateral
        .sub(bobCollateral2)
        .mul(ethers.BigNumber.from(250).mul(parseEther('1')))
        .mul(ethers.BigNumber.from(1e6))
        .div(
          ethers.BigNumber.from(1e6)
            .add(ethers.BigNumber.from(10e4))
            .mul(parseEther('1'))
        );

      const allDebt = aliceDebt.add(bobDebt);

      const allFee = allDebt.mul(ethers.BigNumber.from(10e4)).div(1e6);

      const protocolFee = allFee
        .mul(ethers.BigNumber.from(100))
        .div(ethers.BigNumber.from(1000));

      expect(aliceLoan2).to.be.equal(aliceLoan.sub(parseEther('400')));
      expect(bobLoan2).to.be.equal(0);
      expect(joseLoan2).to.be.equal(joseLoan);
      expect(joseCollateral).to.be.equal(joseCollateral2);

      expect(totalCollateral.sub(totalCollateral2)).to.be.eq(allCollateral);

      expect(recipientDineroBalance).to.be.equal(0);

      // Recipient gets paid for the liquidator work
      // @notice PCS still has prices BNB at 500 USD. So the recipient gets a lot of Dinero
      expect(recipientDineroBalance2.gt(0)).to.be.equal(true);

      // Caller dinero is not used but the collateral
      expect(ownerDineroBalance).to.be.equal(ownerDineroBalance2);

      // Means loan2 feesEarned includes accrued + protocol fee
      expect(loan2.feesEarned.sub(protocolFee).gt(loan.feesEarned)).to.be.equal(
        true
      );

      // total loan principal was properly updated
      expect(totalLoan.base).to.be.equal(joseLoan.add(aliceLoan2));
      // We repaid debt for 600 DNR + interest rate. So the remaining debt should be for 1099 DNR + fees
      // While it is hard to get the exact number we know it has to be smaller 1320 DNR after 2 years at interest rate of 4%
      expect(totalLoan.elastic.lt(parseEther('1320'))).to.be.equal(true);
    });
    it('cleans up dust when liquidating full positions', async () => {
      const market = await deployUUPS('InterestBNBMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        INTEREST_RATE,
        MAX_LTV,
        LIQUIDATION_FEE,
        ethers.constants.MaxUint256,
      ]);

      await mockOracle.__setBNBUSDPrice(parseEther('500'));

      await Promise.all([
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
        market.updateExchangeRate(),
      ]);

      await market
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

      await market.connect(alice).borrow(alice.address, parseEther('499'));

      // Drop BNB to 250. Alice and Bob can now be liquidated
      await mockOracle.__setBNBUSDPrice(parseEther('300'));

      // Pass time to accrue fees
      await advanceTime(63_113_904, ethers); // advance 2 years

      await market
        .connect(owner)
        .liquidate([alice.address], [parseEther('499')], recipient.address, [
          WBNB,
          dinero.address,
        ]);

      const totalLoan = await market.totalLoan();

      expect(totalLoan.elastic).to.be.equal(0);
      expect(totalLoan.base).to.be.equal(0);
    });
  });

  describe('function: request addCollateral', () => {
    it('reverts if the to address is the zero address', async () => {
      await expect(
        market
          .connect(alice)
          .request(
            [ADD_COLLATERAL_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [ethers.constants.AddressZero, 1]
              ),
            ],
            { value: 10 }
          )
      ).to.revertedWith('DM: no zero address');
      await expect(
        market
          .connect(alice)
          .request(
            [ADD_COLLATERAL_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, 0]
              ),
            ],
            { value: 10 }
          )
      ).to.revertedWith('DM: no zero amount');
    });

    it('allows an account to add collateral', async () => {
      const [aliceCollateral, bobCollateral] = await Promise.all([
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
      ]);

      expect(aliceCollateral).to.be.equal(0);
      expect(bobCollateral).to.be.equal(0);

      await expect(
        market
          .connect(alice)
          .request(
            [ADD_COLLATERAL_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [bob.address, parseEther('5')]
              ),
            ],
            { value: parseEther('5') }
          )
      )
        .to.emit(market, 'AddCollateral')
        .withArgs(alice.address, bob.address, parseEther('5'));

      expect(await market.userCollateral(bob.address)).to.be.equal(
        parseEther('5')
      );

      await expect(
        market
          .connect(alice)
          .request(
            [ADD_COLLATERAL_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('2')]
              ),
            ],
            { value: parseEther('2') }
          )
      )
        .to.emit(market, 'AddCollateral')
        .withArgs(alice.address, alice.address, parseEther('2'));

      expect(await market.userCollateral(alice.address)).to.be.equal(
        parseEther('2')
      );
    });
  });

  describe('function: request withdraw', () => {
    it('reverts if the arguments are invalid', async () => {
      await expect(
        market
          .connect(alice)
          .request(
            [WITHDRAW_COLLATERAL_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [ethers.constants.AddressZero, parseEther('2')]
              ),
            ]
          )
      ).to.revertedWith('DM: no zero address');

      await expect(
        market
          .connect(alice)
          .request(
            [WITHDRAW_COLLATERAL_REQUEST],
            [defaultAbiCoder.encode(['address', 'uint256'], [alice.address, 0])]
          )
      ).to.revertedWith('DM: no zero amount');
    });
    it('reverts if the caller is insolvent', async () => {
      await market
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

      await market.connect(alice).borrow(alice.address, parseEther('400'));

      await expect(
        market
          .connect(alice)
          .request(
            [WITHDRAW_COLLATERAL_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('2')]
              ),
            ]
          )
      ).to.revertedWith('MKT: sender is insolvent');

      await expect(
        market
          .connect(alice)
          .withdrawCollateral(alice.address, parseEther('1.1'))
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('allows collateral to be withdrawn', async () => {
      const market = await deployUUPS('InterestBNBMarket', [
        dinero.address,
        treasury.address,
        mockOracle.address,
        INTEREST_RATE,
        MAX_LTV,
        LIQUIDATION_FEE,
        ethers.constants.MaxUint256,
      ]);

      await mockOracle.__setBNBUSDPrice(parseEther('500'));

      await Promise.all([
        dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
        dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
        market.updateExchangeRate(),
      ]);

      await market
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

      const [bobBalance, aliceCollateral] = await Promise.all([
        bob.getBalance(),
        market.userCollateral(alice.address),
        market.connect(alice).borrow(alice.address, parseEther('100')),
      ]);

      await mockOracle.__setBNBUSDPrice(parseEther('510'));

      await expect(
        market.connect(alice).withdrawCollateral(bob.address, parseEther('1.5'))
      )
        .to.emit(market, 'Accrue')
        .to.emit(market, 'ExchangeRate')
        .to.emit(market, 'WithdrawCollateral')
        .withArgs(alice.address, bob.address, parseEther('1.5'));

      const [bobBalance2, aliceCollateral2] = await Promise.all([
        bob.getBalance(),
        market.userCollateral(alice.address),
      ]);

      expect(bobBalance2).to.be.equal(bobBalance.add(parseEther('1.5')));
      expect(aliceCollateral.sub(parseEther('1.5'))).to.be.equal(
        aliceCollateral2
      );
    });
  });

  describe('function: request borrow', async () => {
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
      await market
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

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
      await market
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

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
        parseEther('200').add(bobDineroBalance)
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
        .addCollateral(alice.address, { value: parseEther('2') });

      await market.connect(alice).borrow(alice.address, parseEther('300'));

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

  it('reverts if you try to reenter on a request call', async () => {
    const reenterContract = (await deploy('ReentrantInterestBNBMarketRequest', [
      market.address,
    ])) as ReentrantInterestBNBMarketRequest;

    await expect(
      reenterContract
        .connect(owner)
        .request(
          [ADD_COLLATERAL_REQUEST, WITHDRAW_COLLATERAL_REQUEST],
          [
            defaultAbiCoder.encode(
              ['address', 'uint256'],
              [reenterContract.address, parseEther('1')]
            ),
            defaultAbiCoder.encode(
              ['address', 'uint256'],
              [reenterContract.address, parseEther('0.5')]
            ),
          ],
          { value: parseEther('1') }
        )
    ).to.revertedWith('ReentrancyGuard: reentrant call');
  });

  it('reverts if you pass an unknown request', async () => {
    await expect(
      market
        .connect(alice)
        .request([7], [defaultAbiCoder.encode(['uint256'], [parseEther('2')])])
    ).to.be.revertedWith('DM: invalid request');
  });

  describe('Upgrade functionality', () => {
    it('reverts if a non owner calls it', async () => {
      await market.connect(owner).transferOwnership(alice.address);

      await expect(upgrade(market, 'TestInterestBNBMarketV2')).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });

    it('upgrades to version 2', async () => {
      await market
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

      const [bobBalance, aliceCollateral] = await Promise.all([
        bob.getBalance(),
        market.userCollateral(alice.address),
        market.connect(alice).borrow(alice.address, parseEther('100')),
      ]);

      const marketV2: TestInterestBNBMarketV2 = await upgrade(
        market,
        'TestInterestBNBMarketV2'
      );

      await expect(
        marketV2
          .connect(alice)
          .withdrawCollateral(bob.address, parseEther('1.5'))
      )
        .to.emit(marketV2, 'Accrue')
        .to.emit(marketV2, 'ExchangeRate')
        .to.emit(marketV2, 'WithdrawCollateral')
        .withArgs(alice.address, bob.address, parseEther('1.5'));

      const [version, bobBalance2, aliceCollateral2] = await Promise.all([
        marketV2.version(),
        bob.getBalance(),
        marketV2.userCollateral(alice.address),
      ]);

      expect(version).to.be.equal('V2');

      expect(bobBalance2).to.be.equal(bobBalance.add(parseEther('1.5')));
      expect(aliceCollateral.sub(parseEther('1.5'))).to.be.equal(
        aliceCollateral2
      );
    });
  });
}).timeout(50_000);
