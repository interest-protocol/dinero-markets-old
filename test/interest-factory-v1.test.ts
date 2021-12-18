import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { deploy, multiDeploy } from '../lib/test-utils';
import { Dinero, InterestFactoryV1, MockInterestMarketV1 } from '../typechain';

const { defaultAbiCoder, keccak256 } = ethers.utils;
const { AddressZero } = ethers.constants;
const makeData = (data: string) => defaultAbiCoder.encode(['string'], [data]);

describe('InterestFactoryV1', () => {
  // Contracts
  let dinero: Dinero;
  let mockInterestMarketV1: MockInterestMarketV1;
  let interestFactoryV1: InterestFactoryV1;

  // Users
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;

  // Fake Addresses
  let stakerContractAddress: string;
  let collateralTokenAddress: string;
  let unregisteredMarketAddress: string;

  beforeEach(async () => {
    [
      [
        owner,
        alice,
        { address: stakerContractAddress },
        { address: collateralTokenAddress },
        { address: unregisteredMarketAddress },
      ],
      [mockInterestMarketV1, dinero],
    ] = await Promise.all([
      ethers.getSigners(),
      multiDeploy(['MockInterestMarketV1', 'Dinero']),
    ]);

    interestFactoryV1 = await deploy('InterestFactoryV1', [dinero.address]);

    await dinero
      .connect(owner)
      .grantRole(await dinero.DEFAULT_ADMIN_ROLE(), interestFactoryV1.address);
  });

  it('returns the address of the Dinero contract', async () => {
    expect(await interestFactoryV1.DINERO()).to.be.equal(dinero.address);
  });

  it('returns the total number of deployed markets', async () => {
    expect(await interestFactoryV1.getAllMarketsLength()).to.be.equal(0);

    const masterMarketContractAddress = mockInterestMarketV1.address;

    const contracts = [
      [masterMarketContractAddress, makeData('data1')],
      [masterMarketContractAddress, makeData('data3')],
      [masterMarketContractAddress, makeData('data4')],
      [masterMarketContractAddress, makeData('data5')],
    ];
    await Promise.all(
      contracts.map(([contract, data]) =>
        interestFactoryV1
          .connect(owner)
          // @notice Since we are using a mock market we can pass any address as the collateral token
          .createMarket(contract, collateralTokenAddress, data)
      )
    );
    expect(await interestFactoryV1.getAllMarketsLength()).to.be.equal(
      contracts.length
    );
  });

  it('tells if a market is registered', async () => {
    expect(
      await interestFactoryV1.isMarket(unregisteredMarketAddress)
    ).to.be.equal(false);

    await interestFactoryV1
      .connect(owner)
      .createMarket(
        mockInterestMarketV1.address,
        stakerContractAddress,
        makeData('data1')
      );

    const market = await interestFactoryV1.allMarkets([0]);

    expect(await interestFactoryV1.isMarket(market)).to.be.equal(true);
  });

  describe('function: getStaker', () => {
    it('reverts if the market does not exist', async () => {
      await expect(interestFactoryV1.getStaker(AddressZero)).to.revertedWith(
        'IFV1: not a market'
      );
    });
    it('returns the staker associated with a market', async () => {
      await interestFactoryV1
        .connect(owner)
        .createMarket(
          mockInterestMarketV1.address,
          collateralTokenAddress,
          makeData('data1')
        );

      const market = await interestFactoryV1.allMarkets(0);

      // @notice Since this is a unit test using a mock contract we can use any address for the staker contract
      await interestFactoryV1.setStaker(market, stakerContractAddress);

      expect(await interestFactoryV1.getStaker(market)).to.be.equal(
        stakerContractAddress
      );
    });
  });

  it('allows to predict a clone address', async () => {
    const data = makeData('data1');
    await interestFactoryV1
      .connect(owner)
      .createMarket(mockInterestMarketV1.address, collateralTokenAddress, data);

    const market = await interestFactoryV1.allMarkets([0]);

    expect(
      await interestFactoryV1.predictMarketAddress(
        mockInterestMarketV1.address,
        keccak256(data)
      )
    ).to.be.equal(market);
  });

  describe('function: setStaker', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        interestFactoryV1
          .connect(alice)
          // @notice because this a unit test we can pass arbitrary addresses
          .setStaker(unregisteredMarketAddress, stakerContractAddress)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if the market does not exist', async () => {
      await expect(
        interestFactoryV1
          .connect(owner)
          // @notice because this a unit test we can pass arbitrary addresses
          .setStaker(unregisteredMarketAddress, stakerContractAddress)
      ).to.revertedWith('IFV1: not a market');
    });
    it('sets a staker address to a market', async () => {
      await interestFactoryV1
        .connect(owner)
        .createMarket(
          mockInterestMarketV1.address,
          stakerContractAddress,
          makeData('data1')
        );

      const market = await interestFactoryV1.allMarkets([0]);

      // @notice Since this is a unit test using a mock contract we can use any address for the staker contract
      await expect(interestFactoryV1.setStaker(market, stakerContractAddress))
        .to.emit(interestFactoryV1, 'StakerUpdated')
        .withArgs(market, stakerContractAddress);
    });
  });
  describe('function: setFeeTo', () => {
    it('reverts if the caller is not the owner', async () => {
      await expect(
        interestFactoryV1.connect(alice).setFeeTo(dinero.address)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if the zero address is passed', async () => {
      await expect(
        interestFactoryV1.connect(owner).setFeeTo(AddressZero)
      ).to.revertedWith('IFV1: not zero address');
    });
    it('updates the feeTo address', async () => {
      expect(await interestFactoryV1.feeTo()).to.be.equal(AddressZero);
      await expect(interestFactoryV1.connect(owner).setFeeTo(alice.address))
        .to.emit(interestFactoryV1, 'FeeToUpdated')
        .withArgs(alice.address);
      expect(await interestFactoryV1.feeTo()).to.be.equal(alice.address);
    });
  });
  describe('function: createMarket', () => {
    it('reverts if the caller is not the owner', async () => {
      await expect(
        interestFactoryV1
          .connect(alice)
          .createMarket(
            unregisteredMarketAddress,
            collateralTokenAddress,
            makeData('data')
          )
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if the master market contract is address zero', async () => {
      await expect(
        interestFactoryV1
          .connect(owner)
          .createMarket(AddressZero, collateralTokenAddress, makeData('data'))
      ).to.revertedWith('IFV1: not zero address');
    });
    it('reverts if the collateral token is address zero', async () => {
      await expect(
        interestFactoryV1
          .connect(owner)
          .createMarket(
            unregisteredMarketAddress,
            AddressZero,
            makeData('data')
          )
      ).to.revertedWith('IFV1: not zero address');
    });
    it('reverts if you clone the master contract with the same data', async () => {
      await interestFactoryV1
        .connect(owner)
        .createMarket(
          mockInterestMarketV1.address,
          stakerContractAddress,
          makeData('data1')
        );

      await expect(
        interestFactoryV1
          .connect(owner)
          .createMarket(
            mockInterestMarketV1.address,
            stakerContractAddress,
            makeData('data1')
          )
      ).to.revertedWith('ERC1167: create2 failed');
    });
    it('creates a master market contract clone', async () => {
      const data = makeData('data1');

      // Throws because it has not been instantiated
      await expect(interestFactoryV1.allMarkets(0)).to.revertedWith('');
      const predictedAddress = await interestFactoryV1.predictMarketAddress(
        mockInterestMarketV1.address,
        keccak256(data)
      );
      expect(await interestFactoryV1.isMarket(predictedAddress)).to.be.equal(
        false
      );
      await expect(
        interestFactoryV1
          .connect(owner)
          .createMarket(
            mockInterestMarketV1.address,
            collateralTokenAddress,
            data
          )
      )
        .to.emit(interestFactoryV1, 'MarketCreated')
        .withArgs(collateralTokenAddress, predictedAddress, 0);

      const market = await interestFactoryV1.allMarkets(0);
      expect(await interestFactoryV1.isMarket(market)).to.be.equal(true);
      expect(market).to.be.equal(predictedAddress);

      expect(
        await dinero.hasRole(await dinero.MINTER_ROLE(), market)
      ).to.be.equal(true);
      expect(
        await dinero.hasRole(await dinero.BURNER_ROLE(), market)
      ).to.be.equal(true);
      const marketContract: MockInterestMarketV1 = await (
        await ethers.getContractFactory('MockInterestMarketV1')
      ).attach(market);
      expect(await marketContract.initialized()).to.be.equal(true);
    });
  });
});
