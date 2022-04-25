import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  MockChainLinkFeed,
  MockERC20,
  MockInterestRateModel,
  MockTWAP,
  MockVenusController,
  MockVenusToken,
  MockVenusVault,
  Oracle,
  SafeVenus,
  TestSafeVenus,
  TestSafeVenusV2,
} from '../typechain';
import { deploy, deployUUPS, multiDeploy, upgrade } from './lib/test-utils';

const { parseEther } = ethers.utils;

const INITIAL_SUPPLY = parseEther('10000');

// These are only basic Unit tests.
describe('SafeVenus', () => {
  // Wrapper contract to test the functionality of safeVenus via events
  let testSafeVenus: TestSafeVenus;
  let safeVenus: SafeVenus;
  let venusController: MockVenusController;
  let vault: MockVenusVault;
  let oracle: Oracle;
  let vToken: MockVenusToken;
  let xvsUSDFeed: MockChainLinkFeed;
  let ethUSDFeed: MockChainLinkFeed;
  let bnbUSDFeed: MockChainLinkFeed;
  let interestRateModel: MockInterestRateModel;
  let XVS: MockERC20;
  let ETH: MockERC20;
  let WBNB: MockERC20;
  let BUSD: MockERC20;
  let TWAP: MockTWAP;

  let owner: SignerWithAddress;

  beforeEach(async () => {
    [
      [owner],
      [
        XVS,
        ETH,
        WBNB,
        BUSD,
        vToken,
        TWAP,
        vault,
        xvsUSDFeed,
        ethUSDFeed,
        bnbUSDFeed,
        interestRateModel,
      ],
    ] = await Promise.all([
      ethers.getSigners(),
      multiDeploy(
        [
          'MockERC20',
          'MockERC20',
          'MockERC20',
          'MockERC20',
          'MockVenusToken',
          'MockTWAP',
          'MockVenusVault',
          'MockChainLinkFeed',
          'MockChainLinkFeed',
          'MockChainLinkFeed',
          'MockInterestRateModel',
        ],
        [
          ['Venus Token', 'XVS', INITIAL_SUPPLY],
          ['Ether', 'ETH', INITIAL_SUPPLY],
          ['Wrapped BNB', 'WBNB', INITIAL_SUPPLY],
          ['Binance USD', 'BUSD', INITIAL_SUPPLY],
          ['Venus BTC', 'vBTC', INITIAL_SUPPLY.mul(2)],
          [],
          [parseEther('0.9')],
          [18, 'XSV/USD', 2],
          [18, 'ETH/USD', 2],
          [18, 'BNB/USD', 2],
          [],
        ]
      ),
    ]);

    [oracle, venusController] = await Promise.all([
      deployUUPS('Oracle', [
        TWAP.address,
        bnbUSDFeed.address,
        WBNB.address,
        BUSD.address,
      ]),
      deploy('MockVenusController', [XVS.address]),
    ]);

    [safeVenus] = await Promise.all([
      deployUUPS('SafeVenus', [
        venusController.address,
        XVS.address,
        oracle.address,
      ]),
      vToken.__setUnderlying(ETH.address),
      vToken.__setInterestRateModel(interestRateModel.address),
      vToken.__setReserveFactorMantissa(parseEther('1')),
      oracle.connect(owner).setFeed(XVS.address, xvsUSDFeed.address, 0),
      oracle.connect(owner).setFeed(ETH.address, ethUSDFeed.address, 0),
      xvsUSDFeed.setAnswer(parseEther('10')),
      ethUSDFeed.setAnswer(parseEther('3000')),
    ]);

    testSafeVenus = await deploy('TestSafeVenus', [safeVenus.address]);
  });

  describe('function: initialize', () => {
    it('reverts if you call after deployment', async () => {
      expect(
        oracle.initialize(
          TWAP.address,
          bnbUSDFeed.address,
          WBNB.address,
          BUSD.address
        )
      ).to.revertedWith('Initializable: contract is already initialized');
    });
    it('sets the initial state properly', async () => {
      const [_owner, _venusController, _xvs, _oracle] = await Promise.all([
        safeVenus.owner(),
        safeVenus.VENUS_CONTROLLER(),
        safeVenus.XVS(),
        safeVenus.ORACLE(),
      ]);

      expect(_owner).to.be.equal(owner.address);
      expect(_venusController).to.be.equal(venusController.address);
      expect(_xvs).to.be.equal(XVS.address);
      expect(_oracle).to.be.equal(oracle.address);
    });
  });

  it('calculates the lowest collateral ratio returning one based on supply and borrow rate', async () => {
    await Promise.all([
      vToken.__setSupplyRatePerBlock(parseEther('0.05')),
      vToken.__setBorrowRatePerBlock(parseEther('0.08')),
      venusController.__setMarkets(
        vToken.address,
        true,
        parseEther('0.9'),
        true,
        true
      ),
    ]);

    // Selected collateral based on supplyRate/borrowRate
    expect(
      await safeVenus.safeCollateralRatio(vault.address, vToken.address)
    ).to.be.equal(parseEther('0.625'));

    venusController.__setMarkets(
      vToken.address,
      true,
      parseEther('0.6'),
      true,
      true
    );

    // Selected collateral based on factor mantissa of Venus and Vault collateral limit because it is lower
    expect(
      await safeVenus.safeCollateralRatio(vault.address, vToken.address)
    ).to.be.equal(parseEther('0.54'));

    await vToken.__setBorrowRatePerBlock(0);

    expect(
      await safeVenus.safeCollateralRatio(vault.address, vToken.address)
    ).to.be.equal(parseEther('0.54'));
  });
  it('returns the total amount of borrow and supply of a vault in a vToken market', async () => {
    await Promise.all([
      vToken.__setBorrowBalanceCurrent(vault.address, parseEther('17')),
      vToken.__setBalanceOfUnderlying(vault.address, parseEther('31')),
    ]);

    await expect(testSafeVenus.borrowAndSupply(vault.address, vToken.address))
      .to.emit(testSafeVenus, 'BorrowAndSupply')
      .withArgs(parseEther('17'), parseEther('31'));
  });

  it('evaluates if a market is profitable via the borrow and supply rates', async () => {
    await Promise.all([
      vToken.__setTotalBorrowsCurrent(parseEther('1000')),
      vToken.__setBorrowBalanceCurrent(vault.address, parseEther('200')),
      vToken.__setCash(parseEther('100')),
      vToken.__setExchangeRateCurrent(parseEther('1.1')),
      vToken.__setBalanceOfUnderlying(vault.address, parseEther('500')),
      venusController.__setVenusSpeeds(vToken.address, parseEther('9')),
      interestRateModel.__setBorrowRate(parseEther('0.09')),
      interestRateModel.__setSupplyRate(parseEther('0.12')),
    ]);

    await expect(
      testSafeVenus.isProfitable(vault.address, vToken.address, 1000)
    )
      .to.emit(testSafeVenus, 'IsProfitable')
      .withArgs(true);

    // Lower the supply rate so borrow > supply rate
    await interestRateModel.__setSupplyRate(parseEther('0.03'));

    await expect(
      testSafeVenus.isProfitable(vault.address, vToken.address, 1000)
    )
      .to.emit(testSafeVenus, 'IsProfitable')
      .withArgs(false);

    // Greatly increase the rewards so even tho borrow > supply rate. The rewards make up for it.
    await venusController.__setVenusSpeeds(vToken.address, parseEther('9000'));

    await expect(
      testSafeVenus.isProfitable(vault.address, vToken.address, 1000)
    )
      .to.emit(testSafeVenus, 'IsProfitable')
      .withArgs(true);
  });

  describe('function: safeBorrow', () => {
    it('reverts if the vault is not supplying', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.625
        vToken.__setSupplyRatePerBlock(parseEther('0.05')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        venusController.__setMarkets(
          vToken.address,
          true,
          parseEther('0.9'),
          true,
          true
        ),
      ]);

      await expect(
        safeVenus.safeBorrow(vault.address, vToken.address)
      ).to.revertedWith('SV: no supply');
    });

    it('returns 0 if the we are currently borrowing more than the safe collateral ratio', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.625
        vToken.__setSupplyRatePerBlock(parseEther('0.05')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        venusController.__setMarkets(
          vToken.address,
          true,
          parseEther('0.9'),
          true,
          true
        ),

        // Current ratio of 0.7
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('70')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      await expect(testSafeVenus.safeBorrow(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'SafeBorrow')
        .withArgs(0);
    });

    it('returns 0 if there is no cash', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.75
        vToken.__setSupplyRatePerBlock(parseEther('0.06')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        venusController.__setMarkets(
          vToken.address,
          true,
          parseEther('0.9'),
          true,
          true
        ),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('60')), // (75 - 60) / 60 = ~ 25% BUT there is no CASH
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      await expect(testSafeVenus.safeBorrow(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'SafeBorrow')
        .withArgs(0);
    });

    it('returns 0 if we are borrowing more than the limit', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.75
        vToken.__setSupplyRatePerBlock(parseEther('0.06')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        venusController.__setMarkets(
          vToken.address,
          true,
          parseEther('0.9'),
          true,
          true
        ),
        vToken.__setCash(parseEther('10')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('80')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      await expect(testSafeVenus.safeBorrow(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'SafeBorrow')
        .withArgs(0);
    });

    it('returns 0 if the new borrow amount is less than 5% of the current borrow amount', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.75
        vToken.__setSupplyRatePerBlock(parseEther('0.06')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        venusController.__setMarkets(
          vToken.address,
          true,
          parseEther('0.9'),
          true,
          true
        ),
        vToken.__setCash(parseEther('10')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('72')), // (75 - 72) / 75 = ~ 4%
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      await expect(testSafeVenus.safeBorrow(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'SafeBorrow')
        .withArgs(0);

      await Promise.all([
        vToken.__setCash(parseEther('2')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('60')), // (75 - 60) / 60 = ~ 25% BUT there is no enough cash
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      await expect(testSafeVenus.safeBorrow(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'SafeBorrow')
        .withArgs(0);
    });

    it('returns 0 if it is not profitable to borrow', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.75
        vToken.__setSupplyRatePerBlock(parseEther('0.06')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        venusController.__setMarkets(
          vToken.address,
          true,
          parseEther('0.9'),
          true,
          true
        ),
        vToken.__setCash(parseEther('100')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('50')), // (75 - 50) / 75 = ~ 30%
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
        vToken.__setExchangeRateCurrent(parseEther('1.1')),
        // We make it unprofitable to borrow
        interestRateModel.__setBorrowRate(parseEther('0.15')),
        interestRateModel.__setSupplyRate(parseEther('0.05')),
      ]);

      await expect(testSafeVenus.safeBorrow(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'SafeBorrow')
        .withArgs(0);
    });

    it('recommends a borrow amount if it is profitable to do so', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.75
        vToken.__setSupplyRatePerBlock(parseEther('0.06')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        venusController.__setMarkets(
          vToken.address,
          true,
          parseEther('0.9'),
          true,
          true
        ),
        vToken.__setCash(parseEther('100')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('50')), // (75 - 50) / 75 = ~ 30%
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
        vToken.__setExchangeRateCurrent(parseEther('1.1')),
        // We make it profitable to borrow
        venusController.__setVenusSpeeds(vToken.address, parseEther('900')),
        interestRateModel.__setBorrowRate(parseEther('0.09')),
        interestRateModel.__setSupplyRate(parseEther('0.08')),
      ]);

      await expect(testSafeVenus.safeBorrow(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'SafeBorrow')
        .withArgs(parseEther('23.75')); // 25 * 0.95

      // we reduce the cash
      await vToken.__setCash(parseEther('15'));

      await expect(testSafeVenus.safeBorrow(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'SafeBorrow')
        .withArgs(parseEther('14.25')); // 15 * 0.95
    });
  });
  describe('function: safeRedeem', () => {
    it('returns the borrow balance or cash if there no loans', async () => {
      await Promise.all([
        vToken.__setCash(parseEther('1000')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      await expect(testSafeVenus.safeRedeem(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'SafeRedeem')
        .withArgs(parseEther('100'));

      await vToken.__setCash(parseEther('99'));

      await expect(testSafeVenus.safeRedeem(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'SafeRedeem')
        .withArgs(parseEther('99'));
    });

    it('returns 0 if we are underwater', async () => {
      await Promise.all([
        venusController.__setMarkets(
          vToken.address,
          true,
          parseEther('0.9'),
          true,
          true
        ),
        vToken.__setCash(parseEther('100')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('90')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      // Current safe collateral is 81% but we are at 90%
      await expect(testSafeVenus.safeRedeem(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'SafeRedeem')
        .withArgs(0);
    });

    it('safe redeem amount', async () => {
      await Promise.all([
        venusController.__setMarkets(
          vToken.address,
          true,
          parseEther('0.95'),
          true,
          true
        ),
        vToken.__setSupplyRatePerBlock(parseEther('0.08')),
        vToken.__setBorrowRatePerBlock(parseEther('0.1')),
        vToken.__setCash(parseEther('100')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('60')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      // Current safe collateral is 80%. 60/0.8 = 75. 100 - 75 = 25
      await expect(testSafeVenus.safeRedeem(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'SafeRedeem')
        .withArgs(parseEther('23.75')); // 25 * 0.95 because of the safety margin

      await vToken.__setCash(parseEther('14'));

      await expect(testSafeVenus.safeRedeem(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'SafeRedeem')
        .withArgs(parseEther('13.3'));
    });
  });
  describe('function: borrowInterestPerBlock', () => {
    it('returns 0 if there are no open borrow positions', async () => {
      await expect(
        testSafeVenus.borrowInterestPerBlock(vault.address, vToken.address, 0)
      )
        .to.emit(testSafeVenus, 'BorrowInterestPerBlock')
        .withArgs(0, 0);
    });
    it('returns cost and profit of opening a new borrow position', async () => {
      await Promise.all([
        vToken.__setTotalBorrowsCurrent(parseEther('1000')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('150')),
        venusController.__setVenusSpeeds(vToken.address, parseEther('40')),
        interestRateModel.__setBorrowRate(parseEther('0.07')),
      ]);

      await expect(
        testSafeVenus.borrowInterestPerBlock(
          vault.address,
          vToken.address,
          parseEther('20')
        )
      )
        .to.emit(testSafeVenus, 'BorrowInterestPerBlock')
        // First value - 170 * 0.07 * 3000 = 35_700
        // Second Value - (40 * 170) / 1020 * 10 = ~ 66.6. We took the exact number post-fact to pass the test.
        .withArgs(parseEther('35700'), '66666666666666666660');
    });
  });

  describe('function: supplyRewardPerBlock', () => {
    it('returns 0 if there is no current supply amount in the market', async () => {
      await expect(
        testSafeVenus.supplyRewardPerBlock(vault.address, vToken.address, 0)
      )
        .to.emit(testSafeVenus, 'SupplyRewardPerBlock')
        .withArgs(0);
    });
    it('returns the current supply reward', async () => {
      await Promise.all([
        vToken.__setExchangeRateCurrent(parseEther('1.1')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('200')),
        venusController.__setVenusSpeeds(vToken.address, parseEther('400')),
        interestRateModel.__setSupplyRate(parseEther('0.05')),
      ]);

      await expect(
        testSafeVenus.supplyRewardPerBlock(
          vault.address,
          vToken.address,
          parseEther('100')
        )
      )
        .to.emit(testSafeVenus, 'SupplyRewardPerBlock')
        // Underlying value 200 * 0.05 * 3000 = 30_000
        // XVS reward (400 * 200 / 22000) * 10 = ~36
        // Value below copied post test due to rounding.
        .withArgs('30036363636363636363630');
    });
  });
  it('returns a prediction for the borrow rate', async () => {
    await Promise.all([
      vToken.__setCash(parseEther('100')),
      vToken.__setTotalBorrowsCurrent(parseEther('600')),
      vToken.__setTotalReserves(parseEther('45')),
      interestRateModel.__setBorrowRate(parseEther('0.06')),
    ]);
    await expect(
      testSafeVenus.predictBorrowRate(vToken.address, parseEther('150'))
    )
      .to.emit(testSafeVenus, 'PredictBorrowRate')
      .withArgs(parseEther('0.06'))
      .to.emit(interestRateModel, 'BorrowRateArgs')
      .withArgs(0, parseEther('700'), parseEther('45'));

    await expect(
      testSafeVenus.predictBorrowRate(vToken.address, parseEther('60'))
    )
      .to.emit(testSafeVenus, 'PredictBorrowRate')
      .withArgs(parseEther('0.06'))
      .to.emit(interestRateModel, 'BorrowRateArgs')
      .withArgs(parseEther('40'), parseEther('660'), parseEther('45'));
  });
  it('returns a prediction for the supply rate', async () => {
    await Promise.all([
      vToken.__setCash(parseEther('200')),
      vToken.__setTotalBorrowsCurrent(parseEther('700')),
      vToken.__setTotalReserves(parseEther('85')),
      vToken.__setReserveFactorMantissa(parseEther('2')),
      interestRateModel.__setSupplyRate(parseEther('0.035')),
    ]);

    await expect(
      testSafeVenus.predictSupplyRate(vToken.address, parseEther('300'))
    )
      .to.emit(testSafeVenus, 'PredictSupplyRate')
      .withArgs(parseEther('0.035'))
      .to.emit(interestRateModel, 'SupplyRateArgs')
      .withArgs(0, parseEther('900'), parseEther('85'), parseEther('2'));

    await expect(
      testSafeVenus.predictSupplyRate(vToken.address, parseEther('150'))
    )
      .to.emit(testSafeVenus, 'PredictSupplyRate')
      .withArgs(parseEther('0.035'))
      .to.emit(interestRateModel, 'SupplyRateArgs')
      .withArgs(
        parseEther('50'),
        parseEther('850'),
        parseEther('85'),
        parseEther('2')
      );
  });
  describe('function: deleverage', () => {
    it('returns 0 if you are borrowing below the safe maximum value', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.75
        vToken.__setSupplyRatePerBlock(parseEther('0.06')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        venusController.__setMarkets(
          vToken.address,
          true,
          parseEther('0.9'),
          true,
          true
        ),
        vToken.__setCash(parseEther('100')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('40')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')), // we can  borrow up to 75 ether. (100 * 0.75)
      ]);

      await expect(testSafeVenus.deleverage(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'Deleverage')
        .withArgs(0);
    });
    it('returns redeem amount with 5% room if our borrow amount is over (85% * venus collateral factor * supply)', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.75
        vToken.__setSupplyRatePerBlock(parseEther('0.06')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        venusController.__setMarkets(
          vToken.address,
          true,
          parseEther('0.9'),
          true,
          true
        ),
        vToken.__setCash(parseEther('100')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('85')), // We are way above the safe collateral ratio of 0.675
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      await expect(testSafeVenus.deleverage(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'Deleverage')
        .withArgs(parseEther('0.584795321637426901')); // 100 - (85 / (0.9 * 0.95)) => ~0.5 Taken post fact for rounding purposes

      await vToken.__setCash(parseEther('0.5'));

      await expect(testSafeVenus.deleverage(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'Deleverage')
        .withArgs(parseEther('0.5')); // It will return cash if cash value is lower than the redeem amount.
    });
    it('returns redeem amount with 15% room if we are NOT over (85% * venus collateral factor * supply)', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.625
        vToken.__setSupplyRatePerBlock(parseEther('0.05')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        venusController.__setMarkets(
          vToken.address,
          true,
          parseEther('0.9'),
          true,
          true
        ),
        vToken.__setCash(parseEther('100')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('75')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')), // 0.9 * 0.85 * 100 => 76.5
      ]);

      await expect(testSafeVenus.deleverage(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'Deleverage')
        .withArgs(parseEther('1.960784313725490197')); // 100 - 75 / (0.9 * 0.85) => ~ 1.96. Taken post fact due to rounding

      await vToken.__setCash(parseEther('1.5'));

      await expect(testSafeVenus.deleverage(vault.address, vToken.address))
        .to.emit(testSafeVenus, 'Deleverage')
        .withArgs(parseEther('1.5')); // It will return cash if cash value is lower than the redeem amount.
    });
  });

  describe('Upgrade functionality', () => {
    it('reverts if it is called by a non-owner account', async () => {
      await safeVenus.connect(owner).renounceOwnership();

      await expect(upgrade(safeVenus, 'TestSafeVenusV2')).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });

    it('upgrades to version 2', async () => {
      const safeVenusV2: TestSafeVenusV2 = await upgrade(
        safeVenus,
        'TestSafeVenusV2'
      );

      const testSafeVenusV2: TestSafeVenusV2 = await deploy('TestSafeVenus', [
        safeVenusV2.address,
      ]);

      await Promise.all([
        venusController.__setMarkets(
          vToken.address,
          true,
          parseEther('0.9'),
          true,
          true
        ),
        vToken.__setCash(parseEther('100')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('90')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      // Current safe collateral is 81% but we are at 90%
      await expect(testSafeVenusV2.safeRedeem(vault.address, vToken.address))
        .to.emit(testSafeVenusV2, 'SafeRedeem')
        .withArgs(0);

      expect(await safeVenusV2.version()).to.be.equal('V2');
    });
  });
});
