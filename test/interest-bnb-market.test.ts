import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  Dinero,
  ETHRouter,
  InterestBNBMarketV1,
  LiquidityRouter,
  MockChainLinkFeed,
  MockERC20,
  MockTWAP,
  OracleV1,
  PancakeFactory,
  ReentrantInterestBNBMarketLiquidate,
  ReentrantInterestBNBMarketWithdrawCollateral,
  TestInterestBNBMarketV2,
  WETH9,
} from '../typechain';
import { BURNER_ROLE, MINTER_ROLE } from './lib/constants';
import {
  advanceTime,
  deploy,
  deployUUPS,
  multiDeploy,
  upgrade,
} from './lib/test-utils';

const BNB_USD_PRICE = ethers.BigNumber.from('50000000000'); // 500 USD

const { parseEther } = ethers.utils;

describe('InterestBNBMarketV1', () => {
  let interestBNBMarket: InterestBNBMarketV1;
  let dinero: Dinero;
  let oracle: OracleV1;
  let mockBnbUsdDFeed: MockChainLinkFeed;
  let weth: WETH9;
  let factory: PancakeFactory;
  let router: ETHRouter;
  let liquidityRouter: LiquidityRouter;
  let mockTWAP: MockTWAP;
  let busd: MockERC20;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let treasury: SignerWithAddress;
  let developer: SignerWithAddress;
  let jose: SignerWithAddress;
  let recipient: SignerWithAddress;

  beforeEach(async () => {
    [owner, alice, bob, treasury, developer, jose, recipient] =
      await ethers.getSigners();

    [dinero, [weth, mockBnbUsdDFeed, factory, mockTWAP, busd]] =
      await Promise.all([
        deployUUPS('Dinero', []),
        multiDeploy(
          [
            'WETH9',
            'MockChainLinkFeed',
            'PancakeFactory',
            'MockTWAP',
            'MockERC20',
          ],
          [
            [],
            [8, 'CAKE/USD', 1],
            [developer.address],
            [],
            ['Binance USD', 'BUSD', parseEther('1000')],
          ]
        ),
      ]);

    [oracle, [router, liquidityRouter]] = await Promise.all([
      deployUUPS('OracleV1', [
        mockTWAP.address,
        mockBnbUsdDFeed.address,
        weth.address,
        busd.address,
      ]),
      multiDeploy(
        ['ETHRouter', 'LiquidityRouter'],
        [
          [factory.address, weth.address],
          [factory.address, weth.address],
        ]
      ),
    ]);

    [interestBNBMarket] = await Promise.all([
      deployUUPS('InterestBNBMarketV1', [
        router.address,
        dinero.address,
        treasury.address,
        oracle.address,
        ethers.BigNumber.from(12e8),
        ethers.BigNumber.from('500000000000000000'),
        ethers.BigNumber.from('100000000000000000'),
      ]),
      mockBnbUsdDFeed.setAnswer(BNB_USD_PRICE),
      oracle.connect(owner).setFeed(weth.address, mockBnbUsdDFeed.address, 0),
      weth.approve(liquidityRouter.address, ethers.constants.MaxUint256),
      weth.connect(owner).mint(parseEther('1000')),
    ]);

    await Promise.all([
      dinero.connect(owner).grantRole(MINTER_ROLE, owner.address),
      dinero.connect(owner).grantRole(MINTER_ROLE, interestBNBMarket.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, interestBNBMarket.address),
    ]);

    await Promise.all([
      dinero.connect(owner).mint(owner.address, parseEther('700000')),
      dinero.connect(owner).mint(alice.address, parseEther('500000')),
      dinero.approve(liquidityRouter.address, ethers.constants.MaxUint256),
      // BNB/DINERO Liquidity
      liquidityRouter
        .connect(owner)
        .addLiquidity(
          weth.address,
          dinero.address,
          parseEther('1000'),
          parseEther('500000'),
          parseEther('1000'),
          parseEther('500000'),
          owner.address,
          ethers.constants.MaxUint256
        ),
      interestBNBMarket.updateExchangeRate(),
    ]);
  });

  describe('function: initialize', () => {
    it('reverts if you initialize after deployment', async () => {
      await expect(
        interestBNBMarket
          .connect(alice)
          .initialize(
            router.address,
            dinero.address,
            treasury.address,
            oracle.address,
            ethers.BigNumber.from(12e8),
            ethers.BigNumber.from('500000000000000000'),
            ethers.BigNumber.from('100000000000000000')
          )
      ).to.revertedWith('Initializable: contract is already initialized');
    });

    it('sets the initial state correctly', async () => {
      const [
        _owner,
        _router,
        _dinero,
        _feeTo,
        _oracle,
        _loan,
        _maxLTVRatio,
        _liquidationFee,
      ] = await Promise.all([
        interestBNBMarket.owner(),
        interestBNBMarket.ROUTER(),
        interestBNBMarket.DINERO(),
        interestBNBMarket.FEE_TO(),
        interestBNBMarket.ORACLE(),
        interestBNBMarket.loan(),
        interestBNBMarket.maxLTVRatio(),
        interestBNBMarket.liquidationFee(),
      ]);

      expect(_owner).to.be.equal(owner.address);
      expect(_router).to.be.equal(router.address);
      expect(_dinero).to.be.equal(dinero.address);
      expect(_feeTo).to.be.equal(treasury.address);
      expect(_oracle).to.be.equal(oracle.address);
      expect(_loan.INTEREST_RATE).to.be.equal(ethers.BigNumber.from(12e8));
      expect(_maxLTVRatio).to.be.equal(
        ethers.BigNumber.from('500000000000000000')
      );
      expect(_liquidationFee).to.be.equal(
        ethers.BigNumber.from('100000000000000000')
      );
    });
  });

  it('sends the fees earned to the feeTo address', async () => {
    await alice.sendTransaction({
      to: interestBNBMarket.address,
      value: parseEther('3'),
    });

    await interestBNBMarket
      .connect(alice)
      .borrow(alice.address, parseEther('700'));

    // Pass time to accrue fees
    await advanceTime(10_000, ethers); // advance 10_000 seconds

    const debt = parseEther('700')
      .mul(ethers.BigNumber.from(12e8))
      .mul(10_000)
      .div(parseEther('1'));

    expect(await dinero.balanceOf(treasury.address)).to.be.equal(0);
    // Acrrue has not been called
    expect((await interestBNBMarket.totalLoan()).elastic).to.be.equal(
      parseEther('700')
    );

    await expect(interestBNBMarket.getEarnings())
      .to.emit(interestBNBMarket, 'Accrue')
      .to.emit(interestBNBMarket, 'GetEarnings');

    expect((await interestBNBMarket.loan()).feesEarned).to.be.equal(0);
    expect((await dinero.balanceOf(treasury.address)).gte(debt)).to.be.equal(
      true
    );
    expect(
      (await interestBNBMarket.totalLoan()).elastic.gte(
        parseEther('700').add(debt)
      )
    );
  });
  describe('function: accrue', () => {
    it('does not accrue fees if there is no open loans', async () => {
      const loan = await interestBNBMarket.loan();
      expect((await interestBNBMarket.totalLoan()).base).to.be.equal(0);
      await expect(interestBNBMarket.accrue()).to.not.emit(
        interestBNBMarket,
        'Accrue'
      );
      const loan2 = await interestBNBMarket.loan();
      // It only updated the timestamp
      expect(loan.lastAccrued.lt(loan2.lastAccrued)).to.be.equal(true);
      expect(loan2.feesEarned).to.be.equal(0);
      expect((await interestBNBMarket.totalLoan()).base).to.be.equal(0);
    });
    it('accrues the interest rate', async () => {
      await alice.sendTransaction({
        to: interestBNBMarket.address,
        value: parseEther('3'),
      });

      await interestBNBMarket
        .connect(alice)
        .borrow(alice.address, parseEther('700'));
      const [loan, totalLoan] = await Promise.all([
        interestBNBMarket.loan(),
        interestBNBMarket.totalLoan(),
      ]);

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // advance 10_000 seconds
      const debt = parseEther('700')
        .mul(ethers.BigNumber.from(12e8))
        .mul(10_000)
        .div(parseEther('1'));

      expect(interestBNBMarket.accrue()).to.emit(interestBNBMarket, 'Accrue');

      const [loan2, totalLoan2] = await Promise.all([
        interestBNBMarket.loan(),
        interestBNBMarket.totalLoan(),
      ]);

      expect(loan.feesEarned).to.be.equal(0);
      expect(loan2.lastAccrued.gt(0)).to.be.equal(true);
      expect(totalLoan2.base).to.be.equal(totalLoan.base);
      expect(totalLoan2.elastic.gte(totalLoan.elastic.add(debt))).to.be.equal(
        true
      );
      expect(loan2.lastAccrued.gt(loan.lastAccrued)).to.be.equal(true);
    });
  });
  describe('function: updateExchangeRate', () => {
    it('reverts if the rate is 0', async () => {
      await mockBnbUsdDFeed.setAnswer(0);
      await expect(interestBNBMarket.updateExchangeRate()).to.revertedWith(
        'MKT: invalid exchange rate'
      );
    });
    it('does not update the state if the interest rate is the same', async () => {
      expect(await interestBNBMarket.exchangeRate()).to.be.equal(
        parseEther('500')
      );
      await expect(interestBNBMarket.updateExchangeRate()).to.not.emit(
        interestBNBMarket,
        'ExchangeRate'
      );
      expect(await interestBNBMarket.exchangeRate()).to.be.equal(
        parseEther('500')
      );
    });
    it('updates the exchange rate', async () => {
      expect(await interestBNBMarket.exchangeRate()).to.be.equal(
        parseEther('500')
      );

      await mockBnbUsdDFeed.setAnswer(ethers.BigNumber.from('52000000000'));

      await expect(interestBNBMarket.updateExchangeRate()).to.emit(
        interestBNBMarket,
        'ExchangeRate'
      );

      expect(await interestBNBMarket.exchangeRate()).to.be.equal(
        parseEther('520')
      );
    });
  });
  it('allows an account to add collateral', async () => {
    expect(await interestBNBMarket.userCollateral(bob.address)).to.be.equal(0);
    expect(await interestBNBMarket.userCollateral(alice.address)).to.be.equal(
      0
    );
    await expect(
      interestBNBMarket
        .connect(alice)
        .addCollateral(bob.address, { value: parseEther('5') })
    )
      .to.emit(interestBNBMarket, 'AddCollateral')
      .withArgs(alice.address, bob.address, parseEther('5'));

    expect(await interestBNBMarket.userCollateral(bob.address)).to.be.equal(
      parseEther('5')
    );

    await expect(
      interestBNBMarket
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') })
    )
      .to.emit(interestBNBMarket, 'AddCollateral')
      .withArgs(alice.address, alice.address, parseEther('2'));

    expect(await interestBNBMarket.userCollateral(alice.address)).to.be.equal(
      parseEther('2')
    );

    await expect(
      alice.sendTransaction({
        to: interestBNBMarket.address,
        value: parseEther('1'),
      })
    )
      .to.emit(interestBNBMarket, 'AddCollateral')
      .withArgs(alice.address, alice.address, parseEther('1'));

    expect(await interestBNBMarket.userCollateral(alice.address)).to.be.equal(
      parseEther('3')
    );
  });
  describe('function: withdrawCollateral', () => {
    it('reverts if the caller is insolvent', async () => {
      await interestBNBMarket
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

      await interestBNBMarket
        .connect(alice)
        .borrow(alice.address, parseEther('400'));

      await expect(
        interestBNBMarket
          .connect(alice)
          .withdrawCollateral(alice.address, parseEther('1'))
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('allows collateral to be withdrawn', async () => {
      await interestBNBMarket
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

      const [bobBalance, aliceCollateral] = await Promise.all([
        bob.getBalance(),
        interestBNBMarket.userCollateral(alice.address),
        interestBNBMarket
          .connect(alice)
          .borrow(alice.address, parseEther('100')),
      ]);

      await mockBnbUsdDFeed.setAnswer(ethers.BigNumber.from('51000000000'));

      await expect(
        interestBNBMarket
          .connect(alice)
          .withdrawCollateral(bob.address, parseEther('1.5'))
      )
        .to.emit(interestBNBMarket, 'Accrue')
        .to.emit(interestBNBMarket, 'ExchangeRate')
        .to.emit(interestBNBMarket, 'WithdrawCollateral')
        .withArgs(alice.address, bob.address, parseEther('1.5'));

      expect(await bob.getBalance()).to.be.equal(
        bobBalance.add(parseEther('1.5'))
      );
      expect(aliceCollateral.sub(parseEther('1.5'))).to.be.equal(
        await interestBNBMarket.userCollateral(alice.address)
      );
    });
    it('reverts if the caller tries to reenter', async () => {
      const attackContract: ReentrantInterestBNBMarketWithdrawCollateral =
        await deploy('ReentrantInterestBNBMarketWithdrawCollateral', [
          interestBNBMarket.address,
        ]);

      await interestBNBMarket
        .connect(alice)
        .addCollateral(attackContract.address, { value: parseEther('2') });

      await mockBnbUsdDFeed.setAnswer(ethers.BigNumber.from('51000000000'));

      await expect(
        attackContract
          .connect(alice)
          .withdrawCollateral(attackContract.address, parseEther('1.5'))
      ).to.revertedWith('ReentrancyGuard: reentrant call');
    });
  });
  describe('function: borrow', () => {
    it('reverts if you borrow to the zero address', async () => {
      await expect(
        interestBNBMarket.connect(alice).borrow(ethers.constants.AddressZero, 1)
      ).to.revertedWith('MKT: no zero address');
    });
    it('reverts if the user is insolvent', async () => {
      await interestBNBMarket
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

      await expect(
        interestBNBMarket.connect(alice).borrow(bob.address, parseEther('500'))
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('allows a user to borrow as long as he remains solvent', async () => {
      await interestBNBMarket
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

      const [totalLoan, aliceLoan, aliceDineroBalance] = await Promise.all([
        interestBNBMarket.totalLoan(),
        interestBNBMarket.userLoan(alice.address),
        dinero.balanceOf(alice.address),
      ]);

      expect(totalLoan.base).to.be.equal(0);
      expect(totalLoan.elastic).to.be.equal(0);
      expect(aliceLoan).to.be.equal(0);

      await expect(
        interestBNBMarket.connect(alice).borrow(bob.address, parseEther('200'))
      )
        .to.emit(dinero, 'Transfer')
        .withArgs(ethers.constants.AddressZero, bob.address, parseEther('200'))
        .to.emit(interestBNBMarket, 'Borrow')
        .to.not.emit(interestBNBMarket, 'Accrue');

      const [totalLoan2, aliceLoan2, aliceDineroBalance2, bobDineroBalance] =
        await Promise.all([
          interestBNBMarket.totalLoan(),
          interestBNBMarket.userLoan(alice.address),
          dinero.balanceOf(alice.address),
          dinero.balanceOf(bob.address),
        ]);

      expect(totalLoan2.base).to.be.equal(parseEther('200'));
      expect(totalLoan2.elastic).to.be.equal(parseEther('200'));
      expect(aliceLoan2).to.be.equal(parseEther('200'));
      expect(aliceDineroBalance2).to.be.equal(aliceDineroBalance);
      expect(bobDineroBalance).to.be.equal(parseEther('200'));

      await advanceTime(10_000, ethers); // advance 10_000 seconds

      await expect(
        interestBNBMarket
          .connect(alice)
          .borrow(alice.address, parseEther('199'))
      )
        .to.emit(interestBNBMarket, 'Accrue')
        .to.emit(dinero, 'Transfer')
        .withArgs(
          ethers.constants.AddressZero,
          alice.address,
          parseEther('199')
        )
        .to.emit(interestBNBMarket, 'Borrow');

      const [
        totalLoan3,
        aliceLoan3,
        bobLoan,
        aliceDineroBalance3,
        bobDineroBalance2,
      ] = await Promise.all([
        interestBNBMarket.totalLoan(),
        interestBNBMarket.userLoan(alice.address),
        interestBNBMarket.userLoan(bob.address),
        dinero.balanceOf(alice.address),
        dinero.balanceOf(bob.address),
      ]);
      expect(
        totalLoan3.base.gt(totalLoan2.base.add(parseEther('190')))
      ).to.be.equal(true); // Interest rate makes it hard to calculate the exact value
      expect(
        totalLoan3.elastic.gte(totalLoan2.elastic.add(parseEther('199')))
      ).to.be.equal(true);
      expect(aliceLoan3.gt(aliceLoan2.add(parseEther('190')))).to.be.equal(
        true
      ); // Interest rate makes it hard to calculate the exact value
      expect(aliceDineroBalance3).to.be.equal(
        aliceDineroBalance2.add(parseEther('199'))
      );
      expect(bobDineroBalance2).to.be.equal(parseEther('200'));
      expect(bobLoan).to.be.equal(0);
    });
  });
  describe('function: repay', () => {
    it('reverts if you pass zero address or 0 principal', async () => {
      await expect(
        interestBNBMarket.repay(ethers.constants.AddressZero, 1)
      ).to.revertedWith('MKT: no zero address');
      await expect(interestBNBMarket.repay(alice.address, 0)).to.revertedWith(
        'MKT: principal cannot be 0'
      );
    });
    it('allows a user to repay a debt', async () => {
      await interestBNBMarket
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

      await interestBNBMarket
        .connect(alice)
        .borrow(alice.address, parseEther('300'));

      const [ownerDineroBalance, aliceLoan, totalLoan] = await Promise.all([
        dinero.balanceOf(owner.address),
        interestBNBMarket.userLoan(alice.address),
        interestBNBMarket.totalLoan(),
        advanceTime(1000, ethers),
      ]);

      await expect(
        interestBNBMarket.connect(owner).repay(alice.address, parseEther('150'))
      )
        .to.emit(interestBNBMarket, 'Accrue')
        .to.emit(dinero, 'Transfer')
        .to.emit(interestBNBMarket, 'Repay');

      const [ownerDineroBalance2, aliceLoan2, totalLoan2] = await Promise.all([
        dinero.balanceOf(owner.address),
        interestBNBMarket.userLoan(alice.address),
        interestBNBMarket.totalLoan(),
      ]);

      expect(
        ownerDineroBalance2.lte(ownerDineroBalance.sub(parseEther('150')))
      ).to.be.equal(true);
      expect(aliceLoan).to.be.equal(parseEther('300'));
      expect(aliceLoan2).to.be.equal(parseEther('150'));
      expect(totalLoan.elastic).to.be.equal(parseEther('300'));
      expect(totalLoan.base).to.be.equal(parseEther('300'));
      expect(totalLoan2.base).to.be.equal(parseEther('150'));
      expect(
        totalLoan2.elastic.gt(totalLoan.elastic.sub(parseEther('150')))
      ).to.be.equal(true);
    });
  });
  describe('function: setMaxLTVRatio', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        interestBNBMarket.connect(alice).setMaxLTVRatio(0)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if we set a collateral higher than 9e5', async () => {
      await expect(
        interestBNBMarket
          .connect(owner)
          .setMaxLTVRatio(ethers.BigNumber.from('900000000000000001'))
      ).to.revertedWith('MKT: too high');
    });
    it('updates the max tvl ratio', async () => {
      expect(await interestBNBMarket.maxLTVRatio()).to.be.equal(
        ethers.BigNumber.from('500000000000000000')
      );

      await interestBNBMarket
        .connect(owner)
        .setMaxLTVRatio(ethers.BigNumber.from('900000000000000000'));

      expect(await interestBNBMarket.maxLTVRatio()).to.be.equal(
        ethers.BigNumber.from('900000000000000000')
      );
    });
  });
  describe('function: setLiquidationFee', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        interestBNBMarket.connect(alice).setLiquidationFee(0)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if we set a liquidation fee higher than 15e4', async () => {
      await expect(
        interestBNBMarket
          .connect(owner)
          .setLiquidationFee(ethers.BigNumber.from('150000000000000001'))
      ).to.revertedWith('MKT: too high');
    });
    it('updates the liquidation fee', async () => {
      expect(await interestBNBMarket.liquidationFee()).to.be.equal(
        ethers.BigNumber.from('100000000000000000')
      );

      await interestBNBMarket
        .connect(owner)
        .setLiquidationFee(ethers.BigNumber.from('150000000000000000'));

      expect(await interestBNBMarket.liquidationFee()).to.be.equal(
        ethers.BigNumber.from('150000000000000000')
      );
    });
  });
  describe('function: setInterestRate', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(
        interestBNBMarket.connect(alice).setInterestRate(0)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if we set a liquidation fee higher than 15e4', async () => {
      await expect(
        interestBNBMarket
          .connect(owner)
          .setInterestRate(ethers.BigNumber.from(13e8).add(1))
      ).to.revertedWith('MKT: too high');
    });
    it('updates the liquidation fee', async () => {
      expect((await interestBNBMarket.loan()).INTEREST_RATE).to.be.equal(
        ethers.BigNumber.from(12e8)
      );

      await interestBNBMarket
        .connect(owner)
        .setInterestRate(ethers.BigNumber.from(13e8));

      expect((await interestBNBMarket.loan()).INTEREST_RATE).to.be.equal(
        ethers.BigNumber.from(13e8)
      );
    });
  });
  describe('function: liquidate', () => {
    it('reverts if you try to reenter', async () => {
      await Promise.all([
        interestBNBMarket
          .connect(alice)
          .addCollateral(alice.address, { value: parseEther('2') }),
        interestBNBMarket
          .connect(bob)
          .addCollateral(bob.address, { value: parseEther('1') }),
        interestBNBMarket
          .connect(jose)
          .addCollateral(jose.address, { value: parseEther('10') }),
      ]);

      await Promise.all([
        interestBNBMarket
          .connect(alice)
          .borrow(alice.address, parseEther('499')),
        interestBNBMarket.connect(bob).borrow(bob.address, parseEther('200')),
        interestBNBMarket
          .connect(jose)
          .borrow(jose.address, parseEther('1000')),
      ]);

      const attackContract: ReentrantInterestBNBMarketLiquidate = await deploy(
        'ReentrantInterestBNBMarketLiquidate',
        [interestBNBMarket.address]
      );

      // Drop BNB to 250. Alice and Bob can now be liquidated
      await Promise.all([
        dinero
          .connect(owner)
          .mint(attackContract.address, parseEther('7000000')),
        mockBnbUsdDFeed.setAnswer(ethers.BigNumber.from('25000000000')),
      ]);

      // Pass time to accrue fees
      await advanceTime(63_113_904, ethers); // advance 2 years

      await expect(
        attackContract
          .connect(owner)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [parseEther('400'), parseEther('200'), parseEther('1000')],
            attackContract.address,
            []
          )
      ).to.revertedWith('ReentrancyGuard: reentrant call');
    });
    it('reverts if last item on path is not dinero', async () => {
      await expect(
        interestBNBMarket
          .connect(owner)
          .liquidate([], [], owner.address, [
            bob.address,
            dinero.address,
            weth.address,
          ])
      ).to.revertedWith('MKT: no dinero at last index');
    });
    it('reverts if there are no liquidations', async () => {
      await interestBNBMarket
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

      await interestBNBMarket
        .connect(alice)
        .borrow(alice.address, parseEther('499'));

      await expect(
        interestBNBMarket
          .connect(owner)
          .liquidate([alice.address], [parseEther('499')], owner.address, [])
      ).to.revertedWith('MKT: no liquidations');
    });
    it('liquidates users using caller dinero funds', async () => {
      await Promise.all([
        interestBNBMarket
          .connect(alice)
          .addCollateral(alice.address, { value: parseEther('2') }),
        interestBNBMarket
          .connect(bob)
          .addCollateral(bob.address, { value: parseEther('1') }),
        interestBNBMarket
          .connect(jose)
          .addCollateral(jose.address, { value: parseEther('10') }),
      ]);

      await Promise.all([
        interestBNBMarket
          .connect(alice)
          .borrow(alice.address, parseEther('499')),
        interestBNBMarket.connect(bob).borrow(bob.address, parseEther('200')),
        interestBNBMarket
          .connect(jose)
          .borrow(jose.address, parseEther('1000')),
      ]);

      // Drop BNB to 250. Alice and Bob can now be liquidated
      await mockBnbUsdDFeed.setAnswer(ethers.BigNumber.from('25000000000'));

      const [
        totalCollateral,
        aliceLoan,
        bobLoan,
        joseLoan,
        aliceCollateral,
        bobCollateral,
        joseCollateral,
        loan,
        ownerDineroBalance,
        pair,
        recipientBalance,
      ] = await Promise.all([
        ethers.provider.getBalance(interestBNBMarket.address),
        interestBNBMarket.userLoan(alice.address),
        interestBNBMarket.userLoan(bob.address),
        interestBNBMarket.userLoan(jose.address),
        interestBNBMarket.userCollateral(alice.address),
        interestBNBMarket.userCollateral(bob.address),
        interestBNBMarket.userCollateral(jose.address),
        interestBNBMarket.loan(),
        dinero.balanceOf(owner.address),
        factory.allPairs(0),
        recipient.getBalance(),
      ]);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      expect(totalCollateral).to.be.equal(parseEther('13'));
      expect(aliceLoan).to.be.equal(parseEther('499'));
      // Due to fees paid by alice their principal is lower than 99
      expect(bobLoan.lte(parseEther('200'))).to.be.equal(true);
      expect(joseLoan.lte(parseEther('1000'))).to.be.equal(true);

      // Pass time to accrue fees
      await advanceTime(63_113_904, ethers); // advance 2 years

      await expect(
        interestBNBMarket
          .connect(owner)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [parseEther('400'), parseEther('200'), parseEther('1000')],
            recipient.address,
            []
          )
      )
        .to.emit(interestBNBMarket, 'ExchangeRate')
        .to.emit(interestBNBMarket, 'Accrue')
        .to.emit(interestBNBMarket, 'WithdrawCollateral')
        .to.emit(interestBNBMarket, 'Repay')
        .to.emit(dinero, 'Transfer')
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
        recipientBalance2,
      ] = await Promise.all([
        interestBNBMarket.totalLoan(),
        ethers.provider.getBalance(interestBNBMarket.address),
        interestBNBMarket.userLoan(alice.address),
        interestBNBMarket.userLoan(bob.address),
        interestBNBMarket.userLoan(jose.address),
        interestBNBMarket.userCollateral(alice.address),
        interestBNBMarket.userCollateral(bob.address),
        interestBNBMarket.userCollateral(jose.address),
        interestBNBMarket.loan(),
        dinero.balanceOf(owner.address),
        recipient.getBalance(),
      ]);

      const allCollateral = aliceCollateral
        .sub(aliceCollateral2)
        .add(bobCollateral.sub(bobCollateral2));

      // We calculate the debt by re-engineering the formula
      const aliceDebt = aliceCollateral
        .sub(aliceCollateral2)
        .mul(ethers.BigNumber.from(250).mul(parseEther('1')))
        .mul(ethers.BigNumber.from(1e6))
        .div(
          ethers.BigNumber.from(1e6)
            .add(ethers.BigNumber.from(10e4))
            .mul(parseEther('1'))
        );

      // We calculate the debt by re-engineering the formula
      const bobDebt = bobCollateral
        .sub(bobCollateral2)
        .mul(ethers.BigNumber.from(250).mul(parseEther('1')))
        .mul(ethers.BigNumber.from(1e6))
        .div(
          ethers.BigNumber.from(1e6)
            .add(ethers.BigNumber.from(10e4))
            .mul(parseEther('1'))
        );

      const allDebt = aliceDebt.add(bobDebt);

      const allFee = allDebt.mul(ethers.BigNumber.from(10e4)).div(1e6);

      const protocolFee = allFee
        .mul(ethers.BigNumber.from(100))
        .div(ethers.BigNumber.from(1000));

      expect(aliceLoan2).to.be.equal(aliceLoan.sub(parseEther('400')));
      expect(bobLoan2).to.be.equal(0);
      expect(joseLoan2).to.be.equal(joseLoan);
      expect(joseCollateral).to.be.equal(joseCollateral2);

      expect(totalCollateral.sub(totalCollateral2)).to.be.eq(allCollateral);

      expect(recipientBalance2.sub(recipientBalance)).to.be.equal(
        allCollateral
      );

      // Means loan2 feesEarned includes accrued + protocol fee
      expect(loan2.feesEarned.sub(protocolFee).gt(loan.feesEarned)).to.be.equal(
        true
      );

      // total loan principal was properly updated
      expect(totalLoan.base).to.be.equal(joseLoan.add(aliceLoan2));
      // We repaid debt for 600 DNR + interest rate. So the remaining debt should be for 1099 DNR + fees
      // While it is hard to get the exact number we know it has to be smaller 1320 DNR after 2 years at interest rate of 4%
      expect(totalLoan.elastic.lt(parseEther('1320'))).to.be.equal(true);

      // Need to remove the 4 last decimal houses for accuracy
      expect(ownerDineroBalance.sub(ownerDineroBalance2).div(1e4)).to.be.equal(
        allDebt.add(protocolFee).div(1e4)
      );
    });
    it('liquidates a user using the collateral in the contract', async () => {
      await Promise.all([
        interestBNBMarket
          .connect(alice)
          .addCollateral(alice.address, { value: parseEther('2') }),
        interestBNBMarket
          .connect(bob)
          .addCollateral(bob.address, { value: parseEther('1') }),
        interestBNBMarket
          .connect(jose)
          .addCollateral(jose.address, { value: parseEther('10') }),
      ]);

      await Promise.all([
        interestBNBMarket
          .connect(alice)
          .borrow(alice.address, parseEther('499')),
        interestBNBMarket.connect(bob).borrow(bob.address, parseEther('200')),
        interestBNBMarket
          .connect(jose)
          .borrow(jose.address, parseEther('1000')),
      ]);

      // Drop BNB to 250. Alice and Bob can now be liquidated
      await mockBnbUsdDFeed.setAnswer(ethers.BigNumber.from('25000000000'));

      const [
        totalCollateral,
        aliceLoan,
        bobLoan,
        joseLoan,
        aliceCollateral,
        bobCollateral,
        joseCollateral,
        loan,
        ownerDineroBalance,
        pair,
        recipientDineroBalance,
      ] = await Promise.all([
        ethers.provider.getBalance(interestBNBMarket.address),
        interestBNBMarket.userLoan(alice.address),
        interestBNBMarket.userLoan(bob.address),
        interestBNBMarket.userLoan(jose.address),
        interestBNBMarket.userCollateral(alice.address),
        interestBNBMarket.userCollateral(bob.address),
        interestBNBMarket.userCollateral(jose.address),
        interestBNBMarket.loan(),
        dinero.balanceOf(owner.address),
        factory.allPairs(0),
        dinero.balanceOf(recipient.address),
      ]);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      expect(totalCollateral).to.be.equal(parseEther('13'));
      expect(aliceLoan).to.be.equal(parseEther('499'));
      // Due to fees paid by alice their principal is lower than 99
      expect(bobLoan.lte(parseEther('200'))).to.be.equal(true);
      expect(joseLoan.lte(parseEther('1000'))).to.be.equal(true);

      // Pass time to accrue fees
      await advanceTime(63_113_904, ethers); // advance 2 years

      await expect(
        interestBNBMarket
          .connect(owner)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [parseEther('400'), parseEther('200'), parseEther('1000')],
            recipient.address,
            [weth.address, dinero.address]
          )
      )
        .to.emit(interestBNBMarket, 'ExchangeRate')
        .to.emit(interestBNBMarket, 'Accrue')
        .to.emit(interestBNBMarket, 'WithdrawCollateral')
        .to.emit(interestBNBMarket, 'Repay')
        .to.emit(dinero, 'Transfer')
        .to.emit(pairContract, 'Swap');

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
        recipientDineroBalance2,
      ] = await Promise.all([
        interestBNBMarket.totalLoan(),
        ethers.provider.getBalance(interestBNBMarket.address),
        interestBNBMarket.userLoan(alice.address),
        interestBNBMarket.userLoan(bob.address),
        interestBNBMarket.userLoan(jose.address),
        interestBNBMarket.userCollateral(alice.address),
        interestBNBMarket.userCollateral(bob.address),
        interestBNBMarket.userCollateral(jose.address),
        interestBNBMarket.loan(),
        dinero.balanceOf(owner.address),
        dinero.balanceOf(recipient.address),
      ]);

      const allCollateral = aliceCollateral
        .sub(aliceCollateral2)
        .add(bobCollateral.sub(bobCollateral2));

      // We calculate the debt by re-engineering the formula
      const aliceDebt = aliceCollateral
        .sub(aliceCollateral2)
        .mul(ethers.BigNumber.from(250).mul(parseEther('1')))
        .mul(ethers.BigNumber.from(1e6))
        .div(
          ethers.BigNumber.from(1e6)
            .add(ethers.BigNumber.from(10e4))
            .mul(parseEther('1'))
        );

      // We calculate the debt by re-engineering the formula
      const bobDebt = bobCollateral
        .sub(bobCollateral2)
        .mul(ethers.BigNumber.from(250).mul(parseEther('1')))
        .mul(ethers.BigNumber.from(1e6))
        .div(
          ethers.BigNumber.from(1e6)
            .add(ethers.BigNumber.from(10e4))
            .mul(parseEther('1'))
        );

      const allDebt = aliceDebt.add(bobDebt);

      const allFee = allDebt.mul(ethers.BigNumber.from(10e4)).div(1e6);

      const protocolFee = allFee
        .mul(ethers.BigNumber.from(100))
        .div(ethers.BigNumber.from(1000));

      expect(aliceLoan2).to.be.equal(aliceLoan.sub(parseEther('400')));
      expect(bobLoan2).to.be.equal(0);
      expect(joseLoan2).to.be.equal(joseLoan);
      expect(joseCollateral).to.be.equal(joseCollateral2);

      expect(totalCollateral.sub(totalCollateral2)).to.be.eq(allCollateral);

      expect(recipientDineroBalance).to.be.equal(0);

      // Recipient gets paid for the liquidator work
      // @notice PCS still has prices BNB at 500 USD. So the recipient gets a lot of Dinero
      expect(recipientDineroBalance2.gt(0)).to.be.equal(true);

      // Caller dinero is not used but the collateral
      expect(ownerDineroBalance).to.be.equal(ownerDineroBalance2);

      // Means loan2 feesEarned includes accrued + protocol fee
      expect(loan2.feesEarned.sub(protocolFee).gt(loan.feesEarned)).to.be.equal(
        true
      );

      // total loan principal was properly updated
      expect(totalLoan.base).to.be.equal(joseLoan.add(aliceLoan2));
      // We repaid debt for 600 DNR + interest rate. So the remaining debt should be for 1099 DNR + fees
      // While it is hard to get the exact number we know it has to be smaller 1320 DNR after 2 years at interest rate of 4%
      expect(totalLoan.elastic.lt(parseEther('1320'))).to.be.equal(true);
    });
  });

  describe('Upgrade functionality', () => {
    it('reverts if a non owner calls it', async () => {
      await interestBNBMarket.connect(owner).transferOwnership(alice.address);

      await expect(
        upgrade(interestBNBMarket, 'TestInterestBNBMarketV2')
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('upgrades to version 2', async () => {
      await interestBNBMarket
        .connect(alice)
        .addCollateral(alice.address, { value: parseEther('2') });

      const [bobBalance, aliceCollateral] = await Promise.all([
        bob.getBalance(),
        interestBNBMarket.userCollateral(alice.address),
        interestBNBMarket
          .connect(alice)
          .borrow(alice.address, parseEther('100')),
      ]);

      await mockBnbUsdDFeed.setAnswer(ethers.BigNumber.from('51000000000'));

      const interestBNBMarketV2: TestInterestBNBMarketV2 = await upgrade(
        interestBNBMarket,
        'TestInterestBNBMarketV2'
      );

      await expect(
        interestBNBMarketV2
          .connect(alice)
          .withdrawCollateral(bob.address, parseEther('1.5'))
      )
        .to.emit(interestBNBMarketV2, 'Accrue')
        .to.emit(interestBNBMarketV2, 'ExchangeRate')
        .to.emit(interestBNBMarketV2, 'WithdrawCollateral')
        .withArgs(alice.address, bob.address, parseEther('1.5'));

      const [version, bobBalance2] = await Promise.all([
        interestBNBMarketV2.version(),
        bob.getBalance(),
      ]);

      expect(version).to.be.equal('V2');

      expect(bobBalance2).to.be.equal(bobBalance.add(parseEther('1.5')));
      expect(aliceCollateral.sub(parseEther('1.5'))).to.be.equal(
        await interestBNBMarketV2.userCollateral(alice.address)
      );
    });
  });
}).timeout(5000);
