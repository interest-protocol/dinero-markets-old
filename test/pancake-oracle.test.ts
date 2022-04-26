import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import ERC20ABI from '../abi/erc20.json';
import PCSRouterABI from '../abi/pcs-router.json';
import {
  ERC20,
  PancakeOracle,
  TestPancakeOracleV2,
  TestTPCSLibrary,
} from '../typechain';
import {
  CAKE,
  CAKE_WHALE_ONE,
  PCS_ROUTER,
  WBNB,
  WBNB_CAKE_PAIR_LP_TOKEN,
} from './lib/constants';
import {
  advanceBlockAndTime,
  deploy,
  deployUUPS,
  impersonate,
  sortTokens,
  upgrade,
} from './lib/test-utils';

const { parseEther } = ethers.utils;

const WINDOW = 86_400; // 24 hours - 60 * 60 * 24

const GRANULARITY = 4;

const PERIOD_SIZE = WINDOW / GRANULARITY; // 6 hours

describe('PancakeOracle', () => {
  let oracle: PancakeOracle;
  const router = new ethers.Contract(PCS_ROUTER, PCSRouterABI, ethers.provider);
  const CakeContract = new ethers.Contract(
    CAKE,
    ERC20ABI,
    ethers.provider
  ) as ERC20;
  const WBNBContract = new ethers.Contract(
    WBNB,
    ERC20ABI,
    ethers.provider
  ) as ERC20;

  let testLibrary: TestTPCSLibrary;

  let owner: SignerWithAddress;
  beforeEach(async () => {
    [owner] = await ethers.getSigners();

    testLibrary = await deploy('TestTPCSLibrary', []);

    oracle = await deployUUPS('PancakeOracle', [WINDOW, GRANULARITY]);
  });

  describe('function: initialize', () => {
    it('reverts if you call after deployment', async () => {
      expect(oracle.initialize(WINDOW, GRANULARITY)).to.revertedWith(
        'Initializable: contract is already initialized'
      );
    });
    it('reverts if you granularity or period size is incorrect', async () => {
      await expect(deployUUPS('PancakeOracle', [WINDOW, 0])).to.revertedWith(
        'PO: granularity > 1'
      );
    });
    it('sets the initial state correctly', async () => {
      const [_owner, _windowSize, _granularity, _periodSize] =
        await Promise.all([
          oracle.owner(),
          oracle.WINDOW_SIZE(),
          oracle.GRANULARITY(),
          oracle.PERIOD_SIZE(),
        ]);

      expect(_owner).to.be.equal(owner.address);
      expect(_windowSize).to.be.equal(WINDOW);
      expect(_granularity).to.be.equal(GRANULARITY);
      expect(_periodSize).to.be.equal(PERIOD_SIZE);
    });
  });

  it('calculates an index between 0 to 3 for any timestamp', async () => {
    // Feb 1st 2022 - 07:49 GMT unix timestamp seconds
    const timestamp = 1_643_701_705;
    const epoch = PERIOD_SIZE; // 6 hours We add some dust for rounding.

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
      await expect(oracle.update(owner.address, CAKE)).to.revertedWith(
        'PO: pair does not exist'
      );
    });

    it(`only updates every ${PERIOD_SIZE}`, async () => {
      await expect(oracle.update(CAKE, WBNB)).to.emit(oracle, 'Update');
      await expect(oracle.update(CAKE, WBNB)).to.not.emit(oracle, 'Update');
      await expect(oracle.update(CAKE, WBNB)).to.not.emit(oracle, 'Update');
      await expect(oracle.update(CAKE, WBNB)).to.not.emit(oracle, 'Update');

      const observations = await Promise.all([
        oracle.pairObservations(WBNB_CAKE_PAIR_LP_TOKEN, 0),
        oracle.pairObservations(WBNB_CAKE_PAIR_LP_TOKEN, 1),
        oracle.pairObservations(WBNB_CAKE_PAIR_LP_TOKEN, 2),
        oracle.pairObservations(WBNB_CAKE_PAIR_LP_TOKEN, 3),
      ]);

      expect(
        observations.filter((x) => !x.price0Cumulative.isZero()).length
      ).to.be.equal(1);
    });

    it('updates every period size', async () => {
      await expect(oracle.update(CAKE, WBNB)).to.emit(oracle, 'Update');

      await advanceBlockAndTime(PERIOD_SIZE, ethers);

      await expect(oracle.update(CAKE, WBNB)).to.emit(oracle, 'Update');

      await advanceBlockAndTime(PERIOD_SIZE, ethers);

      await expect(oracle.update(CAKE, WBNB)).to.emit(oracle, 'Update');

      await advanceBlockAndTime(PERIOD_SIZE, ethers);

      await expect(oracle.update(CAKE, WBNB)).to.emit(oracle, 'Update');

      const observations = await Promise.all([
        oracle.pairObservations(WBNB_CAKE_PAIR_LP_TOKEN, 0),
        oracle.pairObservations(WBNB_CAKE_PAIR_LP_TOKEN, 1),
        oracle.pairObservations(WBNB_CAKE_PAIR_LP_TOKEN, 2),
        oracle.pairObservations(WBNB_CAKE_PAIR_LP_TOKEN, 3),
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
      await oracle.update(CAKE, WBNB);

      // Miss one observation
      await advanceBlockAndTime(PERIOD_SIZE + PERIOD_SIZE, ethers);

      await oracle.update(CAKE, WBNB);
      await advanceBlockAndTime(PERIOD_SIZE, ethers);

      await oracle.update(CAKE, WBNB);

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
      await expect(oracle.consult(CAKE, parseEther('1'), WBNB)).to.revertedWith(
        'PO: missing observation'
      );

      await advanceBlockAndTime(
        PERIOD_SIZE + PERIOD_SIZE + PERIOD_SIZE + 50,
        ethers
      );

      // It has been over 24 hours since the last update.
      await expect(oracle.consult(CAKE, parseEther('1'), WBNB)).to.revertedWith(
        'PO: missing observation'
      );
    });
    it('returns the price of an asset', async () => {
      await oracle.update(CAKE, WBNB);

      await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

      await oracle.update(CAKE, WBNB);

      await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

      await oracle.update(CAKE, WBNB);

      await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

      await oracle.update(CAKE, WBNB);

      await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

      const cakeBNBPrice = await oracle.consult(CAKE, parseEther('100'), WBNB);
      const bnbCakePrice = await oracle.consult(WBNB, parseEther('1'), CAKE);

      // Taken after the fact
      expect(cakeBNBPrice).to.be.equal(
        ethers.BigNumber.from('2164507108173697662')
      );
      // Taken after the fact
      expect(bnbCakePrice).to.be.equal(
        ethers.BigNumber.from('46199894480538331549')
      );

      const cakeWhale = await impersonate(CAKE_WHALE_ONE);

      await Promise.all([
        owner.sendTransaction({
          value: parseEther('10'),
          to: CAKE_WHALE_ONE,
        }),
        WBNBContract.connect(cakeWhale).approve(
          router.address,
          ethers.constants.MaxUint256
        ),
        CakeContract.connect(cakeWhale).approve(
          router.address,
          ethers.constants.MaxUint256
        ),
      ]);

      const timestamp = (
        await ethers.provider.getBlock(await ethers.provider.getBlockNumber())
      ).timestamp;

      // Gonna keep selling BTC
      await router
        .connect(cakeWhale)
        .swapExactTokensForTokens(
          parseEther('100'),
          0,
          [CAKE, WBNB],
          owner.address,
          timestamp * 10
        );

      await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

      await oracle.update(CAKE, WBNB);

      // Gonna keep selling BTC
      await router
        .connect(cakeWhale)
        .swapExactTokensForTokens(
          parseEther('100'),
          0,
          [CAKE, WBNB],
          owner.address,
          timestamp * 10
        );

      await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

      await oracle.update(CAKE, WBNB);

      const timestamp2 = (
        await ethers.provider.getBlock(await ethers.provider.getBlockNumber())
      ).timestamp;

      const index = await oracle.observationIndexOf(timestamp2);

      const [cakeBNBPrice1, bnbCakePrice1, firstObservation, currentPrices] =
        await Promise.all([
          oracle.consult(CAKE, parseEther('100'), WBNB),
          oracle.consult(WBNB, parseEther('1'), CAKE),
          oracle.pairObservations(
            WBNB_CAKE_PAIR_LP_TOKEN,
            (index + 1) % GRANULARITY
          ),
          testLibrary.currentCumulativePrices(WBNB_CAKE_PAIR_LP_TOKEN),
        ]);

      const sortedTokens = sortTokens(CAKE, WBNB);

      const isCake = sortedTokens[0] === CAKE;

      // Cake is token0
      expect(isCake ? cakeBNBPrice1 : bnbCakePrice1).to.be.equal(
        currentPrices[0]
          .sub(firstObservation.price0Cumulative)
          .div(
            ethers.BigNumber.from(timestamp2).sub(firstObservation.timestamp)
          )
          .mul(parseEther(isCake ? '100' : '1'))
          .shr(112)
      );

      // BNB is token1
      expect(isCake ? bnbCakePrice1 : cakeBNBPrice1).to.be.equal(
        currentPrices[1]
          .sub(firstObservation.price1Cumulative)
          .div(
            ethers.BigNumber.from(timestamp2).sub(firstObservation.timestamp)
          )
          .mul(parseEther(isCake ? '1' : '100'))
          .shr(112)
      );
    });
  });

  describe('Upgrade functionality', () => {
    it('reverts if a non-owner account calls it', async () => {
      await oracle.connect(owner).renounceOwnership();

      await expect(upgrade(oracle, 'TestPancakeOracleV2')).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });

    it('upgrades to version 2', async () => {
      await oracle.update(CAKE, WBNB);

      await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

      await oracle.update(CAKE, WBNB);

      await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

      await oracle.update(CAKE, WBNB);

      await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

      await oracle.update(CAKE, WBNB);

      await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

      const oracleV2: TestPancakeOracleV2 = await upgrade(
        oracle,
        'TestPancakeOracleV2'
      );

      const [cakeBNBPrice, bnbCakePrice, version] = await Promise.all([
        oracleV2.consult(CAKE, parseEther('100'), WBNB),
        oracleV2.consult(WBNB, parseEther('1'), CAKE),
        oracleV2.version(),
      ]);

      // Taken after the fact
      expect(cakeBNBPrice).to.be.equal(
        ethers.BigNumber.from('2164448100172529649')
      );
      // Taken after the fact
      expect(bnbCakePrice).to.be.equal(
        ethers.BigNumber.from('46201153999501734914')
      );
      expect(version).to.be.equal('V2');
    });
  });
});
