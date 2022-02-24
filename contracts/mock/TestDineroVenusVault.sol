// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

import "../interfaces/IVenusTroller.sol";
import "../interfaces/IVToken.sol";
import "../interfaces/IPancakeRouter02.sol";

import "../tokens/Dinero.sol";

import "../DineroVenusVault.sol";
import "../SafeVenus.sol";

//solhint-disable

contract TestDineroVenusVault is DineroVenusVault {
    constructor(
        address xvs,
        address wbnb,
        IPancakeRouter02 router,
        IVenusTroller venusTroller,
        Dinero dinero,
        SafeVenus safeVenus,
        address feeTo
    )
        DineroVenusVault(
            xvs,
            wbnb,
            router,
            venusTroller,
            dinero,
            safeVenus,
            feeTo
        )
    {}

    // Testing
    function borrow(IVToken vToken, uint256 amount) external {
        vToken.borrow(amount);
    }
}
