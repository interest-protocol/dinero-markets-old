import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  Dinero,
  DineroVault,
  MockERC20,
  MockERC20Decimals,
  TestDineroVaultV2,
} from '../typechain';
import { BURNER_ROLE, MINTER_ROLE } from './lib/constants';
import { deployUUPS, multiDeploy, upgrade } from './lib/test-utils';

const { parseEther } = ethers.utils;

const { MaxUint256, AddressZero } = ethers.constants;

describe('Dinero Vault', () => {
  let vault: DineroVault;
  let dinero: Dinero;
  let USDC: MockERC20Decimals; // 6 decimals
  let USDT: MockERC20; // 18 decimals
  let UST: MockERC20Decimals; // 20 decimals

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;

  beforeEach(async () => {
    [[owner, alice], [USDC, USDT, UST], dinero] = await Promise.all([
      ethers.getSigners(),
      multiDeploy(
        ['MockERC20Decimals', 'MockERC20', 'MockERC20Decimals'],
        [
          ['USD Coin', 'USDC', 0, 6],
          ['USD Tether', 'USDT', 0],
          ['USD Terra', 'UST', 0, 20],
        ]
      ),
      deployUUPS('Dinero', []),
    ]);

    vault = await deployUUPS('DineroVault', [dinero.address]);

    await Promise.all([
      vault.connect(owner).addUnderlying(UST.address),
      vault.connect(owner).addUnderlying(USDC.address),
      vault.connect(owner).addUnderlying(USDT.address),
      UST.mint(alice.address, parseEther('10000000')),
      USDC.mint(alice.address, parseEther('1000000')),
      USDT.mint(alice.address, parseEther('1000000')),
      UST.connect(alice).approve(vault.address, MaxUint256),
      USDC.connect(alice).approve(vault.address, MaxUint256),
      USDT.connect(alice).approve(vault.address, MaxUint256),
      dinero.connect(owner).grantRole(MINTER_ROLE, vault.address),
      dinero.connect(owner).grantRole(BURNER_ROLE, vault.address),
    ]);
  });

  describe('function: initialize', () => {
    it('reverts if you try to call it a second time', async () => {
      await expect(vault.initialize(dinero.address)).to.be.revertedWith(
        'Initializable: contract is already initialized'
      );
    });
    it('sets the initial state', async () => {
      const [_dinero, _owner] = await Promise.all([
        vault.DINERO(),
        vault.owner(),
      ]);

      expect(_dinero).to.be.equal(dinero.address);
      expect(_owner).to.be.equal(owner.address);
    });
  });

  it('allows to see what underlying assets are supported', async () => {
    const [isUSTSupported, isUSDTSupported, isOwnerSupported] =
      await Promise.all([
        vault.isUnderlyingSupported(UST.address),
        vault.isUnderlyingSupported(USDT.address),
        vault.isUnderlyingSupported(owner.address),
      ]);

    expect(isUSTSupported).to.be.equal(true);
    expect(isUSDTSupported).to.be.equal(true);
    expect(isOwnerSupported).to.be.equal(false);
  });

  describe('function: deposit', () => {
    it('reverts if you try to deposit a non-supported underlying or 0 amount', async () => {
      await expect(
        vault.connect(alice).deposit(owner.address, 1)
      ).to.be.revertedWith('DV: not supported');

      await expect(
        vault.connect(alice).deposit(UST.address, 0)
      ).to.be.revertedWith('DV: no amount 0');
    });
    it('allows deposit in various stable coins', async () => {
      const [
        aliceVaultUSTBalance,
        aliceVaultUSDTBalance,
        aliceVaultUSDCbalance,
        aliceDineroBalance,
      ] = await Promise.all([
        vault.balanceOf(UST.address, alice.address),
        vault.balanceOf(USDT.address, alice.address),
        vault.balanceOf(USDC.address, alice.address),
        dinero.balanceOf(alice.address),
      ]);

      expect(aliceVaultUSTBalance).to.be.equal(0);
      expect(aliceVaultUSDTBalance).to.be.equal(0);
      expect(aliceVaultUSDCbalance).to.be.equal(0);
      expect(aliceDineroBalance).to.be.equal(0);

      await expect(
        vault.connect(alice).deposit(UST.address, parseEther('1000'))
      )
        .to.emit(UST, 'Transfer')
        .withArgs(alice.address, vault.address, parseEther('1000'))
        .to.emit(dinero, 'Transfer')
        .withArgs(AddressZero, alice.address, parseEther('10'))
        .to.emit(vault, 'Deposit')
        .withArgs(
          alice.address,
          UST.address,
          parseEther('1000'),
          parseEther('10')
        );

      const [
        aliceVaultUSTBalance2,
        aliceVaultUSDTBalance2,
        aliceVaultUSDCbalance2,
        aliceDineroBalance2,
      ] = await Promise.all([
        vault.balanceOf(UST.address, alice.address),
        vault.balanceOf(USDT.address, alice.address),
        vault.balanceOf(USDC.address, alice.address),
        dinero.balanceOf(alice.address),
      ]);

      expect(aliceVaultUSTBalance2).to.be.equal(parseEther('1000'));
      expect(aliceVaultUSDTBalance2).to.be.equal(0);
      expect(aliceVaultUSDCbalance2).to.be.equal(0);
      expect(aliceDineroBalance2).to.be.equal(parseEther('10'));

      await expect(vault.connect(alice).deposit(USDC.address, 1_000_000))
        .to.emit(USDC, 'Transfer')
        .withArgs(alice.address, vault.address, 1_000_000)
        .to.emit(dinero, 'Transfer')
        .withArgs(AddressZero, alice.address, parseEther('1'))
        .to.emit(vault, 'Deposit')
        .withArgs(alice.address, USDC.address, 1_000_000, parseEther('1'));

      await expect(
        vault.connect(alice).deposit(USDT.address, parseEther('100'))
      )
        .to.emit(USDT, 'Transfer')
        .withArgs(alice.address, vault.address, parseEther('100'))
        .to.emit(dinero, 'Transfer')
        .withArgs(AddressZero, alice.address, parseEther('100'))
        .to.emit(vault, 'Deposit')
        .withArgs(
          alice.address,
          USDT.address,
          parseEther('100'),
          parseEther('100')
        );

      const [
        aliceVaultUSTBalance3,
        aliceVaultUSDTBalance3,
        aliceVaultUSDCbalance3,
        aliceDineroBalance3,
      ] = await Promise.all([
        vault.balanceOf(UST.address, alice.address),
        vault.balanceOf(USDT.address, alice.address),
        vault.balanceOf(USDC.address, alice.address),
        dinero.balanceOf(alice.address),
      ]);

      expect(aliceVaultUSTBalance3).to.be.equal(parseEther('1000'));
      expect(aliceVaultUSDTBalance3).to.be.equal(parseEther('100'));
      expect(aliceVaultUSDCbalance3).to.be.equal(1_000_000);
      expect(aliceDineroBalance3).to.be.equal(parseEther('111'));
    });
  });

  describe('function: withdraw', () => {
    it('reverts if you try to withdraw a non-supported underlying or 0 amount', async () => {
      await expect(
        vault.connect(alice).withdraw(owner.address, 1)
      ).to.be.revertedWith('DV: not supported');

      await expect(
        vault.connect(alice).withdraw(UST.address, 0)
      ).to.be.revertedWith('DV: no amount 0');
    });

    it('allows withdraws', async () => {
      await Promise.all([
        vault.connect(alice).deposit(USDT.address, parseEther('100')), // 100 DNR
        vault.connect(alice).deposit(USDC.address, 1_000_000_000), // 1000 DNR
        vault.connect(alice).deposit(UST.address, parseEther('1000000')), // 10_000 DNR
      ]);

      await expect(vault.connect(alice).withdraw(USDC.address, 200_000_000))
        .to.emit(dinero, 'Transfer')
        .withArgs(alice.address, AddressZero, parseEther('200'))
        .to.emit(USDC, 'Transfer')
        .withArgs(vault.address, alice.address, 200_000_000)
        .to.emit(vault, 'Withdraw')
        .withArgs(alice.address, USDC.address, 200_000_000, parseEther('200'));

      const [
        aliceVaultUSTBalance,
        aliceVaultUSDTBalance,
        aliceVaultUSDCbalance,
        aliceDineroBalance,
      ] = await Promise.all([
        vault.balanceOf(UST.address, alice.address),
        vault.balanceOf(USDT.address, alice.address),
        vault.balanceOf(USDC.address, alice.address),
        dinero.balanceOf(alice.address),
      ]);

      expect(aliceVaultUSDCbalance).to.be.equal(800_000_000);
      expect(aliceVaultUSDTBalance).to.be.equal(parseEther('100'));
      expect(aliceVaultUSTBalance).to.be.equal(parseEther('1000000'));
      expect(aliceDineroBalance).to.be.equal(parseEther('10900'));

      await expect(
        vault.connect(alice).withdraw(UST.address, parseEther('1000000'))
      )
        .to.emit(dinero, 'Transfer')
        .withArgs(alice.address, AddressZero, parseEther('10000'))
        .to.emit(UST, 'Transfer')
        .withArgs(vault.address, alice.address, parseEther('1000000'))
        .to.emit(vault, 'Withdraw')
        .withArgs(
          alice.address,
          UST.address,
          parseEther('1000000'),
          parseEther('10000')
        );

      await vault.connect(alice).withdraw(USDT.address, parseEther('50'));

      const [
        aliceVaultUSTBalance2,
        aliceVaultUSDTBalance2,
        aliceVaultUSDCbalance2,
        aliceDineroBalance2,
      ] = await Promise.all([
        vault.balanceOf(UST.address, alice.address),
        vault.balanceOf(USDT.address, alice.address),
        vault.balanceOf(USDC.address, alice.address),
        dinero.balanceOf(alice.address),
      ]);

      expect(aliceVaultUSDCbalance2).to.be.equal(800_000_000);
      expect(aliceVaultUSDTBalance2).to.be.equal(parseEther('50'));
      expect(aliceVaultUSTBalance2).to.be.equal(0);
      expect(aliceDineroBalance2).to.be.equal(parseEther('850'));
    });
  });

  describe('owner functions', () => {
    it('revert if called by a non-owner', async () => {
      await Promise.all([
        expect(
          vault.connect(alice).addUnderlying(UST.address)
        ).to.be.revertedWith('Ownable: caller is not the owner'),
        expect(
          vault.connect(alice).removeUnderlying(UST.address)
        ).to.be.revertedWith('Ownable: caller is not the owner'),
      ]);
    });
    it('allows the owner to remove and add support for underlying', async () => {
      const isUSDTSupported = await vault.isUnderlyingSupported(USDT.address);

      expect(isUSDTSupported).to.be.equal(true);

      await expect(vault.connect(alice).deposit(USDT.address, 1)).to.not.be
        .reverted;

      await expect(vault.connect(owner).removeUnderlying(USDT.address))
        .to.emit(vault, 'RemoveUnderlying')
        .withArgs(USDT.address);

      const isUSDTSupported2 = await vault.isUnderlyingSupported(USDT.address);

      expect(isUSDTSupported2).to.be.equal(false);

      await expect(vault.connect(alice).deposit(USDT.address, 1)).to.be
        .reverted;

      await expect(vault.connect(owner).addUnderlying(USDT.address))
        .to.emit(vault, 'AddUnderlying')
        .withArgs(USDT.address);

      const isUSDTSupported3 = await vault.isUnderlyingSupported(USDT.address);

      expect(isUSDTSupported3).to.be.equal(true);

      await expect(vault.connect(alice).deposit(USDT.address, 1)).to.not.be
        .reverted;
    });
  });
  describe('upgrade functionality', () => {
    it('reverts if a non-owner tries to upgrade', async () => {
      await vault.connect(owner).renounceOwnership();

      await expect(upgrade(vault, 'TestDineroVaultV2')).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });
    it('properly updates to V2', async () => {
      await vault.connect(alice).deposit(USDT.address, parseEther('100'));

      const vaultV2: TestDineroVaultV2 = await upgrade(
        vault,
        'TestDineroVaultV2'
      );

      vaultV2.connect(alice).withdraw(USDT.address, parseEther('25'));

      const [aliceVaultUSDTBalance, version] = await Promise.all([
        vaultV2.balanceOf(USDT.address, alice.address),
        vaultV2.version(),
      ]);

      expect(version).to.be.equal('V2');
      expect(aliceVaultUSDTBalance).to.be.equal(parseEther('75'));
    });
  });
});
