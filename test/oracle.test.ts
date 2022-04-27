import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers, network } from 'hardhat';

import {
  MockBigChainLinkFeedV2,
  MockBytesErrorChainLinkFeed,
  MockErrorChainLinkFeed,
  MockTWAP,
  Oracle,
  TestOracleV2,
} from '../typechain';
import {
  BNB_USD_PRICE_FEED,
  CAKE,
  CAKE_BNB_PRICE_FEED,
  CAKE_USD_PRICE_FEED,
  WBNB,
  WBNB_CAKE_PAIR_LP_TOKEN,
} from './lib/constants';
import { deploy, deployUUPS, multiDeploy, upgrade } from './lib/test-utils';

const { parseEther } = ethers.utils;

const CAKE_USD_PRICE = ethers.BigNumber.from('9860000000000000000');

const WBNB_CAKE_LP_USD_PRICE = ethers.BigNumber.from('133831249510302866440');

const BNB_USD_PRICE = ethers.BigNumber.from('455031293540000000000'); // ~ 455 USD

const CAKE_BNB_PRICE = ethers.BigNumber.from('21625818173764674');

const TWAP_CAKE_BNB_PRICE = ethers.BigNumber.from('24983667000000000');

const TWAP_BNB_USD_PRICE = ethers.BigNumber.from('53987610666'); // ~ 528 USD

describe('Oracle', () => {
  let oracleV1: Oracle;
  let mockTWAP: MockTWAP;
  let mockErrorFeed: MockErrorChainLinkFeed;
  let mockBytesErrorFeed: MockBytesErrorChainLinkFeed;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;

  let dudUsdFeed: string;
  let dudBnBFeed: string;

  beforeEach(async () => {
    [
      [mockTWAP, mockErrorFeed, mockBytesErrorFeed],
      [owner, alice, { address: dudUsdFeed }, { address: dudBnBFeed }],
    ] = await Promise.all([
      multiDeploy(
        ['MockTWAP', 'MockErrorChainLinkFeed', 'MockBytesErrorChainLinkFeed'],
        [[], [], []]
      ),
      ethers.getSigners(),
    ]);

    [oracleV1] = await Promise.all([
      deployUUPS('Oracle', [mockTWAP.address]),
      mockTWAP.setValue(TWAP_CAKE_BNB_PRICE),
    ]);

    await Promise.all([
      oracleV1.connect(owner).setFeed(CAKE, CAKE_USD_PRICE_FEED, 0),
      oracleV1.connect(owner).setFeed(CAKE, CAKE_BNB_PRICE_FEED, 1),
    ]);
  });

  describe('function: initialize', () => {
    it('reverts if you call initialize after deployment', async () => {
      await expect(oracleV1.initialize(mockTWAP.address)).to.revertedWith(
        'Initializable: contract is already initialized'
      );
    });
    it('sets the initial state correctly', async () => {
      const [_owner, _twap] = await Promise.all([
        oracleV1.owner(),
        oracleV1.TWAP(),
      ]);

      expect(_owner).to.be.equal(owner.address);
      expect(_twap).to.be.equal(mockTWAP.address);
    });
  });

  describe('function: getUSDPrice', () => {
    it('returns the value of pair in USD', async () => {
      expect(
        await oracleV1.getUSDPrice(WBNB_CAKE_PAIR_LP_TOKEN, parseEther('1'))
      ).to.be.equal(WBNB_CAKE_LP_USD_PRICE);
    });
    it('returns the value of an ERC20 in USD', async () => {
      expect(await oracleV1.getUSDPrice(CAKE, parseEther('2'))).to.be.equal(
        CAKE_USD_PRICE.mul(2)
      ); // USD feeds are 8 decimal but contract converts all to 18
    });
  });

  describe('function: getTokenUSDPrice', () => {
    it('reverts if we ask for the price of the zero address', async () => {
      await expect(
        oracleV1.getTokenUSDPrice(ethers.constants.AddressZero, parseEther('1'))
      ).to.revertedWith('Oracle: no address zero');
    });
    it('returns the price of WBNB', async () => {
      expect(
        await oracleV1.getTokenUSDPrice(WBNB, parseEther('3'))
      ).to.be.equal(BNB_USD_PRICE.mul(3)); // USD feeds are 8 decimal but contract converts all to 18
    });
    it('returns the price of any ERC20', async () => {
      expect(
        await oracleV1.getTokenUSDPrice(CAKE, parseEther('2'))
      ).to.be.equal(CAKE_USD_PRICE.mul(2)); // USD feeds are 8 decimal but contract converts all to 18
    });
    it('calls the TWAP as a back up if it catches a string error and properly returns the price', async () => {
      await oracleV1.connect(owner).setFeed(CAKE, mockErrorFeed.address, 0);

      expect(
        await oracleV1.getTokenUSDPrice(CAKE, parseEther('1'))
      ).to.be.equal(
        TWAP_CAKE_BNB_PRICE.mul(BNB_USD_PRICE).div(parseEther('1'))
      );
    });
    it('calls the TWAP as a back up if it catches a bytes error and properly returns the price', async () => {
      await oracleV1
        .connect(owner)
        .setFeed(CAKE, mockBytesErrorFeed.address, 0);

      expect(
        await oracleV1.getTokenUSDPrice(CAKE, parseEther('1'))
      ).to.be.equal(
        TWAP_CAKE_BNB_PRICE.mul(BNB_USD_PRICE).div(parseEther('1'))
      );
    });
  });

  it('returns the USD and BNB price for a pair', async () => {
    const data = await oracleV1.getLPTokenPx(
      WBNB_CAKE_PAIR_LP_TOKEN,
      parseEther('1')
    );
    expect(data[0]).to.be.equal(
      WBNB_CAKE_LP_USD_PRICE.mul(parseEther('1')).div(BNB_USD_PRICE)
    );
    expect(data[1]).to.be.equal(WBNB_CAKE_LP_USD_PRICE);
  });

  it('returns the value of BNB for a pair', async () => {
    expect(
      await oracleV1.getLPTokenBNBPrice(WBNB_CAKE_PAIR_LP_TOKEN)
    ).to.be.equal(
      WBNB_CAKE_LP_USD_PRICE.mul(parseEther('1')).div(BNB_USD_PRICE)
    );
  });

  describe('function: getTokenBNBPrice', () => {
    it('reverts if the token is the zero address', async () => {
      await expect(
        oracleV1.getTokenBNBPrice(ethers.constants.AddressZero, parseEther('1'))
      ).to.revertedWith('Oracle: no address zero');
    });
    it('returns the amount if we ask for the WBNB price as it is the underlying', async () => {
      expect(
        await oracleV1.getTokenBNBPrice(WBNB, parseEther('2'))
      ).to.be.equal(parseEther('2'));
    });
    it('returns the price of an ERC20 in BNB', async () => {
      expect(
        await oracleV1.getTokenBNBPrice(CAKE, parseEther('3'))
      ).to.be.equal(ethers.BigNumber.from(CAKE_BNB_PRICE.mul(3)));
    });
    it('calls the TWAP on a bytes error as a back up and properly returns the price in BNB', async () => {
      await oracleV1
        .connect(owner)
        .setFeed(CAKE, mockBytesErrorFeed.address, 1);

      expect(
        await oracleV1.getTokenBNBPrice(CAKE, parseEther('2.5'))
      ).to.be.equal(
        TWAP_CAKE_BNB_PRICE.mul(parseEther('2.5')).div(parseEther('1'))
      );
    });
    it('calls the TWAP on a string error as a back up and properly returns the price in BNB', async () => {
      await oracleV1.connect(owner).setFeed(CAKE, mockErrorFeed.address, 1);

      expect(
        await oracleV1.getTokenBNBPrice(CAKE, parseEther('2.5'))
      ).to.be.equal(
        TWAP_CAKE_BNB_PRICE.mul(parseEther('2.5')).div(parseEther('1'))
      );
    });
  });

  describe('function: getBNBUSDPrice', () => {
    it('returns the price of BNB in USD', async () => {
      expect(await oracleV1.getBNBUSDPrice(parseEther('10'))).to.be.equal(
        BNB_USD_PRICE.mul(10)
      );
    });

    it('scales to 18 decimals if the feed decimals is above 18', async () => {
      const feed: MockBigChainLinkFeedV2 = await deploy(
        'MockBigChainLinkFeedV2',
        []
      );

      const [bnbUSDFeedCode, bigFeedCode] = await Promise.all([
        network.provider.send('eth_getCode', [BNB_USD_PRICE_FEED]),
        network.provider.send('eth_getCode', [feed.address]),
      ]);

      await network.provider.send('hardhat_setCode', [
        BNB_USD_PRICE_FEED,
        bigFeedCode,
      ]);

      expect(await oracleV1.getBNBUSDPrice(parseEther('10'))).to.be.equal(
        parseEther('0.01').mul(10)
      );

      await network.provider.send('hardhat_setCode', [
        BNB_USD_PRICE_FEED,
        bnbUSDFeedCode,
      ]);
    });

    it('calls the TWAP as a back up on a bytes error and properly returns the price of BNB in USD', async () => {
      // BUSD has 10 decimals so we try to emulate the real price
      await mockTWAP.setValue(TWAP_BNB_USD_PRICE.mul(1e10));

      const [bnbUSDFeedCode, errorFeedCode] = await Promise.all([
        network.provider.send('eth_getCode', [BNB_USD_PRICE_FEED]),
        network.provider.send('eth_getCode', [mockBytesErrorFeed.address]),
      ]);

      await network.provider.send('hardhat_setCode', [
        BNB_USD_PRICE_FEED,
        errorFeedCode,
      ]);

      expect(
        await oracleV1.callStatic.getBNBUSDPrice(parseEther('12.7'))
      ).to.be.equal(
        TWAP_BNB_USD_PRICE.mul(1e10)
          .mul(parseEther('12.7'))
          .div(parseEther('1'))
      );

      await network.provider.send('hardhat_setCode', [
        BNB_USD_PRICE_FEED,
        bnbUSDFeedCode,
      ]);
    });

    it('calls the TWAP as a back up on a string error and properly returns the price of BNB in USD', async () => {
      // BUSD has 10 decimals so we try to emulate the real price
      await mockTWAP.setValue(TWAP_BNB_USD_PRICE.mul(1e10));

      const [bnbUSDFeedCode, errorFeedCode] = await Promise.all([
        network.provider.send('eth_getCode', [BNB_USD_PRICE_FEED]),
        network.provider.send('eth_getCode', [mockErrorFeed.address]),
      ]);

      await network.provider.send('hardhat_setCode', [
        BNB_USD_PRICE_FEED,
        errorFeedCode,
      ]);

      expect(await oracleV1.getBNBUSDPrice(parseEther('12.7'))).to.be.equal(
        TWAP_BNB_USD_PRICE.mul(1e10)
          .mul(parseEther('12.7'))
          .div(parseEther('1'))
      );

      await network.provider.send('hardhat_setCode', [
        BNB_USD_PRICE_FEED,
        bnbUSDFeedCode,
      ]);
    });
  });

  describe('function: setFeed', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        oracleV1.connect(alice).setFeed(CAKE, dudBnBFeed, 1)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('updates a BNB feed', async () => {
      expect(await oracleV1.getBNBFeeds(CAKE)).to.be.equal(CAKE_BNB_PRICE_FEED);
      expect(await oracleV1.getUSDFeeds(CAKE)).to.be.equal(CAKE_USD_PRICE_FEED);
      await oracleV1.connect(owner).setFeed(CAKE, dudBnBFeed, 1); // 1 means BNB feed;

      expect(await oracleV1.getBNBFeeds(CAKE)).to.be.equal(dudBnBFeed);
      expect(await oracleV1.getUSDFeeds(CAKE)).to.be.equal(CAKE_USD_PRICE_FEED);
    });
    it('updates a USD feed', async () => {
      expect(await oracleV1.getUSDFeeds(CAKE)).to.be.equal(CAKE_USD_PRICE_FEED);
      expect(await oracleV1.getBNBFeeds(CAKE)).to.be.equal(CAKE_BNB_PRICE_FEED);

      await oracleV1.connect(owner).setFeed(CAKE, dudUsdFeed, 0); // 0 means USD feed;
      expect(await oracleV1.getUSDFeeds(CAKE)).to.be.equal(dudUsdFeed);
      expect(await oracleV1.getBNBFeeds(CAKE)).to.be.equal(CAKE_BNB_PRICE_FEED);
    });
  });

  describe('Upgrade functionality', () => {
    it('reverts if it is called by a non-owner account', async () => {
      await oracleV1.connect(owner).transferOwnership(alice.address);

      await expect(upgrade(oracleV1, 'TestOracleV2')).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });

    it('upgrades to version 2', async () => {
      const oracleV2: TestOracleV2 = await upgrade(oracleV1, 'TestOracleV2');

      const [version, price] = await Promise.all([
        oracleV2.version(),
        oracleV2.getBNBUSDPrice(parseEther('2')),
      ]);

      expect(version).to.be.equal('V2');
      // 18 decimals
      expect(price).to.be.equal(BNB_USD_PRICE.mul(2));
    });
  });
})
  // Increase the time out for the entire tests
  .timeout(5000);
