// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Burnable} from "./interfaces/IERC20Burnable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Custody for a trusted off-chain game ledger. A valid server signature
/// authorizes payment; it is NOT a proof of game fairness or user liabilities.
/// No owner sweep of the game token, arbitrary call, or proxy upgrade exists.
contract SheepGameVault is EIP712, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    struct Withdrawal { bytes32 id; address recipient; uint256 amount; uint256 deadline; uint256 epoch; }
    struct Burn { bytes32 id; uint256 amount; uint256 reserveFloor; uint256 deadline; uint256 epoch; }
    bytes32 public constant WITHDRAWAL_TYPEHASH = keccak256("Withdrawal(bytes32 id,address recipient,uint256 amount,uint256 deadline,uint256 epoch)");
    bytes32 public constant BURN_TYPEHASH = keccak256("Burn(bytes32 id,uint256 amount,uint256 reserveFloor,uint256 deadline,uint256 epoch)");
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    IERC20 public immutable token;
    bool public immutable useTokenBurn;
    uint256 public immutable maxWithdrawal;
    uint256 public immutable maxBurn;
    address public signer;
    uint256 public signerEpoch = 1;
    mapping(bytes32 => uint256) public executedAt;
    mapping(bytes32 => bool) public cancelled;
    uint256 public totalPaid;
    uint256 public totalBurned;
    uint256 public totalDeposited;
    uint256 public totalFunded;
    event Deposited(address indexed account, uint256 amount);
    event PoolFunded(address indexed funder, uint256 amount);
    event Withdrawn(bytes32 indexed id, address indexed recipient, uint256 amount);
    event Burned(bytes32 indexed id, uint256 amount, bool reducedTotalSupply);
    event SignerChanged(address indexed signer, uint256 epoch);
    event AuthorizationCancelled(bytes32 indexed id);

    constructor(address asset, address admin, address issuer, uint256 withdrawalLimit, uint256 burnLimit, bool nativeBurn)
        EIP712("SheepGameVault", "1") Ownable(admin) {
        require(asset.code.length > 0 && issuer != address(0), "invalid configuration");
        require(IERC20Metadata(asset).decimals() == 18 && withdrawalLimit > 0 && burnLimit > 0, "invalid limits");
        token = IERC20(asset); signer = issuer; maxWithdrawal = withdrawalLimit; maxBurn = burnLimit; useTokenBurn = nativeBurn;
    }
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        uint256 received = _receive(amount); totalDeposited += received; emit Deposited(msg.sender, received);
    }
    function fundPool(uint256 amount) external nonReentrant whenNotPaused onlyOwner {
        uint256 received = _receive(amount); totalFunded += received; emit PoolFunded(msg.sender, received);
    }
    /// Cumulative direct income (game taxes and unsolicited transfers). Explicit
    /// deposits/funding are excluded even before the off-chain ledger sees them.
    /// Supported asset: fixed-balance ERC20, no rebasing or confiscation.
    function directPoolIncome() external view returns (uint256) {
        return token.balanceOf(address(this)) + totalPaid + totalBurned - totalDeposited - totalFunded;
    }
    function _receive(uint256 amount) private returns (uint256 received) {
        require(amount > 0, "zero amount"); uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount); received = token.balanceOf(address(this)) - beforeBalance;
        require(received > 0 && received <= amount, "unsupported token");
    }
    function withdrawalDigest(Withdrawal calldata w) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(WITHDRAWAL_TYPEHASH,w.id,w.recipient,w.amount,w.deadline,w.epoch)));
    }
    function burnDigest(Burn calldata b) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(BURN_TYPEHASH,b.id,b.amount,b.reserveFloor,b.deadline,b.epoch)));
    }
    function _consume(bytes32 id, uint256 deadline, uint256 epoch, bytes32 digest, bytes calldata signature) private {
        require(id != bytes32(0) && executedAt[id] == 0 && !cancelled[id], "authorization used");
        require(block.timestamp <= deadline && epoch == signerEpoch, "authorization expired");
        require(ECDSA.recover(digest, signature) == signer, "invalid signature");
        executedAt[id] = block.number;
    }
    /// Anyone may relay, but funds can only go to the signed recipient.
    function withdraw(Withdrawal calldata w, bytes calldata signature) external nonReentrant whenNotPaused {
        require(w.amount > 0 && w.amount <= maxWithdrawal && w.recipient != address(0) && w.recipient != address(this) && w.recipient != DEAD, "invalid withdrawal");
        _consume(w.id,w.deadline,w.epoch,withdrawalDigest(w),signature);
        totalPaid += w.amount;
        uint256 recipientBefore = token.balanceOf(w.recipient); uint256 vaultBefore = token.balanceOf(address(this));
        token.safeTransfer(w.recipient,w.amount);
        require(token.balanceOf(w.recipient) - recipientBefore == w.amount && vaultBefore - token.balanceOf(address(this)) == w.amount, "unsupported transfer tax");
        emit Withdrawn(w.id,w.recipient,w.amount);
    }
    /// reserveFloor is the server's audited reserve snapshot, not a proof of
    /// off-chain liabilities. Server freezes new settlement while a burn waits.
    function executeBurn(Burn calldata b, bytes calldata signature) external nonReentrant whenNotPaused onlyOwner {
        require(b.amount > 0 && b.amount <= maxBurn && token.balanceOf(address(this)) >= b.amount + b.reserveFloor, "insufficient burn surplus");
        _consume(b.id,b.deadline,b.epoch,burnDigest(b),signature);
        uint256 beforeBalance = token.balanceOf(address(this));
        if (useTokenBurn) {
            uint256 supply = token.totalSupply(); IERC20Burnable(address(token)).burn(b.amount);
            require(supply - token.totalSupply() == b.amount, "burn supply mismatch");
        } else {
            uint256 deadBefore = token.balanceOf(DEAD); token.safeTransfer(DEAD,b.amount);
            require(token.balanceOf(DEAD) - deadBefore == b.amount, "burn transfer tax");
        }
        require(beforeBalance - token.balanceOf(address(this)) == b.amount, "burn balance mismatch");
        totalBurned += b.amount; emit Burned(b.id,b.amount,useTokenBurn);
    }
    function cancelAuthorization(bytes32 id) external onlyOwner { require(executedAt[id] == 0, "already executed"); cancelled[id] = true; emit AuthorizationCancelled(id); }
    function setSigner(address next) external onlyOwner { require(next != address(0), "zero signer"); signer = next; signerEpoch++; emit SignerChanged(next,signerEpoch); }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
