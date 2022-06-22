// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

import "../../SafeVenus.sol";

contract TestSafeVenus is SafeVenus {
    function testSafeCollateralLimit(IVToken vToken, uint256 collateralLimit)
        external
        view
        returns (uint256)
    {
        return safeCollateralRatio(vToken, collateralLimit);
    }

    function testBorrowInterestPerBlock(
        IVToken vToken,
        address account,
        uint256 amount
    ) external view returns (uint256, uint256) {
        return borrowInterestPerBlock(vToken, account, amount);
    }

    function testPredictBorrowRate(IVToken vToken, uint256 amount)
        external
        view
        returns (uint256)
    {
        return predictBorrowRate(vToken, amount);
    }

    function testPredictSupplyRate(IVToken vToken, uint256 amount)
        external
        view
        returns (uint256)
    {
        return predictSupplyRate(vToken, amount);
    }
}
