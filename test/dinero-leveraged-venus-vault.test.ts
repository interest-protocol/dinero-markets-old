import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber, Contract } from 'ethers';
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
  TestDineroVenusVaultV2,
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
  WBNB_XVS_PAIR,
  XVS,
} from './lib/constants';
import {
  deploy,
  deployUUPS,
  impersonate,
  multiDeploy,
  upgrade,
} from './lib/test-utils';

const { parseEther } = ethers.utils;

const DINERO_LTV = parseEther('0.7');

const calculateFee = (x: BigNumber) =>
  x.mul(parseEther('0.005')).div(parseEther('1'));

describe('Dinero Leverage Venus Vault', () => {
  let dineroVenusVault: TestDineroVenusVault;
  let dinero: Dinero;
  let safeVenus: MockSafeVenus;

  let vUSDCContract: Contract;
  let vDAIContract: Contract;
  let XVSContract: Contract;
  let USDCContract: Contract;
  let venusControllerContract: Contract;
  let venusControllerAdminContract: Contract;

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

    venusControllerAdminContract = new ethers.Contract(
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
    it('it charges a fee to the reserves', async () => {
      const [feeToAccount, exchangeRate] = await Promise.all([
        dineroVenusVault.accountOf(USDC, feeTo.address),
        vUSDCContract.callStatic.exchangeRateCurrent(),
      ]);

      expect(feeToAccount.rewardsPaid).to.be.equal(0);
      expect(feeToAccount.lossVTokensAccrued).to.be.equal(0);
      expect(feeToAccount.vTokens).to.be.equal(0);
      expect(feeToAccount.principal).to.be.equal(0);

      await expect(
        dineroVenusVault.connect(usdcWhale).deposit(USDC, parseEther('100000'))
      ).to.emit(dineroVenusVault, 'Deposit');

      const feeToAccount2 = await dineroVenusVault.accountOf(
        USDC,
        feeTo.address
      );

      expect(feeToAccount2.rewardsPaid).to.be.equal(0);
      expect(feeToAccount2.lossVTokensAccrued).to.be.equal(0);
      expect(feeToAccount2.vTokens).to.be.closeTo(
        calculateFee(
          parseEther('100000').mul(parseEther('1')).div(exchangeRate)
        ),
        1e7 // 1/10 of a vToken
      );
      expect(feeToAccount2.principal).to.be.equal(0);
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

      const fee = calculateFee(vTokensMinted);

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
          vTokensMinted.sub(fee)
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
      expect(totalFreeVTokens2).to.be.closeTo(
        vTokensMinted.sub(fee),
        ONE_V_TOKEN
      );
      expect(rewards2).to.be.equal(0);
      expect(totalFreeUnderlying2).to.be.closeTo(
        parseEther('100000'),
        parseEther('1')
      );
      expect(usdcWhaleDineroBalance2).to.be.equal(
        parseEther('100000').mul(DINERO_LTV).div(parseEther('1'))
      );
      expect(usdcWhaleAccount2.vTokens).to.be.closeTo(
        vTokensMinted.sub(fee),
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
        totalFreeVUSDC,
      ] = await Promise.all([
        vUSDCContract.balanceOf(dineroVenusVault.address),
        dineroVenusVault.rewardsOf(vUSDC),
        dineroVenusVault.accountOf(USDC, usdcWhale.address),
        dineroVenusVault.accountOf(USDC, usdcWhale2.address),
        dineroVenusVault.totalFreeVTokenOf(vUSDC),
        USDC_USDC_WHALE_TWO.approve(
          dineroVenusVault.address,
          ethers.constants.MaxUint256
        ),
      ]);

      const exchangeRate = await vUSDCContract.callStatic.exchangeRateCurrent();

      const usdcWhaleVTokensMinted = parseEther('1000000')
        .mul(parseEther('1'))
        .div(exchangeRate);

      const fee = calculateFee(usdcWhaleVTokensMinted);

      expect(vaultVUSDCBalance).to.be.closeTo(
        usdcWhaleVTokensMinted,
        ONE_V_TOKEN
      );
      expect(vUSDCRewards).to.be.equal(0);
      expect(usdcWhaleAccount.rewardsPaid).to.be.equal(0);
      expect(usdcWhaleAccount.vTokens).to.be.closeTo(
        vaultVUSDCBalance.sub(fee),
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

      const fee2 = calculateFee(usdcWhale2VTokensMinted);

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
          .div(totalFreeVUSDC)
      );
      expect(usdcWhale2Account2.rewardsPaid).to.be.equal(
        usdcWhale2Account2.vTokens.mul(vUSDCRewards2).div(ONE_V_TOKEN)
      );
      expect(usdcWhale2Account2.vTokens).to.be.closeTo(
        usdcWhale2VTokensMinted.sub(fee2),
        ONE_V_TOKEN
      );
      expect(usdcWhaleAccount2.principal).to.be.equal(
        usdcWhaleAccount2.principal
      );
      expect(usdcWhale2Account2.rewardsPaid).to.be.closeTo(
        usdcWhale2VTokensMinted.sub(fee2).mul(vUSDCRewards2).div(ONE_V_TOKEN),
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

      const fee3 = calculateFee(usdcWhaleVTokensMinted2);

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
          )
          .sub(fee3),
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

      const fee4 = calculateFee(usdcWhale2VTokensMinted2);

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
          .add(usdcWhale2VTokensMinted2.sub(fee4)),
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
      await impersonate(USDC_WHALE_TWO);

      const alice = await ethers.getSigner(USDC_WHALE_TWO);

      const usdcContractAlice = new ethers.Contract(USDC, ERC20ABI, alice);

      await usdcContractAlice.approve(
        dineroVenusVault.address,
        ethers.constants.MaxUint256
      );

      const vUSDCSpeed = await venusControllerAdminContract.venusSpeeds(vUSDC);

      await venusControllerAdminContract._setVenusSpeed(vUSDC, 0); // removes the XVS rewards, which  makes this market unprofitable,

      // Need initial deposit to incur a loss
      await dineroVenusVault
        .connect(alice)
        .deposit(USDC, parseEther('1000000'));

      // To emulate a real life scenario, losses only happen when we leverage the vault position.
      await dineroVenusVault.connect(owner).borrow(vUSDC, parseEther('790000'));

      await dineroVenusVault.burnERC20(USDC, parseEther('790000'));

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

      const aliceFee1 = calculateFee(aliceDeposit1);

      expect(vUSDCTotalLoss).to.be.equal(0);
      expect(totalFreeUnderlying).to.be.closeTo(
        parseEther('1000000'),
        parseEther('0.1')
      );

      expect(aliceAccount.vTokens).to.be.closeTo(
        aliceDeposit1.sub(aliceFee1),
        ONE_V_TOKEN
      );
      expect(aliceAccount.principal).to.be.equal(
        parseEther('1000000').mul(DINERO_LTV).div(parseEther('1'))
      );
      expect(aliceAccount.rewardsPaid).to.be.equal(0);
      expect(aliceAccount.lossVTokensAccrued).to.be.equal(0);
      expect(totalFreeVTokens).to.be.closeTo(
        aliceDeposit1.sub(aliceFee1),
        ONE_V_TOKEN
      );

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
      ]);

      const usdcWhaleDeposit2 = parseEther('50000')
        .mul(parseEther('1'))
        .div(exchangeRate2);

      const usdcWhaleFee1 = calculateFee(usdcWhaleDeposit2);

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
            .sub(usdcWhaleFee1)
        )
      ).to.be.equal(true);

      expect(usdcWhaleAccount2.principal).to.be.equal(
        parseEther('50000').mul(DINERO_LTV).div(parseEther('1'))
      );
      // USDC WHALE should not incur any loss
      expect(usdcWhaleAccount2.vTokens).to.be.closeTo(
        usdcWhaleDeposit2.sub(usdcWhaleFee1),
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

      const aliceFee2 = calculateFee(aliceDeposit2);

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
          .add(totalVUSDCRewards3.mul(aliceAccount.vTokens).div(ONE_V_TOKEN))
          .sub(aliceFee2),
        ONE_V_TOKEN
      );

      // She still owes this much DNR
      expect(aliceAccount3.principal).to.be.equal(
        parseEther('1450000').mul(DINERO_LTV).div(parseEther('1'))
      );

      expect(aliceAccount3.vTokens).to.be.closeTo(
        aliceDeposit2
          .sub(aliceFee2)
          .add(aliceAccount.vTokens)
          .sub(
            vUSDCTotalLoss3
              .mul(aliceAccount.vTokens)
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

      await venusControllerAdminContract._setVenusSpeed(vUSDC, vUSDCSpeed);
    });
  });

  describe('function: withdraw', () => {
    it('reverts if the contract is paused, the underlying is not supported, the amount is 0 or user does not have enough vTokens', async () => {
      await dineroVenusVault.connect(owner).pause();

      await expect(dineroVenusVault.withdraw(USDC, 0)).to.revertedWith(
        'Pausable: paused'
      );

      await dineroVenusVault.connect(owner).unpause();

      await expect(
        dineroVenusVault.connect(alice).withdraw(alice.address, 0)
      ).to.revertedWith('DV: underlying not whitelisted');

      await expect(
        dineroVenusVault.connect(alice).withdraw(USDC, 0)
      ).to.revertedWith('DV: no zero amount');

      await dineroVenusVault
        .connect(usdcWhale)
        .deposit(USDC, parseEther('1000'));

      await expect(
        dineroVenusVault
          .connect(usdcWhale)
          .withdraw(
            USDC,
            (
              await dineroVenusVault.accountOf(USDC, usdcWhale.address)
            ).vTokens.add(1)
          )
      ).to.revertedWith('DV: not enough balance');
    });
    it('reverts if the redeemable amount is lower than the withdraw amount', async () => {
      const [exchangeRate] = await Promise.all([
        vUSDCContract.callStatic.exchangeRateCurrent(),
        dineroVenusVault.connect(usdcWhale).deposit(USDC, parseEther('1000')),
        safeVenus.__setSafeRedeem(0),
      ]);

      await expect(
        dineroVenusVault
          .connect(usdcWhale)
          .withdraw(
            USDC,
            parseEther('100').mul(parseEther('1')).div(exchangeRate)
          )
      ).to.revertedWith('DV: failed to withdraw');
    });
    it('reverts when the redeemUnderlying function fails', async () => {
      await dineroVenusVault.removeVToken(vUSDC);
      await dineroVenusVault.addVToken(mockVUSDC.address);

      const [exchangeRate] = await Promise.all([
        mockVUSDC.callStatic.exchangeRateCurrent(),
        dineroVenusVault.connect(usdcWhale).deposit(USDC, parseEther('1000')),
        mockVUSDC.__setRedeemUnderlyingReturn(1),
      ]);

      await expect(
        dineroVenusVault
          .connect(usdcWhale)
          .withdraw(
            USDC,
            parseEther('100').mul(parseEther('1')).div(exchangeRate)
          )
      ).to.revertedWith('DV: failed to redeem');
    });
    it('allows for withdraws', async () => {
      const usdcWhaleUSDCBalance = await USDCContract.balanceOf(
        usdcWhale.address
      );

      const [exchangeRate] = await Promise.all([
        vUSDCContract.callStatic.exchangeRateCurrent(),
        dineroVenusVault.connect(usdcWhale).deposit(USDC, parseEther('1000')),
      ]);

      const wBNBXvsPair = (
        await ethers.getContractFactory('PancakePair')
      ).attach(WBNB_XVS_PAIR);

      const [
        usdcWhaleDineroBalance,
        usdcWhaleUSDCBalance2,
        totalFreeUnderlying,
        usdcWhaleAccount,
        totalFreeVTokens,
      ] = await Promise.all([
        dinero.balanceOf(usdcWhale.address),
        USDCContract.balanceOf(usdcWhale.address),
        dineroVenusVault.totalFreeUnderlying(USDC),
        dineroVenusVault.accountOf(USDC, usdcWhale.address),
        dineroVenusVault.totalFreeVTokenOf(vUSDC),
      ]);

      const vTokenAmount = parseEther('1000')
        .mul(parseEther('1'))
        .div(exchangeRate);

      const fee = calculateFee(vTokenAmount);

      expect(usdcWhaleDineroBalance).to.be.equal(
        parseEther('1000').mul(DINERO_LTV).div(parseEther('1'))
      );
      expect(usdcWhaleUSDCBalance2).to.be.equal(
        usdcWhaleUSDCBalance.sub(parseEther('1000'))
      );
      expect(totalFreeUnderlying).to.be.closeTo(
        parseEther('1000'),
        parseEther('1')
      );
      expect(usdcWhaleAccount.principal).to.be.equal(
        parseEther('1000').mul(DINERO_LTV).div(parseEther('1'))
      );
      expect(usdcWhaleAccount.rewardsPaid).to.be.equal(0);
      expect(usdcWhaleAccount.lossVTokensAccrued).to.be.equal(0);
      expect(usdcWhaleAccount.vTokens).to.be.closeTo(
        vTokenAmount.sub(fee),
        ONE_V_TOKEN
      );
      expect(totalFreeVTokens).to.be.equal(usdcWhaleAccount.vTokens);

      const vUSDCWhaleAmountToWithdraw = parseEther('300')
        .mul(parseEther('1'))
        .div(exchangeRate);

      const usdcWhaleAmountToRedeem = vUSDCWhaleAmountToWithdraw
        .mul(exchangeRate)
        .div(parseEther('1'));

      await expect(
        dineroVenusVault
          .connect(usdcWhale)
          .withdraw(USDC, vUSDCWhaleAmountToWithdraw)
      )
        .to.emit(dineroVenusVault, 'Withdraw')
        .withArgs(
          usdcWhale.address,
          USDC,
          usdcWhaleAmountToRedeem,
          vUSDCWhaleAmountToWithdraw
        )
        .to.emit(dinero, 'Transfer')
        .withArgs(
          usdcWhale.address,
          ethers.constants.AddressZero,
          vUSDCWhaleAmountToWithdraw
            .mul(parseEther('1000'))
            .div(vTokenAmount.sub(fee))
        )
        .to.emit(vUSDCContract, 'Redeem')
        .to.emit(vUSDCContract, 'Transfer')
        .to.not.emit(dineroVenusVault, 'Loss')
        .to.not.emit(wBNBXvsPair, 'Swap')
        .to.not.emit(vUSDCContract, 'RepayBorrow');

      const [
        usdcWhaleDineroBalance2,
        usdcWhaleUSDCBalance3,
        totalFreeUnderlying2,
        usdcWhaleAccount2,
        totalFreeVTokens2,
        rewardsOfVUSDC,
        exchangeRate2,
      ] = await Promise.all([
        dinero.balanceOf(usdcWhale.address),
        USDCContract.balanceOf(usdcWhale.address),
        dineroVenusVault.totalFreeUnderlying(USDC),
        dineroVenusVault.accountOf(USDC, usdcWhale.address),
        dineroVenusVault.totalFreeVTokenOf(vUSDC),
        dineroVenusVault.rewardsOf(vUSDC),
        vUSDCContract.callStatic.exchangeRateCurrent(),
        impersonate(USDC_WHALE_TWO),
      ]);

      expect(usdcWhaleDineroBalance2).to.be.closeTo(
        usdcWhaleDineroBalance.sub(
          vUSDCWhaleAmountToWithdraw
            .mul(usdcWhaleDineroBalance)
            .div(vTokenAmount.sub(fee))
        ),
        parseEther('0.1') // 10 cents
      );

      expect(usdcWhaleUSDCBalance3).to.be.closeTo(
        usdcWhaleUSDCBalance2.add(usdcWhaleAmountToRedeem),
        parseEther('0.1') // 10 cents
      );
      expect(totalFreeUnderlying2).to.be.closeTo(
        totalFreeUnderlying.sub(usdcWhaleAmountToRedeem),
        parseEther('0.1') // 10 cents
      );

      expect(totalFreeVTokens2).to.be.closeTo(
        totalFreeVTokens.sub(vUSDCWhaleAmountToWithdraw),
        ONE_V_TOKEN
      );

      expect(usdcWhaleAccount2.principal).to.be.closeTo(
        usdcWhaleAccount.principal.sub(
          vUSDCWhaleAmountToWithdraw
            .mul(usdcWhaleAccount.principal)
            .div(vTokenAmount.sub(fee))
        ),
        parseEther('0.1') // 10 cents
      );
      expect(usdcWhaleAccount2.vTokens).to.be.equal(
        usdcWhaleAccount.vTokens.sub(vUSDCWhaleAmountToWithdraw)
      );
      expect(usdcWhaleAccount2.rewardsPaid).to.be.equal(
        rewardsOfVUSDC.mul(usdcWhaleAccount2.vTokens).div(ONE_V_TOKEN)
      );
      expect(usdcWhaleAccount2.lossVTokensAccrued).to.be.equal(0);

      const bob = await ethers.getSigner(USDC_WHALE_TWO);

      const bobUSDCContract = new Contract(USDC, ERC20ABI, bob);

      await bobUSDCContract.approve(
        dineroVenusVault.address,
        ethers.constants.MaxUint256
      );

      await dineroVenusVault.connect(bob).deposit(USDC, parseEther('25000'));

      const usdcWhaleAmountToWithdraw2 = parseEther('250')
        .mul(parseEther('1'))
        .div(exchangeRate2);

      await expect(
        dineroVenusVault
          .connect(usdcWhale)
          .withdraw(USDC, usdcWhaleAmountToWithdraw2)
      ).to.emit(wBNBXvsPair, 'Swap');

      const [
        usdcWhaleDineroBalance3,
        usdcWhaleUSDCBalance4,
        totalFreeUnderlying3,
        usdcWhaleAccount3,
        totalFreeVTokens3,
        vUSDCRewards2,
      ] = await Promise.all([
        dinero.balanceOf(usdcWhale.address),
        USDCContract.balanceOf(usdcWhale.address),
        dineroVenusVault.totalFreeUnderlying(USDC),
        dineroVenusVault.accountOf(USDC, usdcWhale.address),
        dineroVenusVault.totalFreeVTokenOf(vUSDC),
        dineroVenusVault.rewardsOf(vUSDC),
      ]);

      const usdcWhaleAmountToRedeem2 = usdcWhaleAmountToWithdraw2
        .add(
          vUSDCRewards2
            .mul(usdcWhaleAccount2.vTokens)
            .div(ONE_V_TOKEN)
            .sub(usdcWhaleAccount2.rewardsPaid)
            .div(PRECISION)
        )
        .mul(exchangeRate2)
        .div(parseEther('1'));

      expect(usdcWhaleDineroBalance3).to.be.equal(
        usdcWhaleDineroBalance2.sub(
          usdcWhaleAmountToWithdraw2
            .mul(usdcWhaleAccount2.principal)
            .div(usdcWhaleAccount2.vTokens)
        )
      );

      expect(usdcWhaleUSDCBalance4).to.be.closeTo(
        usdcWhaleUSDCBalance3.add(usdcWhaleAmountToRedeem2),
        parseEther('0.01') // 1 cent
      );

      const bobDepositInVTokens = parseEther('25000')
        .mul(parseEther('1'))
        .div(exchangeRate2);

      const bobFee = calculateFee(bobDepositInVTokens);

      // TS does not know closeTo supports BigNumber ont he second parameter
      expect(totalFreeUnderlying3).to.be.closeTo(
        totalFreeUnderlying2
          // Bob Deposit
          .add(parseEther('25000'))
          // usdcWhale withdraw
          .sub(usdcWhaleAmountToRedeem2),
        parseEther('1')
      );

      expect(totalFreeVTokens3).to.be.closeTo(
        usdcWhaleAccount3.vTokens.add(bobDepositInVTokens.sub(bobFee)),
        ONE_V_TOKEN
      );
      expect(usdcWhaleAccount3.vTokens).to.be.closeTo(
        usdcWhaleAccount2.vTokens.sub(usdcWhaleAmountToWithdraw2),
        ONE_V_TOKEN
      );
      expect(usdcWhaleAccount3.principal).to.be.equal(
        usdcWhaleAccount2.principal.sub(
          usdcWhaleAmountToWithdraw2
            .mul(usdcWhaleAccount2.principal)
            .div(usdcWhaleAccount2.vTokens)
        )
      );
      expect(usdcWhaleAccount3.lossVTokensAccrued).to.be.equal(0);
      expect(usdcWhaleAccount3.rewardsPaid).to.be.equal(
        usdcWhaleAccount3.vTokens.mul(vUSDCRewards2).div(ONE_V_TOKEN)
      );

      await expect(
        dineroVenusVault
          .connect(usdcWhale)
          .withdraw(USDC, usdcWhaleAccount3.vTokens)
      ).to.not.reverted;

      expect(await dinero.balanceOf(alice.address)).to.be.equal(0);
    });
    it('calculates losses properly', async () => {
      await impersonate(USDC_WHALE_TWO);
      const bob = await ethers.getSigner(USDC_WHALE_TWO);

      const bobUSDCContract = new Contract(USDC, ERC20ABI, bob);

      await bobUSDCContract.approve(
        dineroVenusVault.address,
        ethers.constants.MaxUint256
      );

      // Need initial deposit to incur a loss
      await dineroVenusVault
        .connect(usdcWhale)
        .deposit(USDC, parseEther('1000000'));

      const borrowAndSupply = await safeVenus.callStatic.borrowAndSupply(
        dineroVenusVault.address,
        vUSDC
      );

      // To emulate a real life scenario, losses only happen when we leverage the vault position.
      await dineroVenusVault.connect(owner).borrow(vUSDC, parseEther('300000'));
      // Force a loss by throwing away money
      await dineroVenusVault.burnERC20(USDC, parseEther('300000'));

      const [
        totalFreeUnderlying,
        vUSDCTotalLoss,
        totalFreeVTokens,
        exchangeRate,
        borrowAndSupply2,
      ] = await Promise.all([
        dineroVenusVault.totalFreeUnderlying(USDC),
        dineroVenusVault.totalLossOf(vUSDC),
        dineroVenusVault.totalFreeVTokenOf(vUSDC),
        vUSDCContract.callStatic.exchangeRateCurrent(),
        safeVenus.callStatic.borrowAndSupply(dineroVenusVault.address, vUSDC),
      ]);

      const usdcWhaleDeposit1 = parseEther('1000000')
        .mul(parseEther('1'))
        .div(exchangeRate);

      const fee = calculateFee(usdcWhaleDeposit1);

      expect(vUSDCTotalLoss).to.be.equal(0);

      expect(totalFreeUnderlying).to.be.closeTo(
        parseEther('1000000'),
        parseEther('0.1')
      );

      expect(totalFreeVTokens).to.be.closeTo(
        usdcWhaleDeposit1.sub(fee),
        ONE_V_TOKEN
      );

      await dineroVenusVault.connect(bob).deposit(USDC, parseEther('50000'));

      const [freeVUSDC, vUSDCTotalLoss2, bobAccount, usdcWhaleAccount] =
        await Promise.all([
          dineroVenusVault.totalFreeVTokenOf(vUSDC),
          dineroVenusVault.totalLossOf(vUSDC),
          dineroVenusVault.accountOf(USDC, bob.address),
          dineroVenusVault.accountOf(USDC, usdcWhale.address),
        ]);

      const bobDepositAmount = parseEther('50000')
        .mul(parseEther('1'))
        .div(exchangeRate);

      const bobFee = calculateFee(bobDepositAmount);

      const loss = borrowAndSupply.supply
        .sub(borrowAndSupply.borrow)
        .sub(borrowAndSupply2.supply.sub(borrowAndSupply2.borrow));

      // Loss has been registered in the underlying terms
      expect(vUSDCTotalLoss2).to.be.closeTo(
        loss
          .mul(parseEther('1'))
          .div(exchangeRate)
          .mul(PRECISION)
          .mul(ONE_V_TOKEN)
          .div(totalFreeVTokens),
        ONE_V_TOKEN.mul(100)
      );

      //  Loss has not been incurred by bob so it is not registered in vTokens yet
      expect(freeVUSDC).to.be.closeTo(
        parseEther('50000')
          .add(parseEther('1000000'))
          .mul(parseEther('1'))
          .div(exchangeRate)
          .sub(fee)
          .sub(bobFee),
        ONE_V_TOKEN
      );

      await network.provider.send('hardhat_mine', [
        `0x${Number(100).toString(16)}`,
      ]);

      // Bob is able to completely get his entire deposit back because loss happened before his deposit.
      await expect(
        dineroVenusVault.connect(bob).withdraw(USDC, bobAccount.vTokens)
      ).to.emit(dineroVenusVault, 'Withdraw');

      // Loss still has not been registered in free V Tokens not incurred by BOB
      expect(await dineroVenusVault.totalFreeVTokenOf(vUSDC)).to.be.closeTo(
        parseEther('1000000').mul(parseEther('1')).div(exchangeRate).sub(fee),
        ONE_V_TOKEN
      );

      const vTokenWithdrawAmount = parseEther('500000')
        .mul(parseEther('1'))
        .div(exchangeRate);

      await dineroVenusVault.connect(usdcWhale).withdraw(
        USDC,
        // Bob suffers no loss
        vTokenWithdrawAmount
      );

      const [usdcWhaleAccount2, freeVUSDC2] = await Promise.all([
        dineroVenusVault.accountOf(USDC, usdcWhale.address),
        dineroVenusVault.totalFreeVTokenOf(vUSDC),
      ]);

      expect(usdcWhaleAccount2.principal).to.be.closeTo(
        usdcWhaleAccount.principal.sub(
          vTokenWithdrawAmount
            .mul(usdcWhaleAccount.principal)
            .div(
              usdcWhaleAccount.vTokens.sub(
                vUSDCTotalLoss2
                  .mul(usdcWhaleAccount.vTokens)
                  .div(ONE_V_TOKEN)
                  .div(PRECISION)
              )
            )
        ),
        // 1 USD
        parseEther('1')
      );

      expect(usdcWhaleAccount2.vTokens).to.be.closeTo(
        usdcWhaleAccount.vTokens
          .sub(vTokenWithdrawAmount)
          .sub(
            vUSDCTotalLoss2
              .mul(usdcWhaleAccount.vTokens)
              .div(ONE_V_TOKEN)
              .div(PRECISION)
          ),
        ONE_V_TOKEN
      );

      // Alice has incurred all losses
      expect(usdcWhaleAccount2.lossVTokensAccrued).to.be.closeTo(
        usdcWhaleAccount2.vTokens.mul(vUSDCTotalLoss2).div(ONE_V_TOKEN),
        ONE_V_TOKEN
      );

      // Free USDC should be updated
      expect(freeVUSDC2).to.be.equal(usdcWhaleAccount2.vTokens);
    });
    it('deleverages the vault if there is not enough underlying to withdraw', async () => {
      await dineroVenusVault
        .connect(usdcWhale)
        .deposit(USDC, parseEther('100000'));

      await dineroVenusVault.connect(owner).leverage(vUSDC);

      const usdcWhaleAccount = await dineroVenusVault.accountOf(
        USDC,
        usdcWhale.address
      );

      await expect(
        dineroVenusVault
          .connect(usdcWhale)
          .withdraw(USDC, usdcWhaleAccount.vTokens)
      )
        .to.emit(vUSDC, 'RedeemUnderlying')
        .to.emit(vUSDC, 'RepayBorrow')
        .to.emit(dineroVenusVault, 'Withdraw');

      const [borrowBalance, balanceOfUnderlying] = await Promise.all([
        vUSDCContract.callStatic.borrowBalanceCurrent(dineroVenusVault.address),
        vUSDCContract.callStatic.balanceOfUnderlying(dineroVenusVault.address),
      ]);

      expect(borrowBalance).to.be.closeTo(
        ethers.BigNumber.from(0),
        parseEther('0.1')
      );

      // Reserves
      // 1 dollar = 1e18
      expect(balanceOfUnderlying).to.be.closeTo(
        calculateFee(parseEther('100000')),
        parseEther('0.1')
      );

      await dineroVenusVault
        .connect(usdcWhale)
        .deposit(USDC, parseEther('100000'));

      await dineroVenusVault.connect(owner).leverage(vUSDC);

      const borrowBalance2 =
        await vUSDCContract.callStatic.borrowBalanceCurrent(
          dineroVenusVault.address
        );

      expect(borrowBalance2.gt(0)).to.be.equal(true);

      // We only withdraw one third of the balance so the vault will try it's best to keep the leverage
      await expect(
        dineroVenusVault
          .connect(usdcWhale)
          .withdraw(USDC, usdcWhaleAccount.vTokens.div(4))
      )
        .to.emit(vUSDC, 'RedeemUnderlying')
        .to.emit(vUSDC, 'RepayBorrow')
        .to.emit(dineroVenusVault, 'Withdraw');

      // Vault does not completely deleverage unless it needs
      expect(
        (
          await vUSDCContract.callStatic.borrowBalanceCurrent(
            dineroVenusVault.address
          )
        ).gt(0)
      ).to.be.equal(true);
    });
  });

  describe('Upgrade functionality', () => {
    it('reverts if a caller that is the owner calls it', async () => {
      await dineroVenusVault.connect(owner).transferOwnership(alice.address);

      await expect(
        upgrade(dineroVenusVault, 'TestDineroVenusVaultV2')
      ).to.revertedWith('Ownable: caller is not the owner');
    });
  });

  it('upgrades to version 2', async () => {
    const [
      usdcWhaleUSDCBalance,
      vaultVUSDCBalance,
      exchangeRate,
      totalFreeVTokens,
      usdcWhaleAccount,
      rewards,
      totalFreeUnderlying,
      usdcWhaleDineroBalance,
    ] = await Promise.all([
      USDCContract.balanceOf(usdcWhale.address),
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
    expect(usdcWhaleDineroBalance).to.be.equal(0);

    const vTokensMinted = parseEther('100000')
      .mul(parseEther('1'))
      .div(exchangeRate);

    const fee = calculateFee(vTokensMinted);

    await expect(
      dineroVenusVault.connect(usdcWhale).deposit(USDC, parseEther('100000'))
    )
      .to.emit(dineroVenusVault, 'Deposit')
      .withArgs(
        usdcWhale.address,
        USDC,
        parseEther('100000'),
        vTokensMinted.sub(fee)
      )
      .to.emit(USDCContract, 'Transfer')
      .withArgs(
        usdcWhale.address,
        dineroVenusVault.address,
        parseEther('100000')
      )
      .to.emit(USDCContract, 'Transfer')
      .withArgs(dineroVenusVault.address, vUSDC, parseEther('100000'))
      .to.emit(vUSDCContract, 'Transfer');

    const dineroVenusVaultV2: TestDineroVenusVaultV2 = await upgrade(
      dineroVenusVault,
      'TestDineroVenusVaultV2'
    );

    const [
      usdcWhaleUSDCBalance2,
      vaultVUSDCBalance2,
      totalFreeVTokens2,
      usdcWhaleAccount2,
      totalFreeUnderlying2,
      version,
      usdcWhaleDineroBalance2,
    ] = await Promise.all([
      USDCContract.balanceOf(usdcWhale.address),
      vUSDCContract.balanceOf(dineroVenusVaultV2.address),
      dineroVenusVaultV2.totalFreeVTokenOf(vUSDC),
      dineroVenusVaultV2.accountOf(USDC, usdcWhale.address),
      dineroVenusVaultV2.totalFreeUnderlying(USDC),
      dineroVenusVaultV2.version(),
      dinero.balanceOf(usdcWhale.address),
    ]);

    expect(usdcWhaleUSDCBalance2).equal(
      usdcWhaleUSDCBalance.sub(parseEther('100000'))
    );
    expect(version).to.be.equal('V2');
    expect(vaultVUSDCBalance2).to.be.closeTo(vTokensMinted, ONE_V_TOKEN);
    expect(totalFreeVTokens2).to.be.closeTo(
      vTokensMinted.sub(fee),
      ONE_V_TOKEN
    );
    expect(totalFreeUnderlying2).to.be.closeTo(
      parseEther('100000'),
      parseEther('0.1')
    );
    expect(usdcWhaleDineroBalance2).to.be.equal(
      parseEther('100000').mul(DINERO_LTV).div(parseEther('1'))
    );
    expect(usdcWhaleAccount2.vTokens).to.be.closeTo(
      vTokensMinted.sub(fee),
      ONE_V_TOKEN
    );
    expect(usdcWhaleAccount2.principal).to.be.equal(
      parseEther('100000').mul(DINERO_LTV).div(parseEther('1'))
    );
    expect(usdcWhaleAccount2.rewardsPaid).to.be.equal(0);
    expect(usdcWhaleAccount2.lossVTokensAccrued).to.be.equal(0);

    const wBNBXvsPair = (await ethers.getContractFactory('PancakePair')).attach(
      WBNB_XVS_PAIR
    );

    await expect(
      dineroVenusVaultV2.connect(usdcWhale).deposit(USDC, parseEther('100'))
    )
      .to.emit(dineroVenusVault, 'Deposit')
      .to.emit(wBNBXvsPair, 'Swap');
  });
}).timeout(10_000);
