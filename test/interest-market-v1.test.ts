import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  CakeToken,
  CakeVault,
  Dinero,
  InterestGovernorV1,
  InterestMarketV1,
  LiquidityRouter,
  MasterChef,
  MockChainLinkFeed,
  MockERC20,
  OracleV1,
  PancakeFactory,
  PancakeRouter,
  SyrupBar,
  WETH9,
} from '../typechain';
import { advanceTime, deploy, multiDeploy } from './lib/test-utils';

const { parseEther, defaultAbiCoder, keccak256 } = ethers.utils;

const CAKE_PER_BLOCK = parseEther('40');

const START_BLOCK = 1;

const BNB_USD_PRICE = ethers.BigNumber.from('50000000000'); // 500 USD

const CAKE_USD_PRICE = ethers.BigNumber.from('2000000000'); // 20 USD

describe('InterestMarketV1', () => {
  let cake: CakeToken;
  let syrup: SyrupBar;
  let masterChef: MasterChef;
  let cakeVault: CakeVault;
  let bnb: MockERC20;
  let dinero: Dinero;
  let governor: InterestGovernorV1;
  let factory: PancakeFactory;
  let router: PancakeRouter;
  let liquidityRouter: LiquidityRouter;
  let weth: WETH9;
  let masterMarket: InterestMarketV1;
  let cakeMarket: InterestMarketV1;
  let mockCakeUsdFeed: MockChainLinkFeed;
  let mockBnbUsdDFeed: MockChainLinkFeed;
  let oracle: OracleV1;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let developer: SignerWithAddress;
  let treasury: SignerWithAddress;

  beforeEach(async () => {
    [owner, alice, bob, developer, treasury] = await ethers.getSigners();

    [cake, dinero, factory, weth, bnb, mockCakeUsdFeed, mockBnbUsdDFeed] =
      await multiDeploy(
        [
          'CakeToken',
          'Dinero',
          'PancakeFactory',
          'WETH9',
          'MockERC20',
          'MockChainLinkFeed',
          'MockChainLinkFeed',
        ],
        [
          [],
          [],
          [developer.address],
          [],
          ['Wrapped BNB', 'WBNB', parseEther('10000000')],
          [8, 'CAKE/USD', 1],
          [8, 'BNB/USD', 1],
        ]
      );

    [syrup, governor, router, liquidityRouter, oracle] = await multiDeploy(
      [
        'SyrupBar',
        'InterestGovernorV1',
        'PancakeRouter',
        'LiquidityRouter',
        'OracleV1',
      ],
      [
        [cake.address],
        [dinero.address],
        [factory.address, weth.address],
        [factory.address, weth.address],
        [mockBnbUsdDFeed.address, bnb.address],
      ]
    );

    [masterChef] = await Promise.all([
      deploy('MasterChef', [
        cake.address,
        syrup.address,
        developer.address,
        CAKE_PER_BLOCK,
        START_BLOCK,
      ]),
      dinero
        .connect(owner)
        .grantRole(await dinero.MINTER_ROLE(), owner.address),
      dinero.connect(owner).mint(owner.address, parseEther('100000000')),
      dinero.approve(liquidityRouter.address, ethers.constants.MaxUint256),
      bnb.mint(owner.address, parseEther('300000')),
      bnb
        .connect(owner)
        .approve(liquidityRouter.address, ethers.constants.MaxUint256),
      cake
        .connect(owner)
        ['mint(address,uint256)'](owner.address, parseEther('2500000')),
      cake
        .connect(owner)
        ['mint(address,uint256)'](alice.address, parseEther('1000')),
      cake
        .connect(owner)
        ['mint(address,uint256)'](bob.address, parseEther('1000')),
      cake
        .connect(owner)
        .approve(liquidityRouter.address, ethers.constants.MaxUint256),
      governor.connect(owner).setFeeTo(treasury.address),
    ]);

    cakeVault = await deploy('CakeVault', [masterChef.address, cake.address]);

    [masterMarket] = await Promise.all([
      deploy('InterestMarketV1', [
        router.address,
        dinero.address,
        governor.address,
        oracle.address,
      ]),
      cake
        .connect(alice)
        .approve(cakeVault.address, ethers.constants.MaxUint256),
      cake.connect(bob).approve(cakeVault.address, ethers.constants.MaxUint256),
      syrup.connect(owner).transferOwnership(masterChef.address),
      cake.connect(owner).transferOwnership(masterChef.address),
      dinero
        .connect(owner)
        .grantRole(await dinero.DEFAULT_ADMIN_ROLE(), governor.address),
      mockBnbUsdDFeed.setAnswer(BNB_USD_PRICE),
      // 1 CAKE === ~12.67 USD
      mockCakeUsdFeed.setAnswer(CAKE_USD_PRICE),
      // BNB/DINERO Liquidity
      liquidityRouter
        .connect(owner)
        .addLiquidity(
          bnb.address,
          dinero.address,
          parseEther('200000'),
          parseEther('100000000'),
          parseEther('200000'),
          parseEther('100000000'),
          owner.address,
          ethers.constants.MaxUint256
        ),
      // BNB/CAKE
      liquidityRouter
        .connect(owner)
        .addLiquidity(
          bnb.address,
          cake.address,
          parseEther('10000'),
          parseEther('200000'),
          parseEther('10000'),
          parseEther('200000'),
          owner.address,
          ethers.constants.MaxUint256
        ),
      oracle.connect(owner).setFeed(bnb.address, mockBnbUsdDFeed.address, 0),
      oracle.connect(owner).setFeed(cake.address, mockCakeUsdFeed.address, 0),
    ]);

    const data = defaultAbiCoder.encode(
      ['address', 'address', 'uint64', 'uint256', 'uint256'],
      [
        cake.address,
        cakeVault.address,
        ethers.BigNumber.from(12e8),
        ethers.BigNumber.from(5e5),
        ethers.BigNumber.from(10e4),
      ]
    );

    const [cakeMarketAddress] = await Promise.all([
      governor.predictMarketAddress(masterMarket.address, keccak256(data)),
      governor
        .connect(owner)
        .createMarket(masterMarket.address, cake.address, data),
    ]);

    cakeMarket = (await ethers.getContractFactory('InterestMarketV1')).attach(
      cakeMarketAddress
    );

    await Promise.all([
      cakeMarket.updateExchangeRate(),
      cakeVault.connect(owner).setMarket(cakeMarket.address),
    ]);
  });

  describe('function: initialize', () => {
    it('reverts if you initialize the master contract', async () => {
      await expect(
        masterMarket.initialize(defaultAbiCoder.encode(['string'], ['random']))
      ).to.revertedWith('MKT: not allowed');
    });
    it('reverts if you try to initialize more than once in the clone contract', async () => {
      await expect(
        cakeMarket.initialize(defaultAbiCoder.encode(['string'], ['random']))
      ).to.revertedWith('Initializable: contract is already initialized');
    });
  });
  it('allows the router allowance to be incremented', async () => {
    await cakeMarket.connect(alice).addCollateral(parseEther('51'));

    // We need to borrow and then liquidate in order to use some of router allowance to increase it
    await cakeMarket.connect(alice).borrow(alice.address, parseEther('500'));

    // Drop CAKE to 15 USD. Alice can now be liquidated
    await mockCakeUsdFeed.setAnswer(ethers.BigNumber.from('1500000000'));

    // Liquidate alice using the collateral so router will use some allowance
    await cakeMarket
      .connect(bob)
      .liquidate([alice.address], [parseEther('50')], bob.address, [
        cake.address,
        bnb.address,
        dinero.address,
      ]);

    const currentAllowance = await cake.allowance(
      cakeMarket.address,
      router.address
    );

    await expect(cakeMarket.approve(5))
      .to.emit(cake, 'Approval')
      .withArgs(cakeMarket.address, router.address, currentAllowance.add(5));

    expect(
      await cake.allowance(cakeMarket.address, router.address)
    ).to.be.equal(currentAllowance.add(5));
  });
  it('sends the feesEarned to the treasury', async () => {
    // Add 50 CAKE as collateral
    await cakeMarket.connect(alice).addCollateral(parseEther('50'));

    // Borrow 490 DINERO
    await cakeMarket.connect(alice).borrow(alice.address, parseEther('490'));

    // Pass time to accrue fees
    await advanceTime(10_000, ethers); // advance 10_000 milliseconds

    const debt = parseEther('490')
      .mul(ethers.BigNumber.from(12e8))
      .mul(10_000)
      .div(parseEther('1'));

    expect(await dinero.balanceOf(treasury.address)).to.be.equal(0);
    expect((await cakeMarket.totalLoan()).elastic).to.be.equal(
      parseEther('490')
    );

    await expect(cakeMarket.getEarnings())
      .to.emit(cakeMarket, 'Accrue')
      .withArgs(debt)
      .to.emit(cakeMarket, 'GetEarnings')
      .withArgs(treasury.address, debt);

    expect((await cakeMarket.loan()).feesEarned).to.be.equal(0);
    expect((await dinero.balanceOf(treasury.address)).gte(debt)).to.be.equal(
      true
    );
    expect(
      (await cakeMarket.totalLoan()).elastic.gte(parseEther('490').add(debt))
    ).to.be.equal(true);
  });
  describe('function: accrue', () => {
    it('does not update the state if there is no debt', async () => {
      const loan = await cakeMarket.loan();
      await expect(cakeMarket.accrue()).not.emit(cakeMarket, 'Accrue');
      expect(
        loan.lastAccrued.lt((await cakeMarket.loan()).lastAccrued)
      ).to.be.equal(true);
    });
    it('accrues the interest rate', async () => {
      // Add 50 CAKE as collateral
      await cakeMarket.connect(alice).addCollateral(parseEther('50'));

      // Borrow 490 DINERO
      await cakeMarket.connect(alice).borrow(alice.address, parseEther('490'));
      const [loan, totalLoan] = await Promise.all([
        cakeMarket.loan(),
        cakeMarket.totalLoan(),
      ]);

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // advance 10_000 milliseconds
      const debt = parseEther('490')
        .mul(ethers.BigNumber.from(12e8))
        .mul(10_000)
        .div(parseEther('1'));

      await expect(cakeMarket.accrue())
        .to.emit(cakeMarket, 'Accrue')
        .withArgs(debt);

      const [loan2, totalLoan2] = await Promise.all([
        cakeMarket.loan(),
        cakeMarket.totalLoan(),
      ]);

      expect(loan2.lastAccrued.gt(loan.lastAccrued)).to.be.equal(true);
      expect(loan2.feesEarned).to.be.equal(debt);
      expect(totalLoan2.base).to.be.equal(totalLoan.base);
      expect(totalLoan2.elastic).to.be.equal(totalLoan.elastic.add(debt));
    });
  });
  it('updates the exchange rate', async () => {
    expect(await cakeMarket.exchangeRate()).to.be.equal(
      CAKE_USD_PRICE.mul(1e10)
    );

    await expect(cakeMarket.updateExchangeRate()).to.not.emit(
      cakeMarket,
      'ExchangeRate'
    );

    expect(await cakeMarket.exchangeRate()).to.be.equal(
      CAKE_USD_PRICE.mul(1e10)
    );

    // Update the exchange rate
    await mockCakeUsdFeed.setAnswer(ethers.BigNumber.from('1500000000'));

    await expect(cakeMarket.updateExchangeRate())
      .to.emit(cakeMarket, 'ExchangeRate')
      .withArgs(ethers.BigNumber.from('1500000000').mul(1e10));

    expect(await cakeMarket.exchangeRate()).to.be.equal(
      ethers.BigNumber.from('1500000000').mul(1e10)
    );
  });
  describe('function: addCollateral', () => {
    it('accepts collateral and deposits to the vault', async () => {
      expect(await cakeMarket.totalCollateral()).to.be.equal(0);

      expect(await cakeMarket.userCollateral(alice.address)).to.be.equal(0);

      const amount = parseEther('10');

      await expect(cakeMarket.connect(alice).addCollateral(amount))
        .to.emit(cakeMarket, 'AddCollateral')
        .withArgs(alice.address, amount)
        .to.emit(cakeVault, 'Deposit')
        .withArgs(alice.address, amount)
        .to.emit(cake, 'Transfer')
        .withArgs(alice.address, cakeVault.address, amount);

      expect(await cakeMarket.totalCollateral()).to.be.equal(amount);

      expect(await cakeMarket.userCollateral(alice.address)).to.be.equal(
        amount
      );

      await expect(cakeMarket.connect(bob).addCollateral(amount))
        .to.emit(cakeMarket, 'AddCollateral')
        .withArgs(bob.address, amount)
        .to.emit(cakeVault, 'Deposit')
        .withArgs(bob.address, amount)
        .to.emit(cake, 'Transfer')
        .withArgs(bob.address, cakeVault.address, amount);

      expect(await cakeMarket.totalCollateral()).to.be.equal(
        amount.add(amount)
      );

      expect(await cakeMarket.userCollateral(alice.address)).to.be.equal(
        amount
      );
      expect(await cakeMarket.userCollateral(bob.address)).to.be.equal(amount);
      expect(await cake.balanceOf(cakeMarket.address)).to.be.equal(0); // Cake is in the masterChef
    });
    it('accepts collateral without a vault', async () => {
      const data = defaultAbiCoder.encode(
        ['address', 'address', 'uint64', 'uint256', 'uint256'],
        [
          cake.address,
          ethers.constants.AddressZero,
          ethers.BigNumber.from(12e8),
          ethers.BigNumber.from(5e5),
          ethers.BigNumber.from(10e4),
        ]
      );

      const [cakeMarketAddress] = await Promise.all([
        governor.predictMarketAddress(masterMarket.address, keccak256(data)),
        governor
          .connect(owner)
          .createMarket(masterMarket.address, cake.address, data),
      ]);

      const cakeMarket2 = (
        await ethers.getContractFactory('InterestMarketV1')
      ).attach(cakeMarketAddress);

      await Promise.all([
        cake
          .connect(alice)
          .approve(cakeMarket2.address, ethers.constants.MaxUint256),
        cake
          .connect(bob)
          .approve(cakeMarket2.address, ethers.constants.MaxUint256),
      ]);

      expect(await cakeMarket2.totalCollateral()).to.be.equal(0);

      expect(await cakeMarket2.userCollateral(alice.address)).to.be.equal(0);

      const amount = parseEther('25');

      await expect(cakeMarket2.connect(alice).addCollateral(amount))
        .to.emit(cakeMarket2, 'AddCollateral')
        .withArgs(alice.address, amount)
        .to.emit(cake, 'Transfer')
        .withArgs(alice.address, cakeMarket2.address, amount)
        .to.not.emit(cakeVault, 'Deposit')
        .withArgs(alice.address, amount);

      expect(await cakeMarket2.totalCollateral()).to.be.equal(amount);

      expect(await cakeMarket2.userCollateral(alice.address)).to.be.equal(
        amount
      );

      await expect(cakeMarket2.connect(bob).addCollateral(amount))
        .to.emit(cakeMarket2, 'AddCollateral')
        .withArgs(bob.address, amount)
        .to.emit(cake, 'Transfer')
        .withArgs(bob.address, cakeMarket2.address, amount)
        .to.not.emit(cakeVault, 'Deposit')
        .withArgs(bob.address, amount);

      expect(await cakeMarket2.totalCollateral()).to.be.equal(
        amount.add(amount)
      );

      expect(await cakeMarket2.userCollateral(alice.address)).to.be.equal(
        amount
      );
      expect(await cakeMarket2.userCollateral(bob.address)).to.be.equal(amount);
      expect(await cake.balanceOf(cakeMarket2.address)).to.be.equal(
        amount.add(amount)
      );
    });
  });
  describe('function: removeCollateral', () => {
    it('removes collateral using a vault', async () => {
      const aliceAmount = parseEther('12');
      const bobAmount = parseEther('7');
      await Promise.all([
        cakeMarket.connect(alice).addCollateral(aliceAmount),
        cakeMarket.connect(bob).addCollateral(bobAmount),
      ]);

      // We need to borrow to test the Accrue event
      await cakeMarket.connect(bob).borrow(alice.address, parseEther('10'));

      expect(await cakeMarket.totalCollateral()).to.be.equal(
        aliceAmount.add(bobAmount)
      );

      expect(await cakeMarket.userCollateral(alice.address)).to.be.equal(
        aliceAmount
      );
      expect(await cakeMarket.userCollateral(bob.address)).to.be.equal(
        bobAmount
      );

      await expect(cakeMarket.connect(alice).removeCollateral(aliceAmount))
        .to.emit(cakeMarket, 'RemoveCollateral')
        .withArgs(alice.address, aliceAmount)
        .to.emit(cakeVault, 'Withdraw')
        .withArgs(alice.address, alice.address, aliceAmount)
        .to.emit(cakeMarket, 'Accrue')
        .to.emit(cake, 'Transfer')
        .withArgs(cakeVault.address, alice.address, aliceAmount);

      expect(await cakeMarket.totalCollateral()).to.be.equal(bobAmount);

      expect(await cakeMarket.userCollateral(alice.address)).to.be.equal(0);

      expect(await cakeMarket.userCollateral(bob.address)).to.be.equal(
        bobAmount
      );

      await expect(cakeMarket.connect(bob).removeCollateral(parseEther('3')))
        .to.emit(cakeMarket, 'RemoveCollateral')
        .withArgs(bob.address, parseEther('3'))
        .to.emit(cakeVault, 'Withdraw')
        .withArgs(bob.address, bob.address, parseEther('3'))
        .to.emit(cakeMarket, 'Accrue')
        .to.emit(cake, 'Transfer')
        .withArgs(cakeVault.address, bob.address, parseEther('3'));

      expect(await cakeMarket.totalCollateral()).to.be.equal(
        bobAmount.sub(parseEther('3'))
      );

      expect(await cakeMarket.userCollateral(bob.address)).to.be.equal(
        bobAmount.sub(parseEther('3'))
      );
    });
    it('removes collateral without a vault', async () => {
      const aliceAmount = parseEther('12');
      const bobAmount = parseEther('14');

      const data = defaultAbiCoder.encode(
        ['address', 'address', 'uint64', 'uint256', 'uint256'],
        [
          cake.address,
          ethers.constants.AddressZero,
          ethers.BigNumber.from(12e8),
          ethers.BigNumber.from(5e5),
          ethers.BigNumber.from(10e4),
        ]
      );

      const [cakeMarketAddress] = await Promise.all([
        governor.predictMarketAddress(masterMarket.address, keccak256(data)),
        governor
          .connect(owner)
          .createMarket(masterMarket.address, cake.address, data),
      ]);

      const cakeMarket2 = (
        await ethers.getContractFactory('InterestMarketV1')
      ).attach(cakeMarketAddress);

      await Promise.all([
        cake
          .connect(alice)
          .approve(cakeMarket2.address, ethers.constants.MaxUint256),
        cake
          .connect(bob)
          .approve(cakeMarket2.address, ethers.constants.MaxUint256),
        cakeMarket2.updateExchangeRate(),
      ]);

      await Promise.all([
        cakeMarket2.connect(alice).addCollateral(aliceAmount),
        cakeMarket2.connect(bob).addCollateral(bobAmount),
      ]);

      // We need to borrow to test the Accrue event
      await cakeMarket2.connect(bob).borrow(alice.address, parseEther('10'));

      expect(await cakeMarket2.totalCollateral()).to.be.equal(
        aliceAmount.add(bobAmount)
      );

      expect(await cakeMarket2.userCollateral(alice.address)).to.be.equal(
        aliceAmount
      );
      expect(await cakeMarket2.userCollateral(bob.address)).to.be.equal(
        bobAmount
      );

      await expect(cakeMarket2.connect(alice).removeCollateral(aliceAmount))
        .to.emit(cakeMarket2, 'RemoveCollateral')
        .withArgs(alice.address, aliceAmount)
        .to.emit(cakeMarket2, 'Accrue')
        .to.emit(cake, 'Transfer')
        .withArgs(cakeMarket2.address, alice.address, aliceAmount)
        .to.not.emit(cakeVault, 'Withdraw');

      expect(await cakeMarket2.totalCollateral()).to.be.equal(bobAmount);

      expect(await cakeMarket2.userCollateral(alice.address)).to.be.equal(0);

      expect(await cakeMarket2.userCollateral(bob.address)).to.be.equal(
        bobAmount
      );

      await expect(cakeMarket2.connect(bob).removeCollateral(parseEther('3')))
        .to.emit(cakeMarket2, 'RemoveCollateral')
        .withArgs(bob.address, parseEther('3'))
        .to.emit(cakeMarket2, 'Accrue')
        .to.emit(cake, 'Transfer')
        .withArgs(cakeMarket2.address, bob.address, parseEther('3'))
        .to.not.emit(cakeVault, 'Withdraw');

      expect(await cakeMarket2.totalCollateral()).to.be.equal(
        bobAmount.sub(parseEther('3'))
      );

      expect(await cakeMarket2.userCollateral(bob.address)).to.be.equal(
        bobAmount.sub(parseEther('3'))
      );
      expect(await cake.balanceOf(cakeMarket2.address)).to.be.equal(
        bobAmount.sub(parseEther('3'))
      );
    });
  });
  describe('function: setCollateralRatio', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        cakeMarket.connect(alice).setCollateralRatio(0)
      ).to.revertedWith('MKT: caller is not the owner');
    });
    it('reverts if we set a collateral higher than 9e5', async () => {
      await expect(
        cakeMarket
          .connect(owner)
          .setCollateralRatio(ethers.BigNumber.from(9e5).add(1))
      ).to.revertedWith('MKT: too high');
    });
    it('updates the collateralRatio', async () => {
      expect(await cakeMarket.collateralRatio()).to.be.equal(
        ethers.BigNumber.from(5e5)
      );

      await cakeMarket
        .connect(owner)
        .setCollateralRatio(ethers.BigNumber.from(9e5));

      expect(await cakeMarket.collateralRatio()).to.be.equal(
        ethers.BigNumber.from(9e5)
      );
    });
  });
  describe('function: setLiquidationFee', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        cakeMarket.connect(alice).setLiquidationFee(0)
      ).to.revertedWith('MKT: caller is not the owner');
    });
    it('reverts if we set a liquidation fee higher than 15e4', async () => {
      await expect(
        cakeMarket
          .connect(owner)
          .setLiquidationFee(ethers.BigNumber.from(15e4).add(1))
      ).to.revertedWith('MKT: too high');
    });
    it('updates the liquidation fee', async () => {
      expect(await cakeMarket.liquidationFee()).to.be.equal(
        ethers.BigNumber.from(10e4)
      );

      await cakeMarket
        .connect(owner)
        .setLiquidationFee(ethers.BigNumber.from(15e4));

      expect(await cakeMarket.liquidationFee()).to.be.equal(
        ethers.BigNumber.from(15e4)
      );
    });
  });
  describe('function: setInterestRate', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        cakeMarket.connect(alice).setInterestRate(0)
      ).to.revertedWith('MKT: caller is not the owner');
    });
    it('reverts if we set a liquidation fee higher than 15e4', async () => {
      await expect(
        cakeMarket
          .connect(owner)
          .setInterestRate(ethers.BigNumber.from(13e8).add(1))
      ).to.revertedWith('MKT: too high');
    });
    it('updates the liquidation fee', async () => {
      expect((await cakeMarket.loan()).INTEREST_RATE).to.be.equal(
        ethers.BigNumber.from(12e8)
      );

      await cakeMarket
        .connect(owner)
        .setInterestRate(ethers.BigNumber.from(13e8));

      expect((await cakeMarket.loan()).INTEREST_RATE).to.be.equal(
        ethers.BigNumber.from(13e8)
      );
    });
  });
  it('returns the governor owner', async () => {
    expect(await cakeMarket.governorOwner()).to.be.equal(
      await governor.owner()
    );
  });
  describe('function: borrow', () => {
    it('reverts if the user is insolvent', async () => {
      await expect(
        cakeMarket.connect(alice).borrow(alice.address, 1)
      ).to.revertedWith('MKT: sender is insolvent');

      await cakeMarket.connect(alice).addCollateral(parseEther('10')); // 200 USD of collateral

      // @notice the collateral ratio is 49.9%
      await expect(
        cakeMarket.connect(alice).borrow(alice.address, parseEther('100')) // Borrow 100 USD
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('reverts if the recipient is the zero address', async () => {
      await cakeMarket.connect(alice).addCollateral(parseEther('10')); // 200 USD of collateral

      await expect(
        cakeMarket
          .connect(alice)
          .borrow(ethers.constants.AddressZero, parseEther('50'))
      ).to.revertedWith('MKT: no zero address');
    });
    it('allows borrowing', async () => {
      await cakeMarket.connect(alice).addCollateral(parseEther('10')); // 200 USD of collateral

      const totalLoan = await cakeMarket.totalLoan();

      expect(await cakeMarket.userLoan(alice.address)).to.be.equal(0);
      expect(await dinero.balanceOf(alice.address)).to.be.equal(0);
      expect(totalLoan.base).to.be.equal(0);
      expect(totalLoan.elastic).to.be.equal(0);

      await expect(
        cakeMarket.connect(alice).borrow(alice.address, parseEther('50'))
      )
        .to.emit(dinero, 'Transfer')
        .withArgs(ethers.constants.AddressZero, alice.address, parseEther('50'))
        .to.emit(cakeMarket, 'Borrow')
        .withArgs(alice.address, alice.address, parseEther('50'))
        .to.not.emit(cakeMarket, 'Accrue');

      const totalLoan2 = await cakeMarket.totalLoan();

      expect(await cakeMarket.userLoan(alice.address)).to.be.equal(
        parseEther('50')
      );
      expect(await dinero.balanceOf(alice.address)).to.be.equal(
        parseEther('50')
      );
      expect(totalLoan2.base).to.be.equal(parseEther('50'));
      expect(totalLoan2.elastic).to.be.equal(parseEther('50'));
      expect(await dinero.balanceOf(bob.address)).to.be.equal(0);

      await expect(
        cakeMarket.connect(alice).borrow(bob.address, parseEther('30'))
      )
        .to.emit(cakeMarket, 'Accrue')
        .to.emit(dinero, 'Transfer')
        .withArgs(ethers.constants.AddressZero, bob.address, parseEther('30'))
        .to.emit(cakeMarket, 'Borrow')
        .withArgs(alice.address, bob.address, parseEther('30'));

      const totalLoan3 = await cakeMarket.totalLoan();

      expect(await cakeMarket.userLoan(alice.address)).to.be.equal(
        parseEther('80')
      );
      expect(await cakeMarket.userLoan(bob.address)).to.be.equal(0);
      expect(await dinero.balanceOf(alice.address)).to.be.equal(
        parseEther('50')
      );
      expect(await dinero.balanceOf(bob.address)).to.be.equal(parseEther('30'));
      expect(totalLoan3.base).to.be.equal(parseEther('80'));
      expect(totalLoan3.elastic.gt(parseEther('80'))).to.be.equal(true); // includes fees
    });
  });
});
