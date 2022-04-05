import { ethers } from 'hardhat';

// @desc follow the same order of the signers accounts
export const PRIVATE_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
];

export const MINTER_ROLE = ethers.utils.solidityKeccak256(
  ['string'],
  ['MINTER_ROLE']
);
export const DEVELOPER_ROLE = ethers.utils.solidityKeccak256(
  ['string'],
  ['DEVELOPER_ROLE']
);
export const BURNER_ROLE = ethers.utils.solidityKeccak256(
  ['string'],
  ['BURNER_ROLE']
);

export const DEFAULT_ADMIN_ROLE = ethers.constants.HashZero;

export const CAKE_WHALE_ONE = '0xf8ba3ec49212ca45325a2335a8ab1279770df6c0';

export const CAKE_WHALE_TWO = '0xda07f1603a1c514b2f4362f3eae7224a9cdefaf9';

export const CAKE_WHALE_THREE = '0xf89d7b9c864f589bbf53a82105107622b35eaa40';

export const CAKE = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';

export const CAKE_MASTER_CHEF = '0x73feaa1eE314F8c655E354234017bE2193C9E24E';
