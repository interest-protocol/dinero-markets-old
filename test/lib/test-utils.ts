// eslint-disable-next-line node/no-unpublished-import
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

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

export const advanceTime = (time: number, _ethers: typeof ethers) =>
  _ethers.provider.send('evm_increaseTime', [time]);

export const advanceBlock = (_ethers: typeof ethers) =>
  _ethers.provider.send('evm_mine', []);

export const B = (x: BigNumber) => ethers.BigNumber.from(x);

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
      .mul(1e12);

    return accruedInterest.add(rewards.div(totalSupply));
  };
