import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers, network } from 'hardhat';

import {
  Dinero,
  ErrorInterestBearingSendBNBRequireMessage,
  ErrorInterestBearingSendBNBRequireNoMessage,
  InterestBNBBearingMarket,
  MockTWAP,
  MockVBNB,
  MockVenusController,
  OracleV1,
  TestInterestBNBBearingMarketV2,
} from '../typechain';
import {
  BNB_USD_PRICE_FEED,
  BURNER_ROLE,
  BUSD,
  MINTER_ROLE,
  WBNB,
  WBNB_WHALE,
} from './lib/constants';
import {
  advanceBlock,
  advanceBlockAndTime,
  advanceTime,
  deploy,
  deployUUPS,
  impersonate,
  multiDeploy,
  upgrade,
} from './lib/test-utils';

const { parseEther } = ethers.utils;

describe('Interest BNB Bearing Market', () => {
  let market: InterestBNBBearingMarket;
  let dinero: Dinero;
  let oracle: OracleV1;
  let mockTWAP: MockTWAP;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let treasury: SignerWithAddress;

  beforeEach(async () => {
    [owner, alice, treasury] = await ethers.getSigners();

    [dinero, mockTWAP] = await Promise.all([
      deployUUPS('Dinero', []),
      deploy('MockTWAP', []),
      impersonate(WBNB_WHALE),
    ]);

    oracle = await deployUUPS('OracleV1', [
      mockTWAP.address,
      BNB_USD_PRICE_FEED,
      WBNB,
      BUSD,
    ]);

    market = await deployUUPS('InterestBNBBearingMarket', [
      dinero.address,
      treasury.address,
      oracle.address,
      ethers.BigNumber.from(12e8),
      ethers.BigNumber.from('500000000000000000'),
      ethers.BigNumber.from('100000000000000000'),
    ]);

    const[wbnbWhaleSigner] =await Promise.all([
      ethers.getSigner(WBNB_WHALE)
      dinero.connect(owner).grantRole(MINTER_ROLE, owner.address),
      dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
    ]);

    await Promise.all([
      dinero.connect(owner).mint(owner.address, parseEther('2000000')),
      dinero.connect(owner).mint(alice.address, parseEther('500000')),
      dinero.connect(owner).mint(WBNB_WHALE, parseEther('10000000'))
      dinero.approve(liquidityRouter.address, ethers.constants.MaxUint256),
      // BNB/DINERO Liquidity
      liquidityRouter
        .connect(owner)
        .addLiquidity(
          WETH.address,
          dinero.address,
          parseEther('2000'),
          parseEther('1000000'),
          parseEther('2000'),
          parseEther('1000000'),
          owner.address,
          ethers.constants.MaxUint256
        ),
      market.updateExchangeRate(),
    ]);
  });

  describe('function: initialize', () => {
    it('reverts if you call after deployment', async () => {
      await expect(
        market
          .connect(alice)
          .initialize(
            ethRouter.address,
            dinero.address,
            treasury.address,
            oracle.address,
            venusController.address,
            XVS.address,
            vBNB.address,
            ethers.BigNumber.from(12e8),
            ethers.BigNumber.from('500000000000000000'),
            LIQUIDATION_FEE
          )
      ).to.revertedWith('Initializable: contract is already initialized');
    });
    it('reverts if you set a max tvl ratio out of bounds', async () => {
      await expect(
        deployUUPS('InterestBNBBearingMarket', [
          ethRouter.address,
          dinero.address,
          treasury.address,
          oracle.address,
          venusController.address,
          XVS.address,
          vBNB.address,
          ethers.BigNumber.from(12e8),
          ethers.BigNumber.from('900000000000000001'),
          ethers.BigNumber.from('100000000000000000'),
        ])
      ).to.revertedWith('DM: ltc ratio out of bounds');
      await expect(
        deployUUPS('InterestBNBBearingMarket', [
          ethRouter.address,
          dinero.address,
          treasury.address,
          oracle.address,
          venusController.address,
          XVS.address,
          vBNB.address,
          ethers.BigNumber.from(12e8),
          ethers.BigNumber.from('490000000000000000'),
          ethers.BigNumber.from('100000000000000000'),
        ])
      ).to.revertedWith('DM: ltc ratio out of bounds');
    });
    it('sets the initial state', async () => {
      const [
        _router,
        _dinero,
        _feeTo,
        _oracle,
        _venusController,
        _xvs,
        _vToken,
        _loan,
        _maxLTVRatio,
        _liquidationFee,
        _owner,
      ] = await Promise.all([
        market.ROUTER(),
        market.DINERO(),
        market.FEE_TO(),
        market.ORACLE(),
        market.VENUS_CONTROLLER(),
        market.XVS(),
        market.VTOKEN(),
        market.loan(),
        market.maxLTVRatio(),
        market.liquidationFee(),
        market.owner(),
      ]);

      expect(_router).to.be.equal(ethRouter.address);
      expect(_dinero).to.be.equal(dinero.address);
      expect(_feeTo).to.be.equal(treasury.address);
      expect(_oracle).to.be.equal(oracle.address);
      expect(_venusController).to.be.equal(venusController.address);
      expect(_xvs).to.be.equal(XVS.address);
      expect(_loan.INTEREST_RATE).to.be.equal(ethers.BigNumber.from(12e8));
      expect(_maxLTVRatio).to.be.equal(
        ethers.BigNumber.from('500000000000000000')
      );
      expect(_liquidationFee).to.be.equal(
        ethers.BigNumber.from('100000000000000000')
      );
      expect(_owner).to.be.equal(owner.address);
      expect(_vToken).to.be.equal(vBNB.address);
    });
  });

  // it('sends the fees earned to the feeTo address', async () => {
  //   await market.connect(alice).addCollateral({ value: parseEther('10') });

  //   await market.connect(alice).borrow(alice.address, parseEther('700'));

  //   // Pass time to accrue fees
  //   await advanceTime(10_000, ethers); // advance 10_000 seconds

  //   const debt = parseEther('700')
  //     .mul(ethers.BigNumber.from(12e8))
  //     .mul(10_000)
  //     .div(parseEther('1'));

  //   expect(await dinero.balanceOf(treasury.address)).to.be.equal(0);

  //   // Accrue has not been called
  //   expect((await market.totalLoan()).elastic).to.be.equal(parseEther('700'));

  //   await expect(market.getEarnings())
  //     .to.emit(market, 'Accrue')
  //     .to.emit(market, 'GetEarnings');

  //   expect((await market.loan()).feesEarned).to.be.equal(0);
  //   expect((await dinero.balanceOf(treasury.address)).gte(debt)).to.be.equal(
  //     true
  //   );
  //   expect((await market.totalLoan()).elastic.gte(parseEther('700').add(debt)));
  // });
  // describe('function: accrue', () => {
  //   it('does not accrue fees if there is no open loans', async () => {
  //     const loan = await market.loan();
  //     expect((await market.totalLoan()).base).to.be.equal(0);
  //     await expect(market.accrue()).to.not.emit(market, 'Accrue');
  //     const loan2 = await market.loan();
  //     // It only updated the timestamp
  //     expect(loan.lastAccrued.lt(loan2.lastAccrued)).to.be.equal(true);
  //     expect(loan2.feesEarned).to.be.equal(0);
  //     expect((await market.totalLoan()).base).to.be.equal(0);
  //   });
  //   it('does not update if no time has passed', async () => {
  //     await network.provider.send('evm_setAutomine', [false]);

  //     // Add 10 BNB as collateral
  //     await market.connect(alice).addCollateral({ value: parseEther('10') });

  //     await advanceBlock(ethers);

  //     // Borrow 2000
  //     await market.connect(alice).borrow(alice.address, parseEther('2000'));

  //     await advanceBlock(ethers);

  //     await advanceBlockAndTime(50_000, ethers);

  //     const receipt = await market.accrue();
  //     const receipt2 = await market.accrue();

  //     await advanceBlock(ethers);

  //     const [awaitedReceipt, awaitedReceipt2] = await Promise.all([
  //       receipt.wait(),
  //       receipt2.wait(),
  //     ]);

  //     expect(
  //       awaitedReceipt.events?.filter((x) => x.event === 'Accrue').length
  //     ).to.be.equal(1);

  //     expect(
  //       awaitedReceipt2.events?.filter((x) => x.event === 'Accrue').length
  //     ).to.be.equal(0);

  //     await network.provider.send('evm_setAutomine', [true]);
  //   });
  //   it('accrues the interest rate', async () => {
  //     // Add 10 BNB as collateral
  //     await market.connect(alice).addCollateral({ value: parseEther('10') });

  //     await market.connect(alice).borrow(alice.address, parseEther('1500'));
  //     const [loan, totalLoan] = await Promise.all([
  //       market.loan(),
  //       market.totalLoan(),
  //     ]);

  //     // Pass time to accrue fees
  //     await advanceTime(10_000, ethers); // advance 10_000 seconds
  //     const debt = parseEther('1500')
  //       .mul(ethers.BigNumber.from(12e8))
  //       .mul(10_000)
  //       .div(parseEther('1'));

  //     await expect(market.accrue()).to.emit(market, 'Accrue');

  //     const [loan2, totalLoan2] = await Promise.all([
  //       market.loan(),
  //       market.totalLoan(),
  //     ]);

  //     expect(loan.feesEarned).to.be.equal(0);
  //     expect(loan2.lastAccrued.gt(0)).to.be.equal(true);
  //     expect(totalLoan2.base).to.be.equal(totalLoan.base);
  //     expect(totalLoan2.elastic.gte(totalLoan.elastic.add(debt))).to.be.equal(
  //       true
  //     );
  //     expect(loan2.lastAccrued.gt(loan.lastAccrued)).to.be.equal(true);
  //   });
  // });

  // describe('function: updateExchangeRate', () => {
  //   it('reverts if the exchange rate is 0', async () => {
  //     await mockBnbUsdDFeed.setAnswer(0);

  //     await expect(market.updateExchangeRate()).to.revertedWith(
  //       'DM: invalid exchange rate'
  //     );
  //   });
  //   it('updates the exchange rate for vBNB', async () => {
  //     const [exchangeRate] = await Promise.all([
  //       market.exchangeRate(),
  //       mockBnbUsdDFeed.setAnswer(ethers.BigNumber.from('60000000000')),
  //     ]);

  //     expect(exchangeRate).to.be.equal(
  //       BNB_USD_PRICE.mul(1e10)
  //         .mul(VTOKEN_BNB_EXCHANGE_RATE)
  //         .div(parseEther('1'))
  //     );

  //     await expect(market.updateExchangeRate())
  //       .to.emit(market, 'ExchangeRate')
  //       .withArgs(
  //         ethers.BigNumber.from('60000000000')
  //           .mul(1e10)
  //           .mul(VTOKEN_BNB_EXCHANGE_RATE)
  //           .div(parseEther('1'))
  //       );

  //     await expect(market.updateExchangeRate()).to.not.emit(
  //       market,
  //       'ExchangeRate'
  //     );
  //   });
  // });

  // describe('function: addCollateral', async () => {
  //   it('reverts if it fails to mint vBNB', async () => {
  //     await vBNB.__setMintReturn(1);
  //     await expect(
  //       market.connect(alice).addCollateral({ value: parseEther('2') })
  //     ).to.revertedWith('DM: failed to mint');
  //   });
  //   it('accepts BNB deposits', async () => {
  //     const [
  //       aliceCollateral,
  //       totalRewardsPerVToken,
  //       totalVCollateral,
  //       aliceRewards,
  //     ] = await Promise.all([
  //       market.userCollateral(alice.address),
  //       market.totalRewardsPerVToken(),
  //       market.totalVCollateral(),
  //       market.rewardsOf(alice.address),
  //     ]);

  //     expect(aliceCollateral).to.be.equal(0);
  //     expect(totalRewardsPerVToken).to.be.equal(0);
  //     expect(totalVCollateral).to.be.equal(0);
  //     expect(aliceRewards).to.be.equal(0);

  //     await expect(
  //       market.connect(alice).addCollateral({ value: parseEther('10') })
  //     )
  //       .to.emit(market, 'AddCollateral')
  //       .withArgs(
  //         alice.address,
  //         parseEther('10').mul(VTOKEN_BNB_EXCHANGE_RATE).div(parseEther('1')),
  //         parseEther('10').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //       )
  //       .to.not.emit(venusController, 'Claim')
  //       .to.not.emit(XVS, 'Transfer');

  //     await expect(
  //       market.connect(bob).addCollateral({ value: parseEther('5') })
  //     )
  //       .to.emit(market, 'AddCollateral')
  //       .withArgs(
  //         alice.address,
  //         parseEther('5').mul(VTOKEN_BNB_EXCHANGE_RATE).div(parseEther('1')),
  //         parseEther('5').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //       )
  //       .to.not.emit(venusController, 'Claim')
  //       .to.not.emit(XVS, 'Transfer');

  //     const [
  //       aliceCollateral2,
  //       totalRewardsPerVToken2,
  //       totalVCollateral2,
  //       aliceRewards2,
  //       bobRewards2,
  //       bobCollateral2,
  //     ] = await Promise.all([
  //       market.userCollateral(alice.address),
  //       market.totalRewardsPerVToken(),
  //       market.totalVCollateral(),
  //       market.rewardsOf(alice.address),
  //       market.rewardsOf(bob.address),
  //       market.userCollateral(bob.address),
  //       venusController.__setClaimVenusValue(parseEther('100')),
  //     ]);

  //     expect(aliceCollateral2).to.be.equal(
  //       parseEther('10').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //     );
  //     expect(bobCollateral2).to.be.equal(
  //       parseEther('5').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //     );
  //     expect(totalRewardsPerVToken2).to.be.equal(0);
  //     expect(totalVCollateral2).to.be.closeTo(
  //       parseEther('15').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       1
  //     );
  //     expect(aliceRewards2).to.be.equal(0);
  //     expect(bobRewards2).to.be.equal(0);

  //     await expect(
  //       market.connect(alice).addCollateral({ value: parseEther('5') })
  //     )
  //       .to.emit(market, 'AddCollateral')
  //       .withArgs(
  //         alice.address,
  //         parseEther('5').mul(VTOKEN_BNB_EXCHANGE_RATE).div(parseEther('1')),
  //         parseEther('5').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //       )
  //       .to.emit(venusController, 'Claim')
  //       .to.emit(XVS, 'Transfer')
  //       .withArgs(
  //         market.address,
  //         alice.address,
  //         parseEther('100')
  //           .mul(oneVToken)
  //           .div(totalVCollateral2)
  //           .mul(aliceCollateral2)
  //           .div(oneVToken)
  //       );

  //     const [
  //       aliceCollateral3,
  //       totalRewardsPerVToken3,
  //       totalVCollateral3,
  //       aliceRewards3,
  //       bobRewards3,
  //       bobCollateral3,
  //     ] = await Promise.all([
  //       market.userCollateral(alice.address),
  //       market.totalRewardsPerVToken(),
  //       market.totalVCollateral(),
  //       market.rewardsOf(alice.address),
  //       market.rewardsOf(bob.address),
  //       market.userCollateral(bob.address),
  //       venusController.__setClaimVenusValue(parseEther('50')),
  //     ]);

  //     expect(aliceCollateral3).to.be.closeTo(
  //       parseEther('15').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       1
  //     );
  //     expect(bobCollateral3).to.be.equal(
  //       parseEther('5').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //     );
  //     expect(totalRewardsPerVToken3).to.be.equal(
  //       parseEther('100').mul(oneVToken).div(totalVCollateral2)
  //     );
  //     expect(totalVCollateral3).to.be.closeTo(
  //       parseEther('20').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       1
  //     );
  //     expect(aliceRewards3).to.be.equal(
  //       aliceCollateral3.mul(totalRewardsPerVToken3).div(oneVToken)
  //     );
  //     expect(bobRewards3).to.be.equal(0);

  //     await expect(
  //       market.connect(alice).addCollateral({ value: parseEther('5') })
  //     )
  //       .to.emit(XVS, 'Transfer')
  //       .withArgs(
  //         market.address,
  //         alice.address,
  //         totalRewardsPerVToken3
  //           .add(parseEther('50').mul(oneVToken).div(totalVCollateral3))
  //           .mul(aliceCollateral3)
  //           .div(oneVToken)
  //           .sub(aliceRewards3)
  //       );

  //     const [totalRewardsPerVToken4, aliceRewards4] = await Promise.all([
  //       market.totalRewardsPerVToken(),
  //       market.rewardsOf(alice.address),
  //     ]);

  //     expect(totalRewardsPerVToken4).to.be.equal(
  //       totalRewardsPerVToken3.add(
  //         parseEther('50').mul(oneVToken).div(totalVCollateral3)
  //       )
  //     );
  //     expect(aliceRewards4).to.be.closeTo(
  //       parseEther('20')
  //         .mul(parseEther('1'))
  //         .div(VTOKEN_BNB_EXCHANGE_RATE)
  //         .mul(totalRewardsPerVToken4)
  //         .div(oneVToken),
  //       parseEther('1')
  //     );
  //   });
  // });

  // it('reverts if anyone but the vToken sends BNB to it', async () => {
  //   await expect(
  //     alice.sendTransaction({
  //       to: market.address,
  //       value: parseEther('3'),
  //     })
  //   ).to.revertedWith('DM: not allowed');
  // });

  // describe('function: withdrawCollateral', () => {
  //   it('reverts if the user is insolvent', async () => {
  //     await market.connect(alice).addCollateral({ value: parseEther('10') });

  //     await market.connect(alice).borrow(jose.address, parseEther('2000'));

  //     await expect(
  //       market
  //         .connect(alice)
  //         .withdrawCollateral(
  //           parseEther('2.1')
  //             .mul(parseEther('1'))
  //             .div(VTOKEN_BNB_EXCHANGE_RATE),
  //           false
  //         )
  //     ).to.revertedWith('MKT: sender is insolvent');
  //   });
  //   it('reverts if vBNB fails to redeem', async () => {
  //     await Promise.all([
  //       vBNB.__setRedeemReturn(1),
  //       market.connect(alice).addCollateral({ value: parseEther('2') }),
  //     ]);

  //     await expect(
  //       market
  //         .connect(alice)
  //         .withdrawCollateral(
  //           parseEther('1').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //           true
  //         )
  //     ).to.revertedWith('DM: failed to redeem');
  //   });
  //   it('allows collateral to be withdrawn in vBNB', async () => {
  //     await market.connect(alice).addCollateral({ value: parseEther('10') });

  //     await market.connect(alice).borrow(alice.address, parseEther('100'));

  //     // Make sure accrue gets called
  //     await advanceTime(100, ethers); // advance 100 seconds

  //     await expect(
  //       market
  //         .connect(alice)
  //         .withdrawCollateral(
  //           parseEther('2').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //           false
  //         )
  //     )
  //       .to.emit(market, 'Accrue')
  //       .to.emit(vBNB, 'Transfer')
  //       .withArgs(
  //         market.address,
  //         alice.address,
  //         0,
  //         parseEther('2').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //       )
  //       .to.not.emit(venusController, 'Claim')
  //       .to.not.emit(XVS, 'Transfer')
  //       .to.not.emit(vBNB, 'Redeem');

  //     const [
  //       aliceCollateral,
  //       totalRewardsPerVToken,
  //       totalVCollateral,
  //       aliceRewards,
  //     ] = await Promise.all([
  //       market.userCollateral(alice.address),
  //       market.totalRewardsPerVToken(),
  //       market.totalVCollateral(),
  //       market.rewardsOf(alice.address),
  //     ]);

  //     expect(aliceCollateral).to.be.closeTo(
  //       parseEther('8').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       1
  //     );
  //     expect(totalRewardsPerVToken).to.be.equal(0);
  //     expect(totalVCollateral).to.be.closeTo(
  //       parseEther('8').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       1
  //     );
  //     expect(aliceRewards).to.be.equal(0);

  //     await Promise.all([
  //       market.connect(bob).addCollateral({ value: parseEther('5') }),
  //       venusController.__setClaimVenusValue(parseEther('100')),
  //     ]);

  //     // Make sure accrue gets called
  //     await advanceTime(100, ethers); // advance 100 seconds

  //     await expect(
  //       market
  //         .connect(alice)
  //         .withdrawCollateral(
  //           parseEther('1').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //           false
  //         )
  //     )
  //       .to.emit(market, 'Accrue')
  //       .to.emit(vBNB, 'Transfer')
  //       .withArgs(
  //         market.address,
  //         alice.address,
  //         0,
  //         parseEther('1').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //       )
  //       .to.emit(venusController, 'Claim')
  //       .to.emit(XVS, 'Transfer')
  //       .withArgs(
  //         market.address,
  //         alice.address,
  //         parseEther('100')
  //           .mul(oneVToken)
  //           .div(
  //             parseEther('13')
  //               .mul(parseEther('1'))
  //               .div(VTOKEN_BNB_EXCHANGE_RATE)
  //           )
  //           .mul(aliceCollateral)
  //           .div(oneVToken)
  //       )
  //       .to.not.emit(vBNB, 'Redeem');

  //     const [
  //       aliceCollateral2,
  //       totalRewardsPerVToken2,
  //       totalVCollateral2,
  //       aliceRewards2,
  //     ] = await Promise.all([
  //       market.userCollateral(alice.address),
  //       market.totalRewardsPerVToken(),
  //       market.totalVCollateral(),
  //       market.rewardsOf(alice.address),
  //     ]);

  //     expect(aliceCollateral2).to.be.closeTo(
  //       parseEther('7').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       10
  //     );
  //     expect(totalRewardsPerVToken2).to.be.equal(
  //       parseEther('100')
  //         .mul(oneVToken)
  //         .div(
  //           parseEther('13').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //         )
  //     );
  //     expect(totalVCollateral2).to.be.closeTo(
  //       parseEther('12').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       10
  //     );
  //     expect(aliceRewards2).to.be.equal(
  //       totalRewardsPerVToken2.mul(aliceCollateral2).div(oneVToken)
  //     );
  //   });

  //   it('allows BNB to be withdrawn', async () => {
  //     await market.connect(alice).addCollateral({ value: parseEther('10') });

  //     await market.connect(alice).borrow(alice.address, parseEther('100'));

  //     // Make sure accrue gets called
  //     await advanceTime(100, ethers); // advance 100 seconds

  //     const aliceBalance = await alice.getBalance();

  //     await expect(
  //       market
  //         .connect(alice)
  //         .withdrawCollateral(
  //           parseEther('2').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //           true
  //         )
  //     )
  //       .to.emit(market, 'Accrue')
  //       .to.emit(vBNB, 'Redeem')
  //       .withArgs(parseEther('2'))
  //       .to.emit(market, 'WithdrawCollateral')
  //       .withArgs(
  //         alice.address,
  //         parseEther('2'),
  //         parseEther('2').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //       )
  //       .to.not.emit(XVS, 'Transfer')
  //       .to.not.emit(venusController, 'Claim');

  //     const [
  //       aliceCollateral,
  //       totalRewardsPerVToken,
  //       totalVCollateral,
  //       aliceRewards,
  //       aliceBalance2,
  //       aliceVBNBBalance,
  //     ] = await Promise.all([
  //       market.userCollateral(alice.address),
  //       market.totalRewardsPerVToken(),
  //       market.totalVCollateral(),
  //       market.rewardsOf(alice.address),
  //       alice.getBalance(),
  //       vBNB.balanceOf(alice.address),
  //     ]);

  //     expect(aliceCollateral).to.be.closeTo(
  //       parseEther('8').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       5
  //     );
  //     expect(totalRewardsPerVToken).to.be.equal(0);
  //     expect(totalVCollateral).to.be.equal(aliceCollateral);
  //     expect(aliceRewards).to.be.equal(0);
  //     expect(aliceBalance2).to.be.closeTo(
  //       aliceBalance.add(parseEther('2')),
  //       parseEther('0.1') // TX fees
  //     );
  //     expect(aliceVBNBBalance).to.be.equal(0);

  //     await Promise.all([
  //       market.connect(bob).addCollateral({ value: parseEther('5') }),
  //       venusController.__setClaimVenusValue(parseEther('100')),
  //     ]);

  //     // Make sure accrue gets called
  //     await advanceTime(100, ethers); // advance 100 seconds

  //     await expect(
  //       market
  //         .connect(alice)
  //         .withdrawCollateral(
  //           parseEther('3').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //           true
  //         )
  //     )
  //       .to.emit(market, 'Accrue')
  //       .to.emit(venusController, 'Claim')
  //       .to.emit(vBNB, 'Redeem')
  //       .withArgs(parseEther('3'))
  //       .to.emit(market, 'WithdrawCollateral')
  //       .withArgs(
  //         alice.address,
  //         parseEther('3'),
  //         parseEther('3').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //       )
  //       .to.emit(XVS, 'Transfer')
  //       .withArgs(
  //         market.address,
  //         alice.address,
  //         parseEther('100')
  //           .mul(oneVToken)
  //           .div(
  //             parseEther('13')
  //               .mul(parseEther('1'))
  //               .div(VTOKEN_BNB_EXCHANGE_RATE)
  //           )
  //           .mul(aliceCollateral)
  //           .div(oneVToken)
  //       );

  //     const [
  //       aliceCollateral2,
  //       totalRewardsPerVToken2,
  //       totalVCollateral2,
  //       aliceRewards2,
  //       aliceBalance3,
  //       aliceVBNBBalance2,
  //     ] = await Promise.all([
  //       market.userCollateral(alice.address),
  //       market.totalRewardsPerVToken(),
  //       market.totalVCollateral(),
  //       market.rewardsOf(alice.address),
  //       alice.getBalance(),
  //       vBNB.balanceOf(alice.address),
  //     ]);

  //     expect(aliceCollateral2).to.be.closeTo(
  //       parseEther('5').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       10
  //     );
  //     expect(totalRewardsPerVToken2).to.be.equal(
  //       parseEther('100')
  //         .mul(oneVToken)
  //         .div(
  //           parseEther('13').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //         )
  //     );
  //     expect(totalVCollateral2).to.be.closeTo(
  //       parseEther('10').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       10
  //     );
  //     expect(aliceRewards2).to.be.equal(
  //       totalRewardsPerVToken2.mul(aliceCollateral2).div(oneVToken)
  //     );
  //     expect(aliceBalance3).to.be.closeTo(
  //       aliceBalance2.add(parseEther('3')),
  //       parseEther('0.1') // TX tax
  //     );
  //     expect(aliceVBNBBalance2).to.be.equal(0);

  //     await expect(market.connect(alice).withdrawCollateral(0, true))
  //       .to.emit(XVS, 'Transfer')
  //       .withArgs(
  //         market.address,
  //         alice.address,
  //         totalRewardsPerVToken2
  //           .add(parseEther('100').mul(oneVToken).div(totalVCollateral2))
  //           .mul(aliceCollateral2)
  //           .div(oneVToken)
  //           .sub(aliceRewards2)
  //       );
  //   });
  // });
  // describe('function: borrow', () => {
  //   it('reverts if you borrow to the zero address', async () => {
  //     await expect(
  //       market.connect(alice).borrow(ethers.constants.AddressZero, 1)
  //     ).to.revertedWith('MKT: no zero address');
  //   });
  //   it('reverts if the user is insolvent', async () => {
  //     await market.connect(alice).addCollateral({ value: parseEther('2') });

  //     await expect(
  //       market.connect(alice).borrow(bob.address, parseEther('500'))
  //     ).to.revertedWith('MKT: sender is insolvent');
  //   });
  //   it('allows a user to borrow as long as he remains solvent', async () => {
  //     await market.connect(alice).addCollateral({ value: parseEther('2') });

  //     const [totalLoan, aliceLoan, aliceDineroBalance] = await Promise.all([
  //       market.totalLoan(),
  //       market.userLoan(alice.address),
  //       dinero.balanceOf(alice.address),
  //     ]);

  //     expect(totalLoan.base).to.be.equal(0);
  //     expect(totalLoan.elastic).to.be.equal(0);
  //     expect(aliceLoan).to.be.equal(0);

  //     await expect(market.connect(alice).borrow(bob.address, parseEther('200')))
  //       .to.emit(dinero, 'Transfer')
  //       .withArgs(ethers.constants.AddressZero, bob.address, parseEther('200'))
  //       .to.emit(market, 'Borrow')
  //       .to.not.emit(market, 'Accrue');

  //     const [totalLoan2, aliceLoan2, aliceDineroBalance2, bobDineroBalance] =
  //       await Promise.all([
  //         market.totalLoan(),
  //         market.userLoan(alice.address),
  //         dinero.balanceOf(alice.address),
  //         dinero.balanceOf(bob.address),
  //       ]);

  //     expect(totalLoan2.base).to.be.equal(parseEther('200'));
  //     expect(totalLoan2.elastic).to.be.equal(parseEther('200'));
  //     expect(aliceLoan2).to.be.equal(parseEther('200'));
  //     expect(aliceDineroBalance2).to.be.equal(aliceDineroBalance);
  //     expect(bobDineroBalance).to.be.equal(parseEther('200'));

  //     await advanceTime(10_000, ethers); // advance 10_000 seconds

  //     await expect(
  //       market.connect(alice).borrow(alice.address, parseEther('199'))
  //     )
  //       .to.emit(market, 'Accrue')
  //       .to.emit(dinero, 'Transfer')
  //       .withArgs(
  //         ethers.constants.AddressZero,
  //         alice.address,
  //         parseEther('199')
  //       )
  //       .to.emit(market, 'Borrow');

  //     const [
  //       totalLoan3,
  //       aliceLoan3,
  //       bobLoan,
  //       aliceDineroBalance3,
  //       bobDineroBalance2,
  //     ] = await Promise.all([
  //       market.totalLoan(),
  //       market.userLoan(alice.address),
  //       market.userLoan(bob.address),
  //       dinero.balanceOf(alice.address),
  //       dinero.balanceOf(bob.address),
  //     ]);
  //     expect(
  //       totalLoan3.base.gt(totalLoan2.base.add(parseEther('190')))
  //     ).to.be.equal(true); // Interest rate makes it hard to calculate the exact value
  //     expect(
  //       totalLoan3.elastic.gte(totalLoan2.elastic.add(parseEther('199')))
  //     ).to.be.equal(true);
  //     expect(aliceLoan3.gt(aliceLoan2.add(parseEther('190')))).to.be.equal(
  //       true
  //     ); // Interest rate makes it hard to calculate the exact value
  //     expect(aliceDineroBalance3).to.be.equal(
  //       aliceDineroBalance2.add(parseEther('199'))
  //     );
  //     expect(bobDineroBalance2).to.be.equal(parseEther('200'));
  //     expect(bobLoan).to.be.equal(0);
  //   });
  // });
  // describe('function: repay', () => {
  //   it('reverts if you pass zero address or 0 principal', async () => {
  //     await expect(
  //       market.repay(ethers.constants.AddressZero, 1)
  //     ).to.revertedWith('MKT: no zero address');
  //     await expect(market.repay(alice.address, 0)).to.revertedWith(
  //       'MKT: principal cannot be 0'
  //     );
  //   });
  //   it('allows a user to repay a debt', async () => {
  //     await market.connect(alice).addCollateral({ value: parseEther('2') });

  //     await market.connect(alice).borrow(alice.address, parseEther('300'));

  //     const [ownerDineroBalance, aliceLoan, totalLoan] = await Promise.all([
  //       dinero.balanceOf(owner.address),
  //       market.userLoan(alice.address),
  //       market.totalLoan(),
  //       advanceTime(1000, ethers),
  //     ]);

  //     await expect(
  //       market.connect(owner).repay(alice.address, parseEther('150'))
  //     )
  //       .to.emit(market, 'Accrue')
  //       .to.emit(dinero, 'Transfer')
  //       .to.emit(market, 'Repay');

  //     const [ownerDineroBalance2, aliceLoan2, totalLoan2] = await Promise.all([
  //       dinero.balanceOf(owner.address),
  //       market.userLoan(alice.address),
  //       market.totalLoan(),
  //     ]);

  //     expect(
  //       ownerDineroBalance2.lte(ownerDineroBalance.sub(parseEther('150')))
  //     ).to.be.equal(true);
  //     expect(aliceLoan).to.be.equal(parseEther('300'));
  //     expect(aliceLoan2).to.be.equal(parseEther('150'));
  //     expect(totalLoan.elastic).to.be.equal(parseEther('300'));
  //     expect(totalLoan.base).to.be.equal(parseEther('300'));
  //     expect(totalLoan2.base).to.be.equal(parseEther('150'));
  //     expect(
  //       totalLoan2.elastic.gt(totalLoan.elastic.sub(parseEther('150')))
  //     ).to.be.equal(true);
  //   });
  // });
  // describe('function: setMaxLTVRatio', () => {
  //   it('reverts if it is not called by the owner', async () => {
  //     await expect(market.connect(alice).setMaxLTVRatio(0)).to.revertedWith(
  //       'Ownable: caller is not the owner'
  //     );
  //   });
  //   it('reverts if we set a collateral higher than 9e5', async () => {
  //     await expect(
  //       market
  //         .connect(owner)
  //         .setMaxLTVRatio(ethers.BigNumber.from('900000000000000001'))
  //     ).to.revertedWith('MKT: too high');
  //   });
  //   it('updates the max tvl ratio', async () => {
  //     expect(await market.maxLTVRatio()).to.be.equal(
  //       ethers.BigNumber.from('500000000000000000')
  //     );

  //     await market
  //       .connect(owner)
  //       .setMaxLTVRatio(ethers.BigNumber.from('900000000000000000'));

  //     expect(await market.maxLTVRatio()).to.be.equal(
  //       ethers.BigNumber.from('900000000000000000')
  //     );
  //   });
  // });
  // describe('function: setLiquidationFee', () => {
  //   it('reverts if it is not called by the owner', async () => {
  //     await expect(market.connect(alice).setLiquidationFee(0)).to.revertedWith(
  //       'Ownable: caller is not the owner'
  //     );
  //   });
  //   it('reverts if we set a liquidation fee higher than 15e4', async () => {
  //     await expect(
  //       market
  //         .connect(owner)
  //         .setLiquidationFee(ethers.BigNumber.from('150000000000000001'))
  //     ).to.revertedWith('MKT: too high');
  //   });
  //   it('updates the liquidation fee', async () => {
  //     expect(await market.liquidationFee()).to.be.equal(
  //       ethers.BigNumber.from('100000000000000000')
  //     );

  //     await market
  //       .connect(owner)
  //       .setLiquidationFee(ethers.BigNumber.from('150000000000000000'));

  //     expect(await market.liquidationFee()).to.be.equal(
  //       ethers.BigNumber.from('150000000000000000')
  //     );
  //   });
  // });
  // describe('function: setInterestRate', () => {
  //   it('reverts if it is not called by the owner', async () => {
  //     await expect(market.connect(alice).setInterestRate(0)).to.revertedWith(
  //       'Ownable: caller is not the owner'
  //     );
  //   });
  //   it('reverts if we set a liquidation fee higher than 15e4', async () => {
  //     await expect(
  //       market
  //         .connect(owner)
  //         .setInterestRate(ethers.BigNumber.from(13e8).add(1))
  //     ).to.revertedWith('MKT: too high');
  //   });
  //   it('updates the liquidation fee', async () => {
  //     expect((await market.loan()).INTEREST_RATE).to.be.equal(
  //       ethers.BigNumber.from(12e8)
  //     );

  //     await market.connect(owner).setInterestRate(ethers.BigNumber.from(13e8));

  //     expect((await market.loan()).INTEREST_RATE).to.be.equal(
  //       ethers.BigNumber.from(13e8)
  //     );
  //   });
  // });
  // it('reverts if it sends BNB to a contract without receive', async () => {
  //   const [errorRequireMessage, errorRequireNoMessage]: [
  //     ErrorInterestBearingSendBNBRequireMessage,
  //     ErrorInterestBearingSendBNBRequireNoMessage
  //   ] = await multiDeploy(
  //     [
  //       'ErrorInterestBearingSendBNBRequireMessage',
  //       'ErrorInterestBearingSendBNBRequireNoMessage',
  //     ],
  //     [[], []]
  //   );

  //   await Promise.all([
  //     errorRequireMessage
  //       .connect(alice)
  //       .addCollateral(market.address, { value: parseEther('10') }),
  //     errorRequireNoMessage
  //       .connect(alice)
  //       .addCollateral(market.address, { value: parseEther('10') }),
  //   ]);

  //   await Promise.all([
  //     expect(
  //       errorRequireNoMessage.withdrawCollateral(market.address, 1)
  //     ).to.revertedWith('DM: unable to remove collateral'),
  //     expect(
  //       errorRequireMessage.withdrawCollateral(market.address, 1)
  //     ).to.revertedWith('test error'),
  //   ]);
  // });
  // describe('function: liquidate', () => {
  //   it('reverts if the last element on path is not dinero', async () => {
  //     await expect(
  //       market
  //         .connect(alice)
  //         .liquidate([], [], recipient.address, true, [jose.address])
  //     ).to.revertedWith('DM: no dinero at last index');
  //   });
  //   it('reverts if there is a path and underlying is false', async () => {
  //     await expect(
  //       market
  //         .connect(alice)
  //         .liquidate([], [], recipient.address, false, [dinero.address])
  //     ).to.revertedWith('DM: cannot sell VTokens');
  //   });
  //   it('reverts if there are no positions to liquidate', async () => {
  //     await Promise.all([
  //       market.connect(alice).addCollateral({ value: parseEther('10') }),
  //       market.connect(bob).addCollateral({ value: parseEther('10') }),
  //     ]);

  //     // Collateral should allow them to borrow up to 2500
  //     await Promise.all([
  //       market.connect(alice).borrow(alice.address, parseEther('2450')),
  //       market.connect(bob).borrow(bob.address, parseEther('2450')),
  //     ]);

  //     const principalToLiquidate = parseEther('10')
  //       .mul(parseEther('1'))
  //       .div(VTOKEN_BNB_EXCHANGE_RATE);

  //     await expect(
  //       market
  //         .connect(jose)
  //         .liquidate(
  //           [alice.address, bob.address],
  //           [principalToLiquidate, principalToLiquidate],
  //           recipient.address,
  //           false,
  //           []
  //         )
  //     ).to.revertedWith('DM: no liquidations');
  //   });
  //   it('reverts if you try to sell XVS', async () => {
  //     await expect(
  //       market
  //         .connect(jose)
  //         .liquidate([], [], recipient.address, true, [
  //           XVS.address,
  //           dinero.address,
  //         ])
  //     ).to.revertedWith('DM: not allowed to sell XVS');
  //   });
  //   it('reverts if the principal to liquidate is very low', async () => {
  //     await Promise.all([
  //       market.connect(alice).addCollateral({ value: parseEther('10') }),
  //       market.connect(bob).addCollateral({ value: parseEther('10') }),
  //       market.connect(jose).addCollateral({ value: parseEther('7') }),
  //     ]);

  //     await venusController.__setClaimVenusValue(parseEther('100'));

  //     await Promise.all([
  //       market.connect(alice).borrow(alice.address, parseEther('2450')),
  //       market.connect(bob).borrow(bob.address, parseEther('500')),
  //       market.connect(jose).borrow(jose.address, parseEther('1500')),
  //     ]);

  //     // Drop BNB to 300. Alice and Jose can now be liquidated
  //     await mockBnbUsdDFeed.setAnswer(ethers.BigNumber.from('30000000000'));

  //     // Pass time to accrue fees
  //     await advanceTime(10_000, ethers); // 10_000 seconds

  //     await expect(
  //       market
  //         .connect(recipient)
  //         .liquidate(
  //           [alice.address, bob.address, jose.address],
  //           [
  //             parseEther('2450'),
  //             toVBalance(parseEther('10')),
  //             toVBalance(parseEther('7')),
  //           ],
  //           recipient.address,
  //           true,
  //           [WETH.address, dinero.address]
  //         )
  //     ).to.revertedWith('DM: principal too low');
  //   });
  //   it('allows for full liquidation', async () => {
  //     await market.connect(alice).addCollateral({ value: parseEther('10') });

  //     await market.connect(alice).borrow(alice.address, parseEther('2450'));

  //     // Drop BNB to 300. Alice and Jose can now be liquidated
  //     await mockBnbUsdDFeed.setAnswer(ethers.BigNumber.from('30000000000'));

  //     await market
  //       .connect(owner)
  //       .liquidate(
  //         [alice.address],
  //         [parseEther('2450')],
  //         recipient.address,
  //         false,
  //         []
  //       );

  //     const totalLoan = await market.totalLoan();

  //     expect(totalLoan.base).to.be.equal(0);
  //     expect(totalLoan.elastic).to.be.equal(0);
  //   });
  //   it('liquidates a user by selling redeeming the collateral and burning the acquired dinero', async () => {
  //     await Promise.all([
  //       market.connect(alice).addCollateral({ value: parseEther('10') }),
  //       market.connect(bob).addCollateral({ value: parseEther('10') }),
  //       market.connect(jose).addCollateral({ value: parseEther('7') }),
  //     ]);

  //     await venusController.__setClaimVenusValue(parseEther('100'));

  //     await Promise.all([
  //       market.connect(alice).borrow(alice.address, parseEther('2450')),
  //       market.connect(bob).borrow(bob.address, parseEther('500')),
  //       market.connect(jose).borrow(jose.address, parseEther('1500')),
  //     ]);

  //     // Drop BNB to 300. Alice and Jose can now be liquidated
  //     await mockBnbUsdDFeed.setAnswer(ethers.BigNumber.from('30000000000'));

  //     const [
  //       pair,
  //       recipientDineroBalance,
  //       aliceLoan,
  //       bobLoan,
  //       joseLoan,
  //       aliceCollateral,
  //       bobCollateral,
  //       joseCollateral,
  //       aliceRewards,
  //       bobRewards,
  //       joseRewards,
  //       totalVCollateral,
  //       recipientBNBBalance,
  //       recipientVBNBBalance,
  //       aliceXVSBalance,
  //       bobXVSBalance,
  //       joseXVSBalance,
  //       loan,
  //     ] = await Promise.all([
  //       factory.getPair(dinero.address, WETH.address),
  //       dinero.balanceOf(recipient.address),
  //       market.userLoan(alice.address),
  //       market.userLoan(bob.address),
  //       market.userLoan(jose.address),
  //       market.userCollateral(alice.address),
  //       market.userCollateral(bob.address),
  //       market.userCollateral(jose.address),
  //       market.rewardsOf(alice.address),
  //       market.rewardsOf(bob.address),
  //       market.rewardsOf(jose.address),
  //       market.totalVCollateral(),
  //       recipient.getBalance(),
  //       vBNB.balanceOf(recipient.address),
  //       XVS.balanceOf(alice.address),
  //       XVS.balanceOf(bob.address),
  //       XVS.balanceOf(jose.address),
  //       market.loan(),
  //     ]);

  //     const pairContract = (
  //       await ethers.getContractFactory('PancakePair')
  //     ).attach(pair);

  //     expect(recipientDineroBalance).to.be.equal(0);
  //     expect(aliceLoan).to.be.equal(parseEther('2450'));
  //     // Bob in shares will owe less than 500 due to fees
  //     expect(bobLoan.lte(parseEther('500'))).to.be.equal(true);
  //     expect(joseLoan.lte(parseEther('1500'))).to.be.equal(true);
  //     expect(aliceCollateral).to.be.equal(toVBalance(parseEther('10')));
  //     expect(bobCollateral).to.be.equal(toVBalance(parseEther('10')));
  //     expect(joseCollateral).to.be.equal(toVBalance(parseEther('7')));
  //     expect(totalVCollateral).to.be.equal(
  //       bobCollateral.add(joseCollateral).add(aliceCollateral)
  //     );
  //     expect(aliceXVSBalance).to.be.equal(0);
  //     expect(bobXVSBalance).to.be.equal(0);
  //     expect(joseXVSBalance).to.be.equal(0);

  //     // Pass time to accrue fees
  //     await advanceTime(10_000, ethers); // 10_000 seconds

  //     await expect(
  //       market
  //         .connect(recipient)
  //         .liquidate(
  //           [alice.address, bob.address, jose.address],
  //           [parseEther('2450'), parseEther('500'), parseEther('1200')],
  //           recipient.address,
  //           true,
  //           [WETH.address, dinero.address]
  //         )
  //     )
  //       .to.emit(market, 'Accrue')
  //       .to.emit(venusController, 'Claim')
  //       .to.emit(XVS, 'Transfer')
  //       .withArgs(
  //         market.address,
  //         alice.address,
  //         parseEther('100')
  //           .mul(oneVToken)
  //           .div(totalVCollateral)
  //           .mul(aliceCollateral)
  //           .div(oneVToken)
  //           .sub(aliceRewards)
  //       )
  //       .to.emit(XVS, 'Transfer')
  //       .withArgs(
  //         market.address,
  //         jose.address,
  //         parseEther('100')
  //           .mul(oneVToken)
  //           .div(totalVCollateral)
  //           .mul(joseCollateral)
  //           .div(oneVToken)
  //           .sub(joseRewards)
  //       )
  //       .to.emit(vBNB, 'Redeem')
  //       .withArgs(aliceCollateral)
  //       .to.emit(pairContract, 'Swap');

  //     const [
  //       recipientDineroBalance2,
  //       aliceLoan2,
  //       bobLoan2,
  //       joseLoan2,
  //       aliceCollateral2,
  //       bobCollateral2,
  //       joseCollateral2,
  //       loan2,
  //       aliceRewards2,
  //       bobRewards2,
  //       joseRewards2,
  //       totalVCollateral2,
  //       aliceXVSBalance2,
  //       bobXVSBalance2,
  //       joseXVSBalance2,
  //       totalLoan2,
  //       recipientBNBBalance2,
  //     ] = await Promise.all([
  //       dinero.balanceOf(recipient.address),
  //       market.userLoan(alice.address),
  //       market.userLoan(bob.address),
  //       market.userLoan(jose.address),
  //       market.userCollateral(alice.address),
  //       market.userCollateral(bob.address),
  //       market.userCollateral(jose.address),
  //       market.loan(),
  //       market.rewardsOf(alice.address),
  //       market.rewardsOf(bob.address),
  //       market.rewardsOf(jose.address),
  //       market.totalVCollateral(),
  //       XVS.balanceOf(alice.address),
  //       XVS.balanceOf(bob.address),
  //       XVS.balanceOf(jose.address),
  //       market.totalLoan(),
  //       recipient.getBalance(),
  //     ]);

  //     // Recipient got paid for liquidating
  //     expect(recipientDineroBalance2.gt(0)).to.be.equal(true);
  //     // Alice got fully liquidated
  //     expect(aliceLoan2).to.be.equal(0);
  //     // Bob did not get liquidated
  //     expect(bobLoan2).to.be.equal(bobLoan);
  //     // Jose got partially liquidated
  //     expect(joseLoan2).to.be.equal(joseLoan.sub(parseEther('1200')));

  //     expect(bobCollateral2).to.be.equal(bobCollateral);
  //     // Alice collateral 2 must be lower than collateral 1 minus loan liquidated + 10% due to fees
  //     expect(aliceCollateral2).to.be.closeTo(
  //       aliceCollateral.sub(
  //         convertBorrowToLiquidationCollateral(parseEther('2450'))
  //       ),
  //       ethers.BigNumber.from(10).pow(7) // 0.1 VToken
  //     );
  //     expect(joseCollateral2).to.be.closeTo(
  //       joseCollateral.sub(
  //         convertBorrowToLiquidationCollateral(parseEther('1200'))
  //       ),
  //       ethers.BigNumber.from(10).pow(7) // 0.1 VToken
  //     );

  //     expect(bobRewards2).to.be.equal(bobRewards);
  //     expect(aliceRewards2).to.be.equal(
  //       parseEther('100')
  //         .mul(oneVToken)
  //         .div(totalVCollateral)
  //         .mul(aliceCollateral2)
  //         .div(oneVToken)
  //     );
  //     expect(joseRewards2).to.be.equal(
  //       parseEther('100')
  //         .mul(oneVToken)
  //         .div(totalVCollateral)
  //         .mul(joseCollateral2)
  //         .div(oneVToken)
  //     );
  //     expect(aliceXVSBalance2).to.be.equal(
  //       parseEther('100')
  //         .mul(oneVToken)
  //         .div(totalVCollateral)
  //         .mul(aliceCollateral)
  //         .div(oneVToken)
  //         .sub(aliceRewards)
  //     );
  //     expect(bobXVSBalance2).to.be.equal(0);
  //     expect(joseXVSBalance2).to.be.equal(
  //       parseEther('100')
  //         .mul(oneVToken)
  //         .div(totalVCollateral)
  //         .mul(joseCollateral)
  //         .div(oneVToken)
  //         .sub(joseRewards)
  //     );
  //     expect(totalVCollateral2).to.be.closeTo(
  //       totalVCollateral.sub(
  //         convertBorrowToLiquidationCollateral(parseEther('3650'))
  //       ),
  //       oneVToken
  //     );
  //     expect(totalLoan2.base).to.be.equal(
  //       aliceLoan2.add(joseLoan2).add(bobLoan2)
  //     );
  //     expect(totalLoan2.elastic).to.be.closeTo(
  //       parseEther('800'),
  //       parseEther('2') // 2 DNR to account for fees
  //     );
  //     // Fees earned have to be greater than prev fees plus loan accrued fees.
  //     expect(
  //       loan2.feesEarned.gt(
  //         loan.feesEarned.add(
  //           ethers.BigNumber.from(12e8)
  //             .mul(parseEther('3650'))
  //             .mul(BigNumber.from(10_000))
  //             .div(parseEther('1'))
  //         )
  //       )
  //     );
  //     expect(recipientBNBBalance).closeTo(
  //       recipientBNBBalance2,
  //       parseEther('0.1') // tx fees not from liquidating
  //     );
  //     expect(recipientVBNBBalance).to.be.equal(0);
  //   });
  //   it('liquidates a user by using the caller dinero and getting the underlying as a reward', async () => {
  //     await Promise.all([
  //       market.connect(alice).addCollateral({ value: parseEther('10') }),
  //       market.connect(bob).addCollateral({ value: parseEther('10') }),
  //       market.connect(jose).addCollateral({ value: parseEther('7') }),
  //     ]);

  //     await venusController.__setClaimVenusValue(parseEther('100'));

  //     await Promise.all([
  //       market.connect(alice).borrow(alice.address, parseEther('2450')),
  //       market.connect(bob).borrow(bob.address, parseEther('500')),
  //       market.connect(jose).borrow(jose.address, parseEther('1500')),
  //     ]);

  //     // Drop BNB to 300. Alice and Jose can now be liquidated
  //     await mockBnbUsdDFeed.setAnswer(ethers.BigNumber.from('30000000000'));

  //     const [
  //       pair,
  //       aliceLoan,
  //       bobLoan,
  //       joseLoan,
  //       aliceCollateral,
  //       bobCollateral,
  //       joseCollateral,
  //       aliceRewards,
  //       bobRewards,
  //       joseRewards,
  //       totalVCollateral,
  //       aliceXVSBalance,
  //       bobXVSBalance,
  //       joseXVSBalance,
  //       loan,
  //       ownerDineroBalance,
  //       ownerBNBBalance,
  //       recipientBNBBalance,
  //     ] = await Promise.all([
  //       factory.getPair(dinero.address, WETH.address),
  //       market.userLoan(alice.address),
  //       market.userLoan(bob.address),
  //       market.userLoan(jose.address),
  //       market.userCollateral(alice.address),
  //       market.userCollateral(bob.address),
  //       market.userCollateral(jose.address),
  //       market.rewardsOf(alice.address),
  //       market.rewardsOf(bob.address),
  //       market.rewardsOf(jose.address),
  //       market.totalVCollateral(),
  //       XVS.balanceOf(alice.address),
  //       XVS.balanceOf(bob.address),
  //       XVS.balanceOf(jose.address),
  //       market.loan(),
  //       dinero.balanceOf(owner.address),
  //       owner.getBalance(),
  //       recipient.getBalance(),
  //     ]);

  //     const pairContract = (
  //       await ethers.getContractFactory('PancakePair')
  //     ).attach(pair);

  //     expect(aliceLoan).to.be.equal(parseEther('2450'));
  //     // Bob in shares will owe less than 500 due to fees
  //     expect(bobLoan.lte(parseEther('500'))).to.be.equal(true);
  //     expect(joseLoan.lte(parseEther('1500'))).to.be.equal(true);
  //     expect(aliceCollateral).to.be.equal(toVBalance(parseEther('10')));
  //     expect(bobCollateral).to.be.equal(toVBalance(parseEther('10')));
  //     expect(joseCollateral).to.be.equal(toVBalance(parseEther('7')));
  //     expect(totalVCollateral).to.be.equal(
  //       bobCollateral.add(joseCollateral).add(aliceCollateral)
  //     );
  //     expect(aliceXVSBalance).to.be.equal(0);
  //     expect(bobXVSBalance).to.be.equal(0);
  //     expect(joseXVSBalance).to.be.equal(0);

  //     // Pass time to accrue fees
  //     await advanceTime(10_000, ethers); // 10_000 seconds

  //     await expect(
  //       market
  //         .connect(owner)
  //         .liquidate(
  //           [alice.address, bob.address, jose.address],
  //           [parseEther('2450'), parseEther('500'), parseEther('1200')],
  //           recipient.address,
  //           true,
  //           []
  //         )
  //     )
  //       .to.emit(market, 'Accrue')
  //       .to.emit(venusController, 'Claim')
  //       .to.emit(XVS, 'Transfer')
  //       .withArgs(
  //         market.address,
  //         alice.address,
  //         parseEther('100')
  //           .mul(oneVToken)
  //           .div(totalVCollateral)
  //           .mul(aliceCollateral)
  //           .div(oneVToken)
  //           .sub(aliceRewards)
  //       )
  //       .to.emit(XVS, 'Transfer')
  //       .withArgs(
  //         market.address,
  //         jose.address,
  //         parseEther('100')
  //           .mul(oneVToken)
  //           .div(totalVCollateral)
  //           .mul(joseCollateral)
  //           .div(oneVToken)
  //           .sub(joseRewards)
  //       )
  //       .to.emit(vBNB, 'Redeem')
  //       .withArgs(aliceCollateral)
  //       .to.not.emit(pairContract, 'Swap');

  //     const [
  //       aliceLoan2,
  //       bobLoan2,
  //       joseLoan2,
  //       aliceCollateral2,
  //       bobCollateral2,
  //       joseCollateral2,
  //       loan2,
  //       aliceRewards2,
  //       bobRewards2,
  //       joseRewards2,
  //       totalVCollateral2,
  //       aliceXVSBalance2,
  //       bobXVSBalance2,
  //       joseXVSBalance2,
  //       totalLoan2,
  //       ownerDineroBalance2,
  //       ownerBNBBalance2,
  //       ownerVBNBBalance,
  //       recipientBNBBalance2,
  //       recipientVBNBBalance,
  //     ] = await Promise.all([
  //       market.userLoan(alice.address),
  //       market.userLoan(bob.address),
  //       market.userLoan(jose.address),
  //       market.userCollateral(alice.address),
  //       market.userCollateral(bob.address),
  //       market.userCollateral(jose.address),
  //       market.loan(),
  //       market.rewardsOf(alice.address),
  //       market.rewardsOf(bob.address),
  //       market.rewardsOf(jose.address),
  //       market.totalVCollateral(),
  //       XVS.balanceOf(alice.address),
  //       XVS.balanceOf(bob.address),
  //       XVS.balanceOf(jose.address),
  //       market.totalLoan(),
  //       dinero.balanceOf(owner.address),
  //       owner.getBalance(),
  //       vBNB.balanceOf(owner.address),
  //       recipient.getBalance(),
  //       vBNB.balanceOf(recipient.address),
  //     ]);

  //     expect(ownerDineroBalance2).to.be.closeTo(
  //       ownerDineroBalance.sub(
  //         parseEther('3650')
  //           .add(
  //             ethers.BigNumber.from(12e8)
  //               .mul(parseEther('3650'))
  //               .mul(BigNumber.from(10_000))
  //               .div(parseEther('1'))
  //           )
  //           .add(
  //             parseEther('3650')
  //               .add(
  //                 ethers.BigNumber.from(12e8)
  //                   .mul(parseEther('3650'))
  //                   .mul(BigNumber.from(10_000))
  //                   .div(parseEther('1'))
  //               )
  //               .mul(parseEther('0.01'))
  //               .div(parseEther('1'))
  //           )
  //       ),
  //       parseEther('2')
  //     );

  //     // Alice got fully liquidated
  //     expect(aliceLoan2).to.be.equal(0);
  //     // Bob did not get liquidated
  //     expect(bobLoan2).to.be.equal(bobLoan);
  //     // Jose got partially liquidated
  //     expect(joseLoan2).to.be.equal(joseLoan.sub(parseEther('1200')));

  //     expect(bobCollateral2).to.be.equal(bobCollateral);
  //     // Alice collateral 2 must be lower than collateral 1 minus loan liquidated + 10% due to fees
  //     expect(aliceCollateral2).to.be.closeTo(
  //       aliceCollateral.sub(
  //         convertBorrowToLiquidationCollateral(parseEther('2450'))
  //       ),
  //       ethers.BigNumber.from(10).pow(7) // 0.1 VToken
  //     );
  //     expect(joseCollateral2).to.be.closeTo(
  //       joseCollateral.sub(
  //         convertBorrowToLiquidationCollateral(parseEther('1200'))
  //       ),
  //       ethers.BigNumber.from(10).pow(7) // 0.1 VToken
  //     );

  //     expect(bobRewards2).to.be.equal(bobRewards);
  //     expect(aliceRewards2).to.be.equal(
  //       parseEther('100')
  //         .mul(oneVToken)
  //         .div(totalVCollateral)
  //         .mul(aliceCollateral2)
  //         .div(oneVToken)
  //     );
  //     expect(joseRewards2).to.be.equal(
  //       parseEther('100')
  //         .mul(oneVToken)
  //         .div(totalVCollateral)
  //         .mul(joseCollateral2)
  //         .div(oneVToken)
  //     );
  //     expect(aliceXVSBalance2).to.be.equal(
  //       parseEther('100')
  //         .mul(oneVToken)
  //         .div(totalVCollateral)
  //         .mul(aliceCollateral)
  //         .div(oneVToken)
  //         .sub(aliceRewards)
  //     );
  //     expect(bobXVSBalance2).to.be.equal(0);
  //     expect(joseXVSBalance2).to.be.equal(
  //       parseEther('100')
  //         .mul(oneVToken)
  //         .div(totalVCollateral)
  //         .mul(joseCollateral)
  //         .div(oneVToken)
  //         .sub(joseRewards)
  //     );
  //     expect(totalVCollateral2).to.be.closeTo(
  //       totalVCollateral.sub(
  //         convertBorrowToLiquidationCollateral(parseEther('3650'))
  //       ),
  //       oneVToken
  //     );
  //     expect(totalLoan2.base).to.be.equal(
  //       aliceLoan2.add(joseLoan2).add(bobLoan2)
  //     );
  //     expect(totalLoan2.elastic).to.be.closeTo(
  //       parseEther('800'),
  //       parseEther('2') // 2 DNR to account for fees
  //     );
  //     // Fees earned have to be greater than prev fees plus loan accrued fees.
  //     expect(
  //       loan2.feesEarned.gt(
  //         loan.feesEarned.add(
  //           ethers.BigNumber.from(12e8)
  //             .mul(parseEther('3650'))
  //             .mul(BigNumber.from(10_000))
  //             .div(parseEther('1'))
  //         )
  //       )
  //     );

  //     // liquidator got rewarded in BNB
  //     expect(ownerBNBBalance2).closeTo(
  //       ownerBNBBalance,
  //       parseEther('0.1') // fees
  //     );

  //     // liquidator got rewarded in BNB
  //     expect(recipientBNBBalance2).closeTo(
  //       recipientBNBBalance.add(
  //         // Principal + Interest
  //         parseEther('3650')
  //           .add(
  //             ethers.BigNumber.from(12e8)
  //               .mul(parseEther('3650'))
  //               .mul(BigNumber.from(10_000))
  //               .div(parseEther('1'))
  //           )
  //           // 10% fee
  //           .add(
  //             parseEther('3650')
  //               .add(
  //                 ethers.BigNumber.from(12e8)
  //                   .mul(parseEther('3650'))
  //                   .mul(BigNumber.from(10_000))
  //                   .div(parseEther('1'))
  //               )
  //               .mul(parseEther('0.1'))
  //               .div(parseEther('1'))
  //           )
  //           // Convert to BNB
  //           .mul(parseEther('1'))
  //           .div(parseEther('300'))
  //       ),
  //       parseEther('0.001') // Rounding of debt interest rate
  //     );
  //     expect(recipientVBNBBalance).to.be.equal(0);
  //     expect(ownerVBNBBalance).to.be.equal(0);
  //   });
  //   it('liquidates a user by using the caller dinero and getting VBNB as a reward', async () => {
  //     await Promise.all([
  //       market.connect(alice).addCollateral({ value: parseEther('10') }),
  //       market.connect(bob).addCollateral({ value: parseEther('10') }),
  //       market.connect(jose).addCollateral({ value: parseEther('7') }),
  //     ]);

  //     await venusController.__setClaimVenusValue(parseEther('100'));

  //     await Promise.all([
  //       market.connect(alice).borrow(alice.address, parseEther('2450')),
  //       market.connect(bob).borrow(bob.address, parseEther('500')),
  //       market.connect(jose).borrow(jose.address, parseEther('1500')),
  //     ]);

  //     // Drop BNB to 300. Alice and Jose can now be liquidated
  //     await mockBnbUsdDFeed.setAnswer(ethers.BigNumber.from('30000000000'));

  //     const [
  //       pair,
  //       aliceLoan,
  //       bobLoan,
  //       joseLoan,
  //       aliceCollateral,
  //       bobCollateral,
  //       joseCollateral,
  //       aliceRewards,
  //       bobRewards,
  //       joseRewards,
  //       totalVCollateral,
  //       aliceXVSBalance,
  //       bobXVSBalance,
  //       joseXVSBalance,
  //       loan,
  //       ownerDineroBalance,
  //       ownerBNBBalance,
  //       recipientBNBBalance,
  //     ] = await Promise.all([
  //       factory.getPair(dinero.address, WETH.address),
  //       market.userLoan(alice.address),
  //       market.userLoan(bob.address),
  //       market.userLoan(jose.address),
  //       market.userCollateral(alice.address),
  //       market.userCollateral(bob.address),
  //       market.userCollateral(jose.address),
  //       market.rewardsOf(alice.address),
  //       market.rewardsOf(bob.address),
  //       market.rewardsOf(jose.address),
  //       market.totalVCollateral(),
  //       XVS.balanceOf(alice.address),
  //       XVS.balanceOf(bob.address),
  //       XVS.balanceOf(jose.address),
  //       market.loan(),
  //       dinero.balanceOf(owner.address),
  //       owner.getBalance(),
  //       recipient.getBalance(),
  //     ]);

  //     const pairContract = (
  //       await ethers.getContractFactory('PancakePair')
  //     ).attach(pair);

  //     expect(aliceLoan).to.be.equal(parseEther('2450'));
  //     // Bob in shares will owe less than 500 due to fees
  //     expect(bobLoan.lte(parseEther('500'))).to.be.equal(true);
  //     expect(joseLoan.lte(parseEther('1500'))).to.be.equal(true);
  //     expect(aliceCollateral).to.be.equal(toVBalance(parseEther('10')));
  //     expect(bobCollateral).to.be.equal(toVBalance(parseEther('10')));
  //     expect(joseCollateral).to.be.equal(toVBalance(parseEther('7')));
  //     expect(totalVCollateral).to.be.equal(
  //       bobCollateral.add(joseCollateral).add(aliceCollateral)
  //     );
  //     expect(aliceXVSBalance).to.be.equal(0);
  //     expect(bobXVSBalance).to.be.equal(0);
  //     expect(joseXVSBalance).to.be.equal(0);

  //     // Pass time to accrue fees
  //     await advanceTime(10_000, ethers); // 10_000 seconds

  //     await expect(
  //       market
  //         .connect(owner)
  //         .liquidate(
  //           [alice.address, bob.address, jose.address],
  //           [parseEther('2450'), parseEther('500'), parseEther('1200')],
  //           recipient.address,
  //           false,
  //           []
  //         )
  //     )
  //       .to.emit(market, 'Accrue')
  //       .to.emit(venusController, 'Claim')
  //       .to.emit(XVS, 'Transfer')
  //       .withArgs(
  //         market.address,
  //         alice.address,
  //         parseEther('100')
  //           .mul(oneVToken)
  //           .div(totalVCollateral)
  //           .mul(aliceCollateral)
  //           .div(oneVToken)
  //           .sub(aliceRewards)
  //       )
  //       .to.emit(XVS, 'Transfer')
  //       .withArgs(
  //         market.address,
  //         jose.address,
  //         parseEther('100')
  //           .mul(oneVToken)
  //           .div(totalVCollateral)
  //           .mul(joseCollateral)
  //           .div(oneVToken)
  //           .sub(joseRewards)
  //       )
  //       .to.not.emit(pairContract, 'Swap')
  //       .to.not.emit(vBNB, 'Redeem');

  //     const [
  //       aliceLoan2,
  //       bobLoan2,
  //       joseLoan2,
  //       aliceCollateral2,
  //       bobCollateral2,
  //       joseCollateral2,
  //       loan2,
  //       aliceRewards2,
  //       bobRewards2,
  //       joseRewards2,
  //       totalVCollateral2,
  //       aliceXVSBalance2,
  //       bobXVSBalance2,
  //       joseXVSBalance2,
  //       totalLoan2,
  //       ownerDineroBalance2,
  //       ownerBNBBalance2,
  //       ownerVBNBBalance,
  //       recipientBNBBalance2,
  //       recipientVBNBBalance,
  //     ] = await Promise.all([
  //       market.userLoan(alice.address),
  //       market.userLoan(bob.address),
  //       market.userLoan(jose.address),
  //       market.userCollateral(alice.address),
  //       market.userCollateral(bob.address),
  //       market.userCollateral(jose.address),
  //       market.loan(),
  //       market.rewardsOf(alice.address),
  //       market.rewardsOf(bob.address),
  //       market.rewardsOf(jose.address),
  //       market.totalVCollateral(),
  //       XVS.balanceOf(alice.address),
  //       XVS.balanceOf(bob.address),
  //       XVS.balanceOf(jose.address),
  //       market.totalLoan(),
  //       dinero.balanceOf(owner.address),
  //       owner.getBalance(),
  //       vBNB.balanceOf(owner.address),
  //       recipient.getBalance(),
  //       vBNB.balanceOf(recipient.address),
  //     ]);

  //     expect(ownerDineroBalance2).to.be.closeTo(
  //       ownerDineroBalance.sub(
  //         parseEther('3650')
  //           .add(
  //             ethers.BigNumber.from(12e8)
  //               .mul(parseEther('3650'))
  //               .mul(BigNumber.from(10_000))
  //               .div(parseEther('1'))
  //           )
  //           .add(
  //             parseEther('3650')
  //               .add(
  //                 ethers.BigNumber.from(12e8)
  //                   .mul(parseEther('3650'))
  //                   .mul(BigNumber.from(10_000))
  //                   .div(parseEther('1'))
  //               )
  //               .mul(parseEther('0.01'))
  //               .div(parseEther('1'))
  //           )
  //       ),
  //       parseEther('2')
  //     );

  //     // Alice got fully liquidated
  //     expect(aliceLoan2).to.be.equal(0);
  //     // Bob did not get liquidated
  //     expect(bobLoan2).to.be.equal(bobLoan);
  //     // Jose got partially liquidated
  //     expect(joseLoan2).to.be.equal(joseLoan.sub(parseEther('1200')));

  //     expect(bobCollateral2).to.be.equal(bobCollateral);
  //     // Alice collateral 2 must be lower than collateral 1 minus loan liquidated + 10% due to fees
  //     expect(aliceCollateral2).to.be.closeTo(
  //       aliceCollateral.sub(
  //         convertBorrowToLiquidationCollateral(parseEther('2450'))
  //       ),
  //       ethers.BigNumber.from(10).pow(7) // 0.1 VToken
  //     );
  //     expect(joseCollateral2).to.be.closeTo(
  //       joseCollateral.sub(
  //         convertBorrowToLiquidationCollateral(parseEther('1200'))
  //       ),
  //       ethers.BigNumber.from(10).pow(7) // 0.1 VToken
  //     );

  //     expect(bobRewards2).to.be.equal(bobRewards);
  //     expect(aliceRewards2).to.be.equal(
  //       parseEther('100')
  //         .mul(oneVToken)
  //         .div(totalVCollateral)
  //         .mul(aliceCollateral2)
  //         .div(oneVToken)
  //     );
  //     expect(joseRewards2).to.be.equal(
  //       parseEther('100')
  //         .mul(oneVToken)
  //         .div(totalVCollateral)
  //         .mul(joseCollateral2)
  //         .div(oneVToken)
  //     );
  //     expect(aliceXVSBalance2).to.be.equal(
  //       parseEther('100')
  //         .mul(oneVToken)
  //         .div(totalVCollateral)
  //         .mul(aliceCollateral)
  //         .div(oneVToken)
  //         .sub(aliceRewards)
  //     );
  //     expect(bobXVSBalance2).to.be.equal(0);
  //     expect(joseXVSBalance2).to.be.equal(
  //       parseEther('100')
  //         .mul(oneVToken)
  //         .div(totalVCollateral)
  //         .mul(joseCollateral)
  //         .div(oneVToken)
  //         .sub(joseRewards)
  //     );
  //     expect(totalVCollateral2).to.be.closeTo(
  //       totalVCollateral.sub(
  //         convertBorrowToLiquidationCollateral(parseEther('3650'))
  //       ),
  //       oneVToken
  //     );
  //     expect(totalLoan2.base).to.be.equal(
  //       aliceLoan2.add(joseLoan2).add(bobLoan2)
  //     );
  //     expect(totalLoan2.elastic).to.be.closeTo(
  //       parseEther('800'),
  //       parseEther('2') // 2 DNR to account for fees
  //     );
  //     // Fees earned have to be greater than prev fees plus loan accrued fees.
  //     expect(
  //       loan2.feesEarned.gt(
  //         loan.feesEarned.add(
  //           ethers.BigNumber.from(12e8)
  //             .mul(parseEther('3650'))
  //             .mul(BigNumber.from(10_000))
  //             .div(parseEther('1'))
  //         )
  //       )
  //     );

  //     // liquidator got rewarded in BNB
  //     expect(ownerBNBBalance2).closeTo(
  //       ownerBNBBalance,
  //       parseEther('0.1') // fees
  //     );

  //     expect(recipientBNBBalance2).to.be.equal(recipientBNBBalance);
  //     expect(recipientVBNBBalance).to.be.closeTo(
  //       // Principal + Interest
  //       parseEther('3650')
  //         .add(
  //           ethers.BigNumber.from(12e8)
  //             .mul(parseEther('3650'))
  //             .mul(BigNumber.from(10_000))
  //             .div(parseEther('1'))
  //         )
  //         // 10% fee
  //         .add(
  //           parseEther('3650')
  //             .add(
  //               ethers.BigNumber.from(12e8)
  //                 .mul(parseEther('3650'))
  //                 .mul(BigNumber.from(10_000))
  //                 .div(parseEther('1'))
  //             )
  //             .mul(parseEther('0.1'))
  //             .div(parseEther('1'))
  //         )
  //         // Convert to BNB
  //         .mul(parseEther('1'))
  //         .div(parseEther('300'))
  //         // Convert to VBNB
  //         .mul(parseEther('1'))
  //         .div(VTOKEN_BNB_EXCHANGE_RATE),
  //       ethers.BigNumber.from(10).pow(4)
  //     );
  //     expect(ownerVBNBBalance).to.be.equal(0);
  //   });
  // });
  // describe('update functionality', () => {
  //   it('reverts if a non-owner tries to update it', async () => {
  //     await market.connect(owner).renounceOwnership();

  //     await expect(
  //       upgrade(market, 'TestInterestBNBBearingMarketV2')
  //     ).to.revertedWith('Ownable: caller is not the owner');
  //   });
  //   it('upgrades to version 2', async () => {
  //     await market.connect(alice).addCollateral({ value: parseEther('10') });

  //     const marketV2: TestInterestBNBBearingMarketV2 = await upgrade(
  //       market,
  //       'TestInterestBNBBearingMarketV2'
  //     );

  //     await marketV2
  //       .connect(alice)
  //       .withdrawCollateral(
  //         parseEther('5').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //         false
  //       );

  //     const [version, aliceCollateral, aliceVBNBBalance] = await Promise.all([
  //       marketV2.version(),
  //       marketV2.userCollateral(alice.address),
  //       vBNB.balanceOf(alice.address),
  //     ]);

  //     expect(version).to.be.equal('V2');
  //     expect(aliceCollateral).to.be.closeTo(
  //       parseEther('5').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       ethers.BigNumber.from(10).pow(3)
  //     );
  //     expect(aliceVBNBBalance).to.be.closeTo(
  //       parseEther('5').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       ethers.BigNumber.from(10).pow(3)
  //     );
  //   });
  // });
  // describe('function: addCollateralAndBorrow', () => {
  //   it('reverts if you pass wrong arguments', async () => {
  //     await expect(
  //       market
  //         .connect(alice)
  //         .addCollateralAndBorrow(
  //           ethers.constants.AddressZero,
  //           parseEther('1000'),
  //           {
  //             value: parseEther('5'),
  //           }
  //         )
  //     ).to.revertedWith('DM: no zero address');
  //     await expect(
  //       market.connect(alice).addCollateralAndBorrow(alice.address, 0, {
  //         value: parseEther('5'),
  //       })
  //     ).to.revertedWith('DM: no zero borrow amount');
  //   });
  //   it('reverts if the user is insolvent', async () => {
  //     await expect(
  //       market
  //         .connect(alice)
  //         .addCollateralAndBorrow(bob.address, parseEther('500'), {
  //           value: parseEther('2'),
  //         })
  //     ).to.revertedWith('MKT: sender is insolvent');
  //   });
  //   it('reverts if it fails to mint vBNB', async () => {
  //     await vBNB.__setMintReturn(1);
  //     await expect(
  //       market
  //         .connect(alice)
  //         .addCollateralAndBorrow(bob.address, parseEther('200'), {
  //           value: parseEther('2'),
  //         })
  //     ).to.revertedWith('DM: failed to mint');
  //   });
  //   it('allows a user to first deposit and then borrow', async () => {
  //     const [
  //       aliceCollateral,
  //       totalRewardsPerVToken,
  //       totalVCollateral,
  //       aliceRewards,
  //       totalLoan,
  //       aliceLoan,
  //       aliceDineroBalance,
  //     ] = await Promise.all([
  //       market.userCollateral(alice.address),
  //       market.totalRewardsPerVToken(),
  //       market.totalVCollateral(),
  //       market.rewardsOf(alice.address),
  //       market.totalLoan(),
  //       market.userLoan(alice.address),
  //       dinero.balanceOf(alice.address),
  //     ]);

  //     expect(aliceCollateral).to.be.equal(0);
  //     expect(totalRewardsPerVToken).to.be.equal(0);
  //     expect(totalVCollateral).to.be.equal(0);
  //     expect(aliceRewards).to.be.equal(0);
  //     expect(totalLoan.base).to.be.equal(0);
  //     expect(totalLoan.elastic).to.be.equal(0);
  //     expect(aliceLoan).to.be.equal(0);

  //     await expect(
  //       market
  //         .connect(alice)
  //         .addCollateralAndBorrow(bob.address, parseEther('200'), {
  //           value: parseEther('10'),
  //         })
  //     )
  //       .to.emit(market, 'AddCollateral')
  //       .withArgs(
  //         alice.address,
  //         parseEther('10').mul(VTOKEN_BNB_EXCHANGE_RATE).div(parseEther('1')),
  //         parseEther('10').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //       )
  //       .to.emit(dinero, 'Transfer')
  //       .withArgs(ethers.constants.AddressZero, bob.address, parseEther('200'))
  //       .to.emit(market, 'Borrow')
  //       .to.not.emit(venusController, 'Claim')
  //       .to.not.emit(XVS, 'Transfer')
  //       .to.not.emit(market, 'Accrue');

  //     const [totalLoan2, aliceLoan2, aliceDineroBalance2, bobDineroBalance] =
  //       await Promise.all([
  //         market.totalLoan(),
  //         market.userLoan(alice.address),
  //         dinero.balanceOf(alice.address),
  //         dinero.balanceOf(bob.address),
  //       ]);

  //     expect(totalLoan2.base).to.be.equal(parseEther('200'));
  //     expect(totalLoan2.elastic).to.be.equal(parseEther('200'));
  //     expect(aliceLoan2).to.be.equal(parseEther('200'));
  //     expect(aliceDineroBalance2).to.be.equal(aliceDineroBalance);
  //     expect(bobDineroBalance).to.be.equal(parseEther('200'));

  //     await advanceTime(10_000, ethers); // advance 10_000 seconds

  //     await expect(
  //       market
  //         .connect(bob)
  //         .addCollateralAndBorrow(alice.address, parseEther('199'), {
  //           value: parseEther('5'),
  //         })
  //     )
  //       .to.emit(market, 'AddCollateral')
  //       .withArgs(
  //         alice.address,
  //         parseEther('5').mul(VTOKEN_BNB_EXCHANGE_RATE).div(parseEther('1')),
  //         parseEther('5').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //       )
  //       .to.emit(market, 'Accrue')
  //       .to.emit(dinero, 'Transfer')
  //       .withArgs(
  //         ethers.constants.AddressZero,
  //         alice.address,
  //         parseEther('199')
  //       )
  //       .to.emit(market, 'Borrow')
  //       .to.not.emit(venusController, 'Claim')
  //       .to.not.emit(XVS, 'Transfer');

  //     const [
  //       aliceCollateral2,
  //       totalRewardsPerVToken2,
  //       totalVCollateral2,
  //       aliceRewards2,
  //       bobRewards2,
  //       bobCollateral2,
  //       totalLoan3,
  //       aliceLoan3,
  //       bobLoan,
  //       aliceDineroBalance3,
  //       bobDineroBalance2,
  //     ] = await Promise.all([
  //       market.userCollateral(alice.address),
  //       market.totalRewardsPerVToken(),
  //       market.totalVCollateral(),
  //       market.rewardsOf(alice.address),
  //       market.rewardsOf(bob.address),
  //       market.userCollateral(bob.address),
  //       market.totalLoan(),
  //       market.userLoan(alice.address),
  //       market.userLoan(bob.address),
  //       dinero.balanceOf(alice.address),
  //       dinero.balanceOf(bob.address),
  //     ]);

  //     expect(aliceCollateral2).to.be.equal(
  //       parseEther('10').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //     );
  //     expect(bobCollateral2).to.be.equal(
  //       parseEther('5').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //     );
  //     expect(totalRewardsPerVToken2).to.be.equal(0);
  //     expect(totalVCollateral2).to.be.closeTo(
  //       parseEther('15').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       1
  //     );
  //     expect(aliceRewards2).to.be.equal(0);
  //     expect(bobRewards2).to.be.equal(0);
  //     expect(
  //       totalLoan3.base.gt(totalLoan2.base.add(parseEther('190')))
  //     ).to.be.equal(true); // Interest rate makes it hard to calculate the exact value
  //     expect(
  //       totalLoan3.elastic.gte(totalLoan2.elastic.add(parseEther('199')))
  //     ).to.be.equal(true);

  //     expect(aliceLoan3).to.be.equal(aliceLoan2);

  //     expect(aliceDineroBalance3).to.be.equal(
  //       aliceDineroBalance2.add(parseEther('199'))
  //     );
  //     expect(bobDineroBalance2).to.be.equal(parseEther('200'));
  //     expect(bobLoan).to.be.closeTo(
  //       parseEther('199').mul(totalLoan3.elastic).div(totalLoan3.base),
  //       parseEther('1')
  //     );
  //   });
  // });
  // describe('function: repayAndWithdrawCollateral', () => {
  //   it('reverts if you pass zero address or 0 principal', async () => {
  //     await expect(
  //       market.repayAndWithdrawCollateral(
  //         ethers.constants.AddressZero,
  //         1,
  //         0,
  //         false
  //       )
  //     ).to.revertedWith('DM: no zero address');
  //     await expect(
  //       market.repayAndWithdrawCollateral(alice.address, 0, 0, false)
  //     ).to.revertedWith('DM: principal cannot be 0');
  //     await expect(
  //       market.repayAndWithdrawCollateral(alice.address, 1, 0, false)
  //     ).to.revertedWith('DM: amount cannot be 0');
  //   });
  //   it('reverts if the user is insolvent', async () => {
  //     await market.connect(alice).addCollateral({ value: parseEther('10') });

  //     await market.connect(alice).borrow(jose.address, parseEther('2000'));

  //     await expect(
  //       market
  //         .connect(alice)
  //         .repayAndWithdrawCollateral(
  //           alice.address,
  //           1,
  //           parseEther('2.1')
  //             .mul(parseEther('1'))
  //             .div(VTOKEN_BNB_EXCHANGE_RATE),
  //           false
  //         )
  //     ).to.revertedWith('MKT: sender is insolvent');
  //   });
  //   it('reverts if vBNB fails to redeem', async () => {
  //     await Promise.all([
  //       vBNB.__setRedeemReturn(1),
  //       market.connect(alice).addCollateral({ value: parseEther('2') }),
  //     ]);

  //     await market.connect(alice).borrow(alice.address, parseEther('100'));

  //     await market.connect(alice).addCollateral({ value: parseEther('2') });

  //     await expect(
  //       market
  //         .connect(alice)
  //         .repayAndWithdrawCollateral(
  //           alice.address,
  //           1,
  //           parseEther('1').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //           true
  //         )
  //     ).to.revertedWith('DM: failed to redeem');
  //   });
  //   it('allows a user to repay and then withdraw collateral in vBNB', async () => {
  //     await market.connect(alice).addCollateral({ value: parseEther('10') });

  //     await market.connect(alice).borrow(alice.address, parseEther('300'));

  //     const [aliceDineroBalance, aliceLoan, totalLoan] = await Promise.all([
  //       dinero.balanceOf(alice.address),
  //       market.userLoan(alice.address),
  //       market.totalLoan(),
  //       advanceTime(1000, ethers),
  //     ]);

  //     await expect(
  //       market
  //         .connect(alice)
  //         .repayAndWithdrawCollateral(
  //           alice.address,
  //           parseEther('150'),
  //           parseEther('2').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //           false
  //         )
  //     )
  //       .to.emit(market, 'Accrue')
  //       .to.emit(vBNB, 'Transfer')
  //       .withArgs(
  //         market.address,
  //         alice.address,
  //         0,
  //         parseEther('2').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //       )
  //       .to.emit(dinero, 'Transfer')
  //       .to.emit(market, 'Repay')
  //       .to.not.emit(venusController, 'Claim')
  //       .to.not.emit(XVS, 'Transfer')
  //       .to.not.emit(vBNB, 'Redeem');

  //     const [
  //       aliceCollateral,
  //       totalRewardsPerVToken,
  //       totalVCollateral,
  //       aliceRewards,
  //       aliceDineroBalance2,
  //       aliceLoan2,
  //       totalLoan2,
  //     ] = await Promise.all([
  //       market.userCollateral(alice.address),
  //       market.totalRewardsPerVToken(),
  //       market.totalVCollateral(),
  //       market.rewardsOf(alice.address),
  //       dinero.balanceOf(alice.address),
  //       market.userLoan(alice.address),
  //       market.totalLoan(),
  //     ]);

  //     expect(
  //       aliceDineroBalance2.lte(aliceDineroBalance.sub(parseEther('150')))
  //     ).to.be.equal(true);
  //     expect(aliceLoan).to.be.equal(parseEther('300'));
  //     expect(aliceLoan2).to.be.equal(parseEther('150'));
  //     expect(totalLoan.elastic).to.be.equal(parseEther('300'));
  //     expect(totalLoan.base).to.be.equal(parseEther('300'));
  //     expect(totalLoan2.base).to.be.equal(parseEther('150'));
  //     expect(
  //       totalLoan2.elastic.gt(totalLoan.elastic.sub(parseEther('150')))
  //     ).to.be.equal(true);

  //     expect(aliceCollateral).to.be.closeTo(
  //       parseEther('8').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       1
  //     );
  //     expect(totalRewardsPerVToken).to.be.equal(0);
  //     expect(totalVCollateral).to.be.closeTo(
  //       parseEther('8').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       1
  //     );
  //     expect(aliceRewards).to.be.equal(0);

  //     await Promise.all([
  //       market.connect(bob).addCollateral({ value: parseEther('5') }),
  //       venusController.__setClaimVenusValue(parseEther('100')),
  //     ]);

  //     // Make sure accrue gets called
  //     await advanceTime(100, ethers); // advance 100 seconds

  //     await market.connect(alice).borrow(alice.address, parseEther('10'));

  //     await expect(
  //       market
  //         .connect(alice)
  //         .repayAndWithdrawCollateral(
  //           alice.address,
  //           1,
  //           parseEther('1').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //           false
  //         )
  //     )
  //       .to.emit(market, 'Accrue')
  //       .to.emit(vBNB, 'Transfer')
  //       .withArgs(
  //         market.address,
  //         alice.address,
  //         0,
  //         parseEther('1').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //       )
  //       .to.emit(venusController, 'Claim')
  //       .to.emit(XVS, 'Transfer')
  //       .withArgs(
  //         market.address,
  //         alice.address,
  //         parseEther('100')
  //           .mul(oneVToken)
  //           .div(
  //             parseEther('13')
  //               .mul(parseEther('1'))
  //               .div(VTOKEN_BNB_EXCHANGE_RATE)
  //           )
  //           .mul(aliceCollateral)
  //           .div(oneVToken)
  //       )
  //       .to.not.emit(vBNB, 'Redeem');

  //     const [
  //       aliceCollateral2,
  //       totalRewardsPerVToken2,
  //       totalVCollateral2,
  //       aliceRewards2,
  //     ] = await Promise.all([
  //       market.userCollateral(alice.address),
  //       market.totalRewardsPerVToken(),
  //       market.totalVCollateral(),
  //       market.rewardsOf(alice.address),
  //     ]);

  //     expect(aliceCollateral2).to.be.closeTo(
  //       parseEther('7').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       10
  //     );
  //     expect(totalRewardsPerVToken2).to.be.equal(
  //       parseEther('100')
  //         .mul(oneVToken)
  //         .div(
  //           parseEther('13').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE)
  //         )
  //     );
  //     expect(totalVCollateral2).to.be.closeTo(
  //       parseEther('12').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       10
  //     );
  //     expect(aliceRewards2).to.be.equal(
  //       totalRewardsPerVToken2.mul(aliceCollateral2).div(oneVToken)
  //     );
  //   });
  //   it('allows a user to repay and then withdraw collateral in BNB', async () => {
  //     await market.connect(alice).addCollateral({ value: parseEther('20') });

  //     await market.connect(alice).borrow(alice.address, parseEther('300'));

  //     const [aliceDineroBalance, aliceLoan, totalLoan] = await Promise.all([
  //       dinero.balanceOf(alice.address),
  //       market.userLoan(alice.address),
  //       market.totalLoan(),
  //       advanceTime(1000, ethers),
  //     ]);

  //     const aliceBalance = await alice.getBalance();

  //     await expect(
  //       market
  //         .connect(alice)
  //         .repayAndWithdrawCollateral(
  //           alice.address,
  //           parseEther('150'),
  //           parseEther('2').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //           true
  //         )
  //     )
  //       .to.emit(market, 'Accrue')
  //       .to.emit(dinero, 'Transfer')
  //       .to.emit(market, 'Repay')
  //       .to.emit(market, 'Accrue')
  //       .to.emit(vBNB, 'Redeem')
  //       .withArgs(parseEther('2'))
  //       .to.emit(market, 'WithdrawCollateral');

  //     const [
  //       dineroownerDineroBalance2,
  //       aliceLoan2,
  //       totalLoan2,
  //       aliceCollateral,
  //       totalRewardsPerVToken,
  //       totalVCollateral,
  //       aliceRewards,
  //       aliceBalance2,
  //       aliceVBNBBalance,
  //     ] = await Promise.all([
  //       dinero.balanceOf(alice.address),
  //       market.userLoan(alice.address),
  //       market.totalLoan(),
  //       market.userCollateral(alice.address),
  //       market.totalRewardsPerVToken(),
  //       market.totalVCollateral(),
  //       market.rewardsOf(alice.address),
  //       alice.getBalance(),
  //       vBNB.balanceOf(alice.address),
  //     ]);

  //     expect(aliceCollateral).to.be.closeTo(
  //       parseEther('18').mul(parseEther('1')).div(VTOKEN_BNB_EXCHANGE_RATE),
  //       5
  //     );
  //     expect(totalRewardsPerVToken).to.be.equal(0);
  //     expect(totalVCollateral).to.be.equal(aliceCollateral);
  //     expect(aliceRewards).to.be.equal(0);
  //     expect(aliceBalance2).to.be.closeTo(
  //       aliceBalance.add(parseEther('2')),
  //       parseEther('0.1') // TX fees
  //     );
  //     expect(aliceVBNBBalance).to.be.equal(0);

  //     expect(
  //       dineroownerDineroBalance2.lte(aliceDineroBalance.sub(parseEther('150')))
  //     ).to.be.equal(true);
  //     expect(aliceLoan).to.be.equal(parseEther('300'));
  //     expect(aliceLoan2).to.be.equal(parseEther('150'));
  //     expect(totalLoan.elastic).to.be.equal(parseEther('300'));
  //     expect(totalLoan.base).to.be.equal(parseEther('300'));
  //     expect(totalLoan2.base).to.be.equal(parseEther('150'));
  //     expect(
  //       totalLoan2.elastic.gt(totalLoan.elastic.sub(parseEther('150')))
  //     ).to.be.equal(true);
  //   });
  // });
}).timeout(4000);
