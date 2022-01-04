import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  CakeToken,
  LPVault,
  MasterChef,
  MockERC20,
  SyrupBar,
} from '../typechain';
import { advanceBlock, deploy, multiDeploy } from './lib/test-utils';

const { parseEther } = ethers.utils;

const CAKE_PER_BLOCK = parseEther('40');

const START_BLOCK = 20;

describe('LPVault', () => {
  let cake: CakeToken;
  let syrup: SyrupBar;
  let masterChef: MasterChef;
  let lpVault: LPVault;
  let lpToken: MockERC20;
  let lpToken2: MockERC20;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let developer: SignerWithAddress;
  // @notice Market does not need to be an address for testing purposes
  let market: SignerWithAddress;

  beforeEach(async () => {
    [[owner, alice, developer, market], cake] = await Promise.all([
      ethers.getSigners(),
      deploy('CakeToken'),
    ]);

    syrup = await deploy('SyrupBar', [cake.address]);

    masterChef = await deploy('MasterChef', [
      cake.address,
      syrup.address,
      developer.address,
      CAKE_PER_BLOCK,
      START_BLOCK,
    ]);

    [lpToken, lpToken2] = await multiDeploy(
      ['MockERC20', 'MockERC20'],
      [
        ['CAKE-LP', 'LP', parseEther('1000')],
        ['CAKE-LP-2', 'LP-2', parseEther('1000')],
      ]
    );

    lpVault = await deploy('LPVault', [
      masterChef.address,
      cake.address,
      lpToken.address,
      1,
      market.address,
    ]);

    await Promise.all([
      lpToken
        .connect(alice)
        .approve(lpVault.address, ethers.constants.MaxUint256),
      lpToken
        .connect(market)
        .approve(lpVault.address, ethers.constants.MaxUint256),
      lpToken.mint(alice.address, parseEther('100')),
      lpToken.mint(market.address, parseEther('1000')),
      // Pool Id for lpToken becomes 1
      masterChef.connect(owner).add(800, lpToken.address, false),
      // Pool Id for lptoken2 becomes 2
      masterChef.connect(owner).add(1000, lpToken2.address, false),
      syrup.connect(owner).transferOwnership(masterChef.address),
    ]);
  });
  it('shows the pending rewards in the CAKE and lp token pools', async () => {
    expect(await lpVault.getPendingRewards()).to.be.equal(0);

    await lpVault.connect(market).deposit(alice.address, parseEther('10'));

    // accrue some cake
    await advanceBlock(ethers);
    await advanceBlock(ethers);

    expect(await lpVault.getPendingRewards()).to.be.equal(
      (await masterChef.pendingCake(0, lpVault.address)).add(
        await masterChef.pendingCake(1, lpVault.address)
      )
    );
  });
});
