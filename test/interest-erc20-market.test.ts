import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers, network } from 'hardhat';

import ERC20ABI from '../abi/erc20.json';
import PCSFactoryABI from '../abi/pcs-factory.json';
import PCSRouterABI from '../abi/pcs-router.json';
import WBNBABI from '../abi/wbnb.json';
import {
  CakeVault,
  Dinero,
  ERC20,
  InterestERC20Market,
  MockOracle,
  Oracle,
  TestInterestERC20MarketV2,
} from '../typechain';
import {
  BURNER_ROLE,
  CAKE,
  CAKE_USD_PRICE_FEED,
  CAKE_WHALE_ONE,
  CAKE_WHALE_THREE,
  CAKE_WHALE_TWO,
  MINTER_ROLE,
  PCS_FACTORY,
  PCS_ROUTER,
  WBNB,
  WBNB_WHALE,
} from './lib/constants';
import {
  advanceBlock,
  advanceBlockAndTime,
  advanceTime,
  deployUUPS,
  impersonate,
  multiDeploy,
  upgrade,
} from './lib/test-utils';

const { parseEther, defaultAbiCoder } = ethers.utils;

const INTEREST_RATE = ethers.BigNumber.from(12e8);

const MOCK_ORACLE_PRICE = parseEther('20');

// CAKE PRICE IN THE BLOCK IS 9.8 USD

describe('InterestERC20Market', () => {
  let market: InterestERC20Market;
  let dinero: Dinero;
  let oracle: Oracle;
  let mockOracle: MockOracle;
  const CakeContract = new ethers.Contract(
    CAKE,
    ERC20ABI,
    ethers.provider
  ) as ERC20;

  // BNB Accs
  let owner: SignerWithAddress;
  let recipient: SignerWithAddress;
  let treasury: SignerWithAddress;

  // CAKE whales
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let jose: SignerWithAddress;

  before(async () => {
    [owner, treasury, recipient] = await ethers.getSigners();

    dinero = await deployUUPS('Dinero', []);

    await Promise.all([
      dinero.connect(owner).grantRole(MINTER_ROLE, owner.address),
      impersonate(WBNB_WHALE),
      impersonate(CAKE_WHALE_ONE),
      impersonate(CAKE_WHALE_TWO),
      impersonate(CAKE_WHALE_THREE),
      treasury.sendTransaction({ to: CAKE_WHALE_ONE, value: parseEther('10') }),
      treasury.sendTransaction({ to: CAKE_WHALE_TWO, value: parseEther('10') }),
      treasury.sendTransaction({
        to: CAKE_WHALE_THREE,
        value: parseEther('10'),
      }),
    ]);

    [alice, bob, jose] = await Promise.all([
      ethers.getSigner(CAKE_WHALE_ONE),
      ethers.getSigner(CAKE_WHALE_TWO),
      ethers.getSigner(CAKE_WHALE_THREE),
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

    oracle = await deployUUPS('Oracle', [mockTWAP.address]);

    await oracle.connect(owner).setFeed(CAKE, CAKE_USD_PRICE_FEED, 0);

    market = await deployUUPS('InterestERC20Market', [
      dinero.address,
      treasury.address,
      oracle.address,
      CAKE,
      ethers.constants.AddressZero,
      INTEREST_RATE,
      parseEther('0.5'),
      parseEther('0.1'),
    ]);

    await Promise.all([
      dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
      CakeContract.connect(alice).approve(
        market.address,
        ethers.constants.MaxUint256
      ),
      CakeContract.connect(bob).approve(
        market.address,
        ethers.constants.MaxUint256
      ),
      CakeContract.connect(jose).approve(
        market.address,
        ethers.constants.MaxUint256
      ),
      market.updateExchangeRate(),
    ]);
  });

  const makeMarketWithVault = async () => {
    const vault = (await deployUUPS('CakeVault', [])) as CakeVault;

    const market = await deployUUPS('InterestERC20Market', [
      dinero.address,
      treasury.address,
      oracle.address,
      CAKE,
      vault.address,
      INTEREST_RATE,
      parseEther('0.5'),
      parseEther('0.1'),
    ]);

    await Promise.all([
      vault.connect(owner).setMarket(market.address),
      dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
      CakeContract.connect(alice).approve(
        vault.address,
        ethers.constants.MaxUint256
      ),
      CakeContract.connect(bob).approve(
        vault.address,
        ethers.constants.MaxUint256
      ),
      CakeContract.connect(jose).approve(
        vault.address,
        ethers.constants.MaxUint256
      ),
      market.updateExchangeRate(),
    ]);

    return [market, vault] as [InterestERC20Market, CakeVault];
  };

  const makeMockOracleMarketWithVault = async () => {
    const vault = (await deployUUPS('CakeVault', [])) as CakeVault;

    const market = await deployUUPS('InterestERC20Market', [
      dinero.address,
      treasury.address,
      mockOracle.address,
      CAKE,
      vault.address,
      INTEREST_RATE,
      parseEther('0.5'),
      parseEther('0.1'),
    ]);

    await mockOracle.__setERC20Price(CAKE, MOCK_ORACLE_PRICE);

    await Promise.all([
      vault.connect(owner).setMarket(market.address),
      dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
      CakeContract.connect(alice).approve(
        vault.address,
        ethers.constants.MaxUint256
      ),
      CakeContract.connect(bob).approve(
        vault.address,
        ethers.constants.MaxUint256
      ),
      CakeContract.connect(jose).approve(
        vault.address,
        ethers.constants.MaxUint256
      ),
      market.updateExchangeRate(),
    ]);

    return [market, vault] as [InterestERC20Market, CakeVault];
  };

  const makeMockOracleMarket = async () => {
    const market = await deployUUPS('InterestERC20Market', [
      dinero.address,
      treasury.address,
      mockOracle.address,
      CAKE,
      ethers.constants.AddressZero,
      INTEREST_RATE,
      parseEther('0.5'),
      parseEther('0.1'),
    ]);

    await mockOracle.__setERC20Price(CAKE, MOCK_ORACLE_PRICE);

    await Promise.all([
      dinero.connect(owner).grantRole(MINTER_ROLE, market.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, market.address),
      CakeContract.connect(alice).approve(
        market.address,
        ethers.constants.MaxUint256
      ),
      CakeContract.connect(bob).approve(
        market.address,
        ethers.constants.MaxUint256
      ),
      CakeContract.connect(jose).approve(
        market.address,
        ethers.constants.MaxUint256
      ),
      market.updateExchangeRate(),
    ]);

    return market;
  };

  describe('function: initialize', () => {
    it('gives the router full allowance', async () => {
      expect(
        await CakeContract.allowance(market.address, PCS_ROUTER)
      ).to.be.equal(ethers.constants.MaxUint256);
    });
    it('reverts if you initialize a deployed the market', async () => {
      await expect(
        market.initialize(
          dinero.address,
          treasury.address,
          oracle.address,
          CAKE,
          ethers.constants.AddressZero,
          INTEREST_RATE,
          parseEther('0.5'),
          parseEther('0.1')
        )
      ).to.revertedWith('Initializable: contract is already initialized');
    });
    it('reverts if the collateral is the zero address', async () => {
      await expect(
        deployUUPS('InterestERC20Market', [
          dinero.address,
          treasury.address,
          oracle.address,
          ethers.constants.AddressZero,
          ethers.constants.AddressZero,
          INTEREST_RATE,
          parseEther('0.5'),
          parseEther('0.1'),
        ])
      ).to.revertedWith('DM: no zero address');
    });
    it('reverts if the maxLTVRatio is out of bounds', async () => {
      await expect(
        deployUUPS('InterestERC20Market', [
          dinero.address,
          treasury.address,
          oracle.address,
          CAKE,
          ethers.constants.AddressZero,
          INTEREST_RATE,
          parseEther('0.49'),
          parseEther('0.1'),
        ])
      ).to.revertedWith('DM: ltc ratio out of bounds');
      await expect(
        deployUUPS('InterestERC20Market', [
          dinero.address,
          treasury.address,
          oracle.address,
          CAKE,
          ethers.constants.AddressZero,
          INTEREST_RATE,
          parseEther('0.91'),
          parseEther('0.1'),
        ])
      ).to.revertedWith('DM: ltc ratio out of bounds');
    });
    it('sets initial state correctly', async () => {
      const [marketWithVault, cakeVault] = await makeMarketWithVault();

      const [
        _dinero,
        _owner,
        _feeTo,
        _oracle,
        _collateral,
        _vault,
        _loan,
        _maxLTVRatio,
        _liquidationFee,
        _vault2,
      ] = await Promise.all([
        market.DINERO(),
        market.owner(),
        market.FEE_TO(),
        market.ORACLE(),
        market.COLLATERAL(),
        market.VAULT(),
        market.loan(),
        market.maxLTVRatio(),
        market.liquidationFee(),
        marketWithVault.VAULT(),
      ]);
      expect(_dinero).to.be.equal(dinero.address);
      expect(_owner).to.be.equal(owner.address);
      expect(_feeTo).to.be.equal(treasury.address);
      expect(_oracle).to.be.equal(oracle.address);
      expect(_collateral).to.be.equal(CAKE);
      expect(_vault).to.be.equal(ethers.constants.AddressZero);
      expect(_loan.INTEREST_RATE).to.be.equal(ethers.BigNumber.from(12e8));
      expect(_maxLTVRatio).to.be.equal(
        ethers.BigNumber.from('500000000000000000')
      );
      expect(_liquidationFee).to.be.equal(
        ethers.BigNumber.from('100000000000000000')
      );
      expect(_vault2).to.be.equal(cakeVault.address);
    });
  });

  it('allows the router allowance to be maxed out', async () => {
    const market = await makeMockOracleMarket();

    await market.connect(alice).addCollateral(alice.address, parseEther('10'));

    // We need to borrow and then liquidate in order to use some of router allowance to increase it
    await market.connect(alice).borrow(alice.address, parseEther('99'));

    // Drop CAKE to 15 USD. Alice can now be liquidated
    await mockOracle.__setERC20Price(CAKE, parseEther('15'));

    // Liquidate alice using the collateral so router will use some allowance
    await market
      .connect(owner)
      .liquidate(
        [alice.address],
        [parseEther('10')],
        owner.address,
        [CAKE, WBNB, dinero.address],
        []
      );

    const currentAllowance = await CakeContract.allowance(
      market.address,
      PCS_ROUTER
    );

    // Make sure that current allowance is not maxed out
    expect(ethers.constants.MaxUint256.gt(currentAllowance)).to.be.equal(true);

    await expect(market.approve())
      .to.emit(CakeContract, 'Approval')
      .withArgs(market.address, PCS_ROUTER, ethers.constants.MaxUint256);

    expect(
      await CakeContract.allowance(market.address, PCS_ROUTER)
    ).to.be.equal(ethers.constants.MaxUint256);
  });

  it('sends the feesEarned to the treasury', async () => {
    // Add 50 CAKE as collateral
    await market.connect(alice).addCollateral(alice.address, parseEther('50'));

    // Borrow 490 DINERO
    await market.connect(alice).borrow(alice.address, parseEther('200'));

    // Pass time to accrue fees
    await advanceTime(10_000, ethers); // advance 10_000 seconds

    const debt = parseEther('200')
      .mul(ethers.BigNumber.from(12e8))
      .mul(10_000)
      .div(parseEther('1'));

    expect(await dinero.balanceOf(treasury.address)).to.be.equal(0);
    expect((await market.totalLoan()).elastic).to.be.equal(parseEther('200'));

    // Due to time delays of asynchronous code and the fact that interest is calculated based on time. We cannot guarantee that the value of debt is accurate but only an approximation.
    await expect(market.getEarnings())
      .to.emit(market, 'Accrue')
      .to.emit(market, 'GetEarnings');

    expect((await market.loan()).feesEarned).to.be.equal(0);
    expect((await dinero.balanceOf(treasury.address)).gte(debt)).to.be.equal(
      true
    );
    expect(
      (await market.totalLoan()).elastic.gte(parseEther('200').add(debt))
    ).to.be.equal(true);
  });

  describe('function: accrue', () => {
    it('does not update the state if there is no debt', async () => {
      const loan = await market.loan();
      await expect(market.accrue()).not.emit(market, 'Accrue');
      expect(
        loan.lastAccrued.lt((await market.loan()).lastAccrued)
      ).to.be.equal(true);
    });
    it('does not update if no time has passed', async () => {
      await network.provider.send('evm_setAutomine', [false]);

      // Add 50 CAKE as collateral
      await market
        .connect(alice)
        .addCollateral(alice.address, parseEther('50'));

      await advanceBlock(ethers);

      // Borrow 490 DINERO
      await market.connect(alice).borrow(alice.address, parseEther('200'));

      await advanceBlock(ethers);

      await advanceBlockAndTime(50_000, ethers);

      const receipt = await market.accrue();
      const receipt2 = await market.accrue();

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
      await market
        .connect(alice)
        .addCollateral(alice.address, parseEther('50'));

      // Borrow 490 DINERO
      await market.connect(alice).borrow(alice.address, parseEther('200'));
      const [loan, totalLoan] = await Promise.all([
        market.loan(),
        market.totalLoan(),
      ]);

      // Pass time to accrue fees
      await advanceTime(10_000, ethers); // advance 10_000 seconds
      const debt = parseEther('200')
        .mul(ethers.BigNumber.from(12e8))
        .mul(10_000)
        .div(parseEther('1'));

      await expect(market.accrue()).to.emit(market, 'Accrue');

      const [loan2, totalLoan2] = await Promise.all([
        market.loan(),
        market.totalLoan(),
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
      const market = await makeMockOracleMarket();

      await mockOracle.__setERC20Price(CAKE, 0);
      await expect(market.updateExchangeRate()).to.revertedWith(
        'MKT: invalid exchange rate'
      );
    });
    it('updates the exchange rate', async () => {
      const market = await makeMockOracleMarket();

      expect(await market.exchangeRate()).to.be.equal(MOCK_ORACLE_PRICE);

      await expect(market.updateExchangeRate()).to.not.emit(
        market,
        'ExchangeRate'
      );

      expect(await market.exchangeRate()).to.be.equal(MOCK_ORACLE_PRICE);

      // Update the exchange rate
      await mockOracle.__setERC20Price(CAKE, parseEther('30'));

      await expect(market.updateExchangeRate())
        .to.emit(market, 'ExchangeRate')
        .withArgs(parseEther('30'));

      expect(await market.exchangeRate()).to.be.equal(parseEther('30'));
    });
  });

  describe('function: addCollateral', () => {
    it('reverts if invalid arguments are passed', async () => {
      await expect(
        market.addCollateral(ethers.constants.AddressZero, 1)
      ).to.revertedWith('DM: no zero address');
      await expect(market.addCollateral(alice.address, 0)).to.revertedWith(
        'DM: no zero amount'
      );
    });

    it('accepts collateral and deposits to the vault', async () => {
      const [market, cakeVault] = await makeMarketWithVault();

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
        .to.emit(cakeVault, 'Deposit')
        .withArgs(alice.address, alice.address, amount)
        .to.emit(CakeContract, 'Transfer')
        .withArgs(alice.address, cakeVault.address, amount);

      const [totalCollateral2, aliceCollateral2] = await Promise.all([
        market.totalCollateral(),
        market.userCollateral(alice.address),
      ]);

      expect(totalCollateral2).to.be.equal(amount);

      expect(aliceCollateral2).to.be.equal(amount);

      await expect(market.connect(bob).addCollateral(alice.address, amount))
        .to.emit(market, 'AddCollateral')
        .withArgs(bob.address, alice.address, amount)
        .to.emit(cakeVault, 'Deposit')
        .withArgs(bob.address, alice.address, amount)
        .to.emit(CakeContract, 'Transfer')
        .withArgs(bob.address, cakeVault.address, amount);

      const [
        totalCollateral3,
        aliceCollateral3,
        bobCollateral3,
        marketCakeBalance3,
      ] = await Promise.all([
        market.totalCollateral(),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        CakeContract.balanceOf(market.address),
      ]);

      expect(totalCollateral3).to.be.equal(amount.add(amount));
      expect(aliceCollateral3).to.be.equal(amount.add(amount));
      expect(bobCollateral3).to.be.equal(0);
      expect(marketCakeBalance3).to.be.equal(0); // Cake is in the masterChef
    });
    it('accepts collateral without a vault', async () => {
      const [totalCollateral, aliceCollateral] = await Promise.all([
        market.totalCollateral(),
        market.userCollateral(alice.address),
      ]);

      expect(totalCollateral).to.be.equal(0);
      expect(aliceCollateral).to.be.equal(0);

      const amount = parseEther('25');

      await expect(market.connect(alice).addCollateral(alice.address, amount))
        .to.emit(market, 'AddCollateral')
        .withArgs(alice.address, alice.address, amount)
        .to.emit(CakeContract, 'Transfer')
        .withArgs(alice.address, market.address, amount);

      const [totalCollateral2, aliceCollateral2] = await Promise.all([
        market.totalCollateral(),
        market.userCollateral(alice.address),
      ]);

      expect(totalCollateral2).to.be.equal(amount);
      expect(aliceCollateral2).to.be.equal(amount);

      await expect(market.connect(bob).addCollateral(alice.address, amount))
        .to.emit(market, 'AddCollateral')
        .withArgs(bob.address, alice.address, amount)
        .to.emit(CakeContract, 'Transfer')
        .withArgs(bob.address, market.address, amount);

      const [
        totalCollateral3,
        aliceCollateral3,
        bobCollateral3,
        marketCakeBalance3,
      ] = await Promise.all([
        market.totalCollateral(),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        CakeContract.balanceOf(market.address),
      ]);

      expect(totalCollateral3).to.be.equal(amount.add(amount));

      expect(aliceCollateral3).to.be.equal(amount.add(amount));
      expect(bobCollateral3).to.be.equal(0);
      expect(marketCakeBalance3).to.be.equal(amount.add(amount));
    });
  });

  describe('function: withdrawCollateral', () => {
    it('reverts if you pass invalid arguments', async () => {
      await expect(
        market
          .connect(alice)
          .withdrawCollateral(ethers.constants.AddressZero, 0)
      ).to.revertedWith('DM: no zero address');
    });
    it('reverts if the user is insolvent', async () => {
      await market
        .connect(alice)
        .addCollateral(alice.address, parseEther('10'));

      await market.connect(alice).borrow(alice.address, parseEther('45'));

      await expect(
        market.connect(alice).withdrawCollateral(alice.address, parseEther('2'))
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('removes collateral using a vault', async () => {
      const [market, cakeVault] = await makeMarketWithVault();

      const aliceAmount = parseEther('3000');
      const bobAmount = parseEther('400');

      await Promise.all([
        market.connect(alice).addCollateral(alice.address, aliceAmount),
        market.connect(bob).addCollateral(bob.address, bobAmount),
      ]);

      // We need to borrow to test the Accrue event
      await market.connect(bob).borrow(alice.address, parseEther('10'));

      const [totalCollateral, aliceCollateral, bobCollateral] =
        await Promise.all([
          market.totalCollateral(),
          market.userCollateral(alice.address),
          market.userCollateral(bob.address),
        ]);

      expect(totalCollateral).to.be.equal(aliceAmount.add(bobAmount));

      expect(aliceCollateral).to.be.equal(aliceAmount);
      expect(bobCollateral).to.be.equal(bobAmount);

      await expect(
        market.connect(alice).withdrawCollateral(alice.address, aliceAmount)
      )
        .to.emit(market, 'WithdrawCollateral')
        .withArgs(alice.address, alice.address, aliceAmount)
        .to.emit(cakeVault, 'Withdraw')
        .withArgs(alice.address, alice.address, aliceAmount)
        .to.emit(market, 'Accrue')
        .to.emit(CakeContract, 'Transfer');

      const [
        totalCollateral2,
        aliceCollateral2,
        bobCollateral2,
        aliceCakeBalance2,
        bobCakeBalance2,
      ] = await Promise.all([
        market.totalCollateral(),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        CakeContract.balanceOf(alice.address),
        CakeContract.balanceOf(bob.address),
      ]);

      expect(totalCollateral2).to.be.equal(bobAmount);

      expect(aliceCollateral2).to.be.equal(0);

      expect(bobCollateral2).to.be.equal(bobAmount);

      await advanceBlock(ethers);
      await advanceBlock(ethers);
      await advanceBlock(ethers);
      await advanceBlock(ethers);

      await expect(
        market.connect(bob).withdrawCollateral(alice.address, parseEther('3'))
      )
        .to.emit(market, 'WithdrawCollateral')
        .withArgs(bob.address, alice.address, parseEther('3'))
        .to.emit(cakeVault, 'Withdraw')
        .withArgs(bob.address, alice.address, parseEther('3'))
        .to.emit(market, 'Accrue')
        .to.emit(CakeContract, 'Transfer');

      const [
        totalCollateral3,
        bobCollateral3,
        aliceCakeBalance3,
        bobCakeBalance3,
      ] = await Promise.all([
        market.totalCollateral(),
        market.userCollateral(bob.address),
        CakeContract.balanceOf(alice.address),
        CakeContract.balanceOf(bob.address),
      ]);

      expect(totalCollateral3).to.be.equal(bobAmount.sub(parseEther('3')));

      // he got rewards
      expect(bobCollateral3).to.be.equal(bobCollateral2.sub(parseEther('3')));

      expect(aliceCakeBalance3).to.be.equal(
        aliceCakeBalance2.add(parseEther('3'))
      );

      // Got rewards
      expect(bobCakeBalance3.gt(bobCakeBalance2)).to.be.equal(true);
    });
    it('removes collateral without a vault', async () => {
      const aliceAmount = parseEther('12');
      const bobAmount = parseEther('14');

      await Promise.all([
        market.connect(alice).addCollateral(alice.address, aliceAmount),
        market.connect(bob).addCollateral(bob.address, bobAmount),
      ]);

      // We need to borrow to test the Accrue event
      await market.connect(bob).borrow(alice.address, parseEther('10'));

      const [totalCollateral, aliceCollateral, bobCollateral] =
        await Promise.all([
          market.totalCollateral(),
          market.userCollateral(alice.address),
          market.userCollateral(bob.address),
        ]);

      expect(totalCollateral).to.be.equal(aliceAmount.add(bobAmount));
      expect(aliceCollateral).to.be.equal(aliceAmount);
      expect(bobCollateral).to.be.equal(bobAmount);

      await expect(
        market.connect(alice).withdrawCollateral(alice.address, aliceAmount)
      )
        .to.emit(market, 'WithdrawCollateral')
        .withArgs(alice.address, alice.address, aliceAmount)
        .to.emit(market, 'Accrue')
        .to.emit(CakeContract, 'Transfer');

      const [
        totalCollateral2,
        aliceCollateral2,
        bobCollateral2,
        aliceCakeBalance2,
        bobCakeBalance2,
      ] = await Promise.all([
        market.totalCollateral(),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        CakeContract.balanceOf(alice.address),
        CakeContract.balanceOf(bob.address),
      ]);

      expect(totalCollateral2).to.be.equal(bobAmount);

      expect(aliceCollateral2).to.be.equal(0);

      expect(bobCollateral2).to.be.equal(bobAmount);

      await expect(
        market.connect(bob).withdrawCollateral(alice.address, parseEther('3'))
      )
        .to.emit(market, 'WithdrawCollateral')
        .withArgs(bob.address, alice.address, parseEther('3'))
        .to.emit(market, 'Accrue')
        .to.emit(CakeContract, 'Transfer')
        .withArgs(market.address, alice.address, parseEther('3'));

      const [
        totalCollateral3,
        aliceCollateral3,
        bobCollateral3,
        aliceCakeBalance3,
        bobCakeBalance3,
      ] = await Promise.all([
        market.totalCollateral(),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        CakeContract.balanceOf(alice.address),
        CakeContract.balanceOf(bob.address),
      ]);

      expect(totalCollateral3).to.be.equal(bobAmount.sub(parseEther('3')));

      expect(aliceCollateral3).to.be.equal(0);

      expect(bobCollateral3).to.be.equal(bobAmount.sub(parseEther('3')));

      expect(aliceCakeBalance3).to.be.equal(
        aliceCakeBalance2.add(parseEther('3'))
      );

      expect(bobCakeBalance3).to.be.equal(bobCakeBalance2);
    });
  });

  describe('function: setMaxLTVRatio', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(market.connect(alice).setMaxLTVRatio(0)).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });
    it('reverts if we set a collateral higher than 9e5', async () => {
      await expect(
        market
          .connect(owner)
          .setMaxLTVRatio(ethers.BigNumber.from('900000000000000001'))
      ).to.revertedWith('MKT: too high');
    });
    it('updates the max tvl ratio', async () => {
      expect(await market.maxLTVRatio()).to.be.equal(
        ethers.BigNumber.from('500000000000000000')
      );

      await market
        .connect(owner)
        .setMaxLTVRatio(ethers.BigNumber.from('90000000000000000'));

      expect(await market.maxLTVRatio()).to.be.equal(
        ethers.BigNumber.from('90000000000000000')
      );
    });
  });

  describe('function: setLiquidationFee', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(market.connect(alice).setLiquidationFee(0)).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });
    it('reverts if we set a liquidation fee higher than 15e4', async () => {
      await expect(
        market
          .connect(owner)
          .setLiquidationFee(ethers.BigNumber.from('150000000000000001'))
      ).to.revertedWith('MKT: too high');
    });
    it('updates the liquidation fee', async () => {
      expect(await market.liquidationFee()).to.be.equal(
        ethers.BigNumber.from('100000000000000000')
      );

      await market
        .connect(owner)
        .setLiquidationFee(ethers.BigNumber.from('150000000000000000'));

      expect(await market.liquidationFee()).to.be.equal(
        ethers.BigNumber.from('150000000000000000')
      );
    });
  });

  describe('function: setInterestRate', () => {
    it('reverts if it is not called by the owner', async () => {
      await expect(market.connect(alice).setInterestRate(0)).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });
    it('reverts if the interest rate is too high', async () => {
      await expect(
        market
          .connect(owner)
          .setInterestRate(ethers.BigNumber.from(13e8).add(1))
      ).to.revertedWith('MKT: too high');
    });
    it('updates the interest rate', async () => {
      expect((await market.loan()).INTEREST_RATE).to.be.equal(
        ethers.BigNumber.from(12e8)
      );

      await market.connect(owner).setInterestRate(ethers.BigNumber.from(13e8));

      expect((await market.loan()).INTEREST_RATE).to.be.equal(
        ethers.BigNumber.from(13e8)
      );
    });
  });

  describe('function: borrow', () => {
    it('reverts if the user is insolvent', async () => {
      await expect(
        market.connect(alice).borrow(alice.address, 1)
      ).to.revertedWith('MKT: sender is insolvent');

      await market
        .connect(alice)
        .addCollateral(alice.address, parseEther('10')); // 200 USD of collateral

      // @notice the collateral ratio is 49.9%
      await expect(
        market.connect(alice).borrow(alice.address, parseEther('100')) // Borrow 100 USD
      ).to.revertedWith('MKT: sender is insolvent');
    });
    it('reverts if the recipient is the zero address', async () => {
      await market
        .connect(alice)
        .addCollateral(alice.address, parseEther('10')); // 200 USD of collateral

      await expect(
        market
          .connect(alice)
          .borrow(ethers.constants.AddressZero, parseEther('50'))
      ).to.revertedWith('MKT: no zero address');
    });
    it('allows borrowing', async () => {
      await market
        .connect(alice)
        .addCollateral(alice.address, parseEther('100')); // 200 USD of collateral

      const [totalLoan, aliceLoan, aliceDineroBalance, recipientDineroBalance] =
        await Promise.all([
          market.totalLoan(),
          market.userLoan(alice.address),
          dinero.balanceOf(alice.address),
          dinero.balanceOf(recipient.address),
        ]);

      expect(aliceLoan).to.be.equal(0);
      expect(totalLoan.base).to.be.equal(0);
      expect(totalLoan.elastic).to.be.equal(0);

      await expect(
        market.connect(alice).borrow(recipient.address, parseEther('50'))
      )
        .to.emit(dinero, 'Transfer')
        .withArgs(
          ethers.constants.AddressZero,
          recipient.address,
          parseEther('50')
        )
        .to.emit(market, 'Borrow')
        .withArgs(
          alice.address,
          recipient.address,
          parseEther('50'),
          parseEther('50')
        )
        .to.not.emit(market, 'Accrue');

      const [
        totalLoan2,
        aliceLoan2,
        aliceDineroBalance2,
        recipientDineroBalance2,
        bobDineroBalance2,
      ] = await Promise.all([
        market.totalLoan(),
        market.userLoan(alice.address),
        dinero.balanceOf(alice.address),
        dinero.balanceOf(recipient.address),
        dinero.balanceOf(bob.address),
      ]);

      expect(aliceLoan2).to.be.equal(parseEther('50'));
      expect(aliceDineroBalance2).to.be.equal(aliceDineroBalance);
      expect(recipientDineroBalance2).to.be.equal(
        parseEther('50').add(recipientDineroBalance)
      );
      expect(totalLoan2.base).to.be.equal(parseEther('50'));
      expect(totalLoan2.elastic).to.be.equal(parseEther('50'));

      await expect(market.connect(alice).borrow(bob.address, parseEther('30')))
        .to.emit(market, 'Accrue')
        .to.emit(dinero, 'Transfer')
        .withArgs(ethers.constants.AddressZero, bob.address, parseEther('30'))
        .to.emit(market, 'Borrow');

      const [
        totalLoan3,
        aliceLoan3,
        bobLoan3,
        aliceDineroBalance3,
        recipientDineroBalance3,
        bobDineroBalance3,
      ] = await Promise.all([
        market.totalLoan(),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        dinero.balanceOf(alice.address),
        dinero.balanceOf(recipient.address),
        dinero.balanceOf(bob.address),
      ]);

      expect(aliceLoan3).to.be.equal(totalLoan3.base);
      expect(bobLoan3).to.be.equal(0);
      expect(recipientDineroBalance3).to.be.equal(recipientDineroBalance2);
      expect(aliceDineroBalance3).to.be.equal(aliceDineroBalance2);
      expect(bobDineroBalance3).to.be.equal(
        parseEther('30').add(bobDineroBalance2)
      );
      expect(totalLoan3.base.gt(parseEther('78'))).to.be.equal(true); // Due to fees this value is not easy to estimate
      expect(totalLoan3.base.lt(parseEther('80'))).to.be.equal(true); // Due to fees this value is not easy to estimate
      expect(totalLoan3.elastic.gt(parseEther('80'))).to.be.equal(true); // includes fees
    });
  });

  describe('function: repay', () => {
    it('reverts if you try to repay for address(0) or try to repay nothing', async () => {
      await expect(
        market.connect(alice).repay(ethers.constants.AddressZero, 0)
      ).to.revertedWith('MKT: no zero address');
      await expect(
        market.connect(alice).repay(alice.address, 0)
      ).to.revertedWith('MKT: principal cannot be 0');
    });
    it('allows loans to be repaid', async () => {
      await market
        .connect(alice)
        .addCollateral(alice.address, parseEther('10')); // 200 USD of collateral

      await market.connect(alice).borrow(alice.address, parseEther('30'));

      const [totalLoan, aliceLoan, aliceDineroBalance] = await Promise.all([
        market.totalLoan(),
        market.userLoan(alice.address),
        dinero.balanceOf(alice.address),
      ]);

      expect(aliceLoan).to.be.equal(parseEther('30'));

      expect(totalLoan.base).to.be.equal(parseEther('30'));

      // specific debt is very hard to calculate
      await expect(market.connect(alice).repay(alice.address, parseEther('10')))
        .to.emit(market, 'Repay')
        .to.emit(dinero, 'Transfer')
        .to.emit(market, ' Accrue');

      const [totalLoan2, aliceLoan2, aliceDineroBalance2, ownerDineroBalance2] =
        await Promise.all([
          market.totalLoan(),
          market.userLoan(alice.address),
          dinero.balanceOf(alice.address),
          dinero.balanceOf(owner.address),
        ]);

      expect(aliceLoan2).to.be.equal(parseEther('20'));

      // She paid fees
      expect(
        aliceDineroBalance2.lt(aliceDineroBalance.sub(parseEther('10')))
      ).to.be.equal(true);

      expect(totalLoan2.base).to.be.equal(parseEther('20'));
      expect(totalLoan2.elastic.lt(totalLoan.elastic)).to.be.equal(true);

      // specific debt is very hard to calculate
      await expect(market.connect(owner).repay(alice.address, parseEther('20')))
        .to.emit(market, 'Repay')
        .to.emit(dinero, 'Transfer')
        .to.emit(market, ' Accrue');

      const [totalLoan3, aliceLoan3, aliceDineroBalance3, ownerDineroBalance3] =
        await Promise.all([
          market.totalLoan(),
          market.userLoan(alice.address),
          dinero.balanceOf(alice.address),
          dinero.balanceOf(owner.address),
        ]);

      expect(aliceLoan3).to.be.equal(0);

      // She did not pay for her loan. The owner did
      expect(aliceDineroBalance3).to.be.equal(aliceDineroBalance2);

      expect(
        ownerDineroBalance3.lt(ownerDineroBalance2.sub(parseEther('20')))
      ).to.be.equal(true);

      expect(totalLoan3.base).to.be.equal(0);
      expect(totalLoan3.elastic).to.be.equal(0);
    });
  });

  describe('function: liquidate', () => {
    it('reverts if the path exists and does not have dinero in the last index', async () => {
      await expect(
        market
          .connect(owner)
          .liquidate(
            [alice.address],
            [parseEther('1')],
            recipient.address,
            [dinero.address, CAKE],
            []
          )
      ).to.revertedWith('MKT: no dinero at last index');
    });
    it('reverts if there are no accounts to liquidate', async () => {
      await Promise.all([
        market.connect(alice).addCollateral(alice.address, parseEther('10')),
        market.connect(bob).addCollateral(bob.address, parseEther('10')),
        market.connect(jose).addCollateral(jose.address, parseEther('10')),
      ]);

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('30')),
        market.connect(bob).borrow(bob.address, parseEther('30')),
        market.connect(jose).borrow(jose.address, parseEther('30')),
      ]);

      await expect(
        market
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
      const market = await makeMockOracleMarket();

      // Add Collateral
      await Promise.all([
        market.connect(alice).addCollateral(alice.address, parseEther('10')),
        market.connect(jose).addCollateral(jose.address, parseEther('10')),
      ]);

      // Borrow the maximum amount of 49.9%
      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('45')),
        market.connect(jose).borrow(jose.address, parseEther('45')),
      ]);

      // Drop CAKE to 15 USD. Alice and Jose can now be liquidated
      await mockOracle.__setERC20Price(CAKE, parseEther('9'));

      const factoryContract = new ethers.Contract(
        PCS_FACTORY,
        PCSFactoryABI,
        ethers.provider
      );

      const [
        totalCollateral,
        aliceLoan,
        joseLoan,
        aliceCollateral,
        joseCollateral,
        loan,
        pair,
        dineroRecipientBalance,
        recipientCakeBalance,
      ] = await Promise.all([
        market.totalCollateral(),
        market.userLoan(alice.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(jose.address),
        market.loan(),
        factoryContract.getPair(dinero.address, WBNB),
        dinero.balanceOf(recipient.address),
        CakeContract.balanceOf(recipient.address),
      ]);

      expect(totalCollateral).to.be.equal(parseEther('20'));
      expect(aliceLoan).to.be.equal(parseEther('45'));
      // Due to fees paid by alice their principal is lower than 99
      expect(joseLoan.gt(parseEther('43'))).to.be.equal(true);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      // Pass time to accrue fees
      await advanceTime(63_113_904, ethers); // advance 2 years

      // The recipient can liquidate all because he does not need to have `Dinero` he will use the collateral to cover
      await expect(
        market.connect(recipient).liquidate(
          [alice.address, jose.address],
          [parseEther('45'), parseEther('45')],
          recipient.address,
          [CAKE, WBNB, dinero.address], // Enables the use of the router for non LP-tokens.
          []
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
        joseLoan2,
        aliceCollateral2,
        joseCollateral2,
        loan2,
        dineroRecipientBalance2,
        recipientCakeBalance2,
      ] = await Promise.all([
        market.totalLoan(),
        market.totalCollateral(),
        market.userLoan(alice.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(jose.address),
        market.loan(),
        dinero.balanceOf(recipient.address),
        CakeContract.balanceOf(recipient.address),
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

      // recipient gets paid in DNR not CAKE
      expect(recipientCakeBalance2).to.be.equal(recipientCakeBalance);

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

    it('liquidates accounts on a market with a vault and without using the router', async () => {
      const [market, cakeVault] = await makeMockOracleMarketWithVault();

      await Promise.all([
        market.connect(alice).addCollateral(alice.address, parseEther('10')),
        market.connect(bob).addCollateral(bob.address, parseEther('100')),
        market.connect(jose).addCollateral(jose.address, parseEther('10')),
      ]);

      await Promise.all([
        market.connect(alice).borrow(alice.address, parseEther('50')),
        market.connect(bob).borrow(bob.address, parseEther('50')),
        market.connect(jose).borrow(jose.address, parseEther('50')),
      ]);

      // Drop CAKE to 9 USD. Alice and Jose can now be liquidated
      await mockOracle.__setERC20Price(CAKE, parseEther('9'));

      const factoryContract = new ethers.Contract(
        PCS_FACTORY,
        PCSFactoryABI,
        ethers.provider
      );

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
        recipientCakeBalance,
      ] = await Promise.all([
        market.totalCollateral(),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.userCollateral(jose.address),
        market.loan(),
        factoryContract.getPair(dinero.address, WBNB),
        dinero.balanceOf(owner.address),
        CakeContract.balanceOf(recipient.address),
      ]);

      expect(totalCollateral).to.be.equal(parseEther('120'));
      expect(aliceLoan).to.be.equal(parseEther('50'));
      // Due to fees paid by alice their principal is lower than 99
      expect(bobLoan.gt(parseEther('47'))).to.be.equal(true);
      expect(joseLoan.gt(parseEther('47'))).to.be.equal(true);

      const pairContract = (
        await ethers.getContractFactory('PancakePair')
      ).attach(pair);

      // Pass time to accrue fees
      await advanceTime(63_113_904, ethers); // advance 2 years

      // All but Bob should be liquidated
      await expect(
        market
          .connect(owner)
          .liquidate(
            [alice.address, bob.address, jose.address],
            [parseEther('50'), parseEther('50'), parseEther('40')],
            recipient.address,
            [],
            []
          )
      )
        .to.emit(market, 'WithdrawCollateral')
        .to.emit(market, 'Repay')
        .to.emit(market, 'Accrue')
        .to.emit(market, 'ExchangeRate')
        .to.emit(dinero, 'Transfer')
        .to.emit(cakeVault, 'Withdraw')
        // Router was not used
        .to.not.emit(pairContract, 'Swap');

      const [
        totalLoan2,
        totalCollateral2,
        aliceLoan2,
        bobLoan2,
        joseLoan2,
        aliceCollateral2,
        bobCollateral2,
        joseCollateral2,
        loan2,
        ownerDineroBalance2,
        exchangeRate,
      ] = await Promise.all([
        market.totalLoan(),
        market.totalCollateral(),
        market.userLoan(alice.address),
        market.userLoan(bob.address),
        market.userLoan(jose.address),
        market.userCollateral(alice.address),
        market.userCollateral(bob.address),
        market.userCollateral(jose.address),
        market.loan(),
        dinero.balanceOf(owner.address),
        market.exchangeRate(),
      ]);

      const allCollateral = aliceCollateral
        .sub(aliceCollateral2)
        .add(joseCollateral.sub(joseCollateral2));

      const allDebt = allCollateral
        .mul(exchangeRate)
        .div(parseEther('1'))
        .mul(parseEther('0.9'))
        .div(parseEther('1'));

      const allFee = allDebt.mul(ethers.BigNumber.from(10e4)).div(1e6);

      const protocolFee = allFee
        .mul(ethers.BigNumber.from(100))
        .div(ethers.BigNumber.from(1000));

      // Alice loan  gets fully repaid
      expect(aliceLoan2).to.be.equal(0);
      // Bob loan still open
      expect(bobLoan2).to.be.equal(bobLoan);
      // Jose loan gets partially repaid
      expect(joseLoan2).to.be.equal(joseLoan.sub(parseEther('40')));

      // Bob does not get liquidated
      expect(bobCollateral2).to.be.equal(bobCollateral);

      // Alice and Jose got liquidated
      expect(totalCollateral.sub(totalCollateral2)).to.be.eq(allCollateral);

      // recipient gets the all the collateral to cover
      expect(await CakeContract.balanceOf(recipient.address)).to.be.equal(
        allCollateral.add(recipientCakeBalance)
      );

      // Means loan2 feesEarned includes accrued + protocol fee
      expect(loan2.feesEarned.sub(protocolFee).gt(loan.feesEarned)).to.be.equal(
        true
      );

      // total loan principal was properly updated
      expect(totalLoan2.base).to.be.equal(bobLoan.add(joseLoan2));
      // We repaid debt for 90 DNR + interest rate. So the remaining debt should be for 60 + fees
      // While it is hard to get the exact number we know it has to be smaller than ~70
      expect(totalLoan2.elastic.lte(parseEther('70'))).to.be.equal(true);

      // Need to remove the two last decimal houses for accuracy
      expect(ownerDineroBalance.sub(ownerDineroBalance2)).to.be.closeTo(
        allDebt.add(protocolFee),
        parseEther('1')
      );
    });
  });

  it('reverts if you pass an unknown request', async () => {
    await expect(
      market
        .connect(alice)
        .request([7], [defaultAbiCoder.encode(['uint256'], [parseEther('2')])])
    ).to.be.revertedWith('DM: invalid request');
  });

  describe('Upgrade functionality', () => {
    it('reverts if it not called by the owner', async () => {
      await market.connect(owner).transferOwnership(alice.address);

      await expect(
        upgrade(market, 'TestInterestERC20MarketV2')
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('updates to version 2', async () => {
      expect(await market.totalCollateral()).to.be.equal(0);

      expect(await market.userCollateral(alice.address)).to.be.equal(0);

      const amount = parseEther('10');

      await expect(market.connect(alice).addCollateral(alice.address, amount))
        .to.emit(market, 'AddCollateral')
        .withArgs(alice.address, alice.address, amount)
        .to.emit(CakeContract, 'Transfer')
        .withArgs(alice.address, market.address, amount);

      expect(await market.totalCollateral()).to.be.equal(amount);

      expect(await market.userCollateral(alice.address)).to.be.equal(amount);

      const marketV2: TestInterestERC20MarketV2 = await upgrade(
        market,
        'TestInterestERC20MarketV2'
      );

      await expect(marketV2.connect(bob).addCollateral(alice.address, amount))
        .to.emit(marketV2, 'AddCollateral')
        .withArgs(bob.address, alice.address, amount)
        .to.emit(CakeContract, 'Transfer')
        .withArgs(bob.address, market.address, amount);

      const [
        totalCollateral,
        aliceCollateral,
        bobCollateral,
        version,
        marketCakeBalance,
      ] = await Promise.all([
        marketV2.totalCollateral(),
        marketV2.userCollateral(alice.address),
        marketV2.userCollateral(bob.address),
        marketV2.version(),
        CakeContract.balanceOf(market.address),
      ]);

      expect(totalCollateral).to.be.equal(amount.add(amount));
      expect(aliceCollateral).to.be.equal(amount.add(amount));
      expect(bobCollateral).to.be.equal(0);
      expect(version).to.be.equal('V2');
      expect(marketCakeBalance).to.be.equal(amount.add(amount)); // Cake is in the masterChef
    });
  });
}).timeout(50_000);
