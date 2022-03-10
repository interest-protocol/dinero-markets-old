//SPDX-License-Identifier: MIT
pragma solidity 0.8.12;

/**
 * @notice We use 2 uint64 and 1 uint128 for memory efficiency. These ranges should cover all cases.
 */
struct Loan {
    uint64 lastAccrued; // Last block in which we have calculated the total fees owed to the protocol.
    // solhint-disable-next-line var-name-mixedcase
    uint64 INTEREST_RATE; // INTEREST_RATE is charged per second and has a base unit of 1e18.
    uint128 feesEarned; // How many fees have the protocol earned since the last time the {owner} has collected the fees.
}
/**
 * @dev A struct to avoid stack error for variable. It collects data needed to properly liquidate users.
 *
 * @notice We use uint128 for memory efficiency. Liquidation information should not be higher than the maximum uint128.
 */
struct LiquidationInfo {
    uint128 allCollateral; // How much collateral will be used to repay the underwater positions.
    uint128 allDebt; // How much principal + interest rate is being repaid to the protocol.
    uint128 allPrincipal; // How much principal is being repaid to the protocol.
    uint128 allFee; // Total amount of liquidation fee the liquidator and protocol will earn.
}
