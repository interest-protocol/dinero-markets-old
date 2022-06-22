import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { Contract } from 'ethers';
import { ethers } from 'hardhat';

import ERC20ABI from '../abi/erc20.json';
import VenusControllerABI from '../abi/venus-controller.json';
import {
  MockInterestRateModel,
  MockOracle,
  MockVenusToken,
  TestSafeVenus,
  TestSafeVenusV2,
} from '../typechain';
import {
  BLOCKS_PER_YEAR,
  USDC,
  USDC_WHALE_ONE,
  VENUS_ADMIN,
  VENUS_CONTROLLER,
} from './lib/constants';
import {
  advanceBlock,
  deployUUPS,
  impersonate,
  multiDeploy,
  upgrade,
} from './lib/test-utils';

const { parseEther } = ethers.utils;

describe('SafeVenus', () => {
  let safeVenus: TestSafeVenus;
  let mockVToken: MockVenusToken;
  let mockOracle: MockOracle;
  let venusControllerAdminContract: Contract;
  let mockInterestRateModel: MockInterestRateModel;

  let owner: SignerWithAddress;
  let venusAdmin: SignerWithAddress;
  let usdcWhale: SignerWithAddress;

  beforeEach(async () => {
    [
      [owner],
      [mockVToken, mockOracle, mockInterestRateModel],
      venusAdmin,
      usdcWhale,
    ] = await Promise.all([
      ethers.getSigners(),
      multiDeploy(
        ['MockVenusToken', 'MockOracle', 'MockInterestRateModelV2'],
        [['VToken', 'vT', 0], [], []]
      ),
      impersonate(VENUS_ADMIN),
      impersonate(USDC_WHALE_ONE),
    ]);

    safeVenus = await deployUUPS('TestSafeVenus', [mockOracle.address]);

    await owner.sendTransaction({
      to: venusAdmin.address,
      value: parseEther('2'),
    });
    await owner.sendTransaction({
      to: usdcWhale.address,
      value: parseEther('2'),
    });

    venusControllerAdminContract = new ethers.Contract(
      VENUS_CONTROLLER,
      VenusControllerABI,
      venusAdmin
    );

    const USDCContract = new ethers.Contract(
      USDC,
      ERC20ABI,
      usdcWhale
    ) as Contract;

    await Promise.all([
      mockOracle.__setERC20Price(USDC, parseEther('1')),
      mockVToken.__setUnderlying(USDC),
      mockVToken.__setCollateralFactor(parseEther('0.9')),
      mockVToken.__setExchangeRateCurrent(
        ethers.BigNumber.from('213429808155036526652502393')
      ),
      mockVToken.__setInterestRateModel(mockInterestRateModel.address),
      USDCContract.connect(usdcWhale).approve(
        mockVToken.address,
        ethers.constants.MaxUint256
      ),
    ]);

    await venusControllerAdminContract._supportMarket(mockVToken.address);

    await venusControllerAdminContract._setCollateralFactor(
      mockVToken.address,
      parseEther('0.8')
    );
  });

  it('returns enforcedLimit if there is no borrow rate', async () => {
    expect(
      await safeVenus.testSafeCollateralLimit(
        mockVToken.address,
        parseEther('0.5')
      )
    ).to.be.equal(parseEther('0.4'));
  });

  describe('function: safeBorrow', () => {
    it('returns 0 if you are borrowing more than the max borrow amount', async () => {
      await Promise.all([
        mockVToken.__setTotalBorrows(parseEther('100')),
        mockVToken.__setBorrowBalanceStored(
          usdcWhale.address,
          parseEther('50')
        ),
        mockVToken.connect(usdcWhale).mint(parseEther('80')),
      ]);

      expect(
        await safeVenus.safeBorrow(
          mockVToken.address,
          usdcWhale.address,
          parseEther('0.5')
        )
      ).to.be.equal(0);
    });

    it('returns 0 if there is no cash', async () => {
      await Promise.all([
        mockVToken.__setTotalBorrows(parseEther('100')),
        mockVToken.__setBorrowBalanceStored(
          usdcWhale.address,
          parseEther('10')
        ),
        mockVToken.connect(usdcWhale).mint(parseEther('80')),
      ]);

      expect(
        await safeVenus.safeBorrow(
          mockVToken.address,
          usdcWhale.address,
          parseEther('0.7')
        )
      ).to.be.equal(0);
    });
    it('returns 0 if the new borrow amount is smaller than 5% of the previous amount', async () => {
      await Promise.all([
        mockVToken.__setTotalBorrows(parseEther('100')),
        mockVToken.__setBorrowBalanceStored(
          usdcWhale.address,
          parseEther('42')
        ),
        mockVToken.connect(usdcWhale).mint(parseEther('100')), // leads to 109 underlying tokens due to the exchange rate
        mockVToken.__setCash(parseEther('10')),
      ]);

      expect(
        await safeVenus.safeBorrow(
          mockVToken.address,
          usdcWhale.address,
          parseEther('0.5')
        )
      ).to.be.equal(0);
    });
  });

  it('borrowInterestPerBlock: returns (0,0) if there are no loans on the vToken', async () => {
    const data = await safeVenus.testBorrowInterestPerBlock(
      mockVToken.address,
      usdcWhale.address,
      0
    );

    expect(data[0]).to.be.equal(0);
    expect(data[1]).to.be.equal(0);
  });

  it('predictBorrowRate: has a cash guard', async () => {
    await mockVToken.__setCash(parseEther('49'));
    await expect(
      safeVenus.testPredictBorrowRate(mockVToken.address, parseEther('50'))
    ).to.not.reverted;
  });

  it('predictSupplyRate: has a cash guard', async () => {
    await mockVToken.__setCash(parseEther('49'));
    await expect(
      safeVenus.testPredictSupplyRate(mockVToken.address, parseEther('50'))
    ).to.not.reverted;
  });

  it('viewTotalBorrowsCurrent: reverts if the borrow rate is too high', async () => {
    await mockInterestRateModel.__setBorrowRate(parseEther('0.09'));
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    await expect(
      safeVenus.viewTotalBorrowsCurrent(mockVToken.address)
    ).to.be.revertedWith('borrow rate is absurdly high');
  });

  it('viewExchangeRate: reverts if the borrow rate is too high', async () => {
    await mockInterestRateModel.__setBorrowRate(parseEther('0.09'));
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    await expect(
      safeVenus.viewExchangeRate(mockVToken.address)
    ).to.be.revertedWith('borrow rate is absurdly high');
  });

  it('viewExchangeRate: reverts if there is no supply', async () => {
    await mockInterestRateModel.__setBorrowRate(
      parseEther('0.09').div(BLOCKS_PER_YEAR)
    );
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    await expect(
      safeVenus.viewExchangeRate(mockVToken.address)
    ).to.be.revertedWith('SV: no supply');
  });

  describe('Upgrade functionality', () => {
    it('reverts if it is called by a non-owner account', async () => {
      await safeVenus.connect(owner).transferOwnership(usdcWhale.address);

      await expect(upgrade(safeVenus, 'TestSafeVenusV2')).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });

    it('upgrades to version 2', async () => {
      const safeVenusV2: TestSafeVenusV2 = await upgrade(
        safeVenus,
        'TestSafeVenusV2'
      );

      const [version, oracle] = await Promise.all([
        safeVenusV2.version(),
        safeVenusV2.ORACLE(),
      ]);

      expect(version).to.be.equal('V2');
      expect(oracle).to.be.equal(mockOracle.address);
    });
  });
});
