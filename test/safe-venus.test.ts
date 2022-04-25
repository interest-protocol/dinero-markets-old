import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { Contract } from 'ethers';
import { ethers } from 'hardhat';

import VenusControllerABI from '../abi/venus-controller.json';
import {
  MockInterestRateModel,
  MockTWAP,
  MockVenusToken,
  MockVenusVault,
  Oracle,
  SafeVenus,
  TestSafeVenusV2,
} from '../typechain';
import {
  ETH,
  ETH_USD_PRICE_FEED,
  VENUS_ADMIN,
  VENUS_CONTROLLER,
  XVS,
  XVS_USD_PRICE_FEED,
} from './lib/constants';
import {
  deployUUPS,
  impersonate,
  multiDeploy,
  upgrade,
} from './lib/test-utils';

const { parseEther } = ethers.utils;

describe('SafeVenus', () => {
  // Wrapper contract to test the functionality of safeVenus via events
  let safeVenus: SafeVenus;
  let vault: MockVenusVault;
  let oracle: Oracle;
  let TWAP: MockTWAP;
  let vToken: MockVenusToken;
  let interestRateModel: MockInterestRateModel;
  let venusControllerAdminContract: Contract;

  let owner: SignerWithAddress;
  let venusAdmin: SignerWithAddress;

  beforeEach(async () => {
    [[owner], [TWAP, vault, vToken, interestRateModel], venusAdmin] =
      await Promise.all([
        ethers.getSigners(),
        multiDeploy(
          [
            'MockTWAP',
            'MockVenusVault',
            'MockVenusToken',
            'MockInterestRateModel',
          ],
          [
            [],
            [parseEther('0.9')],
            ['Venus ETH', 'vETH', parseEther('20000')],
            [],
          ]
        ),
        impersonate(VENUS_ADMIN),
      ]);

    venusControllerAdminContract = new ethers.Contract(
      VENUS_CONTROLLER,
      VenusControllerABI,
      venusAdmin
    );

    [oracle] = await Promise.all([
      deployUUPS('Oracle', [TWAP.address]),
      owner.sendTransaction({ to: VENUS_ADMIN, value: parseEther('10') }),
      venusControllerAdminContract._supportMarket(vToken.address),
    ]);

    [safeVenus] = await Promise.all([
      deployUUPS('SafeVenus', [oracle.address]),
      oracle.setFeed(XVS, XVS_USD_PRICE_FEED, 0),
      oracle.setFeed(ETH, ETH_USD_PRICE_FEED, 0),
      vToken.__setUnderlying(ETH),
      vToken.__setInterestRateModel(interestRateModel.address),
      vToken.__setReserveFactorMantissa(parseEther('1')),
    ]);

    await venusControllerAdminContract._setCollateralFactor(
      vToken.address,
      parseEther('0.9')
    );
  });

  describe('function: initialize', () => {
    it('reverts if you call after deployment', async () => {
      expect(oracle.initialize(TWAP.address)).to.revertedWith(
        'Initializable: contract is already initialized'
      );
    });
    it('sets the initial state properly', async () => {
      const [_owner, _oracle] = await Promise.all([
        safeVenus.owner(),
        safeVenus.ORACLE(),
      ]);

      expect(_owner).to.be.equal(owner.address);
      expect(_oracle).to.be.equal(oracle.address);
    });
  });

  it('calculates the lowest collateral ratio returning one based on supply and borrow rate', async () => {
    await Promise.all([
      vToken.__setSupplyRatePerBlock(parseEther('0.05')),
      vToken.__setBorrowRatePerBlock(parseEther('0.08')),
    ]);

    // Selected collateral based on supplyRate/borrowRate
    expect(
      await safeVenus.safeCollateralRatio(vault.address, vToken.address)
    ).to.be.equal(parseEther('0.625'));

    await venusControllerAdminContract._setCollateralFactor(
      vToken.address,
      parseEther('0.6')
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

    const [borrow, supply] = await safeVenus.callStatic.borrowAndSupply(
      vault.address,
      vToken.address
    );

    expect(borrow).to.be.equal(parseEther('17'));
    expect(supply).to.be.equal(parseEther('31'));
  });

  it('evaluates if a market is profitable via the borrow and supply rates', async () => {
    await Promise.all([
      vToken.__setTotalBorrowsCurrent(parseEther('1000')),
      vToken.__setBorrowBalanceCurrent(vault.address, parseEther('200')),
      vToken.__setCash(parseEther('100')),
      vToken.__setExchangeRateCurrent(parseEther('1.1')),
      vToken.__setBalanceOfUnderlying(vault.address, parseEther('500')),
      venusControllerAdminContract._setVenusSpeed(vToken.address, 0),
      interestRateModel.__setBorrowRate(parseEther('0.09')),
      interestRateModel.__setSupplyRate(parseEther('0.12')),
    ]);

    expect(
      await safeVenus.callStatic.isProfitable(
        vault.address,
        vToken.address,
        1000
      )
    ).to.be.equal(true);

    // Lower the supply rate so borrow > supply rate
    await interestRateModel.__setSupplyRate(parseEther('0.03'));

    expect(
      await safeVenus.callStatic.isProfitable(
        vault.address,
        vToken.address,
        1000
      )
    ).to.be.equal(false);

    // Greatly increase the rewards so even tho borrow > supply rate. The rewards make up for it.
    await venusControllerAdminContract._setVenusSpeed(
      vToken.address,
      parseEther('900000')
    );

    expect(
      await safeVenus.callStatic.isProfitable(
        vault.address,
        vToken.address,
        1000
      )
    ).to.be.equal(true);
  });

  describe('function: safeBorrow', () => {
    it('reverts if the vault is not supplying', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.625
        vToken.__setSupplyRatePerBlock(parseEther('0.05')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
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

        // Current ratio of 0.7
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('70')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      expect(
        await safeVenus.callStatic.safeBorrow(vault.address, vToken.address)
      ).to.be.equal(0);
    });

    it('returns 0 if there is no cash', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.75
        vToken.__setSupplyRatePerBlock(parseEther('0.06')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('60')), // (75 - 60) / 60 = ~ 25% BUT there is no CASH
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      expect(
        await safeVenus.callStatic.safeBorrow(vault.address, vToken.address)
      ).to.be.equal(0);
    });

    it('returns 0 if we are borrowing more than the limit', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.75
        vToken.__setSupplyRatePerBlock(parseEther('0.06')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        vToken.__setCash(parseEther('10')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('80')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      expect(
        await safeVenus.callStatic.safeBorrow(vault.address, vToken.address)
      ).to.be.equal(0);
    });

    it('returns 0 if the new borrow amount is less than 5% of the current borrow amount', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.75
        vToken.__setSupplyRatePerBlock(parseEther('0.06')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        vToken.__setCash(parseEther('10')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('72')), // (75 - 72) / 75 = ~ 4%
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      expect(
        await safeVenus.callStatic.safeBorrow(vault.address, vToken.address)
      ).to.be.equal(0);

      await Promise.all([
        vToken.__setCash(parseEther('2')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('60')), // (75 - 60) / 60 = ~ 25% BUT there is no enough cash
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      expect(
        await safeVenus.callStatic.safeBorrow(vault.address, vToken.address)
      ).to.be.equal(0);
    });

    it('returns 0 if it is not profitable to borrow', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.75
        vToken.__setSupplyRatePerBlock(parseEther('0.06')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        vToken.__setCash(parseEther('100')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('50')), // (75 - 50) / 75 = ~ 30%
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
        vToken.__setExchangeRateCurrent(parseEther('1.1')),
        // We make it unprofitable to borrow
        interestRateModel.__setBorrowRate(parseEther('0.15')),
        interestRateModel.__setSupplyRate(parseEther('0.05')),
      ]);

      expect(
        await safeVenus.callStatic.safeBorrow(vault.address, vToken.address)
      ).to.be.equal(0);
    });

    it('recommends a borrow amount if it is profitable to do so', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.75
        vToken.__setSupplyRatePerBlock(parseEther('0.06')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        vToken.__setCash(parseEther('100')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('50')), // (75 - 50) / 75 = ~ 30%
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
        vToken.__setExchangeRateCurrent(parseEther('1.1')),
        // We make it profitable to borrow
        venusControllerAdminContract._setVenusSpeed(
          vToken.address,
          parseEther('900')
        ),
        interestRateModel.__setBorrowRate(parseEther('0.09')),
        interestRateModel.__setSupplyRate(parseEther('0.08')),
      ]);

      expect(
        await safeVenus.callStatic.safeBorrow(vault.address, vToken.address)
      ).to.be.equal(parseEther('23.75')); // 25 * 0.95

      // we reduce the cash
      await vToken.__setCash(parseEther('15'));

      expect(
        await safeVenus.callStatic.safeBorrow(vault.address, vToken.address)
      ).to.be.equal(parseEther('14.25')); // 15 * 0.95
    });
  });

  describe('function: safeRedeem', () => {
    it('returns the borrow balance or cash if there no loans', async () => {
      await Promise.all([
        vToken.__setCash(parseEther('1000')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      expect(
        await safeVenus.callStatic.safeRedeem(vault.address, vToken.address)
      ).to.be.equal(parseEther('100'));

      await vToken.__setCash(parseEther('99'));

      expect(
        await safeVenus.callStatic.safeRedeem(vault.address, vToken.address)
      ).to.be.equal(parseEther('99'));
    });

    it('returns 0 if we are underwater', async () => {
      await Promise.all([
        vToken.__setCash(parseEther('100')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('90')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      // Current safe collateral is 81% but we are at 90%
      expect(
        await safeVenus.callStatic.safeRedeem(vault.address, vToken.address)
      ).to.be.equal(0);
    });

    it('safe redeem amount', async () => {
      await Promise.all([
        vToken.__setSupplyRatePerBlock(parseEther('0.08')),
        vToken.__setBorrowRatePerBlock(parseEther('0.1')),
        vToken.__setCash(parseEther('100')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('60')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      // Current safe collateral is 80%. 60/0.8 = 75. 100 - 75 = 25
      expect(
        await safeVenus.callStatic.safeRedeem(vault.address, vToken.address)
      ).to.be.equal(parseEther('23.75')); // 25 * 0.95 because of the safety margin

      await vToken.__setCash(parseEther('14'));

      expect(
        await safeVenus.callStatic.safeRedeem(vault.address, vToken.address)
      ).to.be.equal(parseEther('13.3'));
    });
  });

  describe('function: borrowInterestPerBlock', () => {
    it('returns 0 if there are no open borrow positions', async () => {
      const data = await safeVenus.callStatic.borrowInterestPerBlock(
        vault.address,
        vToken.address,
        0
      );

      expect(data[0]).to.be.equal(0);
      expect(data[1]).to.be.equal(0);
    });
    it('returns cost and profit of opening a new borrow position', async () => {
      await Promise.all([
        vToken.__setTotalBorrowsCurrent(parseEther('1000')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('150')),
        venusControllerAdminContract._setVenusSpeed(
          vToken.address,
          parseEther('40')
        ),
        interestRateModel.__setBorrowRate(parseEther('0.07')),
      ]);

      const data = await safeVenus.callStatic.borrowInterestPerBlock(
        vault.address,
        vToken.address,
        parseEther('20')
      );

      const xvsInUSDPerBlock = await oracle.getTokenUSDPrice(
        XVS,
        (await venusControllerAdminContract.venusSpeeds(vToken.address))
          .mul(parseEther('150').add(parseEther('20')))
          .div(parseEther('1020'))
      );

      const underlyingInUSDPerBlock = await oracle.getTokenUSDPrice(
        ETH,
        (
          await safeVenus.callStatic.predictBorrowRate(
            vToken.address,
            parseEther('20')
          )
        )
          .mul(parseEther('170'))
          .div(parseEther('1'))
      );

      expect(data[0]).to.be.equal(underlyingInUSDPerBlock);
      expect(data[1]).to.be.equal(xvsInUSDPerBlock);
    });
  });

  describe('function: supplyRewardPerBlock', () => {
    it('returns 0 if there is no current supply amount in the market', async () => {
      expect(
        await safeVenus.callStatic.supplyRewardPerBlock(
          vault.address,
          vToken.address,
          0
        )
      ).to.be.equal(0);
    });
    it('returns the current supply reward', async () => {
      await Promise.all([
        vToken.__setExchangeRateCurrent(parseEther('1.1')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('200')),
        venusControllerAdminContract._setVenusSpeed(
          vToken.address,
          parseEther('400')
        ),
        interestRateModel.__setSupplyRate(parseEther('0.05')),
      ]);

      const xvsAmountInUSD = await oracle.getTokenUSDPrice(
        XVS,
        parseEther('400')
          .mul(parseEther('200'))
          .div(parseEther('20000').mul(parseEther('1.1')).div(parseEther('1')))
      );

      const ethAmountInUSD = await oracle.getTokenUSDPrice(
        ETH,
        (
          await safeVenus.callStatic.predictSupplyRate(
            vToken.address,
            parseEther('100')
          )
        )
          .mul(parseEther('200'))
          .div(parseEther('1'))
      );

      expect(
        await safeVenus.callStatic.supplyRewardPerBlock(
          vault.address,
          vToken.address,
          parseEther('100')
        )
      ).to.be.equal(xvsAmountInUSD.add(ethAmountInUSD));
    });
  });
  it('returns a prediction for the borrow rate', async () => {
    await Promise.all([
      vToken.__setCash(parseEther('100')),
      vToken.__setTotalBorrowsCurrent(parseEther('600')),
      vToken.__setTotalReserves(parseEther('45')),
      interestRateModel.__setBorrowRate(parseEther('0.06')),
    ]);
    expect(
      await safeVenus.callStatic.predictBorrowRate(
        vToken.address,
        parseEther('150')
      )
    ).to.be.equal(parseEther('0.06'));

    await expect(safeVenus.predictBorrowRate(vToken.address, parseEther('60')))
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

    expect(
      await safeVenus.callStatic.predictSupplyRate(
        vToken.address,
        parseEther('300')
      )
    ).to.be.equal(parseEther('0.035'));

    await expect(safeVenus.predictSupplyRate(vToken.address, parseEther('150')))
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
        vToken.__setCash(parseEther('100')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('40')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')), // we can  borrow up to 75 ether. (100 * 0.75)
      ]);

      expect(
        await safeVenus.callStatic.deleverage(vault.address, vToken.address)
      ).to.be.equal(0);
    });
    it('returns redeem amount with 5% room if our borrow amount is over (85% * venus collateral factor * supply)', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.75
        vToken.__setSupplyRatePerBlock(parseEther('0.06')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        vToken.__setCash(parseEther('100')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('85')), // We are way above the safe collateral ratio of 0.675
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      expect(
        await safeVenus.callStatic.deleverage(vault.address, vToken.address)
      ).to.be.closeTo(parseEther('0.5'), parseEther('0.09')); // 100 - (85 / (0.9 * 0.95)) => ~0.5 Taken post fact for rounding purposes

      await vToken.__setCash(parseEther('0.5'));

      expect(
        await safeVenus.callStatic.deleverage(vault.address, vToken.address)
      ).to.be.equal(parseEther('0.5'));
    });

    it('returns redeem amount with 15% room if we are NOT over (85% * venus collateral factor * supply)', async () => {
      await Promise.all([
        // Safe collateral ratio of 0.625
        vToken.__setSupplyRatePerBlock(parseEther('0.05')),
        vToken.__setBorrowRatePerBlock(parseEther('0.08')),
        vToken.__setCash(parseEther('100')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('75')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')), // 0.9 * 0.85 * 100 => 76.5
      ]);

      expect(
        await safeVenus.callStatic.deleverage(vault.address, vToken.address)
      ).to.be.closeTo(parseEther('1.9'), parseEther('0.07')); // 100 - 75 / (0.9 * 0.85) => ~ 1.96. Taken post fact due to rounding

      await vToken.__setCash(parseEther('1.5'));

      expect(
        await safeVenus.callStatic.deleverage(vault.address, vToken.address)
      ).to.be.equal(parseEther('1.5')); // It will return cash if cash value is lower than the redeem amount.
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

      await Promise.all([
        vToken.__setCash(parseEther('100')),
        vToken.__setBorrowBalanceCurrent(vault.address, parseEther('90')),
        vToken.__setBalanceOfUnderlying(vault.address, parseEther('100')),
      ]);

      // Current safe collateral is 81% but we are at 90%
      expect(
        await safeVenusV2.callStatic.safeRedeem(vault.address, vToken.address)
      ).to.be.equal(0);

      expect(await safeVenusV2.version()).to.be.equal('V2');
    });
  });
});
