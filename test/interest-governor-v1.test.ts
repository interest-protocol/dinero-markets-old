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

  it('returns the total number of markets that have dinero roles', async () => {
    expect(await interestGovernorV1.getAllDineroMarketsLength()).to.be.equal(0);

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
          .createDineroMarket(contract, collateralTokenAddress, data)
      )
    );
    expect(await interestGovernorV1.getAllDineroMarketsLength()).to.be.equal(
      contracts.length
    );
  });

  it('tells if a market is a Dinero market', async () => {
    expect(
      await interestGovernorV1.isDineroMarket(unregisteredMarketAddress)
    ).to.be.equal(false);

    await interestGovernorV1
      .connect(owner)
      .createDineroMarket(
        mockInterestMarketV1.address,
        stakerContractAddress,
        makeData('data1')
      );

    const market = await interestGovernorV1.allDineroMarkets([0]);

    expect(await interestGovernorV1.isDineroMarket(market)).to.be.equal(true);
  });

  it('allows to predict a clone address', async () => {
    const data = makeData('data1');
    await interestGovernorV1
      .connect(owner)
      .createDineroMarket(
        mockInterestMarketV1.address,
        collateralTokenAddress,
        data
      );

    const market = await interestGovernorV1.allDineroMarkets([0]);

    expect(
      await interestGovernorV1.predictMarketAddress(
        mockInterestMarketV1.address,
        keccak256(data)
      )
    ).to.be.equal(market);
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
  describe('function: createDineroMarket', () => {
    it('reverts if the caller is not the owner', async () => {
      await expect(
        interestGovernorV1
          .connect(alice)
          .createDineroMarket(
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
          .createDineroMarket(
            AddressZero,
            collateralTokenAddress,
            makeData('data')
          )
      ).to.revertedWith('IFV1: not zero address');
    });
    it('reverts if the collateral token is address zero', async () => {
      await expect(
        interestGovernorV1
          .connect(owner)
          .createDineroMarket(
            unregisteredMarketAddress,
            AddressZero,
            makeData('data')
          )
      ).to.revertedWith('IFV1: not zero address');
    });
    it('reverts if you clone the master contract with the same data', async () => {
      await interestGovernorV1
        .connect(owner)
        .createDineroMarket(
          mockInterestMarketV1.address,
          stakerContractAddress,
          makeData('data1')
        );

      await expect(
        interestGovernorV1
          .connect(owner)
          .createDineroMarket(
            mockInterestMarketV1.address,
            stakerContractAddress,
            makeData('data1')
          )
      ).to.revertedWith('ERC1167: create2 failed');
    });
    it('creates a dinero market based on a master contract', async () => {
      const data = makeData('data1');

      // Throws because it has not been instantiated
      await expect(interestGovernorV1.allDineroMarkets(0)).to.revertedWith('');
      const predictedAddress = await interestGovernorV1.predictMarketAddress(
        mockInterestMarketV1.address,
        keccak256(data)
      );
      expect(
        await interestGovernorV1.isDineroMarket(predictedAddress)
      ).to.be.equal(false);
      await expect(
        interestGovernorV1
          .connect(owner)
          .createDineroMarket(
            mockInterestMarketV1.address,
            collateralTokenAddress,
            data
          )
      )
        .to.emit(interestGovernorV1, 'DineroMarketCreated')
        .withArgs(collateralTokenAddress, predictedAddress, 0);

      const market = await interestGovernorV1.allDineroMarkets(0);
      expect(await interestGovernorV1.isDineroMarket(market)).to.be.equal(true);
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
  describe('function: open market', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        interestGovernorV1.connect(alice).openMarket(unregisteredMarketAddress)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if you pass a non registered market', async () => {
      await expect(
        interestGovernorV1.connect(owner).openMarket(alice.address)
      ).to.revertedWith('IFV1: not a dinero market');
    });
    it('opens a dinero market after being closed', async () => {
      await interestGovernorV1
        .connect(owner)
        .createDineroMarket(
          mockInterestMarketV1.address,
          stakerContractAddress,
          makeData('data1')
        );

      const marketClone = await interestGovernorV1.allDineroMarkets(0);

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
  describe('function: close Market', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        interestGovernorV1.connect(alice).closeMarket(unregisteredMarketAddress)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('closes a market, removing the MINTER_ROLE', async () => {
      await interestGovernorV1
        .connect(owner)
        .createDineroMarket(
          mockInterestMarketV1.address,
          stakerContractAddress,
          makeData('data1')
        );

      const marketClone = await interestGovernorV1.allDineroMarkets(0);

      expect(
        await dinero.hasRole(await dinero.MINTER_ROLE(), marketClone)
      ).to.be.equal(true);

      await expect(interestGovernorV1.connect(owner).closeMarket(marketClone))
        .to.emit(interestGovernorV1, 'CloseMarket')
        .withArgs(marketClone);

      expect(
        await dinero.hasRole(await dinero.MINTER_ROLE(), marketClone)
      ).to.be.equal(false);

      expect(
        await dinero.hasRole(await dinero.BURNER_ROLE(), marketClone)
      ).to.be.equal(true);
    });
  });
  describe('function: addDineroMarket', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        interestGovernorV1.connect(alice).addDineroMarket(alice.address)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if the market is the zero address', async () => {
      await expect(
        interestGovernorV1.connect(owner).addDineroMarket(AddressZero)
      ).to.revertedWith('IFV1: not zero address');
    });
    it('grants dinero role to a market', async () => {
      expect(
        await dinero.hasRole(
          await dinero.BURNER_ROLE(),
          unregisteredMarketAddress
        )
      ).to.be.equal(false);
      expect(
        await dinero.hasRole(
          await dinero.MINTER_ROLE(),
          unregisteredMarketAddress
        )
      ).to.be.equal(false);

      expect(
        await interestGovernorV1.isDineroMarket(unregisteredMarketAddress)
      ).to.be.equal(false);

      await expect(
        interestGovernorV1.addDineroMarket(unregisteredMarketAddress)
      )
        .to.emit(interestGovernorV1, 'DineroMarketAdded')
        .withArgs(unregisteredMarketAddress, 0);

      expect(
        await dinero.hasRole(
          await dinero.BURNER_ROLE(),
          unregisteredMarketAddress
        )
      ).to.be.equal(true);
      expect(
        await dinero.hasRole(
          await dinero.MINTER_ROLE(),
          unregisteredMarketAddress
        )
      ).to.be.equal(true);
      expect(
        await interestGovernorV1.isDineroMarket(unregisteredMarketAddress)
      ).to.be.equal(true);
    });
  });
});
