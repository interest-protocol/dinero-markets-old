//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

import "../../SafeVenus.sol";

//solhint-disable

contract TestSafeVenus {
    event BorrowAndSupply(uint256 borrow, uint256 supply);

    event IsProfitable(bool result);

    event SafeBorrow(uint256 amount);

    event SafeRedeem(uint256 amount);

    event BorrowInterestPerBlock(uint256 cost, uint256 profit);

    event SupplyRewardPerBlock(uint256 profit);

    event PredictBorrowRate(uint256 rate);

    event PredictSupplyRate(uint256 rate);

    event Deleverage(uint256 amount);

    SafeVenus public immutable SAFE_VENUS;

    constructor(SafeVenus safeVenus) {
        SAFE_VENUS = safeVenus;
    }

    function safeCollateralRatio(IVenusVault vault, IVToken vToken)
        public
        view
        returns (uint256)
    {
        return SAFE_VENUS.safeCollateralRatio(vault, vToken);
    }

    function borrowAndSupply(IVenusVault vault, IVToken vToken) public {
        (uint256 borrow, uint256 supply) = SAFE_VENUS.borrowAndSupply(
            vault,
            vToken
        );

        emit BorrowAndSupply(borrow, supply);
    }

    function isProfitable(
        IVenusVault vault,
        IVToken vToken,
        uint256 amount
    ) external {
        bool result = SAFE_VENUS.isProfitable(vault, vToken, amount);

        emit IsProfitable(result);
    }

    function safeBorrow(IVenusVault vault, IVToken vToken) external {
        uint256 amount = SAFE_VENUS.safeBorrow(vault, vToken);

        emit SafeBorrow(amount);
    }

    function safeRedeem(IVenusVault vault, IVToken vToken) external {
        uint256 amount = SAFE_VENUS.safeRedeem(vault, vToken);

        emit SafeRedeem(amount);
    }

    function borrowInterestPerBlock(
        IVenusVault vault,
        IVToken vToken,
        uint256 amount
    ) public {
        (uint256 cost, uint256 profit) = SAFE_VENUS.borrowInterestPerBlock(
            vault,
            vToken,
            amount
        );

        emit BorrowInterestPerBlock(cost, profit);
    }

    function supplyRewardPerBlock(
        IVenusVault vault,
        IVToken vToken,
        uint256 amount
    ) public {
        uint256 profit = SAFE_VENUS.supplyRewardPerBlock(vault, vToken, amount);

        emit SupplyRewardPerBlock(profit);
    }

    function predictBorrowRate(IVToken vToken, uint256 amount) public {
        uint256 rate = SAFE_VENUS.predictBorrowRate(vToken, amount);

        emit PredictBorrowRate(rate);
    }

    function predictSupplyRate(IVToken vToken, uint256 amount) public {
        uint256 rate = SAFE_VENUS.predictSupplyRate(vToken, amount);

        emit PredictSupplyRate(rate);
    }

    function deleverage(IVenusVault vault, IVToken vToken) public {
        uint256 amount = SAFE_VENUS.deleverage(vault, vToken);

        emit Deleverage(amount);
    }
}
