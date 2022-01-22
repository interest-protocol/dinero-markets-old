import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  Dinero,
  ETHRouter,
  InterestBNBMarketV1,
  InterestGovernorV1,
  LiquidityRouter,
  MockChainLinkFeed,
  OracleV1,
  PancakeFactory,
  WETH9,
} from '../typechain';
import { advanceTime, deploy, multiDeploy } from './lib/test-utils';

const BNB_USD_PRICE = ethers.BigNumber.from('50000000000'); // 500 USD

const { parseEther } = ethers.utils;

describe('InterestBNBMarketV1', () => {
  let interestBNBMarket: InterestBNBMarketV1;
  let dinero: Dinero;
  let governor: InterestGovernorV1;
  let oracle: OracleV1;
  let mockBnbUsdDFeed: MockChainLinkFeed;
  let weth: WETH9;
  let factory: PancakeFactory;
  let router: ETHRouter;
  let liquidityRouter: LiquidityRouter;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let treasury: SignerWithAddress;
  let developer: SignerWithAddress;

  beforeEach(async () => {
    [owner, alice, treasury, developer] = await ethers.getSigners();

    [dinero, weth, mockBnbUsdDFeed, factory] = await multiDeploy(
      ['Dinero', 'WETH9', 'MockChainLinkFeed', 'PancakeFactory'],
      [[], [], [8, 'CAKE/USD', 1], [developer.address]]
    );

    [governor, oracle, router, liquidityRouter] = await multiDeploy(
      ['InterestGovernorV1', 'OracleV1', 'ETHRouter', 'LiquidityRouter'],
      [
        [dinero.address],
        [mockBnbUsdDFeed.address, weth.address],
        [factory.address, weth.address],
        [factory.address, weth.address],
      ]
    );
    [interestBNBMarket] = await Promise.all([
      deploy('InterestBNBMarketV1', [
        router.address,
        dinero.address,
        governor.address,
        oracle.address,
        ethers.BigNumber.from(12e8),
        ethers.BigNumber.from(5e5),
        ethers.BigNumber.from(10e4),
      ]),
      dinero
        .connect(owner)
        .grantRole(await dinero.DEFAULT_ADMIN_ROLE(), governor.address),
      dinero
        .connect(owner)
        .grantRole(await dinero.MINTER_ROLE(), owner.address),
      governor.connect(owner).setFeeTo(treasury.address),
      mockBnbUsdDFeed.setAnswer(BNB_USD_PRICE),
      oracle.connect(owner).setFeed(weth.address, mockBnbUsdDFeed.address, 0),
      weth.approve(liquidityRouter.address, ethers.constants.MaxUint256),
      weth.connect(owner).mint(parseEther('1000')),
    ]);

    await Promise.all([
      dinero.connect(owner).mint(owner.address, parseEther('500000')),
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
      governor.connect(owner).addDineroMarket(interestBNBMarket.address),
    ]);
  });

  it('should return the governor owner', async () => {
    expect(await interestBNBMarket.governorOwner()).to.be.equal(
      await governor.owner()
    );
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
});
