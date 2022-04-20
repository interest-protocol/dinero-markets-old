import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

const { getAddress } = ethers.utils;

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

export const CAKE_WHALE_ONE = getAddress(
  '0xf8ba3ec49212ca45325a2335a8ab1279770df6c0'
);

export const CAKE_WHALE_TWO = getAddress(
  '0xda07f1603a1c514b2f4362f3eae7224a9cdefaf9'
);

export const CAKE_WHALE_THREE = getAddress(
  '0xf89d7b9c864f589bbf53a82105107622b35eaa40'
);

export const CAKE = getAddress('0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82');

export const CAKE_MASTER_CHEF = getAddress(
  '0x73feaa1eE314F8c655E354234017bE2193C9E24E'
);

export const WBNB = getAddress('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');

export const XVS = getAddress('0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63');

export const PCS_ROUTER = getAddress(
  '0x10ED43C718714eb63d5aA57B78B54704E256024E'
);

export const VENUS_CONTROLLER = getAddress(
  '0xfD36E2c2a6789Db23113685031d7F16329158384'
);

export const PCS_FACTORY = getAddress(
  '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'
);

export const USDC = getAddress('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d');

export const DAI = getAddress('0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3');

export const BUSD = getAddress('0xe9e7cea3dedca5984780bafc599bd69add087d56');

export const USDT = getAddress('0x55d398326f99059fF775485246999027B3197955');

export const BTC = getAddress('0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c');

export const vUSDC = getAddress('0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8');

export const vDAI = getAddress('0x334b3eCB4DCa3593BCCC3c7EBD1A1C1d1780FBF1');

export const vBTC = getAddress('0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B');

export const vBNB = getAddress('0xA07c5b74C9B40447a954e1466938b865b6BBea36');

export const MAX_UINT_96 = ethers.BigNumber.from(
  '79228162514264337593543950335'
);

export const USDC_WHALE_ONE = getAddress(
  '0xf977814e90da44bfa03b6295a0616a897441acec'
);

export const USDC_WHALE_TWO = getAddress(
  '0x5a52e96bacdabb82fd05763e25335261b270efcb'
);

export const BTC_WHALE_ONE = getAddress(
  '0xF977814e90dA44bFA03b6295A0616a897441aceC'
);

export const BTC_WHALE_TWO = getAddress(
  '0x8894E0a0c962CB723c1976a4421c95949bE2D4E3'
);

export const BTC_WHALE_THREE = getAddress(
  '0x72A53cDBBcc1b9efa39c834A540550e23463AAcB'
);

export const DAI_WHALE_ONE = getAddress(
  '0xf977814e90da44bfa03b6295a0616a897441acec'
);

export const XVS_WHALE = getAddress(
  '0xf977814e90da44bfa03b6295a0616a897441acec'
);

export const WBNB_WHALE = getAddress(
  '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
);

export const VENUS_ADMIN = getAddress(
  '0x939bd8d64c0a9583a7dcea9933f7b21697ab6396'
);

export const ONE_V_TOKEN = BigNumber.from(10).pow(8);

export const PRECISION = BigNumber.from(10).pow(10);

export const WBNB_XVS_PAIR = getAddress(
  '0x7EB5D86FD78f3852a3e0e064f2842d45a3dB6EA2'
);

// FEEDS

export const BNB_USD_PRICE_FEED = getAddress(
  '0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee'
);

export const BTC_USD_PRICE_FEED = getAddress(
  '0x264990fbd0a4796a3e3d8e37c4d5f87a3aca5ebf'
);
