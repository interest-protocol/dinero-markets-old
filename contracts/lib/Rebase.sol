// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "./IntMath.sol";

struct Rebase {
    uint128 elastic;
    uint128 base;
}

/**
 *
 * @dev This library provides a collection of functions to manipulate a base and elastic values saved in a Rebase struct.
 * In a pool context, the base represents the amount of tokens deposited or withdrawn from an investor.
 * The elastic value represents how the pool tokens performed over time by incurring losses or profits.
 * With this library, one can easily calculate how much loss or profit each investor incurred based on their tokens
 * invested.
 *
 * @notice We use the {SafeCast} Open Zeppelin library for safely converting from uint256 to uint128 memory storage efficiency.
 * Therefore, it is important to keep in mind of the upperbound limit number this library supports.
 *
 */
library RebaseLibrary {
    using SafeCast for uint256;
    using IntMath for uint256;

    /**
     * @dev Calculates a base value from an elastic value using the ratio of a {Rebase} struct.
     *
     * @param total {Rebase} struct, which represents a base/elastic pair.
     * @param elastic The new base is calculated from this elastic.
     * @param roundUp Rounding logic due to solidity always rounding down.
     * @return base The calculated base.
     *
     */
    function toBase(
        Rebase memory total,
        uint256 elastic,
        bool roundUp
    ) internal pure returns (uint256 base) {
        if (total.elastic == 0) {
            base = elastic;
        } else {
            base = elastic.mulDiv(total.base, total.elastic);
            if (roundUp && base.mulDiv(total.elastic, total.base) < elastic) {
                base += 1;
            }
        }
    }

    /**
     * @dev Calculates the elastic value from a base value using the ratio of a {Rebase} struct.
     *
     * @param total {Rebase} struct, which represents a base/elastic pair.
     * @param base The new base, which the new elastic will be calculated from.
     * @param roundUp Rounding logic due to solidity always rounding down.
     * @return elastic The calculated elastic.
     *
     */
    function toElastic(
        Rebase memory total,
        uint256 base,
        bool roundUp
    ) internal pure returns (uint256 elastic) {
        if (total.base == 0) {
            elastic = base;
        } else {
            elastic = base.mulDiv(total.elastic, total.base);
            if (roundUp && elastic.mulDiv(total.base, total.elastic) < base) {
                elastic += 1;
            }
        }
    }

    /**
     * @dev Calculates new values to a {Rebase} pair by incrementing the elastic value.
     * This function maintains the ratio of the current pair.
     *
     * @param total {Rebase} struct which represents a base/elastic pair.
     * @param elastic The new elastic to be added to the pair.
     * A new base will be calculated based on the new elastic using {toBase} function.
     * @param roundUp Rounding logic due to solidity always rounding down.
     * @return (total, base) A pair of the new {Rebase} pair values and new calculated base.
     *
     */
    function add(
        Rebase memory total,
        uint256 elastic,
        bool roundUp
    ) internal pure returns (Rebase memory, uint256 base) {
        base = toBase(total, elastic, roundUp);
        total.elastic += elastic.toUint128();
        total.base += base.toUint128();
        return (total, base);
    }

    /**
     * @dev Calculates new values to a {Rebase} pair by reducing the base.
     * This function maintains the ratio of the current pair.
     *
     * @param total {Rebase} struct, which represents a base/elastic pair.
     * @param base The number to be subtracted from the base.
     * The new elastic will be calculated based on the new base value via the {toElastic} function.
     * @param roundUp Rounding logic due to solidity always rounding down.
     * @return (total, elastic) A pair of the new {Rebase} pair values and the new elastic based on the updated base.
     *
     */
    function sub(
        Rebase memory total,
        uint256 base,
        bool roundUp
    ) internal pure returns (Rebase memory, uint256 elastic) {
        elastic = toElastic(total, base, roundUp);
        total.elastic -= elastic.toUint128();
        total.base -= base.toUint128();
        return (total, elastic);
    }

    /**
     * @dev Increases the base and elastic from a {Rebase} pair without keeping a specific ratio.
     *
     * @param total {Rebase} struct which represents a base/elastic pair that will be updated.
     * @param base The value to be added to the `total.base`.
     * @param elastic The value to be added to the `total.elastic`.
     * @return total The new {Rebase} pair calculated by adding the `base` and `elastic` values.
     *
     */
    function add(
        Rebase memory total,
        uint256 base,
        uint256 elastic
    ) internal pure returns (Rebase memory) {
        total.base += base.toUint128();
        total.elastic += elastic.toUint128();
        return total;
    }

    /**
     * @dev Decreases the base and elastic from a {Rebase} pair without keeping a specific ratio.
     *
     * @param total The base/elastic pair that will be updated.
     * @param base The value to be decreased from the `total.base`.
     * @param elastic The value to be decreased from the `total.elastic`.
     * @return total The new {Rebase} calculated by decreasing the base and pair from `total`.
     *
     */
    function sub(
        Rebase memory total,
        uint256 base,
        uint256 elastic
    ) internal pure returns (Rebase memory) {
        total.base -= base.toUint128();
        total.elastic -= elastic.toUint128();
        return total;
    }

    /**
     * @dev Adds elastic to a {Rebase} pair.
     *
     * @notice The `total` parameter is saved in storage. This will update the global state of the caller contract.
     *
     * @param total The {Rebase} struct, which will have its' elastic increased.
     * @param elastic The value to be added to the elastic of `total`.
     * @return newElastic The new elastic value after reducing `elastic` from `total.elastic`.
     *
     */
    function addElastic(Rebase storage total, uint256 elastic)
        internal
        returns (uint256 newElastic)
    {
        newElastic = total.elastic += elastic.toUint128();
    }

    /**
     * @dev Reduces the elastic of a {Rebase} pair.
     *
     * @notice The `total` parameter is saved in storage. The caller contract will have its' storage updated.
     *
     * @param total The {Rebase} struct to be updated.
     * @param elastic The value to be removed from the `total` elastic.
     * @return newElastic The new elastic after decreasing `elastic` from `total.elastic`.
     *
     */
    function subElastic(Rebase storage total, uint256 elastic)
        internal
        returns (uint256 newElastic)
    {
        newElastic = total.elastic -= elastic.toUint128();
    }
}
