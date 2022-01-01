//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.10;

interface IMasterChef {
    function cake() external view returns (address);

    function cakePerBlock() external view returns (uint256);

    function pendingCake(uint256 _pid, address _user)
        external
        view
        returns (uint256);

    function totalAllocPoint() external view returns (uint256);

    function poolInfo(uint256 _pid)
        external
        view
        returns (
            address lpToken,
            uint256 allocPoint,
            uint256 lastRewardBlock,
            uint256 accCakePerShare
        );

    function userInfo(uint256 _pid, address _account)
        external
        view
        returns (uint256 amount, uint256 rewardDebt);

    function poolLength() external view returns (uint256);

    function deposit(uint256 _pid, uint256 _amount) external;

    function withdraw(uint256 _pid, uint256 _amount) external;

    function emergencyWithdraw(uint256 _pid) external;

    function enterStaking(uint256 _amount) external;

    function leaveStaking(uint256 _amount) external;
}
