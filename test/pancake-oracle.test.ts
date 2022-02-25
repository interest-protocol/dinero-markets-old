import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  LiquidityRouter,
  MockERC20,
  MockLibraryWrapper,
  PancakeFactory,
  PancakeOracle,
  PancakeRouter,
  TestPancakeOracleV2,
  WETH9,
} from '../typechain';
import {
  advanceBlockAndTime,
  deploy,
  deployUUPS,
  multiDeploy,
  upgrade,
} from './lib/test-utils';

const { parseEther } = ethers.utils;

const WINDOW = 86_400; // 24 hours - 60 * 60 * 24

const GRANULARITY = 4;

const PERIOD_SIZE = WINDOW / GRANULARITY; // 6 hours

describe('PancakeOracle', () => {
  let oracle: PancakeOracle;
  let factory: PancakeFactory;
  let libraryWrapper: MockLibraryWrapper;
  let router: PancakeRouter;
  let liquidityRouter: LiquidityRouter;
  let weth: WETH9;
  let btc: MockERC20;
  let usdc: MockERC20;

  let owner: SignerWithAddress;
  let btcUSDCPair: string;
  let feeTo: SignerWithAddress;
  beforeEach(async () => {
    [[owner, feeTo], [libraryWrapper, weth, btc, usdc]] = await Promise.all([
      ethers.getSigners(),
      multiDeploy(
        ['MockLibraryWrapper', 'WETH9', 'MockERC20', 'MockERC20'],
        [
          [],
          [],
          ['Bitcoin', 'BTC', parseEther('1500')],
          ['USDC', 'USDC', parseEther('60000000')],
        ]
      ),
    ]);

    factory = await deploy('PancakeFactory', [feeTo.address]);
    [oracle, [liquidityRouter, router]] = await Promise.all([
      deployUUPS('PancakeOracle', [
        factory.address,
        WINDOW,
        GRANULARITY,
        libraryWrapper.address,
      ]),
      multiDeploy(
        ['LiquidityRouter', 'PancakeRouter'],
        [
          [factory.address, weth.address],
          [factory.address, weth.address],
        ]
      ),
    ]);

    await Promise.all([
      btc.connect(owner).approve(router.address, ethers.constants.MaxUint256),
      btc
        .connect(owner)
        .approve(liquidityRouter.address, ethers.constants.MaxUint256),
      usdc.connect(owner).approve(router.address, ethers.constants.MaxUint256),
      usdc
        .connect(owner)
        .approve(liquidityRouter.address, ethers.constants.MaxUint256),
    ]);

    // 1 BTC = 50_000 USDC
    await liquidityRouter.addLiquidity(
      btc.address,
      usdc.address,
      parseEther('1000'),
      parseEther('50000000'),
      parseEther('1000'),
      parseEther('50000000'),
      feeTo.address,
      0
    );

    btcUSDCPair = await factory.allPairs(0);

    await libraryWrapper.setPair(btcUSDCPair);
  });

  it('calculates an index between 0 to 3 for any timestamp', async () => {
    // Feb 1st 2022 - 07:49 GMT unix timestamp seconds
    const timestamp = 1_643_701_705;
    const epoch = PERIOD_SIZE + 50; // 6 hours We add some dust for rounding.

    // Was taken by running the test once. With it we can calculate the next ones.
    expect(await oracle.observationIndexOf(timestamp)).to.be.equal(1);
    expect(await oracle.observationIndexOf(timestamp + epoch)).to.be.equal(2);
    expect(
      await oracle.observationIndexOf(timestamp + epoch + epoch)
    ).to.be.equal(3);
    expect(
      await oracle.observationIndexOf(timestamp + epoch + epoch + epoch)
    ).to.be.equal(0);
  });

  describe('function: update', () => {
    it('reverts if the pair does not exist', async () => {
      await expect(oracle.update(owner.address, btc.address)).to.revertedWith(
        'PO: pair does not exist'
      );
    });

    it(`only updates every ${PERIOD_SIZE}`, async () => {
      await expect(oracle.update(btc.address, usdc.address)).to.emit(
        oracle,
        'Update'
      );
      await expect(oracle.update(btc.address, usdc.address)).to.not.emit(
        oracle,
        'Update'
      );

      const observations = await Promise.all([
        oracle.pairObservations(btcUSDCPair, 0),
        oracle.pairObservations(btcUSDCPair, 1),
        oracle.pairObservations(btcUSDCPair, 2),
        oracle.pairObservations(btcUSDCPair, 3),
      ]);

      expect(
        observations.filter((x) => !x.price0Cumulative.isZero()).length
      ).to.be.equal(1);
    });

    it('updates every period size', async () => {
      await expect(oracle.update(btc.address, usdc.address)).to.emit(
        oracle,
        'Update'
      );

      await advanceBlockAndTime(PERIOD_SIZE, ethers);

      await expect(oracle.update(btc.address, usdc.address)).to.emit(
        oracle,
        'Update'
      );

      await advanceBlockAndTime(PERIOD_SIZE, ethers);

      await expect(oracle.update(btc.address, usdc.address)).to.emit(
        oracle,
        'Update'
      );

      await advanceBlockAndTime(PERIOD_SIZE, ethers);

      await expect(oracle.update(btc.address, usdc.address)).to.emit(
        oracle,
        'Update'
      );

      const observations = await Promise.all([
        oracle.pairObservations(btcUSDCPair, 0),
        oracle.pairObservations(btcUSDCPair, 1),
        oracle.pairObservations(btcUSDCPair, 2),
        oracle.pairObservations(btcUSDCPair, 3),
      ]);

      const currentIndex = await oracle.observationIndexOf(
        (
          await ethers.provider.getBlock(await ethers.provider.getBlockNumber())
        ).timestamp
      );

      const previousIndex = currentIndex === 0 ? 3 : currentIndex - 1;

      // All values have been updated
      expect(
        observations.filter((x) => !x.price0Cumulative.isZero()).length
      ).to.be.equal(4);

      expect(
        observations[currentIndex].timestamp.gt(
          observations[previousIndex].timestamp
        )
      ).to.be.equal(true);
      expect(
        observations[currentIndex].price0Cumulative.gt(
          observations[previousIndex].price0Cumulative
        )
      ).to.be.equal(true);
      expect(
        observations[currentIndex].price1Cumulative.gt(
          observations[previousIndex].price1Cumulative
        )
      ).to.be.equal(true);
    });
  });

  describe('function: consult', () => {
    it('reverts if we are missing observations', async () => {
      await oracle.update(btc.address, usdc.address);

      // Miss one observation
      await advanceBlockAndTime(PERIOD_SIZE + PERIOD_SIZE, ethers);

      await oracle.update(btc.address, usdc.address);
      await advanceBlockAndTime(PERIOD_SIZE, ethers);

      await oracle.update(btc.address, usdc.address);

      await advanceBlockAndTime(PERIOD_SIZE, ethers);

      // Example: Time delays might change the specific indexes.
      // 0 - update
      // 6 - NO UPDATE
      // 12 - update
      // 18 - update
      // 24 - Consult fails here

      // 0 -  set
      // 1 - set
      // 2 - NO DATA
      // 3 - set

      // The index is missing because we skipped a period.
      await expect(
        oracle.consult(btc.address, parseEther('1'), usdc.address)
      ).to.revertedWith('PO: missing observation');

      await advanceBlockAndTime(
        PERIOD_SIZE + PERIOD_SIZE + PERIOD_SIZE + 50,
        ethers
      );

      // It has been over 24 hours since the last update.
      await expect(
        oracle.consult(btc.address, parseEther('1'), usdc.address)
      ).to.revertedWith('PO: missing observation');
    });
    it('returns the price of an asset', async () => {
      await oracle.update(btc.address, usdc.address);

      await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

      await oracle.update(btc.address, usdc.address);

      await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

      await oracle.update(btc.address, usdc.address);

      await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

      await oracle.update(btc.address, usdc.address);

      await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

      const btcUSDCPrice = await oracle.consult(
        btc.address,
        parseEther('1'),
        usdc.address
      );
      const usdcBTCPrice = await oracle.consult(
        usdc.address,
        parseEther('50000'),
        btc.address
      );

      expect(btcUSDCPrice).to.be.equal(parseEther('50000'));
      // Taken after the fact
      expect(usdcBTCPrice).to.be.equal(
        ethers.BigNumber.from('999999999999999999')
      );

      // Gonna keep selling BTC
      await router
        .connect(owner)
        .swapExactTokensForTokens(
          parseEther('100'),
          0,
          [btc.address, usdc.address],
          owner.address,
          0
        );

      await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

      await oracle.update(btc.address, usdc.address);

      // Gonna keep selling BTC
      await router
        .connect(owner)
        .swapExactTokensForTokens(
          parseEther('100'),
          0,
          [btc.address, usdc.address],
          owner.address,
          0
        );

      await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

      await oracle.update(btc.address, usdc.address);

      const timestamp = (
        await ethers.provider.getBlock(await ethers.provider.getBlockNumber())
      ).timestamp;

      const index = await oracle.observationIndexOf(timestamp);

      const [
        btcUSDCPrice1,
        usdcBTCPrice1,
        firstObservation,
        currentPrices,
        sortedTokens,
      ] = await Promise.all([
        oracle.consult(btc.address, parseEther('1'), usdc.address),
        oracle.consult(usdc.address, parseEther('1000'), btc.address),
        oracle.pairObservations(btcUSDCPair, (index + 1) % GRANULARITY),
        libraryWrapper.currentCumulativePrices(btcUSDCPair),
        libraryWrapper.sortTokens(btc.address, usdc.address),
      ]);

      const isBTC = sortedTokens[0] === btc.address;

      // BTC is token0
      expect(isBTC ? btcUSDCPrice1 : usdcBTCPrice1).to.be.equal(
        currentPrices[0]
          .sub(firstObservation.price0Cumulative)
          .div(ethers.BigNumber.from(timestamp).sub(firstObservation.timestamp))
          .mul(parseEther(isBTC ? '1' : '1000'))
          .shr(112)
      );

      // USDC is token1
      expect(isBTC ? usdcBTCPrice1 : btcUSDCPrice1).to.be.equal(
        currentPrices[1]
          .sub(firstObservation.price1Cumulative)
          .div(ethers.BigNumber.from(timestamp).sub(firstObservation.timestamp))
          .mul(parseEther(isBTC ? '1000' : '1'))
          .shr(112)
      );
    });
  });
  it('upgrades to version 2', async () => {
    await oracle.update(btc.address, usdc.address);

    await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

    await oracle.update(btc.address, usdc.address);

    await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

    await oracle.update(btc.address, usdc.address);

    await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

    await oracle.update(btc.address, usdc.address);

    await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

    const oracleV2: TestPancakeOracleV2 = await upgrade(
      oracle,
      'TestPancakeOracleV2'
    );

    const [btcUSDCPrice, usdcBTCPrice, version] = await Promise.all([
      oracleV2.consult(btc.address, parseEther('1'), usdc.address),
      oracleV2.consult(usdc.address, parseEther('50000'), btc.address),
      oracleV2.version(),
    ]);

    expect(btcUSDCPrice).to.be.equal(parseEther('50000'));
    // Taken after the fact
    expect(usdcBTCPrice).to.be.equal(
      ethers.BigNumber.from('999999999999999999')
    );
    expect(version).to.be.equal('V2');
  });
});
