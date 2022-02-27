// eslint-disable-next-line node/no-unpublished-import
import { ContractAddressOrInstance } from '@openzeppelin/hardhat-upgrades/dist/utils';
import { BigNumber } from 'ethers';
import { ethers, upgrades } from 'hardhat';

export const multiDeploy = async (
  x: ReadonlyArray<string>,
  y: Array<Array<unknown> | undefined> = []
): Promise<any> => {
  const contractFactories = await Promise.all(
    x.map((name) => ethers.getContractFactory(name))
  );

  return Promise.all(
    contractFactories.map((factory, index) =>
      factory.deploy(...(y[index] || []))
    )
  );
};

export const deploy = async (
  name: string,
  parameters: Array<unknown> = []
): Promise<any> => {
  const factory = await ethers.getContractFactory(name);
  return await factory.deploy(...parameters);
};

export const deployUUPS = async (
  name: string,
  parameters: Array<unknown> = []
): Promise<any> => {
  const factory = await ethers.getContractFactory(name);
  const instance = await upgrades.deployProxy(factory, parameters, {
    kind: 'uups',
  });
  await instance.deployed();
  return instance;
};

export const multiDeployUUPS = async (
  name: ReadonlyArray<string>,
  parameters: Array<Array<unknown> | undefined> = []
): Promise<any> => {
  const factories = await Promise.all(
    name.map((x) => ethers.getContractFactory(x))
  );

  const instances = await Promise.all(
    factories.map((factory, index) =>
      upgrades.deployProxy(factory, parameters[index], { kind: 'uups' })
    )
  );

  await Promise.all([instances.map((x) => x.deployed())]);

  return instances;
};

export const upgrade = async (
  proxy: ContractAddressOrInstance,
  name: string
): Promise<any> => {
  const factory = await ethers.getContractFactory(name);
  return upgrades.upgradeProxy(proxy, factory);
};

export const advanceTime = (time: number, _ethers: typeof ethers) =>
  _ethers.provider.send('evm_increaseTime', [time]);

export const advanceBlock = (_ethers: typeof ethers) =>
  _ethers.provider.send('evm_mine', []);

export const advanceBlockAndTime = async (
  time: number,
  _ethers: typeof ethers
) => {
  await _ethers.provider.send('evm_increaseTime', [time]);
  await _ethers.provider.send('evm_mine', []);
};

export const makeCalculateAccruedInt =
  (interestPerBlock: BigNumber) =>
  (
    accruedInterest: BigNumber,
    blocksElapsed: BigNumber,
    allocationPoints: BigNumber,
    totalAllocationPoints: BigNumber,
    totalSupply: BigNumber
  ) => {
    const rewards = blocksElapsed
      .mul(interestPerBlock)
      .mul(allocationPoints)
      .div(totalAllocationPoints)
      .mul(ethers.utils.parseEther('1'));

    return accruedInterest.add(rewards.div(totalSupply));
  };

export const calculateUserPendingRewards = (
  userAmount: BigNumber,
  poolAccruedIntPerShare: BigNumber,
  userRewardsPaid: BigNumber
) =>
  userAmount
    .mul(poolAccruedIntPerShare)
    .div(ethers.utils.parseEther('1'))
    .sub(userRewardsPaid);
