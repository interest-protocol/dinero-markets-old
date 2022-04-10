import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { Contract } from 'ethers';
import { ethers, network } from 'hardhat';

import ERC20ABI from '../abi/erc20.json';
import PCSFactoryABI from '../abi/pcs-factory.json';
import VenusControllerABI from '../abi/venus-controller.json';
import vTokenABI from '../abi/vToken.json';
import {
  Dinero,
  MockSafeVenus,
  MockVenusToken,
  TestDineroVenusVault,
} from '../typechain';
import {
  BURNER_ROLE,
  DAI,
  DAI_WHALE_ONE,
  MAX_UINT_96,
  MINTER_ROLE,
  ONE_V_TOKEN,
  PCS_FACTORY,
  PCS_ROUTER,
  PRECISION,
  USDC,
  USDC_WHALE_ONE,
  USDC_WHALE_TWO,
  vDAI,
  VENUS_ADMIN,
  VENUS_CONTROLLER,
  vUSDC,
  WBNB,
  XVS,
  XVS_WHALE,
} from './lib/constants';
import { deploy, deployUUPS, impersonate, multiDeploy } from './lib/test-utils';

const { parseEther, defaultAbiCoder } = ethers.utils;

const DINERO_LTV = parseEther('0.7');

describe('DineroVenusVault', () => {
  let dineroVenusVault: TestDineroVenusVault;
  let dinero: Dinero;
  let safeVenus: MockSafeVenus;

  let vUSDCContract: Contract;
  let vDAIContract: Contract;
  let XVSContract: Contract;
  let USDCContract: Contract;
  let venusControllerContract: Contract;

  // Whale
  let USDC_USDC_WHALE: Contract;
  let DAI_DAI_WHALE: Contract;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let usdcWhale: SignerWithAddress;
  let daiWhale: SignerWithAddress;
  let feeTo: SignerWithAddress;
  let mockVUSDC: MockVenusToken;

  beforeEach(async () => {
    [[owner, alice, feeTo], [mockVUSDC, safeVenus], dinero] = await Promise.all(
      [
        ethers.getSigners(),
        multiDeploy(
          ['MockVenusToken', 'MockSafeVenus'],
          [['Fake vToken', 'vFake', 0], []]
        ),
        deployUUPS('Dinero', []),
        impersonate(USDC_WHALE_ONE),
        impersonate(DAI_WHALE_ONE),
        impersonate(VENUS_ADMIN),
      ]
    );

    const [venusAdmin] = await Promise.all([
      ethers.getSigner(VENUS_ADMIN),
      feeTo.sendTransaction({ to: VENUS_ADMIN, value: parseEther('10') }),
      mockVUSDC.__setUnderlying(USDC),
      mockVUSDC.__setCollateralFactor(parseEther('0.9')),
      mockVUSDC.__setExchangeRateCurrent(
        ethers.BigNumber.from('213429808155036526652502393')
      ),
      safeVenus.__setVTokenCollateralFactor(
        mockVUSDC.address,
        parseEther('0.9')
      ),
    ]);

    const venusControllerAdminContract = new ethers.Contract(
      VENUS_CONTROLLER,
      VenusControllerABI,
      venusAdmin
    );

    vUSDCContract = new ethers.Contract(vUSDC, vTokenABI, ethers.provider);
    vDAIContract = new ethers.Contract(vDAI, vTokenABI, ethers.provider);
    XVSContract = new ethers.Contract(XVS, ERC20ABI, ethers.provider);
    USDCContract = new ethers.Contract(USDC, ERC20ABI, ethers.provider);
    venusControllerContract = new ethers.Contract(
      VENUS_CONTROLLER,
      VenusControllerABI,
      ethers.provider
    );

    dineroVenusVault = await deployUUPS('TestDineroVenusVault', [
      dinero.address,
      safeVenus.address,
      feeTo.address,
    ]);

    [usdcWhale, daiWhale] = await Promise.all([
      ethers.getSigner(USDC_WHALE_ONE),
      ethers.getSigner(DAI_WHALE_ONE),
      dinero.connect(owner).grantRole(MINTER_ROLE, dineroVenusVault.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, dineroVenusVault.address),
      impersonate(USDC_WHALE_ONE),
      venusControllerAdminContract._supportMarket(mockVUSDC.address),
    ]);

    USDC_USDC_WHALE = new ethers.Contract(USDC, ERC20ABI, usdcWhale);
    DAI_DAI_WHALE = new ethers.Contract(DAI, ERC20ABI, daiWhale);

    await Promise.all([
      venusControllerAdminContract._setCollateralFactor(
        mockVUSDC.address,
        parseEther('0.8')
      ),
      USDC_USDC_WHALE.approve(
        dineroVenusVault.address,
        ethers.constants.MaxUint256
      ),
      DAI_DAI_WHALE.approve(
        dineroVenusVault.address,
        ethers.constants.MaxUint256
      ),
      dineroVenusVault.connect(owner).addVToken(vUSDC),
      dineroVenusVault.connect(owner).addVToken(vDAI),
      safeVenus.__setVTokenCollateralFactor(vUSDC, parseEther('0.8')),
      safeVenus.__setVTokenCollateralFactor(vDAI, parseEther('0.6')),
    ]);
  });

  it('returns a specific underlying', async () => {
    const [_usdc, _dai, usdc, dai] = await Promise.all([
      dineroVenusVault.getUnderlyingAt(0),
      dineroVenusVault.getUnderlyingAt(1),
      vUSDCContract.callStatic.underlying(),
      vDAIContract.callStatic.underlying(),
    ]);

    expect(_usdc).to.be.equal(usdc);
    expect(_dai).to.be.equal(dai);
  });

  it('returns the total number of underlying supported in the contract', async () => {
    expect(await dineroVenusVault.getTotalUnderlyings()).to.be.equal(2);
  });

  it('returns all underlying supported', async () => {
    const underlyings = await dineroVenusVault.getAllUnderlyings();
    expect(
      underlyings.map((x) => ethers.utils.getAddress(x))
    ).to.have.all.members([USDC, DAI]);
  });

  describe('function: initialize', () => {
    it('reverts if you call after deployment', async () => {
      await expect(
        dineroVenusVault.initialize(
          dinero.address,
          safeVenus.address,
          feeTo.address
        )
      ).to.revertedWith('Initializable: contract is already initialized');
    });
    it('fully approves the router', async () => {
      expect(
        await XVSContract.callStatic.allowance(
          dineroVenusVault.address,
          PCS_ROUTER
        )
      ).to.be.equal(MAX_UINT_96);
    });
    it('sets the initial state correctly', async () => {
      const [
        _owner,
        _paused,
        _safeVenus,
        _feeTo,
        _collateralLimit,
        _compoundDepth,
        _dineroLTV,
      ] = await Promise.all([
        dineroVenusVault.owner(),
        dineroVenusVault.paused(),
        dineroVenusVault.SAFE_VENUS(),
        dineroVenusVault.FEE_TO(),
        dineroVenusVault.collateralLimit(),
        dineroVenusVault.compoundDepth(),
        dineroVenusVault.dineroLTV(),
      ]);
      expect(_owner).to.be.equal(owner.address);
      expect(_paused).to.be.equal(false);
      expect(_safeVenus).to.be.equal(safeVenus.address);
      expect(_feeTo).to.be.equal(feeTo.address);
      expect(_collateralLimit).to.be.equal(parseEther('0.5'));
      expect(_compoundDepth).to.be.equal(3);
      expect(_dineroLTV).to.be.equal(DINERO_LTV);
    });
  });

  describe('Simple Owner functions', () => {
    it('updates the DineroLTV', async () => {
      await expect(
        dineroVenusVault.connect(alice).setDineroLTV(parseEther('0.91'))
      ).to.revertedWith('Ownable: caller is not the owner');

      expect(await dineroVenusVault.dineroLTV()).to.be.equal(DINERO_LTV);

      await expect(
        dineroVenusVault.connect(owner).setDineroLTV(parseEther('0.6'))
      )
        .to.emit(dineroVenusVault, 'DineroLTV')
        .withArgs(DINERO_LTV, parseEther('0.6'));

      expect(await dineroVenusVault.dineroLTV()).to.be.equal(parseEther('0.6'));

      await expect(
        dineroVenusVault.connect(owner).setDineroLTV(parseEther('0.901'))
      ).to.revertedWith('DV: must be lower than 90%');
    });
    it('updates the compoundDepth', async () => {
      await expect(
        dineroVenusVault.connect(alice).setCompoundDepth(0)
      ).to.revertedWith('Ownable: caller is not the owner');

      expect(await dineroVenusVault.compoundDepth()).to.be.equal(3);

      await expect(dineroVenusVault.connect(owner).setCompoundDepth(5))
        .to.emit(dineroVenusVault, 'CompoundDepth')
        .withArgs(3, 5);

      expect(await dineroVenusVault.compoundDepth()).to.be.equal(5);

      await expect(
        dineroVenusVault.connect(owner).setCompoundDepth(20)
      ).to.revertedWith('DV: must be lower than 20');

      await expect(
        dineroVenusVault.connect(owner).setCompoundDepth(21)
      ).to.revertedWith('DV: must be lower than 20');
    });
    it('updates the collateral limit', async () => {
      await expect(
        dineroVenusVault.connect(alice).setCollateralLimit(0)
      ).to.revertedWith('Ownable: caller is not the owner');

      expect(await dineroVenusVault.collateralLimit()).to.be.equal(
        parseEther('0.5')
      );

      await expect(
        dineroVenusVault.connect(owner).setCollateralLimit(parseEther('0.8'))
      )
        .to.emit(dineroVenusVault, 'CollateralLimit')
        .withArgs(parseEther('0.5'), parseEther('0.8'));

      expect(await dineroVenusVault.collateralLimit()).to.be.equal(
        parseEther('0.8')
      );

      await expect(
        dineroVenusVault.setCollateralLimit(parseEther('0.91'))
      ).to.revertedWith('DV: must be lower than 90%');
    });
    it('can pause and unpause the contract', async () => {
      expect(await dineroVenusVault.paused()).to.be.equal(false);

      await expect(dineroVenusVault.connect(owner).pause())
        .to.emit(dineroVenusVault, 'Paused')
        .withArgs(owner.address);

      expect(await dineroVenusVault.paused()).to.be.equal(true);

      await expect(dineroVenusVault.connect(owner).unpause())
        .to.emit(dineroVenusVault, 'Unpaused')
        .withArgs(owner.address);

      await expect(dineroVenusVault.connect(alice).unpause()).to.revertedWith(
        'Ownable: caller is not the owner'
      );

      await expect(dineroVenusVault.connect(alice).pause()).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });
  });
  describe('function: removeVToken', () => {
    it('reverts if it not called by the owner', async () => {
      await expect(
        dineroVenusVault.connect(alice).removeVToken(vUSDC)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if the venus controllers fails to exit the market', async () => {
      const [isUSDCSupported, vTokenOfUSDC] = await Promise.all([
        dineroVenusVault.isUnderlyingSupported(USDC),
        dineroVenusVault.vTokenOf(USDC),
        dineroVenusVault.connect(usdcWhale).deposit(USDC, parseEther('10000')),
      ]);

      expect(isUSDCSupported).to.be.equal(true);
      await dineroVenusVault.borrow(vUSDC, parseEther('5000'));
      expect(vTokenOfUSDC).to.be.equal(vUSDC);

      await expect(dineroVenusVault.removeVToken(vUSDC)).to.revertedWith(
        'DV: failed to exit market'
      );

      const [isUSDCSupported2, vTokenOfUSDC2] = await Promise.all([
        dineroVenusVault.isUnderlyingSupported(USDC),
        dineroVenusVault.vTokenOf(USDC),
      ]);

      expect(isUSDCSupported2).to.be.equal(true);

      expect(vTokenOfUSDC2).to.be.equal(vUSDC);
    });
    it('removes a VToken', async () => {
      const [isUSDCSupported, vTokenOfUSDC] = await Promise.all([
        dineroVenusVault.isUnderlyingSupported(USDC),
        dineroVenusVault.vTokenOf(USDC),
      ]);

      expect(isUSDCSupported).to.be.equal(true);

      expect(vTokenOfUSDC).to.be.equal(vUSDC);

      await expect(dineroVenusVault.connect(owner).removeVToken(vUSDC))
        .to.emit(dineroVenusVault, 'RemoveVToken')
        .withArgs(vUSDC, USDC)
        .to.emit(USDCContract, 'Approval')
        .withArgs(dineroVenusVault.address, vUSDC, 0)
        .to.emit(venusControllerContract, 'MarketExited')
        .withArgs(vUSDC, dineroVenusVault.address);

      const [isUSDCSupported2, vTokenOfUSDC2] = await Promise.all([
        dineroVenusVault.isUnderlyingSupported(USDC),
        dineroVenusVault.vTokenOf(USDC),
      ]);

      expect(isUSDCSupported2).to.be.equal(false);

      expect(vTokenOfUSDC2).to.be.equal(ethers.constants.AddressZero);
    });
  });
  describe('function: addVToken', () => {
    it('reverts if it not called by the owner', async () => {
      await expect(
        dineroVenusVault.connect(alice).addVToken(vUSDC)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('reverts if the venus controller fails to enter the market', async () => {
      const unlistedMarket = await deploy('MockVenusToken', [
        'VU',
        'Venus Unlisted',
        0,
      ]);
      const [isUSDCSupported, vTokenOfUSDC] = await Promise.all([
        dineroVenusVault.isUnderlyingSupported(unlistedMarket.address),
        dineroVenusVault.vTokenOf(unlistedMarket.address),
        unlistedMarket.__setUnderlying(USDC),
      ]);

      expect(isUSDCSupported).to.be.equal(false);

      expect(vTokenOfUSDC).to.be.equal(ethers.constants.AddressZero);

      await expect(
        dineroVenusVault.addVToken(unlistedMarket.address)
      ).to.revertedWith('DV: failed to enter market');
    });
    it('adds a vToken', async () => {
      // We need to remove so we can test the {addVToken}
      await dineroVenusVault.removeVToken(vUSDC);

      const [isUSDCSupported, vTokenOfUSDC] = await Promise.all([
        dineroVenusVault.isUnderlyingSupported(USDC),
        dineroVenusVault.vTokenOf(USDC),
      ]);

      expect(isUSDCSupported).to.be.equal(false);

      expect(vTokenOfUSDC).to.be.equal(ethers.constants.AddressZero);

      await expect(dineroVenusVault.addVToken(vUSDC))
        .to.emit(dineroVenusVault, 'AddVToken')
        .withArgs(vUSDC, USDC)
        .to.emit(venusControllerContract, 'MarketEntered')
        .withArgs(vUSDC, dineroVenusVault.address)
        .to.emit(USDCContract, 'Approval')
        .withArgs(dineroVenusVault.address, vUSDC, ethers.constants.MaxUint256);

      const [isUSDCSupported2, vTokenOfUSDC2] = await Promise.all([
        dineroVenusVault.isUnderlyingSupported(USDC),
        dineroVenusVault.vTokenOf(USDC),
      ]);

      expect(isUSDCSupported2).to.be.equal(true);

      expect(vTokenOfUSDC2).to.be.equal(vUSDC);
    });
  });
  describe('function: emergencyRecovery', async () => {
    it('allows only the owner to call when it is paused', async () => {
      await expect(
        dineroVenusVault.connect(alice).emergencyRecovery()
      ).to.revertedWith('Ownable: caller is not the owner');

      await expect(
        dineroVenusVault.connect(owner).emergencyRecovery()
      ).to.revertedWith('Pausable: not paused');
    });
    it('reverts if it fails to redeem or repay', async () => {
      await dineroVenusVault.connect(owner).removeVToken(vUSDC);
      await Promise.all([
        mockVUSDC.__setRedeemUnderlyingReturn(1),
        dineroVenusVault.connect(owner).addVToken(mockVUSDC.address),
      ]);

      await dineroVenusVault
        .connect(usdcWhale)
        .deposit(USDC, parseEther('1000000'));
      await dineroVenusVault.leverage(mockVUSDC.address);
      await dineroVenusVault.connect(owner).pause();

      await expect(
        dineroVenusVault.connect(owner).emergencyRecovery()
      ).to.revertedWith('DV: failed to redeem');

      await Promise.all([
        mockVUSDC.__setRedeemUnderlyingReturn(0),
        mockVUSDC.__setRepayReturnValue(1),
      ]);
      await expect(
        dineroVenusVault.connect(owner).emergencyRecovery()
      ).to.revertedWith('DV: failed to repay');

      await Promise.all([
        mockVUSDC.__setRedeemReturn(1),
        mockVUSDC.__setRepayReturnValue(0),
      ]);

      await expect(
        dineroVenusVault.connect(owner).emergencyRecovery()
      ).to.revertedWith('DV: failed to redeem vtokens');
    });
    it('repays all USDC and DAI', async () => {
      await Promise.all([
        dineroVenusVault.connect(usdcWhale).deposit(USDC, parseEther('100000')),
        dineroVenusVault.connect(daiWhale).deposit(DAI, parseEther('1000')),
      ]);

      const [vUSDCBalance, vDAIBalance] = await Promise.all([
        vUSDCContract.balanceOf(dineroVenusVault.address),
        vDAIContract.balanceOf(dineroVenusVault.address),
      ]);

      await dineroVenusVault.leverageAll();
      await dineroVenusVault.connect(owner).pause();

      await expect(dineroVenusVault.connect(owner).emergencyRecovery())
        .to.emit(dineroVenusVault, 'EmergencyRecovery')
        .withArgs(vUSDCBalance)
        .to.emit(dineroVenusVault, 'EmergencyRecovery')
        .withArgs(vDAIBalance);

      const [vUSDCBalance2, vDAIBalance2] = await Promise.all([
        vUSDCContract.balanceOf(dineroVenusVault.address),
        vDAIContract.balanceOf(dineroVenusVault.address),
      ]);

      expect(vUSDCBalance2).to.be.equal(0);
      expect(vDAIBalance2).to.be.equal(0);
    });
    it('repays all USDC and not DAI', async () => {
      // vToken redeemUnderlying function will throw like Compound.
      await dineroVenusVault
        .connect(usdcWhale)
        .deposit(USDC, parseEther('100000'));

      await dineroVenusVault.leverage(vUSDC);
      await dineroVenusVault.connect(owner).pause();

      const receipt = await dineroVenusVault.connect(owner).emergencyRecovery();

      const awaitedReceipt = await receipt.wait();

      expect(
        awaitedReceipt.events?.filter((x) => x.event === 'EmergencyRecovery')
          .length
      ).to.be.equal(1);

      expect(
        await vUSDCContract.balanceOf(dineroVenusVault.address)
      ).to.be.equal(0);
    });
  });
  describe('function: repayAll', async () => {
    it('reverts if the caller is not the owner', async () => {
      await expect(
        dineroVenusVault.connect(alice).repayAll(vUSDC)
      ).to.revertedWith('Ownable: caller is not the owner');
    });
    it('does not repay if there if the vault did not borrow', async () => {
      await dineroVenusVault
        .connect(usdcWhale)
        .deposit(USDC, parseEther('100000'));

      const vUSDCBalance = await vUSDCContract.balanceOf(
        dineroVenusVault.address
      );

      await expect(dineroVenusVault.connect(owner).repayAll(vUSDC)).to.not.emit(
        dineroVenusVault,
        'RepayAndRedeem'
      );

      expect(
        await vUSDCContract.balanceOf(dineroVenusVault.address)
      ).to.be.equal(vUSDCBalance);
    });
    it('does not repay if there if the vault borrowed but safe redeem is 0', async () => {
      await dineroVenusVault
        .connect(usdcWhale)
        .deposit(USDC, parseEther('100000'));

      await Promise.all([
        dineroVenusVault.leverage(vUSDC),
        safeVenus.__setSafeRedeem(0),
      ]);

      const vUSDCBalance = await vUSDCContract.balanceOf(
        dineroVenusVault.address
      );

      await expect(dineroVenusVault.connect(owner).repayAll(vUSDC)).to.not.emit(
        dineroVenusVault,
        'RepayAndRedeem'
      );

      expect(
        await vUSDCContract.balanceOf(dineroVenusVault.address)
      ).to.be.equal(vUSDCBalance);
    });
    it('repays all debt', async () => {
      await dineroVenusVault
        .connect(usdcWhale)
        .deposit(USDC, parseEther('100000'));

      await dineroVenusVault.leverage(vUSDC);

      await expect(dineroVenusVault.connect(owner).repayAll(vUSDC))
        .to.emit(dineroVenusVault, 'RepayAndRedeem')
        .to.emit(vUSDCContract, 'Mint');

      await safeVenus.borrowAndSupply(dineroVenusVault.address, vUSDC);

      const [borrowBalance, supplyBalance] = await Promise.all([
        safeVenus.borrowBalance(),
        safeVenus.supplyBalance(),
      ]);

      expect(borrowBalance).to.be.equal(0);
      // We had a small profit
      expect(supplyBalance).to.be.closeTo(
        parseEther('100000'),
        parseEther('0.01')
      );
    });
    it('calls repay and redeem multiple times', async () => {
      await dineroVenusVault
        .connect(usdcWhale)
        .deposit(USDC, parseEther('100000'));

      await dineroVenusVault.leverage(vUSDC);

      const receipt = await dineroVenusVault.connect(owner).repayAll(vUSDC);

      const awaitedReceipt = await receipt.wait();

      const array =
        awaitedReceipt.events?.filter((x) => x.event === 'RepayAndRedeem') ||
        [];

      expect(array.length > 1).to.be.equal(true);
    });
  });
  describe('function: leverage', () => {
    it('reverts if the vToken is not listed', async () => {
      await dineroVenusVault.removeVToken(vUSDC);
      await expect(dineroVenusVault.leverage(vUSDC)).to.revertedWith(
        'DV: not allowed'
      );
    });
    it('does not borrow if the safe borrow amount is 500 USD or less', async () => {
      await dineroVenusVault
        .connect(usdcWhale)
        .deposit(USDC, parseEther('1000'));

      await expect(dineroVenusVault.connect(alice).leverage(vUSDC))
        .to.not.emit(vUSDCContract, 'Borrow')
        // Transfer is emitted when supplying an asset because it mints {vUSDC}.
        .to.not.emit(vUSDCContract, 'Transfer');
    });
    it('does not borrow if compoundDepth is 0', async () => {
      await Promise.all([
        dineroVenusVault.connect(owner).setCompoundDepth(0),
        dineroVenusVault
          .connect(usdcWhale)
          // 2000 USD deposit amount gives enough room to leverage
          .deposit(USDC, parseEther('2000')),
      ]);

      await expect(dineroVenusVault.connect(owner).leverage(vUSDC))
        .to.not.emit(vUSDCContract, 'Borrow')
        // Transfer is emitted when supplying an asset because it mints {vUSDC}.
        .to.not.emit(vUSDCContract, 'Transfer');
    });
    it('reverts if the vToken fails to borrow or supply', async () => {
      await dineroVenusVault.connect(owner).removeVToken(vUSDC);
      await dineroVenusVault.connect(owner).addVToken(mockVUSDC.address);

      await Promise.all([
        mockVUSDC.__setBorrowReturn(2),
        dineroVenusVault
          .connect(usdcWhale)
          // 2000 USD deposit amount gives enough room to leverage
          .deposit(USDC, parseEther('2000')),
      ]);

      await expect(
        dineroVenusVault.connect(owner).leverage(mockVUSDC.address)
      ).to.revertedWith('DV: failed to borrow');

      await Promise.all([
        mockVUSDC.__setBorrowReturn(0),
        mockVUSDC.__setMintReturn(1),
      ]);

      await expect(
        dineroVenusVault.connect(owner).leverage(mockVUSDC.address)
      ).to.revertedWith('DV: failed to mint');
    });
    it('borrows and supplies a maximum of compoundDepth times', async () => {
      const [compoundDepth] = await Promise.all([
        dineroVenusVault.compoundDepth(),
        dineroVenusVault
          .connect(usdcWhale)
          .deposit(USDC, parseEther('300000000')),
      ]);

      const [supply, borrow] = await Promise.all([
        vUSDCContract.callStatic.balanceOfUnderlying(dineroVenusVault.address),
        vUSDCContract.callStatic.borrowBalanceCurrent(dineroVenusVault.address),
      ]);

      // 2_000_000 USD should allow the vault to leverage more than 3x if it was not limited by the {compoundDepth}
      const receipt = await (
        await dineroVenusVault.connect(owner).leverage(vUSDC)
      ).wait();

      const [supply2, borrow2] = await Promise.all([
        vUSDCContract.callStatic.balanceOfUnderlying(dineroVenusVault.address),
        vUSDCContract.callStatic.borrowBalanceCurrent(dineroVenusVault.address),
      ]);

      expect(supply).to.be.closeTo(parseEther('300000000'), parseEther('1'));
      expect(borrow).to.be.equal(0);

      expect(borrow2.gt(borrow)).to.be.equal(true);
      expect(supply2.gt(supply)).to.be.equal(true);

      const borrowTopic = vUSDCContract.interface.getEventTopic(
        vUSDCContract.interface.getEvent('Borrow')
      );
      const supplyTopic = vUSDCContract.interface.getEventTopic(
        vUSDCContract.interface.getEvent('Transfer')
      );

      expect(
        receipt.events
          ?.filter((x) => x.topics.includes(borrowTopic))
          .filter(
            (x) =>
              x.address.toLocaleLowerCase() ===
              vUSDCContract.address.toLocaleLowerCase()
          ).length
      ).to.be.equal(compoundDepth);
      expect(
        receipt.events
          ?.filter((x) => x.topics.includes(supplyTopic))
          .filter(
            (x) =>
              x.address.toLocaleLowerCase() ===
              vUSDCContract.address.toLocaleLowerCase()
          ).length
      ).to.be.equal(compoundDepth);
    });
  });
  it('calls leverage in all listed assets', async () => {
    const [compoundDepth] = await Promise.all([
      dineroVenusVault.compoundDepth(),
      dineroVenusVault.connect(usdcWhale).deposit(USDC, parseEther('2000000')),
      dineroVenusVault.connect(daiWhale).deposit(DAI, parseEther('2000000')),
    ]);

    const receipt = await (
      await dineroVenusVault.connect(owner).leverageAll()
    ).wait();

    const USDCborrowTopic = vUSDCContract.interface.getEventTopic(
      vUSDCContract.interface.getEvent('Borrow')
    );
    const USDCsupplyTopic = vUSDCContract.interface.getEventTopic(
      vUSDCContract.interface.getEvent('Transfer')
    );

    const DAIborrowTopic = vDAIContract.interface.getEventTopic(
      vDAIContract.interface.getEvent('Borrow')
    );
    const DAIsupplyTopic = vDAIContract.interface.getEventTopic(
      vDAIContract.interface.getEvent('Transfer')
    );

    expect(
      receipt.events
        ?.filter((x) => x.topics.includes(USDCborrowTopic))
        .filter(
          (x) =>
            x.address.toLocaleLowerCase() ===
            vUSDCContract.address.toLocaleLowerCase()
        ).length
    ).to.be.equal(compoundDepth);
    expect(
      receipt.events
        ?.filter((x) => x.topics.includes(USDCsupplyTopic))
        .filter(
          (x) =>
            x.address.toLocaleLowerCase() ===
            vUSDCContract.address.toLocaleLowerCase()
        ).length
    ).to.be.equal(compoundDepth);

    expect(
      receipt.events
        ?.filter((x) => x.topics.includes(DAIborrowTopic))
        .filter(
          (x) =>
            x.address.toLocaleLowerCase() ===
            vDAIContract.address.toLocaleLowerCase()
        ).length
    ).to.be.equal(compoundDepth);
    expect(
      receipt.events
        ?.filter((x) => x.topics.includes(DAIsupplyTopic))
        .filter(
          (x) =>
            x.address.toLocaleLowerCase() ===
            vDAIContract.address.toLocaleLowerCase()
        ).length
    ).to.be.equal(compoundDepth);
  });
  describe('function: deleverage', () => {
    it('reverts if the vToken is not listed', async () => {
      await dineroVenusVault.removeVToken(vUSDC);
      await expect(dineroVenusVault.deleverage(vUSDC)).to.revertedWith(
        'DV: not allowed'
      );
    });
    it('does nothing if the deleverage amount is 0', async () => {
      await expect(
        dineroVenusVault.connect(owner).deleverage(vUSDC)
      ).to.not.emit(vUSDCContract, 'Redeem');

      // Should not trigger a deleverage as it stays within the parameters
      // Deleveraged is triggered if parameters change or USDC price of underlying
      await dineroVenusVault.connect(owner).leverage(vUSDC);

      await expect(
        dineroVenusVault.connect(owner).deleverage(vUSDC)
      ).to.not.emit(vUSDCContract, 'Redeem');
    });
    it('reverts if redeemUnderlying or repayBorrow from vToken revert', async () => {
      await dineroVenusVault.removeVToken(vUSDC);
      await dineroVenusVault.addVToken(mockVUSDC.address);
      // Set collateral ratio at 80% which will trigger a deleverage since our safe collateral ratio is at 45%
      await Promise.all([
        mockVUSDC.__setBalanceOfUnderlying(
          dineroVenusVault.address,
          parseEther('100000')
        ),
        mockVUSDC.__setBorrowBalanceCurrent(
          dineroVenusVault.address,
          parseEther('80000')
        ),
        // will trigger the error
        mockVUSDC.__setRedeemUnderlyingReturn(1),
      ]);

      await expect(
        dineroVenusVault.connect(owner).deleverage(mockVUSDC.address)
      ).to.revertedWith('DV: failed to redeem');

      await Promise.all([
        mockVUSDC.__setBalanceOfUnderlying(dineroVenusVault.address, 0),
        mockVUSDC.__setBorrowBalanceCurrent(dineroVenusVault.address, 0),
        mockVUSDC.__setRedeemUnderlyingReturn(0),
        mockVUSDC.__setRepayReturnValue(1),
      ]);

      await Promise.all([
        dineroVenusVault
          .connect(usdcWhale)
          .deposit(USDC, parseEther('2000000')),
      ]);

      // 0.9 (vToken collateral factor) * 0.9 => 0.81. So we borrow up to 0.8 => 2_000_000 * 0.8. Should trigger a deleverage
      await dineroVenusVault.borrow(mockVUSDC.address, parseEther('1600000'));

      await expect(
        dineroVenusVault.connect(owner).deleverage(mockVUSDC.address)
      ).to.revertedWith('DV: failed to repay');
    });
    it('deleverages the vault by redeeming and then repaying', async () => {
      await dineroVenusVault
        .connect(usdcWhale)
        .deposit(USDC, parseEther('1000000'));

      // safe collateral ratio will be 0.9 * 0.5 = 0.45
      // Gonna leverage the vault to 0.7 collateral ratio which will trigger a deleverage
      // We are supplying 1_000_000 and borrowing 550_000 => collateral ratio of 0.55 to trigger a deleverage
      await dineroVenusVault.connect(owner).borrow(vUSDC, parseEther('550000'));

      await expect(dineroVenusVault.connect(owner).deleverage(vUSDC))
        .to.emit(vUSDCContract, 'Redeem')
        .to.emit(vUSDCContract, 'RepayBorrow');
    });
    it('deleverages all listed assets', async () => {
      await Promise.all([
        dineroVenusVault
          .connect(usdcWhale)
          .deposit(USDC, parseEther('1000000')),
        dineroVenusVault.connect(daiWhale).deposit(DAI, parseEther('1000000')),
      ]);

      await Promise.all([
        dineroVenusVault.connect(owner).borrow(vUSDC, parseEther('700000')),
        dineroVenusVault.connect(owner).borrow(vDAI, parseEther('550000')),
      ]);

      const receipt = await (
        await dineroVenusVault.connect(owner).deleverageAll()
      ).wait();

      const USDCRedeemUnderlyingTopic = vUSDCContract.interface.getEventTopic(
        vUSDCContract.interface.getEvent('Redeem')
      );
      const USDCRepayBorrowTopic = vUSDCContract.interface.getEventTopic(
        vUSDCContract.interface.getEvent('RepayBorrow')
      );

      const DAIRedeemUnderlyingTopic = vDAIContract.interface.getEventTopic(
        vDAIContract.interface.getEvent('Redeem')
      );
      const DAIRepayBorrowTopic = vDAIContract.interface.getEventTopic(
        vDAIContract.interface.getEvent('RepayBorrow')
      );

      // Based on previous test calculations, it requires 3 loops of redeem and repay to deleverage a position with a  supply of 1m and 700k borrow.
      expect(
        receipt.events
          ?.filter((x) => x.topics.includes(USDCRedeemUnderlyingTopic))
          .filter(
            (x) =>
              x.address.toLocaleLowerCase() ===
              vUSDCContract.address.toLocaleLowerCase()
          ).length
      ).to.be.equal(5);
      expect(
        receipt.events
          ?.filter((x) => x.topics.includes(USDCRepayBorrowTopic))
          .filter(
            (x) =>
              x.address.toLocaleLowerCase() ===
              vUSDCContract.address.toLocaleLowerCase()
          ).length
      ).to.be.equal(5);

      expect(
        receipt.events
          ?.filter((x) => x.topics.includes(DAIRedeemUnderlyingTopic))
          .filter(
            (x) =>
              x.address.toLocaleLowerCase() ===
              vDAIContract.address.toLocaleLowerCase()
          ).length
      ).to.be.equal(5);
      expect(
        receipt.events
          ?.filter((x) => x.topics.includes(DAIRepayBorrowTopic))
          .filter(
            (x) =>
              x.address.toLocaleLowerCase() ===
              vDAIContract.address.toLocaleLowerCase()
          ).length
      ).to.be.equal(5);
    });
  });
  describe('function: deposit', () => {
    it('reverts if the underlying is not whitelisted', async () => {
      await expect(
        dineroVenusVault.connect(owner).deposit(alice.address, 0)
      ).to.revertedWith('DV: underlying not whitelisted');
    });
    it('reverts if the contract is paused', async () => {
      await dineroVenusVault.connect(owner).pause();
      await expect(
        dineroVenusVault.connect(owner).deposit(USDC, parseEther('1000'))
      ).to.revertedWith('Pausable: paused');
    });
    it('reverts if the user tries to deposit 0 tokens', async () => {
      await expect(
        dineroVenusVault.connect(usdcWhale).deposit(USDC, 0)
      ).to.revertedWith('DV: no zero amount');
    });
    it('does not claim XVS not checks for rewards or losses on first deposit', async () => {
      const [
        usdcWhaleUSDCBalance,
        vUSDCUSDBalance,
        vaultVUSDCBalance,
        exchangeRate,
        totalFreeVTokens,
        usdcWhaleAccount,
        rewards,
        totalFreeUnderlying,
        usdcWhalDineroBalance,
      ] = await Promise.all([
        USDCContract.balanceOf(usdcWhale.address),
        USDCContract.balanceOf(vUSDC),
        vUSDCContract.balanceOf(dineroVenusVault.address),
        vUSDCContract.callStatic.exchangeRateCurrent(),
        dineroVenusVault.totalFreeVTokenOf(vUSDC),
        dineroVenusVault.accountOf(USDC, usdcWhale.address),
        dineroVenusVault.rewardsOf(vUSDC),
        dineroVenusVault.totalFreeUnderlying(USDC),
        dinero.balanceOf(usdcWhale.address),
      ]);

      expect(vaultVUSDCBalance).to.be.equal(0);
      expect(totalFreeVTokens).to.be.equal(0);
      expect(usdcWhaleAccount.vTokens).to.be.equal(0);
      expect(usdcWhaleAccount.principal).to.be.equal(0);
      expect(usdcWhaleAccount.rewardsPaid).to.be.equal(0);
      expect(usdcWhaleAccount.lossVTokensAccrued).to.be.equal(0);
      expect(rewards).to.be.equal(0);
      expect(totalFreeUnderlying).to.be.equal(0);
      expect(usdcWhalDineroBalance).to.be.equal(0);

      const vTokensMinted = parseEther('100000')
        .mul(parseEther('1'))
        .div(exchangeRate);

      const factoryContract = new ethers.Contract(
        PCS_FACTORY,
        PCSFactoryABI,
        ethers.provider
      );

      const wBNBXvsPairAddress = await factoryContract.getPair(WBNB, XVS);

      const wBNBXvsPair = (
        await ethers.getContractFactory('PancakePair')
      ).attach(wBNBXvsPairAddress);

      await expect(
        dineroVenusVault.connect(usdcWhale).deposit(USDC, parseEther('100000'))
      )
        .to.emit(dineroVenusVault, 'Deposit')
        .withArgs(alice.address, USDC, parseEther('100000'), vTokensMinted)
        .to.emit(USDCContract, 'Transfer')
        .withArgs(alice.address, dineroVenusVault.address, parseEther('100000'))
        .to.emit(USDCContract, 'Transfer')
        .withArgs(dineroVenusVault.address, vUSDC, parseEther('100000'))
        .to.emit(vUSDCContract, 'Transfer')
        .withArgs(
          ethers.constants.AddressZero,
          dineroVenusVault.address,
          vTokensMinted
        )
        .to.not.emit(venusControllerContract, 'DistributedSupplierVenus')
        .to.not.emit(venusControllerContract, 'DistributedBorrowerVenus')
        .to.not.emit(dineroVenusVault, 'Loss')
        .to.not.emit(wBNBXvsPair, 'Swap'); // It does not swap if there are no XVS rewards

      const [
        usdcWhaleUSDCBalance2,
        vUSDCUSDBalance2,
        vaultVUSDCBalance2,
        totalFreeVTokens2,
        usdcWhaleAccount2,
        rewards2,
        totalFreeUnderlying2,
        usdcWhaleDineroBalance2,
      ] = await Promise.all([
        USDCContract.balanceOf(usdcWhale.address),
        USDCContract.balanceOf(vUSDC),
        vUSDCContract.balanceOf(dineroVenusVault.address),
        dineroVenusVault.totalFreeVTokenOf(vUSDC),
        dineroVenusVault.accountOf(USDC, usdcWhale.address),
        dineroVenusVault.rewardsOf(vUSDC),
        dineroVenusVault.totalFreeUnderlying(USDC),
        dinero.balanceOf(usdcWhale.address),
      ]);

      expect(
        usdcWhaleUSDCBalance2.eq(usdcWhaleUSDCBalance.sub(parseEther('100000')))
      ).equal(true);

      expect(vUSDCUSDBalance2).to.be.equal(
        vUSDCUSDBalance.add(parseEther('100000'))
      );
      expect(vaultVUSDCBalance2).to.be.closeTo(vTokensMinted, ONE_V_TOKEN);
      expect(totalFreeVTokens2).to.be.closeTo(vTokensMinted, ONE_V_TOKEN);
      expect(rewards2).to.be.equal(0);
      expect(totalFreeUnderlying2).to.be.closeTo(
        parseEther('100000'),
        parseEther('1')
      );
      expect(usdcWhaleDineroBalance2).to.be.equal(
        parseEther('100000').mul(DINERO_LTV).div(parseEther('1'))
      );
      expect(usdcWhaleAccount2.vTokens).to.be.closeTo(
        vTokensMinted,
        ONE_V_TOKEN
      );
      expect(usdcWhaleAccount2.principal).to.be.equal(
        parseEther('100000').mul(DINERO_LTV).div(parseEther('1'))
      );
      expect(usdcWhaleAccount2.rewardsPaid).to.be.equal(0);
      expect(usdcWhaleAccount2.lossVTokensAccrued).to.be.equal(0);

      await expect(
        dineroVenusVault.connect(usdcWhale).deposit(USDC, parseEther('100'))
      )
        .to.emit(venusControllerContract, 'DistributedSupplierVenus')
        .to.not.emit(venusControllerContract, 'DistributedBorrowerVenus');
    });
    it('distributes rewards fairly', async () => {
      await impersonate(USDC_WHALE_TWO);
      const usdcWhale2 = await ethers.getSigner(USDC_WHALE_TWO);

      await dineroVenusVault
        .connect(usdcWhale)
        .deposit(USDC, parseEther('1000000'));

      const USDC_USDC_WHALE_TWO = new ethers.Contract(
        USDC,
        ERC20ABI,
        usdcWhale2
      );

      const [
        vaultVUSDCBalance,
        vUSDCRewards,
        usdcWhaleAccount,
        usdcWhale2Account,
      ] = await Promise.all([
        vUSDCContract.balanceOf(dineroVenusVault.address),
        dineroVenusVault.rewardsOf(vUSDC),
        dineroVenusVault.accountOf(USDC, usdcWhale.address),
        dineroVenusVault.accountOf(USDC, usdcWhale2.address),
        USDC_USDC_WHALE_TWO.approve(
          dineroVenusVault.address,
          ethers.constants.MaxUint256
        ),
      ]);

      const exchangeRate = await vUSDCContract.callStatic.exchangeRateCurrent();

      const usdcWhaleVTokensMinted = parseEther('1000000')
        .mul(parseEther('1'))
        .div(exchangeRate);

      expect(vaultVUSDCBalance).to.be.closeTo(
        usdcWhaleVTokensMinted,
        ONE_V_TOKEN
      );
      expect(vUSDCRewards).to.be.equal(0);
      expect(usdcWhaleAccount.rewardsPaid).to.be.equal(0);
      expect(usdcWhaleAccount.vTokens).to.be.closeTo(
        vaultVUSDCBalance,
        ONE_V_TOKEN
      );
      expect(usdcWhaleAccount.principal).to.be.equal(
        parseEther('1000000').mul(DINERO_LTV).div(parseEther('1'))
      );
      expect(usdcWhale2Account.rewardsPaid).to.be.equal(0);
      expect(usdcWhale2Account.vTokens).to.be.equal(0);
      expect(usdcWhale2Account.principal).to.be.equal(0);

      const factoryContract = new ethers.Contract(
        PCS_FACTORY,
        PCSFactoryABI,
        ethers.provider
      );

      const wBNBXvsPairAddress = await factoryContract.getPair(WBNB, XVS);

      const wBNBXvsPair = (
        await ethers.getContractFactory('PancakePair')
      ).attach(wBNBXvsPairAddress);

      await expect(
        dineroVenusVault
          .connect(usdcWhale2)
          .deposit(USDC, parseEther('2000000'))
      )
        .to.emit(venusControllerContract, 'DistributedSupplierVenus')
        .to.emit(wBNBXvsPair, 'Swap');

      const [
        vaultVUSDCBalance2,
        vUSDCRewards2,
        usdcWhaleAccount2,
        usdcWhale2Account2,
        exchangeRate2,
      ] = await Promise.all([
        vUSDCContract.balanceOf(dineroVenusVault.address),
        dineroVenusVault.rewardsOf(vUSDC),
        dineroVenusVault.accountOf(USDC, usdcWhale.address),
        dineroVenusVault.accountOf(USDC, usdcWhale2.address),
        vUSDCContract.callStatic.exchangeRateCurrent(),
      ]);

      const usdcWhale2VTokensMinted = parseEther('2000000')
        .mul(parseEther('1'))
        .div(exchangeRate2);

      expect(
        vaultVUSDCBalance
          .add(usdcWhale2VTokensMinted)
          .add(
            vUSDCRewards2.mul(vaultVUSDCBalance).div(ONE_V_TOKEN).div(PRECISION)
          )
      ).to.be.closeTo(vaultVUSDCBalance2, ONE_V_TOKEN);

      expect(vUSDCRewards2).to.be.equal(
        vaultVUSDCBalance2
          .sub(vaultVUSDCBalance.add(usdcWhale2VTokensMinted))
          .mul(ONE_V_TOKEN)
          .mul(PRECISION)
          .div(vaultVUSDCBalance)
      );
      expect(usdcWhale2Account2.rewardsPaid).to.be.equal(
        usdcWhale2Account2.vTokens.mul(vUSDCRewards2).div(ONE_V_TOKEN)
      );
      expect(usdcWhale2Account2.vTokens).to.be.closeTo(
        usdcWhale2VTokensMinted,
        ONE_V_TOKEN
      );
      expect(usdcWhaleAccount2.principal).to.be.equal(
        usdcWhaleAccount2.principal
      );
      expect(usdcWhale2Account2.rewardsPaid).to.be.closeTo(
        usdcWhale2VTokensMinted.mul(vUSDCRewards2).div(ONE_V_TOKEN),
        ONE_V_TOKEN
      );
      expect(usdcWhale2Account2.vTokens).to.be.closeTo(
        usdcWhale2VTokensMinted,
        ONE_V_TOKEN
      );
      expect(usdcWhale2Account2.principal).to.be.equal(
        parseEther('2000000').mul(DINERO_LTV).div(parseEther('1'))
      );

      await dineroVenusVault
        .connect(usdcWhale)
        .deposit(USDC, parseEther('150000'));

      const [
        vaultVUSDCBalance3,
        vUSDCRewards3,
        usdcWhaleAccount3,
        usdcWhale2Account3,
        exchangeRate3,
      ] = await Promise.all([
        vUSDCContract.balanceOf(dineroVenusVault.address),
        dineroVenusVault.rewardsOf(vUSDC),
        dineroVenusVault.accountOf(USDC, usdcWhale.address),
        dineroVenusVault.accountOf(USDC, usdcWhale2.address),
        vUSDCContract.callStatic.exchangeRateCurrent(),
      ]);

      const usdcWhaleVTokensMinted2 = parseEther('150000')
        .mul(parseEther('1'))
        .div(exchangeRate3);

      expect(vaultVUSDCBalance3).to.be.closeTo(
        vaultVUSDCBalance2
          .add(usdcWhaleVTokensMinted2)
          .add(
            vUSDCRewards3
              .sub(vUSDCRewards2)
              .mul(usdcWhaleVTokensMinted.add(usdcWhale2VTokensMinted))
              .div(ONE_V_TOKEN)
              .div(PRECISION)
          ),
        ONE_V_TOKEN
      );

      expect(usdcWhaleAccount3.vTokens).to.be.closeTo(
        usdcWhaleAccount2.vTokens
          .add(usdcWhaleVTokensMinted2)
          .add(
            vUSDCRewards3
              .mul(usdcWhaleAccount2.vTokens)
              .div(ONE_V_TOKEN)
              .div(PRECISION)
          ),
        ONE_V_TOKEN
      );
      expect(usdcWhaleAccount3.principal).to.be.equal(
        usdcWhaleAccount2.principal.add(
          parseEther('150000').mul(DINERO_LTV).div(parseEther('1'))
        )
      );
      expect(usdcWhaleAccount3.rewardsPaid).to.be.closeTo(
        vUSDCRewards3.mul(usdcWhaleAccount3.vTokens).div(ONE_V_TOKEN),
        ONE_V_TOKEN
      );

      expect(usdcWhale2Account3.principal).to.be.equal(
        usdcWhale2Account2.principal
      );
      expect(usdcWhale2Account3.vTokens).to.be.equal(
        usdcWhale2Account2.vTokens
      );
      expect(usdcWhale2Account3.rewardsPaid).to.be.equal(
        usdcWhale2Account2.rewardsPaid
      );

      await dineroVenusVault
        .connect(usdcWhale2)
        .deposit(USDC, parseEther('350000'));

      const [
        vaultVUSDCBalance4,
        vUSDCRewards4,
        usdcWhaleAccount4,
        usdcWhale2Account4,
        usdcWhaleDineroBalance,
        usdcWhale2DineroBalance,
        totalFreeVTokens,
        totalFreeUnderlying,
        exchangeRate4,
      ] = await Promise.all([
        vUSDCContract.balanceOf(dineroVenusVault.address),
        dineroVenusVault.rewardsOf(vUSDC),
        dineroVenusVault.accountOf(USDC, usdcWhale.address),
        dineroVenusVault.accountOf(USDC, usdcWhale2.address),
        dinero.balanceOf(usdcWhale.address),
        dinero.balanceOf(usdcWhale2.address),
        dineroVenusVault.totalFreeVTokenOf(vUSDC),
        dineroVenusVault.totalFreeUnderlying(USDC),
        vUSDCContract.callStatic.exchangeRateCurrent(),
      ]);

      const usdcWhale2VTokensMinted2 = parseEther('350000')
        .mul(parseEther('1'))
        .div(exchangeRate4);

      expect(vaultVUSDCBalance4).to.be.closeTo(
        vaultVUSDCBalance3
          .add(usdcWhale2VTokensMinted2)
          .add(
            vUSDCRewards4
              .sub(vUSDCRewards3)
              .mul(usdcWhale2Account3.vTokens.add(usdcWhaleAccount3.vTokens))
              .div(ONE_V_TOKEN)
              .div(PRECISION)
          ),
        ONE_V_TOKEN
      );

      expect(usdcWhale2Account4.vTokens).to.be.closeTo(
        usdcWhale2Account3.vTokens
          .add(
            vUSDCRewards4
              .mul(usdcWhale2Account3.vTokens)
              .div(ONE_V_TOKEN)
              .sub(usdcWhale2Account3.rewardsPaid)
              .div(PRECISION)
          )
          .add(usdcWhale2VTokensMinted2),
        ONE_V_TOKEN
      );
      expect(usdcWhale2Account4.principal).to.be.closeTo(
        usdcWhale2Account3.principal.add(
          parseEther('350000').mul(DINERO_LTV).div(parseEther('1'))
        ),
        ONE_V_TOKEN
      );
      expect(usdcWhale2Account4.rewardsPaid).to.be.closeTo(
        vUSDCRewards4.mul(usdcWhale2Account4.vTokens).div(ONE_V_TOKEN),
        ONE_V_TOKEN
      );

      expect(usdcWhaleAccount4.principal).to.be.equal(
        usdcWhaleAccount3.principal
      );
      expect(usdcWhaleAccount4.vTokens).to.be.equal(usdcWhaleAccount3.vTokens);
      expect(usdcWhaleAccount4.rewardsPaid).to.be.equal(
        usdcWhaleAccount3.rewardsPaid
      );

      expect(usdcWhaleDineroBalance).to.be.equal(usdcWhaleAccount4.principal);
      expect(usdcWhale2DineroBalance).to.be.equal(usdcWhale2Account4.principal);

      expect(totalFreeVTokens).to.be.closeTo(
        usdcWhale2Account4.vTokens.add(usdcWhaleAccount4.vTokens),
        ONE_V_TOKEN
      );

      // The vault has no leverage
      expect(totalFreeUnderlying).to.be.closeTo(
        // TS does not know that Chai supports big number in this matcher with waffle
        vaultVUSDCBalance4.mul(exchangeRate4).div(parseEther('1')),
        ONE_V_TOKEN
      );
    });
    it('calculates losses proportionally', async () => {
      await Promise.all([
        impersonate(VENUS_ADMIN),
        impersonate(USDC_WHALE_TWO),
      ]);
      const [alice, venusAdmin] = await Promise.all([
        ethers.getSigner(USDC_WHALE_TWO),
        ethers.getSigner(VENUS_ADMIN),
      ]);

      const usdcContractAlice = new ethers.Contract(USDC, ERC20ABI, alice);

      await usdcContractAlice.approve(
        dineroVenusVault.address,
        ethers.constants.MaxUint256
      );

      const venusControllerContract = new ethers.Contract(
        VENUS_CONTROLLER,
        VenusControllerABI,
        venusAdmin
      );

      await venusControllerContract._setVenusSpeed(vUSDC, 0); // removes the XVS rewards, which  makes this market unprofitable,

      // Need initial deposit to incur a loss
      await dineroVenusVault
        .connect(alice)
        .deposit(USDC, parseEther('1000000'));

      // To emulate a real life scenario, losses only happen when we leverage the vault position.
      await dineroVenusVault.connect(owner).borrow(vUSDC, parseEther('790000'));

      const [venusSpeed] = await Promise.all([
        venusControllerContract.venusSpeeds(vUSDC),
        dineroVenusVault.burnERC20(USDC, parseEther('790000')),
      ]);

      const [
        aliceAccount,
        totalFreeUnderlying,
        vUSDCTotalLoss,
        exchangeRate,
        totalFreeVTokens,
      ] = await Promise.all([
        dineroVenusVault.accountOf(USDC, alice.address),
        dineroVenusVault.totalFreeUnderlying(USDC),
        dineroVenusVault.totalLossOf(vUSDC),
        vUSDCContract.callStatic.exchangeRateCurrent(),
        dineroVenusVault.totalFreeVTokenOf(vUSDC),
      ]);

      // LOSS IS NOT REGISTERED YET
      const aliceDeposit1 = parseEther('1000000')
        .mul(parseEther('1'))
        .div(exchangeRate);

      expect(vUSDCTotalLoss).to.be.equal(0);
      expect(totalFreeUnderlying).to.be.closeTo(
        parseEther('1000000'),
        parseEther('0.1')
      );

      expect(aliceAccount.vTokens).to.be.closeTo(aliceDeposit1, ONE_V_TOKEN);
      expect(aliceAccount.principal).to.be.equal(
        parseEther('1000000').mul(DINERO_LTV).div(parseEther('1'))
      );
      expect(aliceAccount.rewardsPaid).to.be.equal(0);
      expect(aliceAccount.lossVTokensAccrued).to.be.equal(0);
      expect(totalFreeVTokens).to.be.closeTo(aliceDeposit1, ONE_V_TOKEN);

      await network.provider.send('hardhat_mine', [
        `0x${Number(100).toString(16)}`,
      ]);

      // Alice should incur a loss, as the state will be updated
      // usdcWhale should not incur a loss
      await expect(
        dineroVenusVault.connect(usdcWhale).deposit(USDC, parseEther('50000'))
      ).to.emit(dineroVenusVault, 'Loss');

      const [
        totalFreeUnderlying2,
        vUSDCTotalLoss2,
        totalFreeVTokens2,
        usdcWhaleAccount2,
        exchangeRate2,
      ] = await Promise.all([
        dineroVenusVault.totalFreeUnderlying(USDC),
        dineroVenusVault.totalLossOf(vUSDC),
        dineroVenusVault.totalFreeVTokenOf(vUSDC),
        dineroVenusVault.accountOf(USDC, usdcWhale.address),
        vUSDCContract.callStatic.exchangeRateCurrent(),
        venusControllerContract._setVenusSpeed(vUSDC, venusSpeed.mul(2)), // make it profitable again
      ]);

      const usdcWhaleDeposit2 = parseEther('50000')
        .mul(parseEther('1'))
        .div(exchangeRate2);

      expect(totalFreeUnderlying2).to.be.closeTo(
        totalFreeUnderlying
          .add(parseEther('50000'))
          .sub(
            vUSDCTotalLoss2
              .mul(aliceAccount.vTokens)
              .div(ONE_V_TOKEN)
              .mul(exchangeRate2)
              .div(parseEther('1'))
              .div(PRECISION)
          ),
        parseEther('1')
      );
      // Borrow Rate costs
      expect(
        vUSDCTotalLoss2.gt(
          parseEther('790000').mul(parseEther('1')).div(exchangeRate2)
        )
      ).to.be.equal(true);

      expect(
        totalFreeVTokens2.gt(
          parseEther('1000000')
            .sub(parseEther('790000'))
            .mul(parseEther('1'))
            .div(exchangeRate)
            .add(parseEther('50000').mul(parseEther('1')).div(exchangeRate2))
        )
      ).to.be.equal(true);

      expect(usdcWhaleAccount2.principal).to.be.equal(
        parseEther('50000').mul(DINERO_LTV).div(parseEther('1'))
      );
      // USDC WHALE should not incur any loss
      expect(usdcWhaleAccount2.vTokens).to.be.closeTo(
        usdcWhaleDeposit2,
        ONE_V_TOKEN
      );
      expect(usdcWhaleAccount2.rewardsPaid).to.be.equal(0);
      expect(usdcWhaleAccount2.lossVTokensAccrued).to.be.closeTo(
        vUSDCTotalLoss2.mul(usdcWhaleAccount2.vTokens).div(ONE_V_TOKEN),
        ONE_V_TOKEN
      );

      // Alice should incur a loss
      await expect(
        dineroVenusVault.connect(alice).deposit(USDC, parseEther('450000'))
      ).to.emit(dineroVenusVault, 'Loss');

      const [
        totalFreeUnderlying3,
        vUSDCTotalLoss3,
        totalFreeVTokens3,
        aliceAccount3,
        exchangeRate3,
        totalVUSDCRewards3,
      ] = await Promise.all([
        dineroVenusVault.totalFreeUnderlying(USDC),
        dineroVenusVault.totalLossOf(vUSDC),
        dineroVenusVault.totalFreeVTokenOf(vUSDC),
        dineroVenusVault.accountOf(USDC, alice.address),
        vUSDCContract.callStatic.exchangeRateCurrent(),
        dineroVenusVault.rewardsOf(vUSDC),
      ]);

      const aliceDeposit2 = parseEther('450000')
        .mul(parseEther('1'))
        .div(exchangeRate3);

      expect(vUSDCTotalLoss3.gt(vUSDCTotalLoss2)).to.be.equal(true);

      expect(totalFreeUnderlying3).to.closeTo(
        parseEther('450000')
          .add(totalFreeUnderlying2)
          .sub(
            vUSDCTotalLoss3
              .sub(vUSDCTotalLoss2)
              .mul(totalFreeVTokens2)
              .div(ONE_V_TOKEN)
              .mul(exchangeRate3)
              .div(parseEther('1'))
              .div(PRECISION)
          )
          .add(
            totalVUSDCRewards3
              .mul(totalFreeVTokens2)
              .div(ONE_V_TOKEN)
              .mul(exchangeRate3)
              .div(parseEther('1'))
              .div(PRECISION)
          ),
        parseEther('1')
      );

      // V Tokens loss is only calculated per user
      expect(totalFreeVTokens3).to.be.closeTo(
        totalFreeVTokens2
          .add(aliceDeposit2)
          .sub(
            vUSDCTotalLoss3
              .mul(aliceAccount.vTokens)
              .div(ONE_V_TOKEN)
              .div(PRECISION)
              .sub(aliceAccount.lossVTokensAccrued)
          )
          .add(totalVUSDCRewards3.mul(aliceAccount.vTokens).div(ONE_V_TOKEN)),
        ONE_V_TOKEN
      );

      // She still owes this much DNR
      expect(aliceAccount3.principal).to.be.equal(
        parseEther('1450000').mul(DINERO_LTV).div(parseEther('1'))
      );

      expect(aliceAccount3.vTokens).to.be.closeTo(
        aliceDeposit2
          .add(aliceAccount.vTokens)
          .sub(
            vUSDCTotalLoss3
              .mul(aliceDeposit1)
              .div(ONE_V_TOKEN)
              .div(PRECISION)
              .sub(aliceAccount.lossVTokensAccrued)
          )
          .add(
            totalVUSDCRewards3
              .mul(aliceAccount.vTokens)
              .div(ONE_V_TOKEN)
              .sub(aliceAccount.rewardsPaid)
          ),
        ONE_V_TOKEN
      );
      expect(aliceAccount3.rewardsPaid).to.be.closeTo(
        totalVUSDCRewards3.mul(aliceAccount3.vTokens).div(ONE_V_TOKEN),
        ONE_V_TOKEN.div(10)
      );
      expect(aliceAccount3.lossVTokensAccrued).to.be.closeTo(
        vUSDCTotalLoss3.mul(aliceAccount3.vTokens).div(ONE_V_TOKEN),
        ONE_V_TOKEN
      );
    });
  });

  // describe('function: withdraw', () => {
  //   it('reverts if the contract is paused, the underlying is not supported, the amount is 0 or user does not have enough vTokens', async () => {
  //     await dineroVenusVault.connect(owner).pause();

  //     await expect(dineroVenusVault.withdraw(USDC.address, 0)).to.revertedWith(
  //       'Pausable: paused'
  //     );

  //     await dineroVenusVault.connect(owner).unpause();

  //     await expect(
  //       dineroVenusVault.connect(bob).withdraw(alice.address, 0)
  //     ).to.revertedWith('DV: underlying not whitelisted');

  //     await expect(
  //       dineroVenusVault.connect(bob).withdraw(USDC.address, 0)
  //     ).to.revertedWith('DV: no zero amount');

  //     await dineroVenusVault
  //       .connect(alice)
  //       .deposit(USDC.address, parseEther('1000'));

  //     await expect(
  //       dineroVenusVault
  //         .connect(alice)
  //         .withdraw(
  //           USDC.address,
  //           (
  //             await dineroVenusVault.accountOf(USDC.address, alice.address)
  //           ).vTokens.add(1)
  //         )
  //     ).to.revertedWith('DV: not enough balance');
  //   });
  //   it('reverts if the protocol calculate a safe amount to withdraw', async () => {
  //     const [exchangeRate] = await Promise.all([
  //       vUSDC.exchangeRateCurrent(),
  //       dineroVenusVault
  //         .connect(alice)
  //         .deposit(USDC.address, parseEther('1000')),
  //       safeVenus.__setSafeRedeem(0),
  //     ]);

  //     await expect(
  //       dineroVenusVault
  //         .connect(alice)
  //         .withdraw(
  //           USDC.address,
  //           parseEther('100').mul(parseEther('1')).div(exchangeRate)
  //         )
  //     ).to.revertedWith('DV: failed to withdraw');
  //   });
  //   it('reverts when the redeemUnderlying function fails', async () => {
  //     const [exchangeRate] = await Promise.all([
  //       vUSDC.exchangeRateCurrent(),
  //       dineroVenusVault
  //         .connect(alice)
  //         .deposit(USDC.address, parseEther('1000')),
  //       vUSDC.__setRedeemUnderlyingReturn(1),
  //     ]);

  //     await expect(
  //       dineroVenusVault
  //         .connect(alice)
  //         .withdraw(
  //           USDC.address,
  //           parseEther('100').mul(parseEther('1')).div(exchangeRate)
  //         )
  //     ).to.revertedWith('DV: failed to redeem');
  //   });
  //   it('allows for withdraws', async () => {
  //     const aliceUSDCBalance = await USDC.balanceOf(alice.address);

  //     const [exchangeRate, wBNBXvsPairAddress, decimals] = await Promise.all([
  //       vUSDC.exchangeRateCurrent(),
  //       factory.getPair(WBNB.address, XVS.address),
  //       vUSDC.decimals(),
  //       dineroVenusVault
  //         .connect(alice)
  //         .deposit(USDC.address, parseEther('1000')),
  //     ]);

  //     const oneVUSDC = ethers.BigNumber.from(10).pow(decimals);

  //     const wBNBXvsPair = (
  //       await ethers.getContractFactory('PancakePair')
  //     ).attach(wBNBXvsPairAddress);

  //     const [
  //       aliceDineroBalance,
  //       aliceUSDCBalance2,
  //       totalFreeUnderlying,
  //       aliceAccount,
  //       totalFreeVTokens,
  //     ] = await Promise.all([
  //       dinero.balanceOf(alice.address),
  //       USDC.balanceOf(alice.address),
  //       dineroVenusVault.totalFreeUnderlying(USDC.address),
  //       dineroVenusVault.accountOf(USDC.address, alice.address),
  //       dineroVenusVault.totalFreeVTokenOf(vUSDC.address),
  //     ]);
  //     const vTokenAmount = parseEther('1000')
  //       .mul(parseEther('1'))
  //       .div(exchangeRate);
  //     expect(aliceDineroBalance).to.be.equal(parseEther('1000'));
  //     expect(aliceUSDCBalance2).to.be.equal(
  //       aliceUSDCBalance.sub(parseEther('1000'))
  //     );
  //     expect(totalFreeUnderlying).to.be.equal(parseEther('1000'));
  //     expect(aliceAccount.principal).to.be.equal(parseEther('1000'));
  //     expect(aliceAccount.rewardsPaid).to.be.equal(0);
  //     expect(aliceAccount.lossVTokensAccrued).to.be.equal(0);
  //     expect(aliceAccount.vTokens).to.be.equal(
  //       parseEther('1000').mul(parseEther('1')).div(exchangeRate)
  //     );
  //     expect(totalFreeVTokens).to.be.equal(aliceAccount.vTokens);

  //     const aliceAmountToWithdraw = parseEther('300')
  //       .mul(parseEther('1'))
  //       .div(exchangeRate);

  //     const aliceAmountToRedeem = aliceAmountToWithdraw
  //       .mul(exchangeRate)
  //       .div(parseEther('1'));

  //     const aliceFee = aliceAmountToRedeem
  //       .mul(parseEther('0.005'))
  //       .div(parseEther('1'));

  //     await expect(
  //       dineroVenusVault
  //         .connect(alice)
  //         .withdraw(USDC.address, aliceAmountToWithdraw)
  //     )
  //       .to.emit(dineroVenusVault, 'Withdraw')
  //       .withArgs(
  //         alice.address,
  //         USDC.address,
  //         aliceAmountToRedeem.sub(aliceFee),
  //         aliceAmountToWithdraw
  //       )
  //       .to.emit(dinero, 'Transfer')
  //       .withArgs(
  //         alice.address,
  //         ethers.constants.AddressZero,
  //         aliceAmountToWithdraw.mul(parseEther('1000')).div(vTokenAmount)
  //       )
  //       .to.emit(USDC, 'Transfer')
  //       .withArgs(
  //         dineroVenusVault.address,
  //         alice.address,
  //         aliceAmountToRedeem.sub(aliceFee)
  //       )
  //       .to.emit(USDC, 'Transfer')
  //       .withArgs(dineroVenusVault.address, feeTo.address, aliceFee)
  //       .to.emit(vUSDC, 'RedeemUnderlying')
  //       .to.not.emit(dineroVenusVault, 'Loss')
  //       .to.not.emit(wBNBXvsPair, 'Swap')
  //       .to.not.emit(vUSDC, 'RepayBorrow');

  //     const [
  //       aliceDineroBalance2,
  //       aliceUSDCBalance3,
  //       totalFreeUnderlying2,
  //       aliceAccount2,
  //       totalFreeVTokens2,
  //     ] = await Promise.all([
  //       dinero.balanceOf(alice.address),
  //       USDC.balanceOf(alice.address),
  //       dineroVenusVault.totalFreeUnderlying(USDC.address),
  //       dineroVenusVault.accountOf(USDC.address, alice.address),
  //       dineroVenusVault.totalFreeVTokenOf(vUSDC.address),
  //     ]);

  //     expect(aliceDineroBalance2).to.be.equal(
  //       aliceDineroBalance.sub(
  //         aliceAmountToWithdraw.mul(parseEther('1000')).div(vTokenAmount)
  //       )
  //     );

  //     expect(aliceUSDCBalance3).to.be.equal(
  //       aliceUSDCBalance2.add(aliceAmountToRedeem.sub(aliceFee))
  //     );
  //     expect(totalFreeUnderlying2).to.be.equal(
  //       totalFreeUnderlying.sub(aliceAmountToRedeem)
  //     );
  //     expect(totalFreeVTokens2).to.be.equal(
  //       totalFreeVTokens.sub(aliceAmountToWithdraw)
  //     );

  //     expect(aliceAccount2.principal).to.be.equal(
  //       aliceAccount.principal.sub(
  //         aliceAmountToWithdraw.mul(parseEther('1000')).div(vTokenAmount)
  //       )
  //     );
  //     expect(aliceAccount2.vTokens).to.be.equal(
  //       aliceAccount.vTokens.sub(aliceAmountToWithdraw)
  //     );
  //     expect(aliceAccount2.rewardsPaid).to.be.equal(0);
  //     expect(aliceAccount2.lossVTokensAccrued).to.be.equal(0);

  //     // NOW TEST THE REWARD SYSTEM
  //     await venusController.__setClaimVenusValue(parseEther('1000'));

  //     await dineroVenusVault
  //       .connect(bob)
  //       .deposit(USDC.address, parseEther('25000'));

  //     const vUSDCRewards = await dineroVenusVault.rewardsOf(vUSDC.address);

  //     const aliceAmountToWithdraw2 = parseEther('250')
  //       .mul(parseEther('1'))
  //       .div(exchangeRate);

  //     await expect(
  //       dineroVenusVault
  //         .connect(alice)
  //         .withdraw(USDC.address, aliceAmountToWithdraw2)
  //     ).to.emit(wBNBXvsPair, 'Swap');

  //     const [
  //       aliceDineroBalance3,
  //       aliceUSDCBalance4,
  //       totalFreeUnderlying3,
  //       aliceAccount3,
  //       totalFreeVTokens3,
  //       vUSDCRewards2,
  //     ] = await Promise.all([
  //       dinero.balanceOf(alice.address),
  //       USDC.balanceOf(alice.address),
  //       dineroVenusVault.totalFreeUnderlying(USDC.address),
  //       dineroVenusVault.accountOf(USDC.address, alice.address),
  //       dineroVenusVault.totalFreeVTokenOf(vUSDC.address),
  //       dineroVenusVault.rewardsOf(vUSDC.address),
  //     ]);

  //     const aliceAmountToRedeem2 = aliceAmountToWithdraw2
  //       .add(vUSDCRewards2.mul(aliceAccount2.vTokens).div(oneVUSDC))
  //       .mul(exchangeRate)
  //       .div(parseEther('1'));

  //     const aliceFee2 = aliceAmountToRedeem2
  //       .mul(parseEther('0.005'))
  //       .div(parseEther('1'));

  //     expect(aliceDineroBalance3).to.be.equal(
  //       aliceDineroBalance2.sub(
  //         aliceAmountToWithdraw2
  //           .mul(aliceAccount2.principal)
  //           .div(aliceAccount2.vTokens)
  //       )
  //     );
  //     expect(aliceUSDCBalance4).to.be.equal(
  //       aliceUSDCBalance3.add(aliceAmountToRedeem2).sub(aliceFee2)
  //     );

  //     const bobDepositInVTokens = parseEther('25000')
  //       .mul(parseEther('1'))
  //       .div(exchangeRate);

  //     // TS does not know closeTo supports BigNumber ont he second parameter
  //     expect(totalFreeUnderlying3).to.be.closeTo(
  //       totalFreeUnderlying2
  //         // Alice first rewards
  //         .add(
  //           vUSDCRewards
  //             .mul(aliceAccount2.vTokens)
  //             .div(oneVUSDC)
  //             .mul(exchangeRate)
  //             .div(parseEther('1'))
  //         )
  //         // Second gets Bob deposit
  //         .add(parseEther('25000'))
  //         // Bob rewards
  //         .add(
  //           bobDepositInVTokens
  //             .mul(vUSDCRewards2)
  //             .div(oneVUSDC)
  //             .sub(bobDepositInVTokens.mul(vUSDCRewards).div(oneVUSDC))
  //             .mul(exchangeRate)
  //             .div(parseEther('1'))
  //         )
  //         // Alice second rewards
  //         .add(
  //           vUSDCRewards2
  //             .mul(aliceAccount2.vTokens)
  //             .div(oneVUSDC)
  //             .sub(vUSDCRewards.mul(aliceAccount2.vTokens).div(oneVUSDC))
  //             .mul(exchangeRate)
  //             .div(parseEther('1'))
  //         )
  //         .sub(aliceAmountToRedeem2),
  //       parseEther('1')
  //     );

  //     expect(totalFreeVTokens3).to.be.equal(
  //       aliceAccount3.vTokens.add(bobDepositInVTokens)
  //     );
  //     expect(aliceAccount3.vTokens).to.be.equal(
  //       aliceAccount2.vTokens.sub(aliceAmountToWithdraw2)
  //     );
  //     expect(aliceAccount3.principal).to.be.equal(
  //       aliceAccount2.principal.sub(
  //         aliceAmountToWithdraw2
  //           .mul(aliceAccount2.principal)
  //           .div(aliceAccount2.vTokens)
  //       )
  //     );
  //     expect(aliceAccount3.lossVTokensAccrued).to.be.equal(0);
  //     expect(aliceAccount3.rewardsPaid).to.be.equal(
  //       aliceAccount3.vTokens.mul(vUSDCRewards2).div(oneVUSDC)
  //     );

  //     await expect(
  //       dineroVenusVault
  //         .connect(alice)
  //         .withdraw(USDC.address, aliceAccount3.vTokens)
  //     ).to.not.reverted;

  //     expect(await dinero.balanceOf(alice.address)).to.be.equal(0);
  //   });
  //   it('calculates losses properly', async () => {
  //     await dineroVenusVault
  //       .connect(alice)
  //       .deposit(USDC.address, parseEther('100000'));

  //     await dineroVenusVault.connect(bob).leverage(vUSDC.address);

  //     const [
  //       vaultBalanceOfUnderlying,
  //       totalFreeUnderlying,
  //       vUSDCTotalLoss,
  //       totalFreeVTokens,
  //       exchangeRate,
  //       decimals,
  //     ] = await Promise.all([
  //       vUSDC.balanceOfUnderlying(dineroVenusVault.address),
  //       dineroVenusVault.totalFreeUnderlying(USDC.address),
  //       dineroVenusVault.totalLossOf(vUSDC.address),
  //       dineroVenusVault.totalFreeVTokenOf(vUSDC.address),
  //       vUSDC.exchangeRateCurrent(),
  //       vUSDC.decimals(),
  //     ]);

  //     // Artificially cause a 10% loss on the vault from 100_000 USDC -> 90_000 USDC
  //     await vUSDC.__setBalanceOfUnderlying(
  //       dineroVenusVault.address,
  //       vaultBalanceOfUnderlying.sub(parseEther('10000'))
  //     );

  //     expect(vUSDCTotalLoss).to.be.equal(0);
  //     expect(totalFreeUnderlying).to.be.equal(parseEther('100000'));
  //     expect(totalFreeVTokens).to.be.equal(
  //       parseEther('100000').mul(parseEther('1')).div(exchangeRate)
  //     );

  //     const oneVToken = ethers.BigNumber.from(10).pow(
  //       ethers.BigNumber.from(decimals)
  //     );

  //     await dineroVenusVault
  //       .connect(bob)
  //       .deposit(USDC.address, parseEther('50000'));

  //     const [freeVUSDC, vUSDCTotalLoss2] = await Promise.all([
  //       dineroVenusVault.totalFreeVTokenOf(vUSDC.address),
  //       dineroVenusVault.totalLossOf(vUSDC.address),
  //     ]);

  //     // Loss has been registered in the dapp
  //     expect(vUSDCTotalLoss2).to.be.equal(
  //       parseEther('10000')
  //         .mul(parseEther('1'))
  //         .div(exchangeRate)
  //         .mul(oneVToken)
  //         .div(totalFreeVTokens)
  //     );

  //     //  Loss has not been incurred by bob
  //     expect(freeVUSDC).to.be.closeTo(
  //       parseEther('50000')
  //         .add(parseEther('100000'))
  //         .mul(parseEther('1'))
  //         .div(exchangeRate),
  //       1
  //     );

  //     // Bob is able to completely get his entire deposit back because loss happened before his deposit.
  //     await expect(
  //       dineroVenusVault.connect(bob).withdraw(
  //         USDC.address,
  //         // Bob suffers no loss
  //         parseEther('50000').mul(parseEther('1')).div(exchangeRate)
  //       )
  //     ).to.emit(dineroVenusVault, 'Withdraw');

  //     // Loss still has not been registered in free V Tokens not incurred by BOB
  //     expect(
  //       await dineroVenusVault.totalFreeVTokenOf(vUSDC.address)
  //     ).to.be.closeTo(
  //       parseEther('100000').mul(parseEther('1')).div(exchangeRate),
  //       1
  //     );

  //     const vTokenWithdrawAmount = parseEther('50000')
  //       .mul(parseEther('1'))
  //       .div(exchangeRate);

  //     await dineroVenusVault.connect(alice).withdraw(
  //       USDC.address,
  //       // Bob suffers no loss
  //       vTokenWithdrawAmount
  //     );

  //     const [aliceAccount, freeVUSDC2] = await Promise.all([
  //       dineroVenusVault.accountOf(USDC.address, alice.address),
  //       dineroVenusVault.totalFreeVTokenOf(vUSDC.address),
  //     ]);

  //     expect(aliceAccount.principal).to.be.closeTo(
  //       parseEther('100000').sub(
  //         vTokenWithdrawAmount
  //           .mul(parseEther('100000'))
  //           .div(parseEther('90000').mul(parseEther('1')).div(exchangeRate))
  //       ),
  //       // 1 USD
  //       parseEther('1')
  //     );

  //     expect(aliceAccount.vTokens).to.be.closeTo(
  //       parseEther('40000').mul(parseEther('1')).div(exchangeRate),
  //       oneVToken
  //     );
  //     expect(aliceAccount.rewardsPaid).to.be.equal(0);

  //     // Alice has incurred all losses
  //     expect(aliceAccount.lossVTokensAccrued).to.be.closeTo(
  //       parseEther('40000')
  //         .mul(parseEther('1'))
  //         .div(exchangeRate)
  //         .mul(
  //           parseEther('10000')
  //             .mul(parseEther('1'))
  //             .div(exchangeRate)
  //             .mul(oneVToken)
  //             .div(parseEther('100000').mul(parseEther('1')).div(exchangeRate))
  //         )
  //         .div(oneVToken),
  //       oneVToken
  //     );

  //     // Free USDC should be updated
  //     expect(freeVUSDC2).to.be.closeTo(
  //       parseEther('40000').mul(parseEther('1')).div(exchangeRate),
  //       oneVToken
  //     );
  //   });
  //   it('deleverages the vault if there is not enough underlying to withdraw', async () => {
  //     await dineroVenusVault
  //       .connect(alice)
  //       .deposit(USDC.address, parseEther('100000'));

  //     await dineroVenusVault.connect(bob).leverage(vUSDC.address);

  //     const aliceAccount = await dineroVenusVault.accountOf(
  //       USDC.address,
  //       alice.address
  //     );

  //     await expect(
  //       dineroVenusVault
  //         .connect(alice)
  //         .withdraw(USDC.address, aliceAccount.vTokens)
  //     )
  //       .to.emit(vUSDC, 'RedeemUnderlying')
  //       .to.emit(vUSDC, 'RepayBorrow')
  //       .to.emit(dineroVenusVault, 'Withdraw');

  //     const [borrowBalance, balanceOfUnderlying] = await Promise.all([
  //       vUSDC.borrowBalanceCurrent(dineroVenusVault.address),
  //       vUSDC.balanceOfUnderlying(dineroVenusVault.address),
  //     ]);

  //     expect(borrowBalance.isZero()).to.be.equal(true);

  //     // DUST
  //     // 1 dollar = 1e18
  //     expect(balanceOfUnderlying).to.be.closeTo(
  //       ethers.BigNumber.from(0),
  //       parseEther('0.0001')
  //     );

  //     await dineroVenusVault
  //       .connect(alice)
  //       .deposit(USDC.address, parseEther('100000'));

  //     await dineroVenusVault.connect(bob).leverage(vUSDC.address);

  //     const borrowBalance2 = await vUSDC.borrowBalanceCurrent(
  //       dineroVenusVault.address
  //     );

  //     expect(borrowBalance2.gt(0)).to.be.equal(true);

  //     // We only withdraw one third of the balance so the vault will try it's best to keep the leverage
  //     await expect(
  //       dineroVenusVault
  //         .connect(alice)
  //         .withdraw(USDC.address, aliceAccount.vTokens.div(3))
  //     )
  //       .to.emit(vUSDC, 'RedeemUnderlying')
  //       .to.emit(vUSDC, 'RepayBorrow')
  //       .to.emit(dineroVenusVault, 'Withdraw');

  //     // Vault does not completely deleverage unless it needs
  //     expect(
  //       (await vUSDC.borrowBalanceCurrent(dineroVenusVault.address)).gt(0)
  //     ).to.be.equal(true);
  //   });
  //   it('calculates losses', async () => {
  //     const [exchangeRate, decimals] = await Promise.all([
  //       vUSDC.exchangeRateCurrent(),
  //       vUSDC.decimals(),
  //       dineroVenusVault
  //         .connect(alice)
  //         .deposit(USDC.address, parseEther('100000')),
  //     ]);

  //     const aliceVTokenAmount = parseEther('100000')
  //       .mul(parseEther('1'))
  //       .div(exchangeRate);

  //     const oneVToken = ethers.BigNumber.from(10).pow(decimals);

  //     // 10% loss
  //     await vUSDC.__setBalanceOfUnderlying(
  //       dineroVenusVault.address,
  //       parseEther('90000')
  //     );

  //     // Alice should not incur a loss on this deposit
  //     await dineroVenusVault
  //       .connect(alice)
  //       .deposit(USDC.address, parseEther('30000'));

  //     const aliceAccount = await dineroVenusVault.accountOf(
  //       USDC.address,
  //       alice.address
  //     );

  //     expect(aliceAccount.principal).to.be.equal(parseEther('130000'));
  //     expect(aliceAccount.vTokens).to.be.equal(
  //       // Second deposit
  //       parseEther('30000')
  //         .mul(parseEther('1'))
  //         .div(exchangeRate)
  //         // First deposit
  //         .add(aliceVTokenAmount)
  //         // Loss she incurred
  //         .sub(
  //           parseEther('10000')
  //             .mul(parseEther('1'))
  //             .div(exchangeRate)
  //             .mul(oneVToken)
  //             .div(aliceVTokenAmount)
  //             .mul(aliceVTokenAmount)
  //             .div(oneVToken)
  //         )
  //     );

  //     // Bob should not incur losses
  //     await dineroVenusVault
  //       .connect(bob)
  //       .deposit(USDC.address, parseEther('50000'));

  //     const bobVTokenAmount = parseEther('50000')
  //       .mul(parseEther('1'))
  //       .div(exchangeRate);

  //     await expect(
  //       dineroVenusVault.connect(bob).withdraw(USDC.address, bobVTokenAmount)
  //     )
  //       .to.emit(dineroVenusVault, 'Withdraw')
  //       .withArgs(
  //         bob.address,
  //         USDC.address,
  //         // Bob only pays the fee not 10% loss
  //         bobVTokenAmount
  //           .mul(exchangeRate)
  //           .div(parseEther('1'))
  //           .sub(
  //             bobVTokenAmount
  //               .mul(exchangeRate)
  //               .div(parseEther('1'))
  //               .mul(parseEther('0.005'))
  //               .div(parseEther('1'))
  //           ),
  //         bobVTokenAmount
  //       );
  //   });
  // });

  // describe('Upgrade functionality', () => {
  //   it('reverts if a caller that is the owner calls it', async () => {
  //     await dineroVenusVault.connect(owner).transferOwnership(alice.address);

  //     await expect(
  //       upgrade(dineroVenusVault, 'TestDineroVenusVaultV2')
  //     ).to.revertedWith('Ownable: caller is not the owner');
  //   });

  //   it('upgrades to version 2', async () => {
  //     const [
  //       aliceUSDCBalance,
  //       vUSDCUSDBalance,
  //       vaultVUSDCBalance,
  //       exchangeRate,
  //       totalFreeVTokens,
  //       aliceAccount,
  //       rewards,
  //       totalFreeUnderlying,
  //       aliceDineroBalance,
  //     ] = await Promise.all([
  //       USDC.balanceOf(alice.address),
  //       USDC.balanceOf(vUSDC.address),
  //       vUSDC.balanceOf(dineroVenusVault.address),
  //       vUSDC.exchangeRateCurrent(),
  //       dineroVenusVault.totalFreeVTokenOf(vUSDC.address),
  //       dineroVenusVault.accountOf(USDC.address, alice.address),
  //       dineroVenusVault.rewardsOf(vUSDC.address),
  //       dineroVenusVault.totalFreeUnderlying(USDC.address),
  //       dinero.balanceOf(alice.address),
  //     ]);

  //     expect(vaultVUSDCBalance).to.be.equal(0);
  //     expect(vUSDCUSDBalance).to.be.equal(0);
  //     expect(totalFreeVTokens).to.be.equal(0);
  //     expect(aliceAccount.vTokens).to.be.equal(0);
  //     expect(aliceAccount.principal).to.be.equal(0);
  //     expect(aliceAccount.rewardsPaid).to.be.equal(0);
  //     expect(aliceAccount.lossVTokensAccrued).to.be.equal(0);
  //     expect(rewards).to.be.equal(0);
  //     expect(totalFreeUnderlying).to.be.equal(0);
  //     expect(aliceDineroBalance).to.be.equal(0);

  //     const vTokensMinted = parseEther('100000')
  //       .mul(parseEther('1'))
  //       .div(exchangeRate);

  //     await expect(
  //       dineroVenusVault
  //         .connect(alice)
  //         .deposit(USDC.address, parseEther('100000'))
  //     )
  //       .to.emit(dineroVenusVault, 'Deposit')
  //       .withArgs(
  //         alice.address,
  //         USDC.address,
  //         parseEther('100000'),
  //         vTokensMinted
  //       )
  //       .to.emit(USDC, 'Transfer')
  //       .withArgs(alice.address, dineroVenusVault.address, parseEther('100000'))
  //       .to.emit(USDC, 'Transfer')
  //       .withArgs(dineroVenusVault.address, vUSDC.address, parseEther('100000'))
  //       .to.emit(vUSDC, 'Transfer')
  //       .withArgs(
  //         ethers.constants.AddressZero,
  //         dineroVenusVault.address,
  //         vTokensMinted
  //       )
  //       .to.not.emit(venusController, 'Claim')
  //       .to.not.emit(dineroVenusVault, 'Loss');

  //     const dineroVenusVaultV2: TestDineroVenusVaultV2 = await upgrade(
  //       dineroVenusVault,
  //       'TestDineroVenusVaultV2'
  //     );

  //     const [
  //       aliceUSDCBalance2,
  //       vUSDCUSDBalance2,
  //       vaultVUSDCBalance2,
  //       totalFreeVTokens2,
  //       aliceAccount2,
  //       rewards2,
  //       totalFreeUnderlying2,
  //       version,
  //       aliceDineroBalance2,
  //     ] = await Promise.all([
  //       USDC.balanceOf(alice.address),
  //       USDC.balanceOf(vUSDC.address),
  //       vUSDC.balanceOf(dineroVenusVaultV2.address),
  //       dineroVenusVaultV2.totalFreeVTokenOf(vUSDC.address),
  //       dineroVenusVaultV2.accountOf(USDC.address, alice.address),
  //       dineroVenusVaultV2.rewardsOf(vUSDC.address),
  //       dineroVenusVaultV2.totalFreeUnderlying(USDC.address),
  //       dineroVenusVaultV2.version(),
  //       dinero.balanceOf(alice.address),
  //     ]);

  //     expect(
  //       aliceUSDCBalance2.eq(aliceUSDCBalance.sub(parseEther('100000')))
  //     ).equal(true);
  //     expect(version).to.be.equal('V2');
  //     expect(vUSDCUSDBalance2).to.be.equal(parseEther('100000'));
  //     expect(vaultVUSDCBalance2).to.be.equal(vTokensMinted);
  //     expect(totalFreeVTokens2).to.be.equal(vTokensMinted);
  //     expect(rewards2).to.be.equal(0);
  //     expect(totalFreeUnderlying2).to.be.equal(parseEther('100000'));
  //     expect(aliceDineroBalance2).to.be.equal(parseEther('100000'));
  //     expect(aliceAccount2.vTokens).to.be.equal(vTokensMinted);
  //     expect(aliceAccount2.principal).to.be.equal(parseEther('100000'));
  //     expect(aliceAccount2.rewardsPaid).to.be.equal(0);
  //     expect(aliceAccount2.lossVTokensAccrued).to.be.equal(0);

  //     const wBNBXvsPairAddress = await factory.getPair(
  //       WBNB.address,
  //       XVS.address
  //     );

  //     const wBNBXvsPair = (
  //       await ethers.getContractFactory('PancakePair')
  //     ).attach(wBNBXvsPairAddress);

  //     await expect(
  //       dineroVenusVaultV2.connect(bob).deposit(USDC.address, parseEther('100'))
  //     )
  //       .to.emit(venusController, 'Claim')
  //       .withArgs(dineroVenusVault.address, 0)
  //       // It does not swap if there are no XVS rewards
  //       .to.not.emit(wBNBXvsPair, 'Swap');
  //   });
  // });
}).timeout(10_000);
