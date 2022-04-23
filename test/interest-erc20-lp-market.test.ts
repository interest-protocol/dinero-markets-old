import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import ERC20ABI from '../abi/erc20.json';
import PCSFactoryABI from '../abi/pcs-factory.json';
import PCSRouterABI from '../abi/pcs-router.json';
import WBNBABI from '../abi/wbnb.json';
import {
  Dinero,
  ERC20,
  InterestERC20Market,
  LPVault,
  MockOracle,
  OracleV1,
} from '../typechain';
import {
  BNB_USD_PRICE_FEED,
  BURNER_ROLE,
  CAKE,
  CAKE_BNB_PRICE_FEED,
  CAKE_USD_PRICE_FEED,
  MINTER_ROLE,
  PCS_FACTORY,
  PCS_ROUTER,
  WBNB,
  WBNB_CAKE_LP_HOLDER,
  WBNB_CAKE_LP_HOLDER_TWO,
  WBNB_CAKE_LP_TOKEN_POOL_ID,
  WBNB_CAKE_PAIR_LP_TOKEN,
  WBNB_WHALE,
} from './lib/constants';
import {
  advanceBlock,
  advanceTime,
  deployUUPS,
  impersonate,
  multiDeploy,
} from './lib/test-utils';

const { parseEther } = ethers.utils;

const INTEREST_RATE = ethers.BigNumber.from(12e8);

const LP_TOKEN_USD_PRICE = ethers.BigNumber.from('133831249510302866440');

// WBNB-CAKE Pair
// CAKE is token0
// WBNB is token1

describe('InterestERC20Market', () => {
  let market: InterestERC20Market;
  let dinero: Dinero;
  let oracle: OracleV1;
  let mockOracle: MockOracle;
  let vault: LPVault;
  const LPTokenContract = new ethers.Contract(
    WBNB_CAKE_PAIR_LP_TOKEN,
    ERC20ABI,
    ethers.provider
  ) as ERC20;
  const CakeContract = new ethers.Contract(
    CAKE,
    ERC20ABI,
    ethers.provider
  ) as ERC20;

  let owner: SignerWithAddress;
  let recipient: SignerWithAddress;
  let treasury: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  before(async () => {
    [owner, treasury, recipient] = await ethers.getSigners();

    dinero = await deployUUPS('Dinero', []);

    await Promise.all([
      dinero.connect(owner).grantRole(MINTER_ROLE, owner.address),
      impersonate(WBNB_WHALE),
      impersonate(WBNB_CAKE_LP_HOLDER),
      impersonate(WBNB_CAKE_LP_HOLDER_TWO),
      treasury.sendTransaction({
        to: WBNB_CAKE_LP_HOLDER,
        value: parseEther('10'),
      }),
      treasury.sendTransaction({
        to: WBNB_CAKE_LP_HOLDER_TWO,
        value: parseEther('10'),
      }),
    ]);

    [alice, bob] = await Promise.all([
      ethers.getSigner(WBNB_CAKE_LP_HOLDER),
      ethers.getSigner(WBNB_CAKE_LP_HOLDER_TWO),
    ]);

    const wbnbWhaleSigner = await ethers.getSigner(WBNB_WHALE);
    const wbnb = new ethers.Contract(WBNB, WBNBABI, wbnbWhaleSigner);

    await Promise.all([
      dinero.connect(owner).mint(owner.address, parseEther('3000000')),
      dinero.connect(owner).mint(alice.address, parseEther('500000')),
      dinero.connect(owner).mint(WBNB_WHALE, parseEther('10000000')),
      dinero
        .connect(wbnbWhaleSigner)
        .approve(PCS_ROUTER, ethers.constants.MaxUint256),
      wbnb
        .connect(wbnbWhaleSigner)
        .approve(PCS_ROUTER, ethers.constants.MaxUint256),
      wbnb.deposit({ value: parseEther('22000') }),
    ]);

    const router = new ethers.Contract(
      PCS_ROUTER,
      PCSRouterABI,
      wbnbWhaleSigner
    );

    // BNB/DINERO Liquidity
    await router.addLiquidity(
      WBNB,
      dinero.address,
      parseEther('22200'),
      parseEther('10000000'),
      parseEther('22200'),
      parseEther('10000000'),
      owner.address,
      ethers.constants.MaxUint256
    );
  });

  beforeEach(async () => {
    const [mockTWAP, _mockOracle] = await multiDeploy(
      ['MockTWAP', 'MockOracle'],
      [[], []]
    );

    mockOracle = _mockOracle;

    oracle = await deployUUPS('OracleV1', [mockTWAP.address]);

    await Promise.all([
      oracle.connect(owner).setFeed(CAKE, CAKE_USD_PRICE_FEED, 0),
      oracle.connect(owner).setFeed(WBNB, BNB_USD_PRICE_FEED, 0),
      oracle.connect(owner).setFeed(CAKE, CAKE_BNB_PRICE_FEED, 1),
    ]);

    vault = await deployUUPS('LPVault', [
      WBNB_CAKE_PAIR_LP_TOKEN,
      WBNB_CAKE_LP_TOKEN_POOL_ID,
    ]);

    market = await deployUUPS('InterestERC20Market', [
      dinero.address,
      treasury.address,
      oracle.address,
      WBNB_CAKE_PAIR_LP_TOKEN,
      vault.address,
      INTEREST_RATE,
      parseEther('0.5'),
      parseEther('0.1'),
    ]);

    await Promise.all([
      vault.connect(owner).setMarket(market.address),
      dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
      LPTokenContract.connect(alice).approve(
        vault.address,
        ethers.constants.MaxUint256
      ),
      LPTokenContract.connect(bob).approve(
        vault.address,
        ethers.constants.MaxUint256
      ),
      market.updateExchangeRate(),
    ]);
  });

  const makeMockOracleMarket = async () => {
    vault = await deployUUPS('LPVault', [
      WBNB_CAKE_PAIR_LP_TOKEN,
      WBNB_CAKE_LP_TOKEN_POOL_ID,
    ]);

    const market = await deployUUPS('InterestERC20Market', [
      dinero.address,
      treasury.address,
      mockOracle.address,
      WBNB_CAKE_PAIR_LP_TOKEN,
      vault.address,
      INTEREST_RATE,
      parseEther('0.5'),
      parseEther('0.1'),
    ]);

    await mockOracle.__setERC20Price(
      WBNB_CAKE_PAIR_LP_TOKEN,
      LP_TOKEN_USD_PRICE.mul(2)
    );

    await Promise.all([
      vault.connect(owner).setMarket(market.address),
      dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
      LPTokenContract.connect(alice).approve(
        vault.address,
        ethers.constants.MaxUint256
      ),
      LPTokenContract.connect(bob).approve(
        vault.address,
        ethers.constants.MaxUint256
      ),
      market.updateExchangeRate(),
    ]);

    return [market, vault] as [InterestERC20Market, LPVault];
  };

  it('accepts collateral and deposits to the vault', async () => {
    const [totalCollateral, aliceCollateral] = await Promise.all([
      market.totalCollateral(),
      market.userCollateral(alice.address),
    ]);

    expect(totalCollateral).to.be.equal(0);

    expect(aliceCollateral).to.be.equal(0);

    const amount = parseEther('10');

    await expect(market.connect(alice).addCollateral(alice.address, amount))
      .to.emit(market, 'AddCollateral')
      .withArgs(alice.address, alice.address, amount)
      .to.emit(vault, 'Deposit')
      .withArgs(alice.address, alice.address, amount)
      .to.emit(LPTokenContract, 'Transfer')
      .withArgs(alice.address, vault.address, amount);

    const [totalCollateral2, aliceCollateral2] = await Promise.all([
      market.totalCollateral(),
      market.userCollateral(alice.address),
    ]);

    expect(totalCollateral2).to.be.equal(amount);

    expect(aliceCollateral2).to.be.equal(amount);

    await expect(market.connect(bob).addCollateral(alice.address, amount))
      .to.emit(market, 'AddCollateral')
      .withArgs(bob.address, alice.address, amount)
      .to.emit(vault, 'Deposit')
      .withArgs(bob.address, alice.address, amount)
      .to.emit(LPTokenContract, 'Transfer')
      .withArgs(bob.address, vault.address, amount);

    const [
      totalCollateral3,
      aliceCollateral3,
      bobCollateral3,
      marketLPTokenBalance3,
    ] = await Promise.all([
      market.totalCollateral(),
      market.userCollateral(alice.address),
      market.userCollateral(bob.address),
      LPTokenContract.balanceOf(market.address),
    ]);

    expect(totalCollateral3).to.be.equal(amount.add(amount));
    expect(aliceCollateral3).to.be.equal(amount.add(amount));
    expect(bobCollateral3).to.be.equal(0);
    expect(marketLPTokenBalance3).to.be.equal(0); // Cake is in the masterChef
  });

  it('removes collateral using a vault', async () => {
    const aliceAmount = parseEther('300');
    const bobAmount = parseEther('200');

    await Promise.all([
      market.connect(alice).addCollateral(alice.address, aliceAmount),
      market.connect(bob).addCollateral(bob.address, bobAmount),
    ]);

    // We need to borrow to test the Accrue event
    await market.connect(bob).borrow(alice.address, parseEther('10'));

    const [totalCollateral, aliceCollateral, bobCollateral, aliceCakeBalance] =
      await Promise.all([
        market.totalCollateral(),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        CakeContract.balanceOf(alice.address),
      ]);

    expect(totalCollateral).to.be.equal(aliceAmount.add(bobAmount));

    expect(aliceCollateral).to.be.equal(aliceAmount);
    expect(bobCollateral).to.be.equal(bobAmount);

    await expect(
      market.connect(alice).withdrawCollateral(alice.address, aliceAmount)
    )
      .to.emit(market, 'WithdrawCollateral')
      .withArgs(alice.address, alice.address, aliceAmount)
      .to.emit(vault, 'Withdraw')
      .withArgs(alice.address, alice.address, aliceAmount)
      .to.emit(market, 'Accrue')
      .to.emit(LPTokenContract, 'Transfer')
      .to.emit(CakeContract, 'Transfer');

    const [
      totalCollateral2,
      aliceCollateral2,
      bobCollateral2,
      aliceCakeBalance2,
      bobCakeBalance2,
      aliceLPTokenBalance2,
    ] = await Promise.all([
      market.totalCollateral(),
      market.userCollateral(alice.address),
      market.userCollateral(bob.address),
      CakeContract.balanceOf(alice.address),
      CakeContract.balanceOf(bob.address),
      LPTokenContract.balanceOf(alice.address),
    ]);

    expect(totalCollateral2).to.be.equal(bobAmount);

    expect(aliceCollateral2).to.be.equal(0);

    expect(bobCollateral2).to.be.equal(bobAmount);

    expect(aliceCakeBalance2.gt(aliceCakeBalance)).to.be.equal(true);

    await advanceBlock(ethers);
    await advanceBlock(ethers);
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    await expect(
      market.connect(bob).withdrawCollateral(alice.address, parseEther('3'))
    )
      .to.emit(market, 'WithdrawCollateral')
      .withArgs(bob.address, alice.address, parseEther('3'))
      .to.emit(vault, 'Withdraw')
      .withArgs(bob.address, alice.address, parseEther('3'))
      .to.emit(market, 'Accrue')
      .to.emit(LPTokenContract, 'Transfer');

    const [
      totalCollateral3,
      bobCollateral3,
      aliceCakeBalance3,
      bobCakeBalance3,
      aliceLPTokenBalance3,
    ] = await Promise.all([
      market.totalCollateral(),
      market.userCollateral(bob.address),
      CakeContract.balanceOf(alice.address),
      CakeContract.balanceOf(bob.address),
      LPTokenContract.balanceOf(alice.address),
    ]);

    expect(totalCollateral3).to.be.equal(bobAmount.sub(parseEther('3')));

    // he got rewards
    expect(bobCollateral3).to.be.equal(bobCollateral2.sub(parseEther('3')));

    expect(aliceLPTokenBalance3).to.be.equal(
      aliceLPTokenBalance2.add(parseEther('3'))
    );

    expect(aliceCakeBalance3).to.be.equal(aliceCakeBalance2);

    // Got rewards
    expect(bobCakeBalance3.gt(bobCakeBalance2)).to.be.equal(true);
  });

  describe('function: liquidate', () => {
    it('reverts if the path 2 has incorrect data', async () => {
      const [market] = await makeMockOracleMarket();

      await market
        .connect(alice)
        .addCollateral(alice.address, parseEther('10'));

      await market.connect(alice).borrow(alice.address, parseEther('700'));

      await mockOracle.__setERC20Price(
        WBNB_CAKE_PAIR_LP_TOKEN,
        LP_TOKEN_USD_PRICE
      );

      await expect(
        market
          .connect(owner)
          .liquidate(
            [alice.address],
            [parseEther('700')],
            alice.address,
            [CAKE, WBNB, dinero.address],
            []
          )
      ).to.revertedWith('MKT: provide a path for token1');

      await expect(
        market
          .connect(owner)
          .liquidate(
            [alice.address],
            [parseEther('700')],
            alice.address,
            [CAKE, WBNB, dinero.address],
            [WBNB]
          )
      ).to.revertedWith('MKT: provide a path for token1');

      await expect(
        market
          .connect(owner)
          .liquidate(
            [alice.address],
            [parseEther('700')],
            alice.address,
            [CAKE, WBNB, dinero.address],
            [WBNB, CAKE, WBNB]
          )
      ).to.revertedWith('MKT: no dinero on last index');
    });

    it('liquidates accounts by selling the collecteral', async () => {
      const [market] = await makeMockOracleMarket();

      // Add Collateral
      await Promise.all([
        market.connect(alice).addCollateral(alice.address, parseEther('10')),
        market.connect(bob).addCollateral(bob.address, parseEther('7')),
      ]);

      // Borrow the maximum amount of 49.9%
      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('700')),
        market.connect(bob).borrow(bob.address, parseEther('500')),
      ]);

      await mockOracle.__setERC20Price(
        WBNB_CAKE_PAIR_LP_TOKEN,
        LP_TOKEN_USD_PRICE
      );

      const factoryContract = new ethers.Contract(
        PCS_FACTORY,
        PCSFactoryABI,
        ethers.provider
      );

      const [
        totalCollateral,
        aliceLoan,
        bobLoan,
        aliceCollateral,
        bobCollateral,
        loan,
        pair,
        dineroRecipientBalance,
        recipientLPTokenBalance,
      ] = await Promise.all([
        market.totalCollateral(),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.loan(),
        factoryContract.getPair(dinero.address, WBNB),
        dinero.balanceOf(recipient.address),
        LPTokenContract.balanceOf(recipient.address),
      ]);

      expect(totalCollateral).to.be.equal(parseEther('17'));
      expect(aliceLoan).to.be.equal(parseEther('700'));
      expect(bobLoan).to.be.closeTo(parseEther('500'), parseEther('5'));

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      // Pass time to accrue fees
      await advanceTime(63_113_904, ethers); // advance 2 years

      // The recipient can liquidate all because he does not need to have `Dinero` he will use the collateral to cover
      await expect(
        market.connect(recipient).liquidate(
          [alice.address, bob.address],
          [parseEther('700'), parseEther('500')],
          recipient.address,
          [CAKE, WBNB, dinero.address],
          [WBNB, dinero.address] // Enables the use of the router for non LP-tokens.
        )
      )
        .to.emit(market, 'WithdrawCollateral')
        .to.emit(market, 'Repay')
        .to.emit(market, 'Accrue')
        .to.emit(market, 'ExchangeRate')
        .to.emit(dinero, 'Transfer')
        // Router is being used
        .to.emit(pairContract, 'Swap');

      const [
        totalLoan,
        totalCollateral2,
        aliceLoan2,
        bobLoan2,
        aliceCollateral2,
        bobCollateral2,
        loan2,
        dineroRecipientBalance2,
        recipientLPTokenBalance2,
      ] = await Promise.all([
        market.totalLoan(),
        market.totalCollateral(),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.loan(),
        dinero.balanceOf(recipient.address),
        LPTokenContract.balanceOf(recipient.address),
      ]);

      const allCollateral = aliceCollateral
        .sub(aliceCollateral2)
        .add(bobCollateral.sub(bobCollateral2));

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
      const bobDebt = bobCollateral
        .sub(bobCollateral2)
        .mul(ethers.BigNumber.from(15).mul(parseEther('1')))
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

      // Alice loan  gets fully repaid
      expect(aliceLoan2).to.be.equal(0);
      // bob loan gets fully repaid
      expect(bobLoan2).to.be.equal(0);

      // Alice and bob got liquidated
      expect(totalCollateral.sub(totalCollateral2)).to.be.eq(allCollateral);

      // recipient gets paid in DNR not CAKE
      expect(recipientLPTokenBalance2).to.be.equal(recipientLPTokenBalance);

      // Means loan2 feesEarned includes accrued + protocol fee
      expect(loan2.feesEarned.sub(protocolFee).gt(loan.feesEarned)).to.be.equal(
        true
      );

      // There should be no open loan at the moment
      expect(totalLoan.base).to.be.equal(0);
      expect(totalLoan.elastic).to.be.equal(0);

      // Recipient receives the liquidation fee - slippage
      expect(dineroRecipientBalance2.gt(dineroRecipientBalance)).to.be.equal(
        true
      );
    });
  });
}).timeout(50_000);
