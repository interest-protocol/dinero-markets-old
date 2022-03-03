import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers, network } from 'hardhat';

import {
  CakeToken,
  CakeVault,
  Dinero,
  InterestMarketV1,
  LiquidityRouter,
  MasterChef,
  MockChainLinkFeed,
  MockERC20,
  MockTWAP,
  OracleV1,
  PancakeFactory,
  PancakeRouter,
  SyrupBar,
  TestInterestMarketV2,
  WETH9,
} from '../typechain';
import { BURNER_ROLE, MINTER_ROLE } from './lib/constants';
import {
  advanceBlock,
  advanceBlockAndTime,
  advanceTime,
  deploy,
  deployUUPS,
  multiDeploy,
  upgrade,
} from './lib/test-utils';

const { parseEther } = ethers.utils;

const CAKE_PER_BLOCK = parseEther('40');

const START_BLOCK = 1;

const BNB_USD_PRICE = ethers.BigNumber.from('50000000000'); // 500 USD

const CAKE_USD_PRICE = ethers.BigNumber.from('2000000000'); // 20 USD

const CAKE_BNB_PRICE = ethers.BigNumber.from('4000000'); // 20 USD

describe('InterestMarketV1', () => {
  let cake: CakeToken;
  let syrup: SyrupBar;
  let masterChef: MasterChef;
  let cakeVault: CakeVault;
  let bnb: MockERC20;
  let dinero: Dinero;
  let busd: MockERC20;
  let factory: PancakeFactory;
  let router: PancakeRouter;
  let liquidityRouter: LiquidityRouter;
  let weth: WETH9;
  let cakeMarket: InterestMarketV1;
  let mockCakeUsdFeed: MockChainLinkFeed;
  let mockBnbUsdDFeed: MockChainLinkFeed;
  let mockCakeBNBFeed: MockChainLinkFeed;
  let oracle: OracleV1;
  let mockTwap: MockTWAP;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let jose: SignerWithAddress;
  let recipient: SignerWithAddress;
  let developer: SignerWithAddress;
  let treasury: SignerWithAddress;

  beforeEach(async () => {
    [owner, alice, bob, jose, recipient, developer, treasury] =
      await ethers.getSigners();

    [
      dinero,
      [
        cake,
        factory,
        weth,
        bnb,
        mockCakeUsdFeed,
        mockBnbUsdDFeed,
        mockCakeBNBFeed,
        busd,
        mockTwap,
      ],
    ] = await Promise.all([
      deployUUPS('Dinero', []),
      multiDeploy(
        [
          'CakeToken',
          'PancakeFactory',
          'WETH9',
          'MockERC20',
          'MockChainLinkFeed',
          'MockChainLinkFeed',
          'MockChainLinkFeed',
          'MockERC20',
          'MockTWAP',
        ],
        [
          [],
          [developer.address],
          [],
          ['Wrapped BNB', 'WBNB', parseEther('10000000')],
          [8, 'CAKE/USD', 1],
          [8, 'BNB/USD', 1],
          [8, 'CAKE/BNB', 1],
          ['Binance USD', 'BUSD', parseEther('10000000')],
          [],
        ]
      ),
    ]);

    [oracle, [syrup, router, liquidityRouter]] = await Promise.all([
      deployUUPS('OracleV1', [
        mockTwap.address,
        mockBnbUsdDFeed.address,
        bnb.address,
        busd.address,
      ]),
      multiDeploy(
        ['SyrupBar', 'PancakeRouter', 'LiquidityRouter'],
        [
          [cake.address],
          [factory.address, weth.address],
          [factory.address, weth.address],
        ]
      ),
      dinero.connect(owner).grantRole(MINTER_ROLE, owner.address),
    ]);

    [masterChef] = await Promise.all([
      deploy('MasterChef', [
        cake.address,
        syrup.address,
        developer.address,
        CAKE_PER_BLOCK,
        START_BLOCK,
      ]),
      dinero.connect(owner).mint(owner.address, parseEther('20000000000')),
      dinero
        .connect(owner)
        .approve(liquidityRouter.address, ethers.constants.MaxUint256),
      bnb.mint(owner.address, parseEther('30000000')),
      bnb
        .connect(owner)
        .approve(liquidityRouter.address, ethers.constants.MaxUint256),
      cake
        .connect(owner)
        ['mint(address,uint256)'](owner.address, parseEther('250000000')),
      cake
        .connect(owner)
        ['mint(address,uint256)'](alice.address, parseEther('1000')),
      cake
        .connect(owner)
        ['mint(address,uint256)'](bob.address, parseEther('1000')),
      cake
        .connect(owner)
        ['mint(address,uint256)'](jose.address, parseEther('1000')),
      cake
        .connect(owner)
        .approve(liquidityRouter.address, ethers.constants.MaxUint256),
    ]);

    cakeVault = await deployUUPS('CakeVault', [
      masterChef.address,
      cake.address,
    ]);

    [cakeMarket] = await Promise.all([
      deployUUPS('InterestMarketV1', [
        router.address,
        dinero.address,
        treasury.address,
        oracle.address,
        cake.address,
        cakeVault.address,
        ethers.BigNumber.from(12e8),
        ethers.BigNumber.from('500000000000000000'),
        ethers.BigNumber.from('100000000000000000'),
      ]),
      cake
        .connect(alice)
        .approve(cakeVault.address, ethers.constants.MaxUint256),
      cake.connect(bob).approve(cakeVault.address, ethers.constants.MaxUint256),
      cake
        .connect(jose)
        .approve(cakeVault.address, ethers.constants.MaxUint256),
      syrup.connect(owner).transferOwnership(masterChef.address),
      cake.connect(owner).transferOwnership(masterChef.address),
      mockCakeBNBFeed.setAnswer(CAKE_BNB_PRICE),
      // 1 CAKE == 0.04 BNB
      mockBnbUsdDFeed.setAnswer(BNB_USD_PRICE),
      // 1 CAKE === ~12.67 USD
      mockCakeUsdFeed.setAnswer(CAKE_USD_PRICE),
      // BNB/DINERO Liquidity
      liquidityRouter
        .connect(owner)
        .addLiquidity(
          bnb.address,
          dinero.address,
          parseEther('20000000'),
          parseEther('10000000000'),
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
          parseEther('1000000'),
          parseEther('25000000'),
          parseEther('10000'),
          parseEther('250000'),
          owner.address,
          ethers.constants.MaxUint256
        ),
      oracle.connect(owner).setFeed(bnb.address, mockBnbUsdDFeed.address, 0),
      oracle.connect(owner).setFeed(cake.address, mockCakeUsdFeed.address, 0),
      oracle.connect(owner).setFeed(cake.address, mockCakeBNBFeed.address, 1),
    ]);

    await Promise.all([
      dinero.connect(owner).grantRole(MINTER_ROLE, cakeMarket.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, cakeMarket.address),
      cakeMarket.updateExchangeRate(),
      cakeVault.connect(owner).setMarket(cakeMarket.address),
    ]);
  });

  describe('function: initialize', () => {
    it('gives the router full allowance', async () => {
      expect(
        await cake.allowance(cakeMarket.address, router.address)
      ).to.be.equal(ethers.constants.MaxUint256);
    });
    it('reverts if you initialize a deployed the market', async () => {
      await expect(
        cakeMarket.initialize(
          router.address,
          dinero.address,
          treasury.address,
          oracle.address,
          cake.address,
          cakeVault.address,
          ethers.BigNumber.from(12e8),
          ethers.BigNumber.from('500000000000000000'),
          ethers.BigNumber.from('100000000000000000')
        )
      ).to.revertedWith('Initializable: contract is already initialized');
    });
    it('reverts if the collateral is the zero address', async () => {
      await expect(
        deployUUPS('InterestMarketV1', [
          router.address,
          dinero.address,
          treasury.address,
          oracle.address,
          ethers.constants.AddressZero,
          ethers.constants.AddressZero,
          ethers.BigNumber.from(12e8),
          ethers.BigNumber.from('500000000000000000'),
          ethers.BigNumber.from('100000000000000000'),
        ])
      ).to.revertedWith('MKT: no zero address');
    });
    it('reverts if the maxLTVRatio is out of bounds', async () => {
      await expect(
        deployUUPS('InterestMarketV1', [
          router.address,
          dinero.address,
          treasury.address,
          oracle.address,
          cake.address,
          ethers.constants.AddressZero,
          ethers.BigNumber.from(12e8),
          ethers.BigNumber.from(4e5),
          ethers.BigNumber.from(10e4),
        ])
      ).to.revertedWith('MKT: ltc ratio out of bounds');

      await expect(
        deployUUPS('InterestMarketV1', [
          router.address,
          dinero.address,
          treasury.address,
          oracle.address,
          cake.address,
          ethers.constants.AddressZero,
          ethers.BigNumber.from(12e8),
          ethers.BigNumber.from(91e4),
          ethers.BigNumber.from(10e4),
        ])
      ).to.revertedWith('MKT: ltc ratio out of bounds');
    });
    it('sets initial state correctly', async () => {
      const [
        _owner,
        _router,
        _feeTo,
        _oracle,
        _collateral,
        _vault,
        _loan,
        _maxLTVRatio,
        _liquidationFee,
      ] = await Promise.all([
        cakeMarket.owner(),
        cakeMarket.ROUTER(),
        cakeMarket.FEE_TO(),
        cakeMarket.ORACLE(),
        cakeMarket.COLLATERAL(),
        cakeMarket.VAULT(),
        cakeMarket.loan(),
        cakeMarket.maxLTVRatio(),
        cakeMarket.liquidationFee(),
      ]);

      expect(_owner).to.be.equal(owner.address);
      expect(_router).to.be.equal(router.address);
      expect(_feeTo).to.be.equal(treasury.address);
      expect(_oracle).to.be.equal(oracle.address);
      expect(_collateral).to.be.equal(cake.address);
      expect(_vault).to.be.equal(cakeVault.address);
      expect(_loan.INTEREST_RATE).to.be.equal(ethers.BigNumber.from(12e8));
      expect(_maxLTVRatio).to.be.equal(
        ethers.BigNumber.from('500000000000000000')
      );
      expect(_liquidationFee).to.be.equal(
        ethers.BigNumber.from('100000000000000000')
      );
    });
  });
  it('allows the router allowance to be maxed out', async () => {
    await cakeMarket
      .connect(alice)
      .addCollateral(alice.address, parseEther('51'));

    // We need to borrow and then liquidate in order to use some of router allowance to increase it
    await cakeMarket.connect(alice).borrow(alice.address, parseEther('500'));

    // Drop CAKE to 15 USD. Alice can now be liquidated
    await mockCakeUsdFeed.setAnswer(ethers.BigNumber.from('1500000000'));

    // Liquidate alice using the collateral so router will use some allowance
    await cakeMarket
      .connect(bob)
      .liquidate(
        [alice.address],
        [parseEther('50')],
        bob.address,
        [cake.address, bnb.address, dinero.address],
        []
      );

    const currentAllowance = await cake.allowance(
      cakeMarket.address,
      router.address
    );

    // Make sure that current allowance is not maxed out
    expect(ethers.constants.MaxUint256.gt(currentAllowance)).to.be.equal(true);

    await expect(cakeMarket.approve())
      .to.emit(cake, 'Approval')
      .withArgs(
        cakeMarket.address,
        router.address,
        ethers.constants.MaxUint256
      );

    expect(
      await cake.allowance(cakeMarket.address, router.address)
    ).to.be.equal(ethers.constants.MaxUint256);
  });
  it('sends the feesEarned to the treasury', async () => {
    // Add 50 CAKE as collateral
    await cakeMarket
      .connect(alice)
      .addCollateral(alice.address, parseEther('50'));

    // Borrow 490 DINERO
    await cakeMarket.connect(alice).borrow(alice.address, parseEther('490'));

    // Pass time to accrue fees
    await advanceTime(10_000, ethers); // advance 10_000 seconds

    const debt = parseEther('490')
      .mul(ethers.BigNumber.from(12e8))
      .mul(10_000)
      .div(parseEther('1'));

    expect(await dinero.balanceOf(treasury.address)).to.be.equal(0);
    expect((await cakeMarket.totalLoan()).elastic).to.be.equal(
      parseEther('490')
    );

    // Due to time delays of asynchronous code and the fact that interest is calculated based on time. We cannot guarantee that the value of debt is accurate but only an approximation.
    await expect(cakeMarket.getEarnings())
      .to.emit(cakeMarket, 'Accrue')
      .to.emit(cakeMarket, 'GetEarnings');

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
    it('does not update if no time has passed', async () => {
      await network.provider.send('evm_setAutomine', [false]);

      // Add 50 CAKE as collateral
      await cakeMarket
        .connect(alice)
        .addCollateral(alice.address, parseEther('50'));

      await advanceBlock(ethers);

      // Borrow 490 DINERO
      await cakeMarket.connect(alice).borrow(alice.address, parseEther('490'));

      await advanceBlock(ethers);

      await advanceBlockAndTime(50_000, ethers);

      const receipt = await cakeMarket.accrue();
      const receipt2 = await cakeMarket.accrue();

      await advanceBlock(ethers);

      const [awaitedReceipt, awaitedReceipt2] = await Promise.all([
        receipt.wait(),
        receipt2.wait(),
      ]);

      expect(
        awaitedReceipt.events?.filter((x) => x.event === 'Accrue').length
      ).to.be.equal(1);

      expect(
        awaitedReceipt2.events?.filter((x) => x.event === 'Accrue').length
      ).to.be.equal(0);

      await network.provider.send('evm_setAutomine', [true]);
    });
    it('accrues the interest rate', async () => {
      // Add 50 CAKE as collateral
      await cakeMarket
        .connect(alice)
        .addCollateral(alice.address, parseEther('50'));

      // Borrow 490 DINERO
      await cakeMarket.connect(alice).borrow(alice.address, parseEther('490'));
      const [loan, totalLoan] = await Promise.all([
        cakeMarket.loan(),
        cakeMarket.totalLoan(),
      ]);

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // advance 10_000 seconds
      const debt = parseEther('490')
        .mul(ethers.BigNumber.from(12e8))
        .mul(10_000)
        .div(parseEther('1'));

      await expect(cakeMarket.accrue()).to.emit(cakeMarket, 'Accrue');

      const [loan2, totalLoan2] = await Promise.all([
        cakeMarket.loan(),
        cakeMarket.totalLoan(),
      ]);

      // Due to asynchronous code and the fact that Interest rate uses timestamp instead of blocks. Delays in the test can cause more than 10_000 to pass.
      // Therefore, the debt can be slightly higher. So we test with gte instead of discrete value. In most cases will equal the debt.
      expect(loan2.lastAccrued.gt(loan.lastAccrued)).to.be.equal(true);
      expect(loan2.feesEarned.gte(debt)).to.be.equal(true);
      expect(totalLoan2.base).to.be.equal(totalLoan.base);
      expect(totalLoan2.elastic.gte(totalLoan.elastic.add(debt))).to.be.equal(
        true
      );
    });
  });
  describe('function: updateExchangeRate', () => {
    it('reverts if the exchange rate is 0', async () => {
      await mockCakeUsdFeed.setAnswer(0);
      await expect(cakeMarket.updateExchangeRate()).to.revertedWith(
        'MKT: invalid exchange rate'
      );
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
  });

  describe('function: addCollateral', () => {
    it('accepts collateral and deposits to the vault', async () => {
      expect(await cakeMarket.totalCollateral()).to.be.equal(0);

      expect(await cakeMarket.userCollateral(alice.address)).to.be.equal(0);

      const amount = parseEther('10');

      await expect(
        cakeMarket.connect(alice).addCollateral(alice.address, amount)
      )
        .to.emit(cakeMarket, 'AddCollateral')
        .withArgs(alice.address, alice.address, amount)
        .to.emit(cakeVault, 'Deposit')
        .withArgs(alice.address, alice.address, amount)
        .to.emit(cake, 'Transfer')
        .withArgs(alice.address, cakeVault.address, amount);

      expect(await cakeMarket.totalCollateral()).to.be.equal(amount);

      expect(await cakeMarket.userCollateral(alice.address)).to.be.equal(
        amount
      );

      await expect(cakeMarket.connect(bob).addCollateral(alice.address, amount))
        .to.emit(cakeMarket, 'AddCollateral')
        .withArgs(bob.address, alice.address, amount)
        .to.emit(cakeVault, 'Deposit')
        .withArgs(bob.address, alice.address, amount)
        .to.emit(cake, 'Transfer')
        .withArgs(bob.address, cakeVault.address, amount);

      expect(await cakeMarket.totalCollateral()).to.be.equal(
        amount.add(amount)
      );

      expect(await cakeMarket.userCollateral(alice.address)).to.be.equal(
        amount.add(amount)
      );
      expect(await cakeMarket.userCollateral(bob.address)).to.be.equal(0);
      expect(await cake.balanceOf(cakeMarket.address)).to.be.equal(0); // Cake is in the masterChef
    });
    it('accepts collateral without a vault', async () => {
      const cakeMarket2: InterestMarketV1 = await deployUUPS(
        'InterestMarketV1',
        [
          router.address,
          dinero.address,
          treasury.address,
          oracle.address,
          cake.address,
          ethers.constants.AddressZero,
          ethers.BigNumber.from(12e8),
          ethers.BigNumber.from('500000000000000000'),
          ethers.BigNumber.from('100000000000000000'),
        ]
      );

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

      await expect(
        cakeMarket2.connect(alice).addCollateral(alice.address, amount)
      )
        .to.emit(cakeMarket2, 'AddCollateral')
        .withArgs(alice.address, alice.address, amount)
        .to.emit(cake, 'Transfer')
        .withArgs(alice.address, cakeMarket2.address, amount)
        .to.not.emit(cakeVault, 'Deposit')
        .withArgs(alice.address, alice.address, amount);

      expect(await cakeMarket2.totalCollateral()).to.be.equal(amount);

      expect(await cakeMarket2.userCollateral(alice.address)).to.be.equal(
        amount
      );

      await expect(
        cakeMarket2.connect(bob).addCollateral(alice.address, amount)
      )
        .to.emit(cakeMarket2, 'AddCollateral')
        .withArgs(bob.address, alice.address, amount)
        .to.emit(cake, 'Transfer')
        .withArgs(bob.address, cakeMarket2.address, amount)
        .to.not.emit(cakeVault, 'Deposit')
        .withArgs(bob.address, alice.address, amount);

      expect(await cakeMarket2.totalCollateral()).to.be.equal(
        amount.add(amount)
      );

      expect(await cakeMarket2.userCollateral(alice.address)).to.be.equal(
        amount.add(amount)
      );
      expect(await cakeMarket2.userCollateral(bob.address)).to.be.equal(0);
      expect(await cake.balanceOf(cakeMarket2.address)).to.be.equal(
        amount.add(amount)
      );
    });
  });
  describe('function: withdrawCollateral', () => {
    it('removes collateral using a vault', async () => {
      const aliceAmount = parseEther('12');
      const bobAmount = parseEther('7');
      await Promise.all([
        cakeMarket.connect(alice).addCollateral(alice.address, aliceAmount),
        cakeMarket.connect(bob).addCollateral(bob.address, bobAmount),
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

      await expect(
        cakeMarket.connect(alice).withdrawCollateral(alice.address, aliceAmount)
      )
        .to.emit(cakeMarket, 'WithdrawCollateral')
        .withArgs(alice.address, alice.address, aliceAmount)
        .to.emit(cakeVault, 'Withdraw')
        .withArgs(alice.address, alice.address, aliceAmount)
        .to.emit(cakeMarket, 'Accrue')
        .to.emit(cake, 'Transfer');

      expect(await cakeMarket.totalCollateral()).to.be.equal(bobAmount);

      expect(await cakeMarket.userCollateral(alice.address)).to.be.equal(0);

      expect(await cakeMarket.userCollateral(bob.address)).to.be.equal(
        bobAmount
      );

      const aliceCakeBalance = await cake.balanceOf(alice.address);

      await expect(
        cakeMarket
          .connect(bob)
          .withdrawCollateral(alice.address, parseEther('3'))
      )
        .to.emit(cakeMarket, 'WithdrawCollateral')
        .withArgs(bob.address, alice.address, parseEther('3'))
        .to.emit(cakeVault, 'Withdraw')
        .withArgs(bob.address, alice.address, parseEther('3'))
        .to.emit(cakeMarket, 'Accrue')
        .to.emit(cake, 'Transfer');

      expect(await cakeMarket.totalCollateral()).to.be.equal(
        bobAmount.sub(parseEther('3'))
      );

      expect(await cakeMarket.userCollateral(bob.address)).to.be.equal(
        bobAmount.sub(parseEther('3'))
      );
      expect(
        (await cake.balanceOf(alice.address)).gte(
          aliceCakeBalance.add(parseEther('3'))
        )
      ).to.be.equal(true);
    });
    it('removes collateral without a vault', async () => {
      const aliceAmount = parseEther('12');
      const bobAmount = parseEther('14');

      const cakeMarket2: InterestMarketV1 = await deployUUPS(
        'InterestMarketV1',
        [
          router.address,
          dinero.address,
          treasury.address,
          oracle.address,
          cake.address,
          ethers.constants.AddressZero,
          ethers.BigNumber.from(12e8),
          ethers.BigNumber.from('500000000000000000'),
          ethers.BigNumber.from('100000000000000000'),
        ]
      );

      await Promise.all([
        cake
          .connect(alice)
          .approve(cakeMarket2.address, ethers.constants.MaxUint256),
        cake
          .connect(bob)
          .approve(cakeMarket2.address, ethers.constants.MaxUint256),
        cakeMarket2.updateExchangeRate(),
        dinero.connect(owner).grantRole(MINTER_ROLE, cakeMarket2.address),
        dinero.connect(owner).grantRole(BURNER_ROLE, cakeMarket2.address),
      ]);

      await Promise.all([
        cakeMarket2.connect(alice).addCollateral(alice.address, aliceAmount),
        cakeMarket2.connect(bob).addCollateral(bob.address, bobAmount),
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

      await expect(
        cakeMarket2
          .connect(alice)
          .withdrawCollateral(alice.address, aliceAmount)
      )
        .to.emit(cakeMarket2, 'WithdrawCollateral')
        .withArgs(alice.address, alice.address, aliceAmount)
        .to.emit(cakeMarket2, 'Accrue')
        .to.emit(cake, 'Transfer')
        .withArgs(cakeMarket2.address, alice.address, aliceAmount)
        .to.not.emit(cakeVault, 'Withdraw');

      expect(await cakeMarket2.totalCollateral()).to.be.equal(bobAmount);

      expect(await cakeMarket2.userCollateral(alice.address)).to.be.equal(0);

      expect(await cakeMarket2.userCollateral(bob.address)).to.be.equal(
        bobAmount
      );

      const aliceCakeBalance = await cake.balanceOf(alice.address);

      await expect(
        cakeMarket2
          .connect(bob)
          .withdrawCollateral(alice.address, parseEther('3'))
      )
        .to.emit(cakeMarket2, 'WithdrawCollateral')
        .withArgs(bob.address, alice.address, parseEther('3'))
        .to.emit(cakeMarket2, 'Accrue')
        .to.emit(cake, 'Transfer')
        .withArgs(cakeMarket2.address, alice.address, parseEther('3'))
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
      expect(await cake.balanceOf(alice.address)).to.be.equal(
        aliceCakeBalance.add(parseEther('3'))
      );
    });
  });
  describe('function: setMaxLTVRatio', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(cakeMarket.connect(alice).setMaxLTVRatio(0)).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });
    it('reverts if we set a collateral higher than 9e5', async () => {
      await expect(
        cakeMarket
          .connect(owner)
          .setMaxLTVRatio(ethers.BigNumber.from('900000000000000001'))
      ).to.revertedWith('MKT: too high');
    });
    it('updates the max tvl ratio', async () => {
      expect(await cakeMarket.maxLTVRatio()).to.be.equal(
        ethers.BigNumber.from('500000000000000000')
      );

      await cakeMarket
        .connect(owner)
        .setMaxLTVRatio(ethers.BigNumber.from('90000000000000000'));

      expect(await cakeMarket.maxLTVRatio()).to.be.equal(
        ethers.BigNumber.from('90000000000000000')
      );
    });
  });
  describe('function: setLiquidationFee', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        cakeMarket.connect(alice).setLiquidationFee(0)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if we set a liquidation fee higher than 15e4', async () => {
      await expect(
        cakeMarket
          .connect(owner)
          .setLiquidationFee(ethers.BigNumber.from('150000000000000001'))
      ).to.revertedWith('MKT: too high');
    });
    it('updates the liquidation fee', async () => {
      expect(await cakeMarket.liquidationFee()).to.be.equal(
        ethers.BigNumber.from('100000000000000000')
      );

      await cakeMarket
        .connect(owner)
        .setLiquidationFee(ethers.BigNumber.from('150000000000000000'));

      expect(await cakeMarket.liquidationFee()).to.be.equal(
        ethers.BigNumber.from('150000000000000000')
      );
    });
  });
  describe('function: setInterestRate', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        cakeMarket.connect(alice).setInterestRate(0)
      ).to.revertedWith('Ownable: caller is not the owner');
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
  describe('function: borrow', () => {
    it('reverts if the user is insolvent', async () => {
      await expect(
        cakeMarket.connect(alice).borrow(alice.address, 1)
      ).to.revertedWith('MKT: sender is insolvent');

      await cakeMarket
        .connect(alice)
        .addCollateral(alice.address, parseEther('10')); // 200 USD of collateral

      // @notice the collateral ratio is 49.9%
      await expect(
        cakeMarket.connect(alice).borrow(alice.address, parseEther('100')) // Borrow 100 USD
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('reverts if the recipient is the zero address', async () => {
      await cakeMarket
        .connect(alice)
        .addCollateral(alice.address, parseEther('10')); // 200 USD of collateral

      await expect(
        cakeMarket
          .connect(alice)
          .borrow(ethers.constants.AddressZero, parseEther('50'))
      ).to.revertedWith('MKT: no zero address');
    });
    it('allows borrowing', async () => {
      await cakeMarket
        .connect(alice)
        .addCollateral(alice.address, parseEther('10')); // 200 USD of collateral

      const totalLoan = await cakeMarket.totalLoan();

      expect(await cakeMarket.userLoan(alice.address)).to.be.equal(0);
      expect(await dinero.balanceOf(alice.address)).to.be.equal(0);
      expect(totalLoan.base).to.be.equal(0);
      expect(totalLoan.elastic).to.be.equal(0);

      await expect(
        cakeMarket.connect(alice).borrow(recipient.address, parseEther('50'))
      )
        .to.emit(dinero, 'Transfer')
        .withArgs(
          ethers.constants.AddressZero,
          recipient.address,
          parseEther('50')
        )
        .to.emit(cakeMarket, 'Borrow')
        .withArgs(
          alice.address,
          recipient.address,
          parseEther('50'),
          parseEther('50')
        )
        .to.not.emit(cakeMarket, 'Accrue');

      const totalLoan2 = await cakeMarket.totalLoan();

      expect(await cakeMarket.userLoan(alice.address)).to.be.equal(
        parseEther('50')
      );
      expect(await dinero.balanceOf(alice.address)).to.be.equal(0);
      expect(await dinero.balanceOf(recipient.address)).to.be.equal(
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
        .to.emit(cakeMarket, 'Borrow');

      const totalLoan3 = await cakeMarket.totalLoan();

      expect(await cakeMarket.userLoan(alice.address)).to.be.equal(
        totalLoan3.base
      );
      expect(await cakeMarket.userLoan(bob.address)).to.be.equal(0);
      expect(await dinero.balanceOf(recipient.address)).to.be.equal(
        parseEther('50')
      );
      expect(await dinero.balanceOf(alice.address)).to.be.equal(0);
      expect(await dinero.balanceOf(bob.address)).to.be.equal(parseEther('30'));
      expect(totalLoan3.base.gt(parseEther('78'))).to.be.equal(true); // Due to fees this value is not easy to estimate
      expect(totalLoan3.base.lt(parseEther('80'))).to.be.equal(true); // Due to fees this value is not easy to estimate
      expect(totalLoan3.elastic.gt(parseEther('80'))).to.be.equal(true); // includes fees
    });
  });
  describe('function: repay', () => {
    it('reverts if you try to repay for address(0) or try to repay nothing', async () => {
      await expect(
        cakeMarket.connect(alice).repay(ethers.constants.AddressZero, 0)
      ).to.revertedWith('MKT: no zero address');
      await expect(
        cakeMarket.connect(alice).repay(alice.address, 0)
      ).to.revertedWith('MKT: principal cannot be 0');
    });
    it('allows loans to be repaid', async () => {
      await cakeMarket
        .connect(alice)
        .addCollateral(alice.address, parseEther('10')); // 200 USD of collateral

      await cakeMarket.connect(alice).borrow(alice.address, parseEther('30'));

      const totalLoan = await cakeMarket.totalLoan();

      expect(await cakeMarket.userLoan(alice.address)).to.be.equal(
        parseEther('30')
      );

      expect(totalLoan.base).to.be.equal(parseEther('30'));

      expect(await dinero.balanceOf(alice.address)).to.be.equal(
        parseEther('30')
      );

      // specific debt is very hard to calculate
      await expect(
        cakeMarket.connect(alice).repay(alice.address, parseEther('10'))
      )
        .to.emit(cakeMarket, 'Repay')
        .to.emit(dinero, 'Transfer')
        .to.emit(cakeMarket, ' Accrue');

      const totalLoan2 = await cakeMarket.totalLoan();

      expect(await cakeMarket.userLoan(alice.address)).to.be.equal(
        parseEther('20')
      );

      // She paid fees
      expect(
        (await dinero.balanceOf(alice.address)).lt(parseEther('20'))
      ).to.be.equal(true);

      expect(totalLoan2.base).to.be.equal(parseEther('20'));
      expect(totalLoan2.elastic.lt(totalLoan.elastic)).to.be.equal(true);

      const ownerDineroBalance = await dinero.balanceOf(owner.address);

      // specific debt is very hard to calculate
      await expect(
        cakeMarket.connect(owner).repay(alice.address, parseEther('20'))
      )
        .to.emit(cakeMarket, 'Repay')
        .to.emit(dinero, 'Transfer')
        .to.emit(cakeMarket, ' Accrue');

      const totalLoan3 = await cakeMarket.totalLoan();

      expect(await cakeMarket.userLoan(alice.address)).to.be.equal(0);

      // She did not pay for her loan. The owner did
      expect((await dinero.balanceOf(alice.address)).gt(0)).to.be.equal(true);

      expect(
        (await dinero.balanceOf(owner.address)).lt(ownerDineroBalance)
      ).to.be.equal(true);

      expect(totalLoan3.base).to.be.equal(0);
      expect(totalLoan3.elastic).to.be.equal(0);
    });
  });
  describe('function: liquidate', () => {
    it('reverts if the path exists and does not need in dinero', async () => {
      await expect(
        cakeMarket
          .connect(owner)
          .liquidate(
            [alice.address],
            [parseEther('1')],
            recipient.address,
            [dinero.address, cake.address],
            []
          )
      ).to.revertedWith('MKT: no dinero at last index');
    });
    it('reverts if there are no accounts to liquidate', async () => {
      await Promise.all([
        cakeMarket
          .connect(alice)
          .addCollateral(alice.address, parseEther('10')),
        cakeMarket.connect(bob).addCollateral(bob.address, parseEther('10')),
        cakeMarket.connect(jose).addCollateral(jose.address, parseEther('10')),
      ]);

      await Promise.all([
        cakeMarket.connect(alice).borrow(alice.address, parseEther('50')),
        cakeMarket.connect(bob).borrow(bob.address, parseEther('50')),
        cakeMarket.connect(jose).borrow(jose.address, parseEther('50')),
      ]);

      await expect(
        cakeMarket
          .connect(owner)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [parseEther('10'), parseEther('10'), parseEther('10')],
            owner.address,
            [],
            []
          )
      ).to.revertedWith('MKT: no liquidations');
    });
    it('liquidates accounts on a market without a vault and using the router', async () => {
      // Deploy a market without a vault

      const cakeMarket2: InterestMarketV1 = await deployUUPS(
        'InterestMarketV1',
        [
          router.address,
          dinero.address,
          treasury.address,
          oracle.address,
          cake.address,
          ethers.constants.AddressZero,
          ethers.BigNumber.from(12e8),
          ethers.BigNumber.from('500000000000000000'),
          ethers.BigNumber.from('100000000000000000'),
        ]
      );

      // Approve the market to spend the funds of the users
      await Promise.all([
        cake
          .connect(alice)
          .approve(cakeMarket2.address, ethers.constants.MaxUint256),
        cake
          .connect(jose)
          .approve(cakeMarket2.address, ethers.constants.MaxUint256),
        cakeMarket2.updateExchangeRate(),
        dinero.connect(owner).grantRole(MINTER_ROLE, cakeMarket2.address),
        dinero.connect(owner).grantRole(BURNER_ROLE, cakeMarket2.address),
      ]);

      // Add Collateral
      await Promise.all([
        cakeMarket2
          .connect(alice)
          .addCollateral(alice.address, parseEther('10')),
        cakeMarket2.connect(jose).addCollateral(jose.address, parseEther('10')),
      ]);

      // Borrow the maximum amount of 49.9%
      await Promise.all([
        cakeMarket2.connect(alice).borrow(alice.address, parseEther('99')),
        cakeMarket2.connect(jose).borrow(jose.address, parseEther('99')),
      ]);

      // Drop CAKE to 15 USD. Alice and Jose can now be liquidated
      await mockCakeUsdFeed.setAnswer(ethers.BigNumber.from('1500000000'));

      const [
        totalCollateral,
        aliceLoan,
        joseLoan,
        aliceCollateral,
        joseCollateral,
        loan,
        pair,
        dineroRecipientBalance,
      ] = await Promise.all([
        cakeMarket2.totalCollateral(),
        cakeMarket2.userLoan(alice.address),
        cakeMarket2.userLoan(jose.address),
        cakeMarket2.userCollateral(alice.address),
        cakeMarket2.userCollateral(jose.address),
        cakeMarket2.loan(),
        factory.allPairs(0),
        dinero.balanceOf(recipient.address),
      ]);

      expect(totalCollateral).to.be.equal(parseEther('20'));
      expect(aliceLoan).to.be.equal(parseEther('99'));
      // Due to fees paid by alice their principal is lower than 99
      expect(joseLoan.gt(parseEther('95'))).to.be.equal(true);

      expect(dineroRecipientBalance).to.be.equal(0);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      // Pass time to accrue fees
      await advanceTime(63_113_904, ethers); // advance 2 years

      // The recipient can liquidate all because he does not need to have `Dinero` he will use the collateral to cover
      await expect(
        cakeMarket2.connect(recipient).liquidate(
          [alice.address, jose.address],
          [parseEther('99'), parseEther('99')],
          recipient.address,
          [cake.address, bnb.address, dinero.address], // Enables the use of the router for non LP-tokens.
          []
        )
      )
        .to.emit(cakeMarket2, 'WithdrawCollateral')
        .to.emit(cakeMarket2, 'Repay')
        .to.emit(cakeMarket2, 'Accrue')
        .to.emit(cakeMarket2, 'ExchangeRate')
        .to.emit(dinero, 'Transfer')
        // Router is being used
        .to.emit(pairContract, 'Swap')
        // Vault is not used
        .to.not.emit(cakeVault, 'Withdraw');

      const [
        totalLoan,
        totalCollateral2,
        aliceLoan2,
        joseLoan2,
        aliceCollateral2,
        joseCollateral2,
        loan2,
        dineroRecipientBalance2,
      ] = await Promise.all([
        cakeMarket2.totalLoan(),
        cakeMarket2.totalCollateral(),
        cakeMarket2.userLoan(alice.address),
        cakeMarket2.userLoan(jose.address),
        cakeMarket2.userCollateral(alice.address),
        cakeMarket2.userCollateral(jose.address),
        cakeMarket2.loan(),
        dinero.balanceOf(recipient.address),
      ]);

      const allCollateral = aliceCollateral
        .sub(aliceCollateral2)
        .add(joseCollateral.sub(joseCollateral2));

      // We calculate the debt by re-engineering the formula
      const aliceDebt = aliceCollateral
        .sub(aliceCollateral2)
        .mul(ethers.BigNumber.from(15).mul(parseEther('1')))
        .mul(ethers.BigNumber.from(1e6))
        .div(
          ethers.BigNumber.from(1e6)
            .add(ethers.BigNumber.from(10e4))
            .mul(parseEther('1'))
        );

      // We calculate the debt by re-engineering the formula
      const joseDebt = joseCollateral
        .sub(joseCollateral2)
        .mul(ethers.BigNumber.from(15).mul(parseEther('1')))
        .mul(ethers.BigNumber.from(1e6))
        .div(
          ethers.BigNumber.from(1e6)
            .add(ethers.BigNumber.from(10e4))
            .mul(parseEther('1'))
        );

      const allDebt = aliceDebt.add(joseDebt);

      const allFee = allDebt.mul(ethers.BigNumber.from(10e4)).div(1e6);

      const protocolFee = allFee
        .mul(ethers.BigNumber.from(100))
        .div(ethers.BigNumber.from(1000));

      // Alice loan  gets fully repaid
      expect(aliceLoan2).to.be.equal(0);
      // Jose loan gets fully repaid
      expect(joseLoan2).to.be.equal(0);

      // Alice and Jose got liquidated
      expect(totalCollateral.sub(totalCollateral2)).to.be.eq(allCollateral);

      // recipient does not get any collateral
      expect(await cake.balanceOf(recipient.address)).to.be.equal(0);

      // Means loan2 feesEarned includes accrued + protocol fee
      expect(loan2.feesEarned.sub(protocolFee).gt(loan.feesEarned)).to.be.equal(
        true
      );

      // There should be no open loan at the moment
      expect(totalLoan.base).to.be.equal(0);
      expect(totalLoan.elastic).to.be.equal(0);

      // Recipient receives the liquidation fee - slippage
      expect(dineroRecipientBalance2.gt(0)).to.be.equal(true);
    });
    it('liquidates accounts on a market with a vault and without using the router', async () => {
      await Promise.all([
        cakeMarket
          .connect(alice)
          .addCollateral(alice.address, parseEther('10')),
        cakeMarket.connect(bob).addCollateral(bob.address, parseEther('100')),
        cakeMarket.connect(jose).addCollateral(jose.address, parseEther('10')),
      ]);

      await Promise.all([
        cakeMarket.connect(alice).borrow(alice.address, parseEther('99')),
        cakeMarket.connect(bob).borrow(bob.address, parseEther('99')),
        cakeMarket.connect(jose).borrow(jose.address, parseEther('99')),
      ]);

      // Drop CAKE to 15 USD. Alice and Jose can now be liquidated
      await mockCakeUsdFeed.setAnswer(ethers.BigNumber.from('1500000000'));

      const [
        totalCollateral,
        aliceLoan,
        bobLoan,
        joseLoan,
        aliceCollateral,
        bobCollateral,
        joseCollateral,
        loan,
        pair,
        ownerDineroBalance,
      ] = await Promise.all([
        cakeMarket.totalCollateral(),
        cakeMarket.userLoan(alice.address),
        cakeMarket.userLoan(bob.address),
        cakeMarket.userLoan(jose.address),
        cakeMarket.userCollateral(alice.address),
        cakeMarket.userCollateral(bob.address),
        cakeMarket.userCollateral(jose.address),
        cakeMarket.loan(),
        factory.allPairs(0),
        dinero.balanceOf(owner.address),
      ]);

      expect(totalCollateral).to.be.equal(parseEther('120'));
      expect(aliceLoan).to.be.equal(parseEther('99'));
      // Due to fees paid by alice their principal is lower than 99
      expect(bobLoan.gt(parseEther('95'))).to.be.equal(true);
      expect(joseLoan.gt(parseEther('95'))).to.be.equal(true);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      // Pass time to accrue fees
      await advanceTime(63_113_904, ethers); // advance 2 years

      // All but Bob should be liquidated
      await expect(
        cakeMarket
          .connect(owner)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [parseEther('99'), parseEther('99'), parseEther('90')],
            recipient.address,
            [],
            []
          )
      )
        .to.emit(cakeMarket, 'WithdrawCollateral')
        .to.emit(cakeMarket, 'Repay')
        .to.emit(cakeMarket, 'Accrue')
        .to.emit(cakeMarket, 'ExchangeRate')
        .to.emit(dinero, 'Transfer')
        .to.emit(cakeVault, 'Withdraw')
        // Router was not used
        .to.not.emit(pairContract, 'Swap');

      const [
        totalLoan,
        totalCollateral2,
        aliceLoan2,
        bobLoan2,
        joseLoan2,
        aliceCollateral2,
        bobCollateral2,
        joseCollateral2,
        loan2,
        ownerDineroBalance2,
      ] = await Promise.all([
        cakeMarket.totalLoan(),
        cakeMarket.totalCollateral(),
        cakeMarket.userLoan(alice.address),
        cakeMarket.userLoan(bob.address),
        cakeMarket.userLoan(jose.address),
        cakeMarket.userCollateral(alice.address),
        cakeMarket.userCollateral(bob.address),
        cakeMarket.userCollateral(jose.address),
        cakeMarket.loan(),
        dinero.balanceOf(owner.address),
      ]);

      const allCollateral = aliceCollateral
        .sub(aliceCollateral2)
        .add(joseCollateral.sub(joseCollateral2));

      // We calculate the debt by re-engineering the formula
      const aliceDebt = aliceCollateral
        .sub(aliceCollateral2)
        .mul(ethers.BigNumber.from(15).mul(parseEther('1')))
        .mul(ethers.BigNumber.from(1e6))
        .div(
          ethers.BigNumber.from(1e6)
            .add(ethers.BigNumber.from(10e4))
            .mul(parseEther('1'))
        );

      // We calculate the debt by re-engineering the formula
      const joseDebt = joseCollateral
        .sub(joseCollateral2)
        .mul(ethers.BigNumber.from(15).mul(parseEther('1')))
        .mul(ethers.BigNumber.from(1e6))
        .div(
          ethers.BigNumber.from(1e6)
            .add(ethers.BigNumber.from(10e4))
            .mul(parseEther('1'))
        );

      const allDebt = aliceDebt.add(joseDebt);

      const allFee = allDebt.mul(ethers.BigNumber.from(10e4)).div(1e6);

      const protocolFee = allFee
        .mul(ethers.BigNumber.from(100))
        .div(ethers.BigNumber.from(1000));

      // Alice loan  gets fully repaid
      expect(aliceLoan2).to.be.equal(0);
      // Bob loan still open
      expect(bobLoan2).to.be.equal(bobLoan);
      // Jose loan gets partially repaid
      expect(joseLoan2).to.be.equal(joseLoan.sub(parseEther('90')));

      // Bob does not get liquidated
      expect(bobCollateral2).to.be.equal(bobCollateral);

      // Alice and Jose got liquidated
      expect(totalCollateral.sub(totalCollateral2)).to.be.eq(allCollateral);

      // recipient gets the all the collateral to cover
      expect(await cake.balanceOf(recipient.address)).to.be.equal(
        allCollateral
      );

      // Means loan2 feesEarned includes accrued + protocol fee
      expect(loan2.feesEarned.sub(protocolFee).gt(loan.feesEarned)).to.be.equal(
        true
      );

      // total loan principal was properly updated
      expect(totalLoan.base).to.be.equal(bobLoan.add(joseLoan2));
      // We repaid debt for 189 DNR + interest rate. So the remaining debt should be for 108 + fees
      // While it is hard to get the exact number we know it has to be smaller
      expect(totalLoan.elastic.add(parseEther('82')).lt(allDebt)).to.be.equal(
        true
      );

      // Need to remove the two last decimal houses for accuracy
      expect(ownerDineroBalance.sub(ownerDineroBalance2).div(1e2)).to.be.equal(
        allDebt.add(protocolFee).div(1e2)
      );
    });
    it('reverts if the collateral is a pair token and the path is passed without a path2 is', async () => {
      const cakeBnbLPAddress = await factory.getPair(bnb.address, cake.address);

      const cakeBnbLP = (await ethers.getContractFactory('PancakePair')).attach(
        cakeBnbLPAddress
      );

      const cakeBnbLPMarket: InterestMarketV1 = await deployUUPS(
        'InterestMarketV1',
        [
          router.address,
          dinero.address,
          treasury.address,
          oracle.address,
          cakeBnbLPAddress,
          // Already tested the logic of the vault
          ethers.constants.AddressZero,
          ethers.BigNumber.from(12e8),
          ethers.BigNumber.from('500000000000000000'),
          ethers.BigNumber.from('100000000000000000'),
        ]
      );

      await Promise.all([
        cakeBnbLP
          .connect(owner)
          .approve(cakeBnbLPMarket.address, ethers.constants.MaxUint256),
        cakeBnbLPMarket.updateExchangeRate(),
        dinero.connect(owner).grantRole(MINTER_ROLE, cakeBnbLPMarket.address),
        dinero.connect(owner).grantRole(BURNER_ROLE, cakeBnbLPMarket.address),
      ]);

      await cakeBnbLPMarket
        .connect(owner)
        .addCollateral(owner.address, parseEther('10000'));

      await cakeBnbLPMarket
        .connect(owner)
        .borrow(owner.address, parseEther('700000'));

      // BEFORE: 1 LP = 200 USD
      // Owner can now be liquidated
      await mockBnbUsdDFeed.setAnswer(ethers.BigNumber.from('10000000000'));

      // BEFORE: 1 LP = 40 USD

      await expect(
        cakeBnbLPMarket
          .connect(alice)
          .liquidate(
            [owner.address],
            [parseEther('100000')],
            recipient.address,
            [bnb.address, dinero.address],
            []
          )
      ).to.revertedWith('MKT: provide a path for token1');

      await expect(
        cakeBnbLPMarket
          .connect(alice)
          .liquidate(
            [owner.address],
            [parseEther('100000')],
            recipient.address,
            [bnb.address, dinero.address],
            [dinero.address, cake.address]
          )
      ).to.revertedWith('MKT: no dinero on last index');
    });
    it('liquidates an underwater loan using a LP token as collateral', async () => {
      const cakeBnbLPAddress = await factory.getPair(bnb.address, cake.address);

      const cakeBnbLP = (await ethers.getContractFactory('PancakePair')).attach(
        cakeBnbLPAddress
      );

      const cakeBnbLPMarket = await deployUUPS('InterestMarketV1', [
        router.address,
        dinero.address,
        treasury.address,
        oracle.address,
        cakeBnbLPAddress,
        // Already tested the logic of the vault
        ethers.constants.AddressZero,
        ethers.BigNumber.from(12e8),
        ethers.BigNumber.from('500000000000000000'),
        ethers.BigNumber.from('100000000000000000'),
      ]);

      await Promise.all([
        cakeBnbLP
          .connect(owner)
          .approve(cakeBnbLPMarket.address, ethers.constants.MaxUint256),
        cakeBnbLPMarket.updateExchangeRate(),
        dinero.connect(owner).grantRole(MINTER_ROLE, cakeBnbLPMarket.address),
        dinero.connect(owner).grantRole(BURNER_ROLE, cakeBnbLPMarket.address),
      ]);

      await cakeBnbLPMarket
        .connect(owner)
        .addCollateral(owner.address, parseEther('1000'));

      await cakeBnbLPMarket
        .connect(owner)
        .borrow(owner.address, parseEther('25000'));

      // BEFORE: 1 LP = 200 USD
      // Owner can now be liquidated
      await mockBnbUsdDFeed.setAnswer(ethers.BigNumber.from('10000000000'));

      // BEFORE: 1 LP = 40 USD

      const [
        totalCollateral,
        ownerLoan,
        ownerCollateral,
        loan,
        cakeBnbLpRecipientBalance,
        dineroRecipientBalance,
      ] = await Promise.all([
        cakeBnbLPMarket.totalCollateral(),
        cakeBnbLPMarket.userLoan(owner.address),
        cakeBnbLPMarket.userCollateral(owner.address),
        cakeBnbLPMarket.loan(),
        cakeBnbLP.balanceOf(recipient.address),
        dinero.balanceOf(recipient.address),
      ]);

      expect(totalCollateral).to.be.equal(parseEther('1000'));
      expect(ownerLoan).to.be.equal(parseEther('25000'));
      expect(ownerCollateral).to.be.equal(parseEther('1000'));
      expect(cakeBnbLpRecipientBalance).to.be.equal(0);
      expect(loan.feesEarned).to.be.equal(0);
      expect(dineroRecipientBalance).to.be.equal(0);

      // Pass time to accrue fees
      await advanceTime(63_113_904, ethers); // advance 2 years

      await expect(
        cakeBnbLPMarket
          .connect(alice)
          .liquidate(
            [owner.address],
            [parseEther('250000')],
            recipient.address,
            [cake.address, bnb.address, dinero.address],
            [bnb.address, dinero.address]
          )
      )
        .to.emit(cakeBnbLPMarket, 'Repay')
        .to.emit(cakeBnbLPMarket, 'Accrue')
        .to.emit(cakeBnbLPMarket, 'ExchangeRate')
        .to.emit(cakeBnbLPMarket, 'WithdrawCollateral')
        .to.emit(cakeBnbLP, 'Swap')
        // Burn emits a Transfer event
        .to.emit(dinero, 'Transfer')
        // remove liquidity
        .to.emit(cakeBnbLP, 'Burn');

      const [
        totalCollateral2,
        ownerLoan2,
        ownerCollateral2,
        loan2,
        totalLoan,
        cakeBnbLpRecipientBalance2,
        dineroRecipientBalance2,
      ] = await Promise.all([
        cakeBnbLPMarket.totalCollateral(),
        cakeBnbLPMarket.userLoan(owner.address),
        cakeBnbLPMarket.userCollateral(owner.address),
        cakeBnbLPMarket.loan(),
        cakeBnbLPMarket.totalLoan(),
        cakeBnbLP.balanceOf(recipient.address),
        dinero.balanceOf(recipient.address),
      ]);

      // State properly updated

      // Collateral is sold for Dinero
      expect(totalCollateral2.gt(0)).to.be.equal(true);
      expect(ownerCollateral2).to.be.equal(totalCollateral2);
      expect(ownerCollateral.gt(ownerCollateral2)).to.be.equal(true);

      // Loan is completely paid off and accrued was called
      expect(ownerLoan2).to.be.equal(0);
      expect(loan2.lastAccrued.gt(loan.lastAccrued)).to.be.equal(true);
      expect(loan2.feesEarned.gt(0)).to.be.equal(true);
      expect(totalLoan.base).to.be.equal(0);
      expect(totalLoan.elastic).to.be.equal(0);

      // Recipient got paid in Dinero and not in collateral
      expect(cakeBnbLpRecipientBalance2).to.be.equal(0);
      expect(dineroRecipientBalance2.gt(0)).to.be.equal(true);
    });
  });

  describe('Upgrade functionality', () => {
    it('reverts if it not called by the owner', async () => {
      await cakeMarket.connect(owner).transferOwnership(alice.address);

      await expect(upgrade(cakeMarket, 'TestInterestMarketV2')).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });

    it('updates to version 2', async () => {
      expect(await cakeMarket.totalCollateral()).to.be.equal(0);

      expect(await cakeMarket.userCollateral(alice.address)).to.be.equal(0);

      const amount = parseEther('10');

      await expect(
        cakeMarket.connect(alice).addCollateral(alice.address, amount)
      )
        .to.emit(cakeMarket, 'AddCollateral')
        .withArgs(alice.address, alice.address, amount)
        .to.emit(cakeVault, 'Deposit')
        .withArgs(alice.address, alice.address, amount)
        .to.emit(cake, 'Transfer')
        .withArgs(alice.address, cakeVault.address, amount);

      expect(await cakeMarket.totalCollateral()).to.be.equal(amount);

      expect(await cakeMarket.userCollateral(alice.address)).to.be.equal(
        amount
      );

      const cakeMarketV2: TestInterestMarketV2 = await upgrade(
        cakeMarket,
        'TestInterestMarketV2'
      );

      await expect(
        cakeMarketV2.connect(bob).addCollateral(alice.address, amount)
      )
        .to.emit(cakeMarketV2, 'AddCollateral')
        .withArgs(bob.address, alice.address, amount)
        .to.emit(cakeVault, 'Deposit')
        .withArgs(bob.address, alice.address, amount)
        .to.emit(cake, 'Transfer')
        .withArgs(bob.address, cakeVault.address, amount);

      const [
        totalCollateral,
        aliceCollateral,
        bobCollateral,
        version,
        marketCakeBalance,
      ] = await Promise.all([
        cakeMarketV2.totalCollateral(),
        cakeMarketV2.userCollateral(alice.address),
        cakeMarketV2.userCollateral(bob.address),
        cakeMarketV2.version(),
        cake.balanceOf(cakeMarket.address),
      ]);

      expect(totalCollateral).to.be.equal(amount.add(amount));

      expect(aliceCollateral).to.be.equal(amount.add(amount));
      expect(bobCollateral).to.be.equal(0);
      expect(version).to.be.equal('V2');
      expect(marketCakeBalance).to.be.equal(0); // Cake is in the masterChef
    });
  });
}).timeout(7000);
