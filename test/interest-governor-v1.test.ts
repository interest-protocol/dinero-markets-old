import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { Dinero, InterestGovernorV1, MockInterestMarketV1 } from '../typechain';
import { deploy, multiDeploy } from './lib/test-utils';

const { defaultAbiCoder, keccak256 } = ethers.utils;
const { AddressZero } = ethers.constants;
const makeData = (data: string) => defaultAbiCoder.encode(['string'], [data]);

describe('InterestGovernorV1', () => {
  // Contracts
  let dinero: Dinero;
  let mockInterestMarketV1: MockInterestMarketV1;
  let interestGovernorV1: InterestGovernorV1;

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

    interestGovernorV1 = await deploy('InterestGovernorV1', [dinero.address]);

    await dinero
      .connect(owner)
      .grantRole(await dinero.DEFAULT_ADMIN_ROLE(), interestGovernorV1.address);
  });

  it('returns the address of the Dinero contract', async () => {
    expect(await interestGovernorV1.DINERO()).to.be.equal(dinero.address);
  });

  it('returns the total number of deployed markets', async () => {
    expect(await interestGovernorV1.getAllMarketsLength()).to.be.equal(0);

    const masterMarketContractAddress = mockInterestMarketV1.address;

    const contracts = [
      [masterMarketContractAddress, makeData('data1')],
      [masterMarketContractAddress, makeData('data3')],
      [masterMarketContractAddress, makeData('data4')],
      [masterMarketContractAddress, makeData('data5')],
    ];
    await Promise.all(
      contracts.map(([contract, data]) =>
        interestGovernorV1
          .connect(owner)
          // @notice Since we are using a mock market we can pass any address as the collateral token
          .createMarket(contract, collateralTokenAddress, data)
      )
    );
    expect(await interestGovernorV1.getAllMarketsLength()).to.be.equal(
      contracts.length
    );
  });

  it('tells if a market is registered', async () => {
    expect(
      await interestGovernorV1.isMarket(unregisteredMarketAddress)
    ).to.be.equal(false);

    await interestGovernorV1
      .connect(owner)
      .createMarket(
        mockInterestMarketV1.address,
        stakerContractAddress,
        makeData('data1')
      );

    const market = await interestGovernorV1.allMarkets([0]);

    expect(await interestGovernorV1.isMarket(market)).to.be.equal(true);
  });

  describe('function: getStaker', () => {
    it('reverts if the market does not exist', async () => {
      await expect(interestGovernorV1.getStaker(AddressZero)).to.revertedWith(
        'IFV1: not a market'
      );
    });
    it('returns the staker associated with a market', async () => {
      await interestGovernorV1
        .connect(owner)
        .createMarket(
          mockInterestMarketV1.address,
          collateralTokenAddress,
          makeData('data1')
        );

      const market = await interestGovernorV1.allMarkets(0);

      // @notice Since this is a unit test using a mock contract we can use any address for the staker contract
      await interestGovernorV1.setStaker(market, stakerContractAddress);

      expect(await interestGovernorV1.getStaker(market)).to.be.equal(
        stakerContractAddress
      );
    });
  });

  it('allows to predict a clone address', async () => {
    const data = makeData('data1');
    await interestGovernorV1
      .connect(owner)
      .createMarket(mockInterestMarketV1.address, collateralTokenAddress, data);

    const market = await interestGovernorV1.allMarkets([0]);

    expect(
      await interestGovernorV1.predictMarketAddress(
        mockInterestMarketV1.address,
        keccak256(data)
      )
    ).to.be.equal(market);
  });

  describe('function: setStaker', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        interestGovernorV1
          .connect(alice)
          // @notice because this a unit test we can pass arbitrary addresses
          .setStaker(unregisteredMarketAddress, stakerContractAddress)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if the market does not exist', async () => {
      await expect(
        interestGovernorV1
          .connect(owner)
          // @notice because this a unit test we can pass arbitrary addresses
          .setStaker(unregisteredMarketAddress, stakerContractAddress)
      ).to.revertedWith('IFV1: not a market');
    });
    it('sets a staker address to a market', async () => {
      await interestGovernorV1
        .connect(owner)
        .createMarket(
          mockInterestMarketV1.address,
          stakerContractAddress,
          makeData('data1')
        );

      const market = await interestGovernorV1.allMarkets([0]);

      // @notice Since this is a unit test using a mock contract we can use any address for the staker contract
      await expect(interestGovernorV1.setStaker(market, stakerContractAddress))
        .to.emit(interestGovernorV1, 'StakerUpdated')
        .withArgs(market, stakerContractAddress);
    });
  });
  describe('function: setFeeTo', () => {
    it('reverts if the caller is not the owner', async () => {
      await expect(
        interestGovernorV1.connect(alice).setFeeTo(dinero.address)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if the zero address is passed', async () => {
      await expect(
        interestGovernorV1.connect(owner).setFeeTo(AddressZero)
      ).to.revertedWith('IFV1: not zero address');
    });
    it('updates the feeTo address', async () => {
      expect(await interestGovernorV1.feeTo()).to.be.equal(AddressZero);
      await expect(interestGovernorV1.connect(owner).setFeeTo(alice.address))
        .to.emit(interestGovernorV1, 'FeeToUpdated')
        .withArgs(alice.address);
      expect(await interestGovernorV1.feeTo()).to.be.equal(alice.address);
    });
  });
  describe('function: createMarket', () => {
    it('reverts if the caller is not the owner', async () => {
      await expect(
        interestGovernorV1
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
        interestGovernorV1
          .connect(owner)
          .createMarket(AddressZero, collateralTokenAddress, makeData('data'))
      ).to.revertedWith('IFV1: not zero address');
    });
    it('reverts if the collateral token is address zero', async () => {
      await expect(
        interestGovernorV1
          .connect(owner)
          .createMarket(
            unregisteredMarketAddress,
            AddressZero,
            makeData('data')
          )
      ).to.revertedWith('IFV1: not zero address');
    });
    it('reverts if you clone the master contract with the same data', async () => {
      await interestGovernorV1
        .connect(owner)
        .createMarket(
          mockInterestMarketV1.address,
          stakerContractAddress,
          makeData('data1')
        );

      await expect(
        interestGovernorV1
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
      await expect(interestGovernorV1.allMarkets(0)).to.revertedWith('');
      const predictedAddress = await interestGovernorV1.predictMarketAddress(
        mockInterestMarketV1.address,
        keccak256(data)
      );
      expect(await interestGovernorV1.isMarket(predictedAddress)).to.be.equal(
        false
      );
      await expect(
        interestGovernorV1
          .connect(owner)
          .createMarket(
            mockInterestMarketV1.address,
            collateralTokenAddress,
            data
          )
      )
        .to.emit(interestGovernorV1, 'MarketCreated')
        .withArgs(collateralTokenAddress, predictedAddress, 0);

      const market = await interestGovernorV1.allMarkets(0);
      expect(await interestGovernorV1.isMarket(market)).to.be.equal(true);
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
  describe('function: close Market', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        interestGovernorV1.connect(alice).openMarket(unregisteredMarketAddress)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('closes a market, removing the MINTER_ROLE', async () => {
      await interestGovernorV1
        .connect(owner)
        .createMarket(
          mockInterestMarketV1.address,
          stakerContractAddress,
          makeData('data1')
        );

      const marketClone = await interestGovernorV1.allMarkets(0);

      expect(
        await dinero.hasRole(await dinero.MINTER_ROLE(), marketClone)
      ).to.be.equal(true);

      await expect(interestGovernorV1.connect(owner).closeMarket(marketClone))
        .to.emit(interestGovernorV1, 'CloseMarket')
        .withArgs(marketClone);

      expect(
        await dinero.hasRole(await dinero.MINTER_ROLE(), marketClone)
      ).to.be.equal(false);
    });
  });
  describe('function: close Market', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        interestGovernorV1.connect(alice).closeMarket(unregisteredMarketAddress)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('opens a market after being closed', async () => {
      await interestGovernorV1
        .connect(owner)
        .createMarket(
          mockInterestMarketV1.address,
          stakerContractAddress,
          makeData('data1')
        );

      const marketClone = await interestGovernorV1.allMarkets(0);

      await interestGovernorV1.connect(owner).closeMarket(marketClone);

      expect(
        await dinero.hasRole(await dinero.MINTER_ROLE(), marketClone)
      ).to.be.equal(false);

      await expect(interestGovernorV1.connect(owner).openMarket(marketClone))
        .to.emit(interestGovernorV1, 'OpenMarket')
        .withArgs(marketClone);

      expect(
        await dinero.hasRole(await dinero.MINTER_ROLE(), marketClone)
      ).to.be.equal(true);
    });
  });
});
