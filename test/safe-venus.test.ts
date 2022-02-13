import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  MockChainLinkFeed,
  MockERC20,
  MockInterestRateModel,
  MockTWAP,
  MockVenusToken,
  MockVenusTroller,
  MockVenusVault,
  OracleV1,
  SafeVenus,
  TestSafeVenus,
} from '../typechain';
import { deploy, multiDeploy } from './lib/test-utils';

const { parseEther } = ethers.utils;

const INITIAL_SUPPLY = parseEther('10000');

// These are only basic Unit tests.
describe('SafeVenus', () => {
  // Wrapper contract to test the functionality of safeVenus via events
  let testSafeVenus: TestSafeVenus;
  let safeVenus: SafeVenus;
  let venusTroller: MockVenusTroller;
  let vault: MockVenusVault;
  let oracle: OracleV1;
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
        venusTroller,
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
          'MockVenusTroller',
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
          ['Venus BTC', 'vBTC', INITIAL_SUPPLY],
          [],
          [],
          [parseEther('0.9')],
          [18, 'XSV/USD', 2],
          [18, 'ETH/USD', 2],
          [18, 'BNB/USD', 2],
          [],
        ]
      ),
    ]);

    oracle = await deploy('OracleV1', [
      TWAP.address,
      bnbUSDFeed.address,
      WBNB.address,
      BUSD.address,
    ]);

    [safeVenus] = await Promise.all([
      deploy('SafeVenus', [venusTroller.address, XVS.address, oracle.address]),
      vToken.__setUnderlying(ETH.address),
      vToken.__setInterestRateModel(interestRateModel.address),
      vToken.__setReserveFactorMantissa(parseEther('1')),
      vToken.connect(owner).mint(INITIAL_SUPPLY),
      oracle.connect(owner).setFeed(XVS.address, xvsUSDFeed.address, 0),
      oracle.connect(owner).setFeed(ETH.address, ethUSDFeed.address, 0),
      xvsUSDFeed.setAnswer(parseEther('10')),
      ethUSDFeed.setAnswer(parseEther('3000')),
    ]);

    testSafeVenus = await deploy('TestSafeVenus', [safeVenus.address]);
  });

  it('calculates the lowest collateral ratio returning one based on supply and borrow rate', async () => {
    await Promise.all([
      vToken.__setSupplyRatePerBlock(parseEther('0.05')),
      vToken.__setBorrowRatePerBlock(parseEther('0.08')),
      venusTroller.__setMarkets(
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

    venusTroller.__setMarkets(
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
      venusTroller.__setVenusSpeeds(vToken.address, parseEther('9')),
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
    await venusTroller.__setVenusSpeeds(vToken.address, parseEther('9000'));

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
        venusTroller.__setMarkets(
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
        venusTroller.__setMarkets(
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
        venusTroller.__setMarkets(
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
        venusTroller.__setMarkets(
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
        venusTroller.__setMarkets(
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
        venusTroller.__setMarkets(
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
        venusTroller.__setMarkets(
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
        venusTroller.__setVenusSpeeds(vToken.address, parseEther('900')),
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
        venusTroller.__setMarkets(
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
        venusTroller.__setMarkets(
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
});
