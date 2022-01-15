// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "@openzeppelin/contracts/utils/math/SafeCast.sol";

struct Rebase {
    uint128 elastic;
    uint128 base;
}

// Thank you for this~
library RebaseLibrary {
    using SafeCast for uint256;

    /*@dev calculates a new base based on a new elastic keeping the ratio from a base/elastic pair
     *@param total -> Rebase struct which represents a base/elastic pair
     *@param elastic -> the new elastic in which the new base will be based on
     *@param roundUp -> rounding logic due to solidity always rounding down
     *@returns base -> the new calculated base
     */
    function toBase(
        Rebase memory total,
        uint256 elastic,
        bool roundUp
    ) internal pure returns (uint256 base) {
        if (total.elastic == 0) {
            base = elastic;
        } else {
            base = (elastic * total.base) / total.elastic;
            if (roundUp && (base * total.elastic) / total.base < elastic) {
                base += 1;
            }
        }
    }

    /*@dev calculates a new elastic based on a new base keeping the ratio from a base/elastic pair
     *@param total -> Rebase struct which represents a base/elastic pair
     *@param base -> the new base in which the new elastic will be based on
     *@param roundUp -> rounding logic due to solidity always rounding down
     *@returns elastic -> the new calculated elastic
     */
    function toElastic(
        Rebase memory total,
        uint256 base,
        bool roundUp
    ) internal pure returns (uint256 elastic) {
        if (total.base == 0) {
            elastic = base;
        } else {
            elastic = (base * total.elastic) / total.base;
            if (roundUp && (elastic * total.base) / total.elastic < base) {
                elastic += 1;
            }
        }
    }

    /*@dev calculates new values to a Rebase pair by adding a new elastic, this function maintains the ratio of the current pair
     *@param total -> Rebase struct which represents a base/elastic pair
     *@param elastic -> the new elastic to be added to the  pair and be used to find the how much base to substract
     *@param roundUp -> rounding logic due to solidity always rounding down
     *@returns (total, base) -> pair of the new Rebase pair values and the added base value
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

    /*@dev calculates new values to a Rebase pair by subtracting a new base, this function maintains the ratio of the current pair
     *@param total -> Rebase struct which represents a base/elastic pair
     *@param base -> the base to be subtracted to the pair and be used to find how much elastic to subtract
     *@param roundUp -> rounding logic due to solidity always rounding down
     *@returns (total, elastic) -> pair of the new Rebase pair values and the how much elastic was removed from the total
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

    /*@dev add base and elastic to a Rebase pair changing the ratio
     *@param total -> Rebase struct which represents a base/elastic pair
     *@param base -> the base to be added
     *@param elastic -> the elastic to be added
     *@returns total -> new Rebase pair modified with the addition of the base and elastic
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

    /*@dev substracts base and elastic to a Rebase pair changing the ratio
     *@param total -> Rebase struct which represents a base/elastic pair
     *@param base -> the base to be substracted
     *@param elastic -> the elastic to be substracted
     *@returns total -> new Rebase pair modified with the addition of the base and elastic
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

    /*@dev adds elastic to a Rebase pair
     *@important THIS UPDATES THE STORAGE OF THE CALLING CONTRACT (total)
     *@param total -> Rebase struct which represents a base/elastic pair, it will be updated
     *@param elastic -> the base to be added
     *@returns total -> new Rebase pair modified with the addition of the base and elastic
     */
    function addElastic(Rebase storage total, uint256 elastic)
        internal
        returns (uint256 newElastic)
    {
        newElastic = total.elastic += elastic.toUint128();
    }

    /*@dev subtracts elastic to a Rebase pair
     *@important THIS UPDATES THE STORAGE OF THE CALLING CONTRACT (total)
     *@param total -> Rebase struct which represents a base/elastic pair, it will be updated
     *@param elastic -> the base to be substracted
     *@returns total -> new Rebase pair modified with the addition of the base and elastic
     */
    function subElastic(Rebase storage total, uint256 elastic)
        internal
        returns (uint256 newElastic)
    {
        newElastic = total.elastic -= elastic.toUint128();
    }
}
