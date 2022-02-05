import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { MockERC20, MockNFT, NFTMarket } from '../typechain';
import { deploy, multiDeploy } from './lib/test-utils';

const { parseEther } = ethers.utils;

const ONE_DAY = ethers.BigNumber.from(60 * 60 * 24);

const INTEREST_RATE = ethers.BigNumber.from(12e8);

const TEN_BTC = parseEther('10');

describe('NFTMarket', () => {
  let btc: MockERC20;
  let usdc: MockERC20;
  let nft: MockNFT;
  let nftMarket: NFTMarket;

  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let feeTo: SignerWithAddress;

  beforeEach(async () => {
    [[btc, usdc, nft], [alice, bob, feeTo]] = await Promise.all([
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

    nftMarket = await deploy('NFTMarket', [feeTo.address]);

    await Promise.all([
      nft.mint(alice.address, 1),
      nft.mint(alice.address, 99),
      nft.connect(alice).setApprovalForAll(nftMarket.address, true),
      btc.mint(bob.address, parseEther('10000')),
      usdc.mint(bob.address, parseEther('10000')),
      btc.connect(bob).approve(nftMarket.address, ethers.constants.MaxUint256),
      usdc.connect(bob).approve(nftMarket.address, ethers.constants.MaxUint256),
    ]);
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
  });

  describe('function: lenderStartLoan', () => {
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
});
