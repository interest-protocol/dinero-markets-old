import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { Dinero, DineroVault, MockERC20 } from '../typechain';
import {
  advanceBlock,
  deploy,
  deployUUPS,
  multiDeploy,
  upgrade,
} from './lib/test-utils';

describe('Dinero Vault', () => {
  let vault: DineroVault;
  let dinero: Dinero;
  let USDC: MockERC20;
  let USDT: MockERC20;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;

  beforeEach(async () => {
    [[owner, alice], [USDC, USDT], dinero] = await Promise.all([
      ethers.getSigners(),
      multiDeploy(
        ['MockERC20', 'MockERC20'],
        [
          ['USD Coin', 'USDC', 0],
          ['USD Tether', 'USDT', 0],
        ]
      ),
      deployUUPS('Dinero', []),
    ]);

    vault = await deployUUPS('DineroVault', [dinero.address]);
  });

  describe('function: initialize', () => {
    it('reverts if you try to call it a second time', async () => {
      await expect(vault.initialize(dinero.address)).to.be.revertedWith(
        'Initializable: contract is already initialized'
      );
    });
  });
});
