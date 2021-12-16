// eslint-disable-next-line node/no-unpublished-import
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
