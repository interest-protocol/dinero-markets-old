//SPDX-License-Identifier: Unlicensed
pragma solidity 0.8.12;

interface IPancakeERC20 {
    event Approval(
        address indexed owner,
        address indexed spender,
        uint256 value
    );
    event Transfer(address indexed from, address indexed to, uint256 value);

    function name() external returns (string memory);

    function symbol() external returns (string memory);

    function decimals() external returns (uint8);

    function totalSupply() external returns (uint256);

    function balanceOf(address owner) external returns (uint256);

    function allowance(address owner, address spender)
        external
        returns (uint256);

    function approve(address spender, uint256 value) external returns (bool);

    function transfer(address to, uint256 value) external returns (bool);

    function transferFrom(
        address from,
        address to,
        uint256 value
    ) external returns (bool);

    //solhint-disable-next-line
    function DOMAIN_SEPARATOR() external returns (bytes32);

    //solhint-disable-next-line
    function PERMIT_TYPEHASH() external returns (bytes32);

    function nonces(address owner) external returns (uint256);

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
