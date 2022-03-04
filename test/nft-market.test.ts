import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  MockERC20,
  MockNFT,
  NFTMarket,
  ReentrantNFTMarketBorrowerStartLoan,
  ReentrantNFTMarketLenderStartLoan,
  ReentrantNFTMarketRepay,
  ReentrantNFTMarketWithdrawBNB,
  TestNFTMarket,
  TestNFTMarketV2,
} from '../typechain';
import {
  advanceBlockAndTime,
  deploy,
  deployUUPS,
  multiDeploy,
  upgrade,
} from './lib/test-utils';

const { parseEther } = ethers.utils;

const ONE_DAY = ethers.BigNumber.from(60 * 60 * 24);

const INTEREST_RATE = ethers.BigNumber.from(12e8);

const TEN_BTC = parseEther('10');

describe('NFTMarket', () => {
  let btc: MockERC20;
  let usdc: MockERC20;
  let nft: MockNFT;
  let nftMarket: NFTMarket;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let feeTo: SignerWithAddress;

  beforeEach(async () => {
    [[btc, usdc, nft], [owner, alice, bob, feeTo]] = await Promise.all([
      multiDeploy(
        ['MockERC20', 'MockERC20', 'MockNFT'],
        [
          ['Bitcoin', 'BTC', parseEther('10000')],
          ['USDC', 'USDC', parseEther('10000')],
          ['Bored Ape Yatch Club', ' BAYC'],
        ]
      ),
      ethers.getSigners(),
    ]);

    nftMarket = await deployUUPS('NFTMarket', [feeTo.address]);

    await Promise.all([
      nft.mint(alice.address, 1),
      nft.mint(alice.address, 99),
      nft.connect(alice).setApprovalForAll(nftMarket.address, true),
      btc.mint(bob.address, parseEther('10000')),
      usdc.mint(bob.address, parseEther('10000')),
      btc.mint(owner.address, parseEther('10000')),
      usdc.mint(owner.address, parseEther('10000')),
      btc.connect(bob).approve(nftMarket.address, ethers.constants.MaxUint256),
      usdc.connect(bob).approve(nftMarket.address, ethers.constants.MaxUint256),
      btc.mint(alice.address, parseEther('10000')),
      usdc.mint(alice.address, parseEther('10000')),
      btc
        .connect(alice)
        .approve(nftMarket.address, ethers.constants.MaxUint256),
      usdc
        .connect(alice)
        .approve(nftMarket.address, ethers.constants.MaxUint256),
      btc
        .connect(owner)
        .approve(nftMarket.address, ethers.constants.MaxUint256),
      usdc
        .connect(owner)
        .approve(nftMarket.address, ethers.constants.MaxUint256),
    ]);
  });

  describe('function: initialize', () => {
    it('reverts if you call initialize after deployment', async () => {
      await expect(nftMarket.initialize(feeTo.address)).to.revertedWith(
        'Initializable: contract is already initialized'
      );
    });
    it('sets the new state correctly', async () => {
      const [_owner, _feeTo] = await Promise.all([
        nftMarket.owner(),
        nftMarket.FEE_TO(),
      ]);

      expect(_owner).to.be.equal(owner.address);
      expect(_feeTo).to.be.equal(feeTo.address);
    });
  });

  describe('function: proposeLoan', () => {
    it('reverts if it is initiated with wrong parameters', async () => {
      await expect(
        nftMarket.connect(bob).proposeLoan(nft.address, btc.address, 1, 2, 0, 1)
      ).to.revertedWith('NFTM: no interest rate');

      await expect(
        nftMarket.connect(bob).proposeLoan(nft.address, btc.address, 1, 2, 1, 0)
      ).to.revertedWith('NFTM: no maturity');

      await expect(
        nftMarket.connect(bob).proposeLoan(nft.address, btc.address, 1, 0, 1, 1)
      ).to.revertedWith('NFTM: no principal');
    });

    it('reverts if the owner does not own the NFT', async () => {
      await expect(
        nftMarket.connect(bob).proposeLoan(nft.address, btc.address, 1, 1, 1, 1)
      ).to.revertedWith('ERC721: transfer from incorrect owner');

      await expect(
        nftMarket.connect(bob).proposeLoan(nft.address, btc.address, 2, 1, 1, 1)
      ).to.revertedWith('ERC721: operator query for nonexistent token');
    });

    it('creates a loan proposal', async () => {
      const [loan, nftOwner] = await Promise.all([
        nftMarket.loans(nft.address, 1),
        nft.ownerOf(1),
      ]);

      expect(loan.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(loan.principal).to.be.equal(0);
      expect(loan.maturity).to.be.equal(0);
      expect(loan.interestRate).to.be.equal(0);
      expect(loan.tokenId).to.be.equal(0);
      expect(loan.borrower).to.be.equal(ethers.constants.AddressZero);
      expect(loan.startDate).to.be.equal(0);
      expect(loan.lender).to.be.equal(ethers.constants.AddressZero);

      expect(nftOwner).to.be.equal(alice.address);

      await expect(
        nftMarket
          .connect(alice)
          .proposeLoan(
            nft.address,
            btc.address,
            1,
            TEN_BTC,
            INTEREST_RATE,
            ONE_DAY.mul(15)
          )
      )
        .to.emit(nftMarket, 'ProposeLoan')
        .withArgs(
          nft.address,
          alice.address,
          1,
          btc.address,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      const [loan2, nftOwner2, loanCount2, loanId2] = await Promise.all([
        nftMarket.loans(nft.address, 1),
        nft.ownerOf(1),
        nftMarket.getUserLoansCount(nft.address, alice.address),
        nftMarket.getUserLoanId(nft.address, alice.address, 0),
      ]);

      expect(loan2.loanToken).to.be.equal(btc.address);
      expect(loan2.principal).to.be.equal(TEN_BTC);
      expect(loan2.maturity).to.be.equal(ONE_DAY.mul(15));
      expect(loan2.interestRate).to.be.equal(INTEREST_RATE);
      expect(loan2.tokenId).to.be.equal(1);
      expect(loan2.borrower).to.be.equal(alice.address);
      expect(loan2.startDate).to.be.equal(0);
      expect(loan.lender).to.be.equal(ethers.constants.AddressZero);

      expect(nftOwner2).to.be.equal(nftMarket.address);

      expect(loanCount2).to.be.equal(1);
      expect(loanId2).to.be.equal(1);
    });
  });

  describe('function: counterOffer', () => {
    it('reverts if it initiated with the wrong parameters', async () => {
      await expect(
        nftMarket
          .connect(bob)
          .counterOffer(nft.address, usdc.address, 1, 1, 0, 1)
      ).to.revertedWith('NFTM: no interest rate');

      await expect(
        nftMarket
          .connect(bob)
          .counterOffer(nft.address, usdc.address, 1, 1, 1, 0)
      ).to.revertedWith('NFTM: no maturity');

      await expect(
        nftMarket
          .connect(bob)
          .counterOffer(nft.address, usdc.address, 1, 0, 1, 1)
      ).to.revertedWith('NFTM: no principal');
    });

    it('reverts if the owner counter offers himself', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          btc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await expect(
        nftMarket
          .connect(alice)
          .counterOffer(nft.address, usdc.address, 1, 1, 1, 1)
      ).to.revertedWith('NFTM: not allowed');
    });

    it('reverts if you propose to a loan that does not exist or has already started', async () => {
      await expect(
        nftMarket
          .connect(bob)
          .counterOffer(nft.address, usdc.address, 1, 1, 1, 1)
      ).to.revertedWith('NFTM: no loan available');

      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          btc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await nftMarket.connect(bob).lenderStartLoan(nft.address, 1);

      await expect(
        nftMarket
          .connect(bob)
          .counterOffer(nft.address, usdc.address, 1, 1, 1, 1)
      ).to.revertedWith('NFTM: no loan available');
    });

    it('creates a proposal to an existing loan that has not started using an ERC20', async () => {
      const counterOffer = await nftMarket.proposals(
        nft.address,
        1,
        bob.address
      );

      expect(counterOffer.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(counterOffer.principal).to.be.equal(0);
      expect(counterOffer.maturity).to.be.equal(0);
      expect(counterOffer.interestRate).to.be.equal(0);
      expect(counterOffer.lender).to.be.equal(ethers.constants.AddressZero);

      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          btc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await expect(
        nftMarket
          .connect(bob)
          .counterOffer(
            nft.address,
            usdc.address,
            1,
            TEN_BTC.mul(2),
            INTEREST_RATE.add(1),
            ONE_DAY.mul(30)
          )
      )
        .to.emit(nftMarket, 'CounterOffer')
        .withArgs(
          nft.address,
          bob.address,
          1,
          usdc.address,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30)
        );

      const [counterOffer2, loanId, proposer] = await Promise.all([
        nftMarket.proposals(nft.address, 1, bob.address),
        nftMarket.getUserLoanId(nft.address, bob.address, 0),
        nftMarket.getAddressOfProposer(nft.address, 1, 0),
      ]);

      expect(counterOffer2.loanToken).to.be.equal(usdc.address);
      expect(counterOffer2.principal).to.be.equal(TEN_BTC.mul(2));
      expect(counterOffer2.maturity).to.be.equal(ONE_DAY.mul(30));
      expect(counterOffer2.interestRate).to.be.equal(INTEREST_RATE.add(1));
      expect(counterOffer2.lender).to.be.equal(bob.address);

      expect(loanId).to.be.equal(1);
      expect(proposer).to.be.equal(bob.address);
    });

    it('creates a proposal to an existing loan that has not started using an ETH', async () => {
      const [counterOffer, bobBalance, nftMarketBalance] = await Promise.all([
        nftMarket.proposals(nft.address, 1, bob.address),
        bob.getBalance(),
        ethers.provider.getBalance(nftMarket.address),
      ]);

      expect(counterOffer.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(counterOffer.principal).to.be.equal(0);
      expect(counterOffer.maturity).to.be.equal(0);
      expect(counterOffer.interestRate).to.be.equal(0);
      expect(counterOffer.lender).to.be.equal(ethers.constants.AddressZero);

      expect(nftMarketBalance).to.be.equal(0);

      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          btc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await expect(
        nftMarket
          .connect(bob)
          .counterOffer(
            nft.address,
            ethers.constants.AddressZero,
            1,
            TEN_BTC.mul(2),
            INTEREST_RATE.add(1),
            ONE_DAY.mul(30),
            { value: TEN_BTC.mul(2) }
          )
      )
        .to.emit(nftMarket, 'CounterOffer')
        .withArgs(
          nft.address,
          bob.address,
          1,
          ethers.constants.AddressZero,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30)
        );

      const [counterOffer2, loanId, proposer, bobBalance2, nftMarketBalance2] =
        await Promise.all([
          nftMarket.proposals(nft.address, 1, bob.address),
          nftMarket.getUserLoanId(nft.address, bob.address, 0),
          nftMarket.getAddressOfProposer(nft.address, 1, 0),
          bob.getBalance(),
          ethers.provider.getBalance(nftMarket.address),
        ]);

      expect(counterOffer2.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(counterOffer2.principal).to.be.equal(TEN_BTC.mul(2));
      expect(counterOffer2.maturity).to.be.equal(ONE_DAY.mul(30));
      expect(counterOffer2.interestRate).to.be.equal(INTEREST_RATE.add(1));
      expect(counterOffer2.lender).to.be.equal(bob.address);

      // gt and not gte because of TX fees
      expect(bobBalance.sub(bobBalance2).gt(TEN_BTC.mul(2))).to.be.equal(true);
      expect(nftMarketBalance2).to.be.equal(TEN_BTC.mul(2));

      expect(loanId).to.be.equal(1);
      expect(proposer).to.be.equal(bob.address);
    });
    it('reverts if the user does not send enough ETH to cover the principal', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          btc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await expect(
        nftMarket
          .connect(bob)
          .counterOffer(
            nft.address,
            ethers.constants.AddressZero,
            1,
            TEN_BTC.mul(4),
            INTEREST_RATE.add(1),
            ONE_DAY.mul(30),
            { value: TEN_BTC.mul(2) }
          )
      ).to.revertedWith('NFTM: not enough BNB');
    });
    it('reverts if the user did not give enough allowance ot does not have enough ERC20 balance', async () => {
      await Promise.all([
        nftMarket
          .connect(alice)
          .proposeLoan(
            nft.address,
            btc.address,
            1,
            TEN_BTC,
            INTEREST_RATE,
            ONE_DAY.mul(15)
          ),
        usdc
          .connect(bob)
          .decreaseAllowance(
            nftMarket.address,
            await usdc.allowance(bob.address, nftMarket.address)
          ),
      ]);

      await expect(
        nftMarket
          .connect(bob)
          .counterOffer(
            nft.address,
            usdc.address,
            1,
            TEN_BTC.mul(2),
            INTEREST_RATE.add(1),
            ONE_DAY.mul(30)
          )
      ).to.revertedWith('NFTM: need approval');

      await usdc
        .connect(bob)
        .increaseAllowance(nftMarket.address, TEN_BTC.mul(10));

      // Throw away all tokens
      await usdc
        .connect(bob)
        .transfer(feeTo.address, await usdc.balanceOf(bob.address));

      await expect(
        nftMarket
          .connect(bob)
          .counterOffer(
            nft.address,
            usdc.address,
            1,
            TEN_BTC.mul(2),
            INTEREST_RATE.add(1),
            ONE_DAY.mul(30)
          )
      ).to.revertedWith('NFTM: need approval');
    });
  });

  describe('function: lenderStartLoan', () => {
    it('reverts if you try to reenter', async () => {
      const attackContract: ReentrantNFTMarketLenderStartLoan = await deploy(
        'ReentrantNFTMarketLenderStartLoan',
        [nftMarket.address]
      );

      await nft
        .connect(alice)
        .transferFrom(alice.address, attackContract.address, 1);

      await attackContract
        .connect(alice)
        .proposeLoan(
          nft.address,
          ethers.constants.AddressZero,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await expect(
        nftMarket
          .connect(bob)
          .lenderStartLoan(nft.address, 1, { value: TEN_BTC })
      ).to.revertedWith('ReentrancyGuard: reentrant call');
    });

    it('reverts if the loan has already started', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          btc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await nftMarket.connect(bob).lenderStartLoan(nft.address, 1);

      await expect(
        nftMarket.connect(bob).lenderStartLoan(nft.address, 1)
      ).to.revertedWith('NFTM: loan in progress');

      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          btc.address,
          99,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await nftMarket
        .connect(bob)
        .counterOffer(
          nft.address,
          ethers.constants.AddressZero,
          99,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30),
          { value: TEN_BTC.mul(2) }
        );

      await nftMarket
        .connect(alice)
        .borrowerStartLoan(nft.address, 99, bob.address);

      await expect(
        nftMarket.connect(bob).lenderStartLoan(nft.address, 99)
      ).to.revertedWith('NFTM: loan in progress');
    });

    it('reverts if the loan does not exist or borrower is the lender', async () => {
      await expect(
        nftMarket.connect(bob).lenderStartLoan(nft.address, 99)
      ).to.revertedWith('NFTM: invalid borrower');

      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          btc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await expect(
        nftMarket.connect(alice).lenderStartLoan(nft.address, 1)
      ).to.revertedWith('NFTM: invalid borrower');
    });

    it('reverts if the lender does not send enough ETH', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          ethers.constants.AddressZero,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await expect(
        nftMarket
          .connect(bob)
          .lenderStartLoan(nft.address, 1, { value: parseEther('9.9') })
      ).to.revertedWith('NFTM: incorrect principal');
    });

    it('allows a lender to start a loan using an ERC20', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          btc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      const [loan, nftMarketBalance] = await Promise.all([
        nftMarket.loans(nft.address, 1),
        ethers.provider.getBalance(nftMarket.address),
      ]);

      expect(loan.loanToken).to.be.equal(btc.address);
      expect(loan.principal).to.be.equal(TEN_BTC);
      expect(loan.maturity).to.be.equal(ONE_DAY.mul(15));
      expect(loan.interestRate).to.be.equal(INTEREST_RATE);
      expect(loan.tokenId).to.be.equal(1);
      expect(loan.borrower).to.be.equal(alice.address);
      expect(loan.lender).to.be.equal(ethers.constants.AddressZero);
      expect(loan.startDate).to.be.equal(0);

      const timestamp = (
        await ethers.provider.getBlock(await ethers.provider.getBlockNumber())
      ).timestamp;

      const principalToSend = TEN_BTC.mul(
        ethers.BigNumber.from(995).mul(
          ethers.BigNumber.from('1000000000000000')
        )
      ).div(parseEther('1'));

      await expect(nftMarket.connect(bob).lenderStartLoan(nft.address, 1))
        .to.emit(nftMarket, 'LenderStartLoan')
        .withArgs(
          nft.address,
          1,
          bob.address,
          alice.address,
          btc.address,
          principalToSend
        )
        .to.emit(btc, 'Transfer')
        .withArgs(
          bob.address,
          alice.address,
          // Protocol charges a fee
          principalToSend
        );

      const [loan2, nftMarketBalance2, loanId] = await Promise.all([
        nftMarket.loans(nft.address, 1),
        ethers.provider.getBalance(nftMarket.address),
        nftMarket.getUserLoanId(nft.address, bob.address, 0),
      ]);

      expect(loan2.loanToken).to.be.equal(btc.address);
      expect(loan2.principal).to.be.equal(TEN_BTC);
      expect(loan2.maturity).to.be.equal(ONE_DAY.mul(15));
      expect(loan2.interestRate).to.be.equal(INTEREST_RATE);
      expect(loan2.tokenId).to.be.equal(1);
      expect(loan2.borrower).to.be.equal(alice.address);
      expect(loan2.lender).to.be.equal(bob.address);
      expect(loan2.startDate.gte(timestamp)).to.be.equal(true);
      expect(nftMarketBalance.eq(nftMarketBalance2)).to.be.equal(true);
      expect(loanId).to.be.equal(1);
    });
    it('allows a lender to start a loan using ETH', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          ethers.constants.AddressZero,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      const [loan, nftMarketBalance, aliceBalance, bobBalance] =
        await Promise.all([
          nftMarket.loans(nft.address, 1),
          ethers.provider.getBalance(nftMarket.address),
          alice.getBalance(),
          bob.getBalance(),
        ]);

      expect(loan.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(loan.principal).to.be.equal(TEN_BTC);
      expect(loan.maturity).to.be.equal(ONE_DAY.mul(15));
      expect(loan.interestRate).to.be.equal(INTEREST_RATE);
      expect(loan.tokenId).to.be.equal(1);
      expect(loan.borrower).to.be.equal(alice.address);
      expect(loan.lender).to.be.equal(ethers.constants.AddressZero);
      expect(loan.startDate).to.be.equal(0);

      const timestamp = (
        await ethers.provider.getBlock(await ethers.provider.getBlockNumber())
      ).timestamp;

      const principalToSend = TEN_BTC.mul(
        ethers.BigNumber.from(995).mul(
          ethers.BigNumber.from('1000000000000000')
        )
      ).div(parseEther('1'));

      await expect(
        nftMarket.connect(bob).lenderStartLoan(nft.address, 1, {
          value: TEN_BTC,
        })
      )
        .to.emit(nftMarket, 'LenderStartLoan')
        .withArgs(
          nft.address,
          1,
          bob.address,
          alice.address,
          ethers.constants.AddressZero,
          principalToSend
        )
        .to.not.emit(btc, 'Transfer')
        .to.not.emit(usdc, 'Transfer');

      const [loan2, nftMarketBalance2, loanId, aliceBalance2, bobBalance2] =
        await Promise.all([
          nftMarket.loans(nft.address, 1),
          ethers.provider.getBalance(nftMarket.address),
          nftMarket.getUserLoanId(nft.address, bob.address, 0),
          alice.getBalance(),
          bob.getBalance(),
        ]);

      const fee = TEN_BTC.sub(principalToSend);

      expect(loan2.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(loan2.principal).to.be.equal(TEN_BTC);
      expect(loan2.maturity).to.be.equal(ONE_DAY.mul(15));
      expect(loan2.interestRate).to.be.equal(INTEREST_RATE);
      expect(loan2.tokenId).to.be.equal(1);
      expect(loan2.borrower).to.be.equal(alice.address);
      expect(loan2.lender).to.be.equal(bob.address);
      expect(loan2.startDate.gte(timestamp)).to.be.equal(true);
      expect(nftMarketBalance.eq(nftMarketBalance2.sub(fee))).to.be.equal(true);
      expect(loanId).to.be.equal(1);
      expect(aliceBalance.add(principalToSend).eq(aliceBalance2)).to.be.equal(
        true
      );
      // lte because of fees
      expect(bobBalance2.add(principalToSend).lte(bobBalance)).to.be.equal(
        true
      );
    });
  });
  describe('function: borrowerStartLoan', () => {
    it('reverts if you try to start an on-going loan', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          btc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await nftMarket.connect(bob).lenderStartLoan(nft.address, 1);

      await expect(
        nftMarket.connect(alice).borrowerStartLoan(nft.address, 1, bob.address)
      ).to.revertedWith('NFTM: loan in progress');

      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          btc.address,
          99,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      nftMarket
        .connect(bob)
        .counterOffer(
          nft.address,
          usdc.address,
          99,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30)
        );

      await nftMarket
        .connect(alice)
        .borrowerStartLoan(nft.address, 99, bob.address);

      await expect(
        nftMarket.connect(alice).borrowerStartLoan(nft.address, 99, bob.address)
      ).to.revertedWith('NFTM: loan in progress');
    });
    it('reverts if the msg.sender is not the borrower', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          btc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      nftMarket
        .connect(bob)
        .counterOffer(
          nft.address,
          usdc.address,
          1,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30)
        );

      await expect(
        nftMarket.connect(bob).borrowerStartLoan(nft.address, 1, bob.address)
      ).to.revertedWith('NFTM: no permission');
    });
    it('reverts if the proposer does not exist', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          btc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await expect(
        nftMarket.connect(alice).borrowerStartLoan(nft.address, 1, bob.address)
      ).to.revertedWith('NFTM: proposal not found');
    });

    it('reverts if you the borrower tries to reenter', async () => {
      // ReentrantNFTMarketBorrowerStartLoan

      const attackContract: ReentrantNFTMarketBorrowerStartLoan = await deploy(
        'ReentrantNFTMarketBorrowerStartLoan',
        [nftMarket.address]
      );

      await nft
        .connect(alice)
        .transferFrom(alice.address, attackContract.address, 1);

      await attackContract
        .connect(alice)
        .proposeLoan(
          nft.address,
          btc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await nftMarket
        .connect(bob)
        .counterOffer(
          nft.address,
          ethers.constants.AddressZero,
          1,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30),
          {
            value: TEN_BTC.mul(2),
          }
        );

      await expect(
        attackContract
          .connect(alice)
          .borrowerStartLoan(nft.address, 1, bob.address)
      ).to.revertedWith('ReentrancyGuard: reentrant call');
    });

    it('allows a borrower to start an ERC20 loan from a proposal', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          btc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await nftMarket
        .connect(bob)
        .counterOffer(
          nft.address,
          usdc.address,
          1,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30)
        );

      const principalToSend = TEN_BTC.mul(2)
        .mul(
          ethers.BigNumber.from(995).mul(
            ethers.BigNumber.from('1000000000000000')
          )
        )
        .div(parseEther('1'));

      const [loan, proposal, nftMarketBalance] = await Promise.all([
        nftMarket.loans(nft.address, 1),
        nftMarket.proposals(nft.address, 1, bob.address),
        ethers.provider.getBalance(nftMarket.address),
      ]);

      expect(loan.loanToken).to.be.equal(btc.address);
      expect(loan.principal).to.be.equal(TEN_BTC);
      expect(loan.maturity).to.be.equal(ONE_DAY.mul(15));
      expect(loan.interestRate).to.be.equal(INTEREST_RATE);
      expect(loan.tokenId).to.be.equal(1);
      expect(loan.borrower).to.be.equal(alice.address);
      expect(loan.lender).to.be.equal(ethers.constants.AddressZero);
      expect(loan.startDate).to.be.equal(0);

      expect(proposal.interestRate).to.be.equal(INTEREST_RATE.add(1));
      expect(proposal.lender).to.be.equal(bob.address);
      expect(proposal.principal).to.be.equal(TEN_BTC.mul(2));
      expect(proposal.loanToken).to.be.equal(usdc.address);
      expect(proposal.maturity).to.be.equal(ONE_DAY.mul(30));

      const timestamp = (
        await ethers.provider.getBlock(await ethers.provider.getBlockNumber())
      ).timestamp;

      await expect(
        nftMarket.connect(alice).borrowerStartLoan(nft.address, 1, bob.address)
      )
        .to.emit(nftMarket, 'BorrowerStartLoan')
        .withArgs(
          nft.address,
          1,
          bob.address,
          alice.address,
          usdc.address,
          principalToSend
        )
        .to.emit(usdc, 'Transfer')
        .withArgs(bob.address, nftMarket.address, TEN_BTC.mul(2))
        .to.emit(usdc, 'Transfer')
        .withArgs(nftMarket.address, alice.address, principalToSend);

      const [loan2, proposal2, nftMarketBalance2] = await Promise.all([
        nftMarket.loans(nft.address, 1),
        nftMarket.proposals(nft.address, 1, bob.address),
        ethers.provider.getBalance(nftMarket.address),
      ]);

      expect(loan2.loanToken).to.be.equal(usdc.address);
      expect(loan2.principal).to.be.equal(TEN_BTC.mul(2));
      expect(loan2.maturity).to.be.equal(ONE_DAY.mul(30));
      expect(loan2.interestRate).to.be.equal(INTEREST_RATE.add(1));
      expect(loan2.tokenId).to.be.equal(1);
      expect(loan2.borrower).to.be.equal(alice.address);
      expect(loan2.lender).to.be.equal(bob.address);
      expect(loan2.startDate.gte(timestamp)).to.be.equal(true);

      expect(proposal2.interestRate).to.be.equal(0);
      expect(proposal2.lender).to.be.equal(ethers.constants.AddressZero);
      expect(proposal2.principal).to.be.equal(0);
      expect(proposal2.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(proposal2.maturity).to.be.equal(0);

      expect(nftMarketBalance.eq(nftMarketBalance2)).to.be.equal(true);
    });
    it('allows a borrower to start an ETH loan from a proposal', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          usdc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await nftMarket
        .connect(bob)
        .counterOffer(
          nft.address,
          ethers.constants.AddressZero,
          1,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30),
          { value: TEN_BTC.mul(2) }
        );

      const principalToSend = TEN_BTC.mul(2)
        .mul(
          ethers.BigNumber.from(995).mul(
            ethers.BigNumber.from('1000000000000000')
          )
        )
        .div(parseEther('1'));

      const [loan, proposal, nftMarketBalance, aliceBalance] =
        await Promise.all([
          nftMarket.loans(nft.address, 1),
          nftMarket.proposals(nft.address, 1, bob.address),
          ethers.provider.getBalance(nftMarket.address),
          alice.getBalance(),
        ]);

      expect(loan.loanToken).to.be.equal(usdc.address);
      expect(loan.principal).to.be.equal(TEN_BTC);
      expect(loan.maturity).to.be.equal(ONE_DAY.mul(15));
      expect(loan.interestRate).to.be.equal(INTEREST_RATE);
      expect(loan.tokenId).to.be.equal(1);
      expect(loan.borrower).to.be.equal(alice.address);
      expect(loan.lender).to.be.equal(ethers.constants.AddressZero);
      expect(loan.startDate).to.be.equal(0);

      expect(proposal.interestRate).to.be.equal(INTEREST_RATE.add(1));
      expect(proposal.lender).to.be.equal(bob.address);
      expect(proposal.principal).to.be.equal(TEN_BTC.mul(2));
      expect(proposal.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(proposal.maturity).to.be.equal(ONE_DAY.mul(30));

      const timestamp = (
        await ethers.provider.getBlock(await ethers.provider.getBlockNumber())
      ).timestamp;

      await expect(
        nftMarket.connect(alice).borrowerStartLoan(nft.address, 1, bob.address)
      )
        .to.emit(nftMarket, 'BorrowerStartLoan')
        .withArgs(
          nft.address,
          1,
          bob.address,
          alice.address,
          ethers.constants.AddressZero,
          principalToSend
        )
        .to.not.emit(usdc, 'Transfer')
        .to.not.emit(btc, 'Transfer');

      const [loan2, proposal2, nftMarketBalance2, aliceBalance2] =
        await Promise.all([
          nftMarket.loans(nft.address, 1),
          nftMarket.proposals(nft.address, 1, bob.address),
          ethers.provider.getBalance(nftMarket.address),
          alice.getBalance(),
        ]);

      expect(loan2.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(loan2.principal).to.be.equal(TEN_BTC.mul(2));
      expect(loan2.maturity).to.be.equal(ONE_DAY.mul(30));
      expect(loan2.interestRate).to.be.equal(INTEREST_RATE.add(1));
      expect(loan2.tokenId).to.be.equal(1);
      expect(loan2.borrower).to.be.equal(alice.address);
      expect(loan2.lender).to.be.equal(bob.address);
      expect(loan2.startDate.gte(timestamp)).to.be.equal(true);

      expect(proposal2.interestRate).to.be.equal(0);
      expect(proposal2.lender).to.be.equal(ethers.constants.AddressZero);
      expect(proposal2.principal).to.be.equal(0);
      expect(proposal2.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(proposal2.maturity).to.be.equal(0);

      expect(
        nftMarketBalance.eq(nftMarketBalance2.add(principalToSend))
      ).to.be.equal(true);

      // We subtract 0.5 ether because of fees
      expect(
        aliceBalance2.gt(
          aliceBalance.add(TEN_BTC.mul(2).sub(parseEther('0.5')))
        )
      ).to.be.equal(true);
    });
  });
  describe('function: withdrawBNB', () => {
    it('reverts if the proposal has been accepted', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          usdc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await nftMarket
        .connect(bob)
        .counterOffer(
          nft.address,
          ethers.constants.AddressZero,
          1,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30),
          { value: TEN_BTC.mul(2) }
        );

      await nftMarket
        .connect(alice)
        .borrowerStartLoan(nft.address, 1, bob.address);

      await expect(
        nftMarket.connect(bob).withdrawBNB(nft.address, 1, bob.address)
      ).to.revertedWith('NFTM: no permission');

      await expect(
        nftMarket.connect(bob).withdrawBNB(nft.address, 2, bob.address)
      ).to.revertedWith('NFTM: no permission');
    });
    it('reverts if the caller tries to reenter', async () => {
      const attackContract: ReentrantNFTMarketWithdrawBNB = await deploy(
        'ReentrantNFTMarketWithdrawBNB',
        [nftMarket.address]
      );

      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          usdc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await attackContract
        .connect(bob)
        .counterOffer(
          nft.address,
          ethers.constants.AddressZero,
          1,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30),
          { value: TEN_BTC.mul(2) }
        );

      await expect(
        attackContract
          .connect(bob)
          .withdrawBNB(nft.address, 1, attackContract.address)
      ).to.revertedWith('ReentrancyGuard: reentrant call');
    });
    it('reverts if the contract does not have enough BNB', async () => {
      const testNFTMarket: TestNFTMarket = await deployUUPS('TestNFTMarket', [
        feeTo.address,
      ]);

      await nft.connect(alice).setApprovalForAll(testNFTMarket.address, true);

      await testNFTMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          usdc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );
      await testNFTMarket
        .connect(bob)
        .counterOffer(
          nft.address,
          ethers.constants.AddressZero,
          1,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30),
          { value: TEN_BTC.mul(2) }
        );

      await testNFTMarket.connect(owner).stealBNB();

      await expect(
        testNFTMarket.connect(bob).withdrawBNB(nft.address, 1, bob.address)
      ).to.revertedWith('NFTM: not enough BNB');
    });
    it('allows you to withdraw ETH if the proposal was not accepted', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          usdc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await nftMarket
        .connect(bob)
        .counterOffer(
          nft.address,
          ethers.constants.AddressZero,
          1,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30),
          { value: TEN_BTC.mul(2) }
        );

      const [proposal, bobBalance] = await Promise.all([
        nftMarket.proposals(nft.address, 1, bob.address),
        bob.getBalance(),
      ]);

      expect(proposal.interestRate).to.be.equal(INTEREST_RATE.add(1));
      expect(proposal.lender).to.be.equal(bob.address);
      expect(proposal.principal).to.be.equal(TEN_BTC.mul(2));
      expect(proposal.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(proposal.maturity).to.be.equal(ONE_DAY.mul(30));

      await expect(
        nftMarket.connect(bob).withdrawBNB(nft.address, 1, bob.address)
      )
        .to.emit(nftMarket, 'WithdrawBNB')
        .withArgs(nft.address, 1, bob.address, TEN_BTC.mul(2));

      const [proposal2, bobBalance2] = await Promise.all([
        nftMarket.proposals(nft.address, 1, bob.address),
        bob.getBalance(),
      ]);

      expect(proposal2.interestRate).to.be.equal(0);
      expect(proposal2.lender).to.be.equal(ethers.constants.AddressZero);
      expect(proposal2.principal).to.be.equal(0);
      expect(proposal2.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(proposal2.maturity).to.be.equal(0);
      // 19 and not 20 to account for fees
      expect(bobBalance2.gt(bobBalance.add(parseEther('19')))).to.be.equal(
        true
      );
    });
  });
  describe('function: withdraw NFT', () => {
    it('reverts if the  loan has started already', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          usdc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await nftMarket.connect(bob).lenderStartLoan(nft.address, 1);

      await expect(
        nftMarket.connect(alice).withdrawNFT(nft.address, 1)
      ).to.revertedWith('NFTM: loan in progress');

      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          usdc.address,
          99,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await nftMarket
        .connect(bob)
        .counterOffer(
          nft.address,
          ethers.constants.AddressZero,
          99,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30),
          { value: TEN_BTC.mul(2) }
        );

      await nftMarket
        .connect(alice)
        .borrowerStartLoan(nft.address, 99, bob.address);

      await expect(
        nftMarket.connect(alice).withdrawNFT(nft.address, 99)
      ).to.revertedWith('NFTM: loan in progress');
    });
    it('reverts if the caller is not the borrower', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          usdc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await expect(
        nftMarket.connect(bob).withdrawNFT(nft.address, 1)
      ).to.revertedWith('NFTM: no permission');
    });
    it('allows a proposer to withdraw the NFT', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          usdc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      const [loan, nftOwner] = await Promise.all([
        nftMarket.loans(nft.address, 1),
        nft.ownerOf(1),
      ]);

      expect(nftOwner).to.be.equal(nftMarket.address);

      expect(loan.loanToken).to.be.equal(usdc.address);
      expect(loan.principal).to.be.equal(TEN_BTC);
      expect(loan.maturity).to.be.equal(ONE_DAY.mul(15));
      expect(loan.interestRate).to.be.equal(INTEREST_RATE);
      expect(loan.tokenId).to.be.equal(1);
      expect(loan.borrower).to.be.equal(alice.address);
      expect(loan.lender).to.be.equal(ethers.constants.AddressZero);
      expect(loan.startDate).to.be.equal(0);

      await expect(nftMarket.connect(alice).withdrawNFT(nft.address, 1))
        .to.emit(nftMarket, 'WithdrawNFT')
        .withArgs(nft.address, 1, alice.address);

      const [loan2, nftOwner2] = await Promise.all([
        nftMarket.loans(nft.address, 1),
        nft.ownerOf(1),
      ]);

      expect(nftOwner2).to.be.equal(alice.address);

      expect(loan2.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(loan2.principal).to.be.equal(0);
      expect(loan2.maturity).to.be.equal(0);
      expect(loan2.interestRate).to.be.equal(0);
      expect(loan2.tokenId).to.be.equal(0);
      expect(loan2.borrower).to.be.equal(ethers.constants.AddressZero);
      expect(loan2.lender).to.be.equal(ethers.constants.AddressZero);
      expect(loan2.startDate).to.be.equal(0);
    });
  });
  describe('function: liquidate', () => {
    it('reverts if the loan has not started', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          usdc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await expect(
        nftMarket.connect(bob).liquidate(nft.address, 1)
      ).to.revertedWith('NFTM: cannot be liquidated');

      await nftMarket
        .connect(bob)
        .counterOffer(
          nft.address,
          ethers.constants.AddressZero,
          1,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30),
          { value: TEN_BTC.mul(2) }
        );

      await expect(
        nftMarket.connect(bob).liquidate(nft.address, 1)
      ).to.revertedWith('NFTM: cannot be liquidated');
    });
    it('reverts if the loan has started but it is before the maturity date', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          usdc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await nftMarket.connect(bob).lenderStartLoan(nft.address, 1);

      await advanceBlockAndTime(ONE_DAY.mul(14).toNumber(), ethers);

      await expect(
        nftMarket.connect(bob).liquidate(nft.address, 1)
      ).to.revertedWith('NFTM: cannot be liquidated');

      await expect(
        nftMarket.connect(alice).liquidate(nft.address, 1)
      ).to.revertedWith('NFTM: cannot be liquidated');

      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          usdc.address,
          99,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await nftMarket
        .connect(bob)
        .counterOffer(
          nft.address,
          ethers.constants.AddressZero,
          99,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30),
          { value: TEN_BTC.mul(2) }
        );

      await nftMarket
        .connect(alice)
        .borrowerStartLoan(nft.address, 99, bob.address);

      await advanceBlockAndTime(ONE_DAY.mul(29).toNumber(), ethers);

      await expect(
        nftMarket.connect(bob).liquidate(nft.address, 99)
      ).to.revertedWith('NFTM: cannot be liquidated');

      await expect(
        nftMarket.connect(alice).liquidate(nft.address, 99)
      ).to.revertedWith('NFTM: cannot be liquidated');
    });
    it('allows liquidations', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          usdc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      const timestamp = (
        await ethers.provider.getBlock(await ethers.provider.getBlockNumber())
      ).timestamp;

      await nftMarket.connect(bob).lenderStartLoan(nft.address, 1);

      await advanceBlockAndTime(ONE_DAY.mul(15).toNumber(), ethers);

      const [loan, nftOwner] = await Promise.all([
        nftMarket.loans(nft.address, 1),
        nft.ownerOf(1),
      ]);

      expect(nftOwner).to.be.equal(nftMarket.address);

      expect(loan.loanToken).to.be.equal(usdc.address);
      expect(loan.principal).to.be.equal(TEN_BTC);
      expect(loan.maturity).to.be.equal(ONE_DAY.mul(15));
      expect(loan.interestRate).to.be.equal(INTEREST_RATE);
      expect(loan.tokenId).to.be.equal(1);
      expect(loan.borrower).to.be.equal(alice.address);
      expect(loan.lender).to.be.equal(bob.address);
      expect(loan.startDate.gte(timestamp)).to.be.equal(true);

      await expect(nftMarket.connect(bob).liquidate(nft.address, 1))
        .to.emit(nftMarket, 'Liquidate')
        .withArgs(nft.address, 1, bob.address, alice.address);

      const [loan2, nftOwner2] = await Promise.all([
        nftMarket.loans(nft.address, 1),
        nft.ownerOf(1),
      ]);

      expect(nftOwner2).to.be.equal(bob.address);

      expect(loan2.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(loan2.principal).to.be.equal(0);
      expect(loan2.maturity).to.be.equal(0);
      expect(loan2.interestRate).to.be.equal(0);
      expect(loan2.tokenId).to.be.equal(0);
      expect(loan2.borrower).to.be.equal(ethers.constants.AddressZero);
      expect(loan2.lender).to.be.equal(ethers.constants.AddressZero);
      expect(loan2.startDate).to.be.equal(0);

      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          usdc.address,
          99,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await nftMarket
        .connect(bob)
        .counterOffer(
          nft.address,
          ethers.constants.AddressZero,
          99,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30),
          { value: TEN_BTC.mul(2) }
        );

      const timestamp2 = (
        await ethers.provider.getBlock(await ethers.provider.getBlockNumber())
      ).timestamp;

      await nftMarket
        .connect(alice)
        .borrowerStartLoan(nft.address, 99, bob.address);

      const [loan3, nftOwner3] = await Promise.all([
        nftMarket.loans(nft.address, 99),
        nft.ownerOf(99),
      ]);

      expect(nftOwner3).to.be.equal(nftMarket.address);

      expect(loan3.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(loan3.principal).to.be.equal(TEN_BTC.mul(2));
      expect(loan3.maturity).to.be.equal(ONE_DAY.mul(30));
      expect(loan3.interestRate).to.be.equal(INTEREST_RATE.add(1));
      expect(loan3.tokenId).to.be.equal(99);
      expect(loan3.borrower).to.be.equal(alice.address);
      expect(loan3.lender).to.be.equal(bob.address);
      expect(loan3.startDate.gte(timestamp2)).to.be.equal(true);

      await advanceBlockAndTime(ONE_DAY.mul(30).toNumber(), ethers);

      await expect(nftMarket.connect(bob).liquidate(nft.address, 99))
        .to.emit(nftMarket, 'Liquidate')
        .withArgs(nft.address, 99, bob.address, alice.address);

      const [loan4, nftOwner4] = await Promise.all([
        nftMarket.loans(nft.address, 99),
        nft.ownerOf(99),
      ]);

      expect(nftOwner4).to.be.equal(bob.address);

      expect(loan4.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(loan4.principal).to.be.equal(0);
      expect(loan4.maturity).to.be.equal(0);
      expect(loan4.interestRate).to.be.equal(0);
      expect(loan4.tokenId).to.be.equal(0);
      expect(loan4.borrower).to.be.equal(ethers.constants.AddressZero);
      expect(loan4.lender).to.be.equal(ethers.constants.AddressZero);
      expect(loan4.startDate).to.be.equal(0);
    });
  });
  it('allows to get earnings', async () => {
    await nftMarket
      .connect(alice)
      .proposeLoan(
        nft.address,
        usdc.address,
        1,
        TEN_BTC,
        INTEREST_RATE,
        ONE_DAY.mul(15)
      );

    await nftMarket.connect(bob).lenderStartLoan(nft.address, 1);

    await advanceBlockAndTime(ONE_DAY.mul(15).toNumber(), ethers);

    expect(await usdc.balanceOf(feeTo.address)).to.be.equal(0);

    await nftMarket.connect(alice).repay(nft.address, 1);

    const fee = ONE_DAY.mul(15)
      .mul(INTEREST_RATE.mul(TEN_BTC))
      .div(parseEther('1'));

    // 0.02e18
    const protocolFee = fee
      .mul(
        ethers.BigNumber.from(200).mul(ethers.BigNumber.from('100000000000000'))
      )
      .div(parseEther('1'));

    await nftMarket.getEarnings(usdc.address);

    // Principal + fees
    expect((await usdc.balanceOf(feeTo.address)).gte(protocolFee)).to.be.equal(
      true
    );

    await nftMarket
      .connect(alice)
      .proposeLoan(
        nft.address,
        ethers.constants.AddressZero,
        99,
        TEN_BTC.mul(100),
        INTEREST_RATE.mul(1000),
        ONE_DAY.mul(90)
      );

    await nftMarket
      .connect(bob)
      .lenderStartLoan(nft.address, 99, { value: TEN_BTC.mul(100) });

    const feeToBalance = await ethers.provider.getBalance(feeTo.address);

    await advanceBlockAndTime(ONE_DAY.mul(90).toNumber(), ethers);

    const fee2 = INTEREST_RATE.mul(1000)
      .mul(TEN_BTC.mul(100))
      .mul(ONE_DAY.mul(90).add(60 * 3)) // 3 minutes to estimate the amount needed
      .div(parseEther('1'));

    // 0.02e18
    const protocolFee2 = fee2
      .mul(
        ethers.BigNumber.from(2000).mul(ethers.BigNumber.from('10000000000000'))
      )
      .div(parseEther('1'));

    await nftMarket.connect(alice).repay(nft.address, 99, {
      value: TEN_BTC.mul(100).add(fee2).add(protocolFee2),
    });

    await nftMarket.getEarnings(ethers.constants.AddressZero);

    const feeToBalance2 = await ethers.provider.getBalance(feeTo.address);

    expect(feeToBalance2.gt(feeToBalance.add(parseEther('1')))).to.be.equal(
      true
    );
  });
  describe('function: repay', () => {
    it('reverts if the loan has not started or does not exist', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          usdc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await expect(
        nftMarket.connect(bob).repay(nft.address, 1)
      ).to.revertedWith('NFTM: no loan');

      await nftMarket
        .connect(bob)
        .counterOffer(
          nft.address,
          ethers.constants.AddressZero,
          1,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30),
          { value: TEN_BTC.mul(2) }
        );

      await expect(
        nftMarket.connect(alice).repay(nft.address, 1)
      ).to.revertedWith('NFTM: no loan');

      await expect(
        nftMarket.connect(alice).repay(nft.address, 99)
      ).to.revertedWith('NFTM: no loan');
    });

    it('reverts if the caller tries to reenter', async () => {
      const attackContract: ReentrantNFTMarketRepay = await deploy(
        'ReentrantNFTMarketRepay',
        [nftMarket.address]
      );

      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          ethers.constants.AddressZero,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await attackContract
        .connect(bob)
        .lenderStartLoan(nft.address, 1, { value: TEN_BTC });

      // Send a bit more because of time delays
      const fee = ONE_DAY.mul(20)
        .mul(INTEREST_RATE.mul(TEN_BTC))
        .div(parseEther('1'));

      // 0.02e18
      const protocolFee = fee
        .mul(
          ethers.BigNumber.from(200).mul(
            ethers.BigNumber.from('100000000000000')
          )
        )
        .div(parseEther('1'));

      await advanceBlockAndTime(ONE_DAY.mul(16).toNumber(), ethers);

      await expect(
        nftMarket
          .connect(bob)
          .repay(nft.address, 1, { value: fee.add(protocolFee).add(TEN_BTC) })
      ).to.revertedWith('ReentrancyGuard: reentrant call');
    });

    it('allows a loan to be repaid in ERC20', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          usdc.address,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await nftMarket.connect(bob).lenderStartLoan(nft.address, 1);

      await advanceBlockAndTime(ONE_DAY.mul(16).toNumber(), ethers);

      const [loan, nftMarketUSDCBalance, aliceUSDCBalance, nftOwner] =
        await Promise.all([
          nftMarket.loans(nft.address, 1),
          usdc.balanceOf(nftMarket.address),
          usdc.balanceOf(alice.address),
          nft.ownerOf(1),
        ]);

      expect(loan.loanToken).to.be.equal(usdc.address);
      expect(loan.principal).to.be.equal(TEN_BTC);
      expect(loan.maturity).to.be.equal(ONE_DAY.mul(15));
      expect(loan.interestRate).to.be.equal(INTEREST_RATE);
      expect(loan.tokenId).to.be.equal(1);
      expect(loan.borrower).to.be.equal(alice.address);
      expect(loan.lender).to.be.equal(bob.address);
      expect(loan.startDate.gt(0)).to.be.equal(true);

      expect(nftMarketUSDCBalance).to.be.equal(0);

      expect(nftOwner).to.be.equal(nftMarket.address);

      await expect(nftMarket.connect(alice).repay(nft.address, 1))
        .to.emit(nftMarket, 'Repay')
        .to.emit(usdc, 'Transfer');

      const [loan2, nftMarketUSDCBalance2, aliceUSDCBalance2, nftOwner2] =
        await Promise.all([
          nftMarket.loans(nft.address, 1),
          usdc.balanceOf(nftMarket.address),
          usdc.balanceOf(alice.address),
          nft.ownerOf(1),
        ]);

      const fee = ONE_DAY.mul(15)
        .mul(INTEREST_RATE.mul(TEN_BTC))
        .div(parseEther('1'));

      // 0.02e18
      const protocolFee = fee
        .mul(
          ethers.BigNumber.from(200).mul(
            ethers.BigNumber.from('100000000000000')
          )
        )
        .div(parseEther('1'));

      expect(loan2.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(loan2.principal).to.be.equal(0);
      expect(loan2.maturity).to.be.equal(0);
      expect(loan2.interestRate).to.be.equal(0);
      expect(loan2.tokenId).to.be.equal(0);
      expect(loan2.borrower).to.be.equal(ethers.constants.AddressZero);
      expect(loan2.lender).to.be.equal(ethers.constants.AddressZero);
      expect(loan2.startDate).to.be.equal(0);

      expect(nftMarketUSDCBalance2.gte(protocolFee)).to.be.equal(true);

      // estimate fees we use lte
      expect(
        aliceUSDCBalance2.lte(aliceUSDCBalance.sub(fee.add(TEN_BTC)))
      ).to.be.equal(true);

      expect(nftOwner2).to.be.equal(alice.address);
    });
    it('allows a loan to be repaid in ETH', async () => {
      it('allows a loan to be repaid in ERC20', async () => {
        await nftMarket
          .connect(alice)
          .proposeLoan(
            nft.address,
            ethers.constants.AddressZero,
            1,
            TEN_BTC,
            INTEREST_RATE,
            ONE_DAY.mul(15)
          );

        await nftMarket
          .connect(bob)
          .lenderStartLoan(nft.address, 1, { value: TEN_BTC });

        const [loan, nftMarketBalance, aliceBalance, bobBalance, nftOwner] =
          await Promise.all([
            nftMarket.loans(nft.address, 1),
            ethers.provider.getBalance(nftMarket.address),
            alice.getBalance(),
            bob.getBalance(),
            nft.ownerOf(1),
          ]);

        expect(loan.loanToken).to.be.equal(ethers.constants.AddressZero);
        expect(loan.principal).to.be.equal(TEN_BTC);
        expect(loan.maturity).to.be.equal(ONE_DAY.mul(15));
        expect(loan.interestRate).to.be.equal(INTEREST_RATE);
        expect(loan.tokenId).to.be.equal(1);
        expect(loan.borrower).to.be.equal(alice.address);
        expect(loan.lender).to.be.equal(bob.address);
        expect(loan.startDate.gt(0)).to.be.equal(true);

        expect(nftOwner).to.be.equal(nftMarket.address);

        // Send a bit mroe because of time delays
        const fee = ONE_DAY.mul(16)
          .mul(INTEREST_RATE.mul(TEN_BTC))
          .div(parseEther('1'));

        // 0.02e18
        const protocolFee = fee
          .mul(
            ethers.BigNumber.from(200).mul(
              ethers.BigNumber.from('100000000000000')
            )
          )
          .div(parseEther('1'));

        await advanceBlockAndTime(ONE_DAY.mul(16).toNumber(), ethers);

        await expect(
          nftMarket
            .connect(bob)
            .repay(nft.address, 1, { value: fee.add(protocolFee).add(TEN_BTC) })
        )
          .to.emit(nftMarket, 'Repay')
          .to.not.emit(usdc, 'Transfer')
          .to.not.emit(btc, 'Transfer');

        const [
          loan2,
          nftMarketBalance2,
          aliceBalance2,
          bobBalance2,
          nftOwner2,
        ] = await Promise.all([
          nftMarket.loans(nft.address, 1),
          ethers.provider.getBalance(nftMarket.address),
          alice.getBalance(),
          bob.getBalance(),
          nft.ownerOf(1),
        ]);

        expect(loan2.loanToken).to.be.equal(ethers.constants.AddressZero);
        expect(loan2.principal).to.be.equal(0);
        expect(loan2.maturity).to.be.equal(0);
        expect(loan2.interestRate).to.be.equal(0);
        expect(loan2.tokenId).to.be.equal(0);
        expect(loan2.borrower).to.be.equal(ethers.constants.AddressZero);
        expect(loan2.lender).to.be.equal(ethers.constants.AddressZero);
        expect(loan2.startDate).to.be.equal(0);

        expect(
          nftMarketBalance2.gte(nftMarketBalance.add(protocolFee))
        ).to.be.equal(true);

        // estimate fees we use lte
        expect(
          aliceBalance2.gte(aliceBalance.sub(fee.add(TEN_BTC)))
        ).to.be.equal(true);

        expect(
          bobBalance2.lte(bobBalance.sub(fee.add(protocolFee).add(TEN_BTC)))
        ).to.equal(true);

        expect(nftOwner2).to.be.equal(alice.address);
      });
    });
    it('reverts if you the caller does not send enough ETH', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          ethers.constants.AddressZero,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      await nftMarket
        .connect(bob)
        .lenderStartLoan(nft.address, 1, { value: TEN_BTC });

      await advanceBlockAndTime(ONE_DAY.mul(16).toNumber(), ethers);

      await expect(
        nftMarket.connect(bob).repay(nft.address, 1, { value: TEN_BTC })
      ).to.revertedWith('NFTM: incorrect amount');
    });
  });

  describe('Upgrade functionality', () => {
    it('reverts if it is called by a non-owner account', async () => {
      await nftMarket.connect(owner).transferOwnership(alice.address);

      await expect(upgrade(nftMarket, 'TestNFTMarketV2')).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });

    it('upgrades to version 2', async () => {
      await nftMarket
        .connect(alice)
        .proposeLoan(
          nft.address,
          ethers.constants.AddressZero,
          1,
          TEN_BTC,
          INTEREST_RATE,
          ONE_DAY.mul(15)
        );

      const nftMarketV2: TestNFTMarketV2 = await upgrade(
        nftMarket,
        'TestNFTMarketV2'
      );

      const [loan, version] = await Promise.all([
        nftMarketV2.loans(nft.address, 1),
        nftMarketV2.version(),
      ]);

      expect(version).to.be.equal('V2');
      expect(loan.lender).to.be.equal(ethers.constants.AddressZero);
      expect(loan.borrower).to.be.equal(alice.address);
      expect(loan.loanToken).to.be.equal(ethers.constants.AddressZero);
      expect(loan.interestRate).to.be.equal(INTEREST_RATE);
      expect(loan.tokenId).to.be.equal(1);
      expect(loan.maturity).to.be.equal(ONE_DAY.mul(15));
      expect(loan.startDate).to.be.equal(0);
      expect(loan.principal).to.be.equal(TEN_BTC);
    });
  });
  it('returns the total number of counterOffers', async () => {
    await nftMarket
      .connect(alice)
      .proposeLoan(
        nft.address,
        btc.address,
        1,
        TEN_BTC,
        INTEREST_RATE,
        ONE_DAY.mul(15)
      );

    expect(await nftMarket.getTotalProposals(nft.address, 1)).to.be.equal(0);

    await Promise.all([
      nftMarket
        .connect(bob)
        .counterOffer(
          nft.address,
          btc.address,
          1,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30)
        ),
      nftMarket
        .connect(owner)
        .counterOffer(
          nft.address,
          usdc.address,
          1,
          TEN_BTC.mul(2),
          INTEREST_RATE.add(1),
          ONE_DAY.mul(30)
        ),
    ]);

    expect(await nftMarket.getTotalProposals(nft.address, 1)).to.be.equal(2);
  });
}).timeout(5000);
