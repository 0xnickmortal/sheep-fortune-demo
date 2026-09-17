// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {SheepGameVault} from "../SheepGameVault.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
interface Vm {
    function addr(uint256) external returns(address);
    function sign(uint256,bytes32) external returns(uint8,bytes32,bytes32);
    function prank(address) external;
    function expectRevert() external;
    function warp(uint256) external;
    function chainId(uint256) external;
}
contract MockGameToken is ERC20 {
    uint256 public taxBps;
    constructor() ERC20("Test Game Token","TST") {}
    function mint(address to,uint256 amount) external { _mint(to,amount); }
    function burn(uint256 amount) external { _burn(msg.sender,amount); }
    function setTax(uint256 bps) external { taxBps=bps; }
    function _update(address from,address to,uint256 amount) internal override {
        if(from!=address(0)&&to!=address(0)&&taxBps>0) { uint256 fee=amount*taxBps/10000;super._update(from,address(0),fee);amount-=fee; }
        super._update(from,to,amount);
    }
}
contract SheepGameVaultTest {
    Vm constant vm=Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant KEY=0xA11CE;
    MockGameToken token; SheepGameVault vault; address alice; address bob;
    function setUp() public {
        vm.chainId(56);alice=vm.addr(10);bob=vm.addr(11);token=new MockGameToken();
        vault=new SheepGameVault(address(token),address(this),vm.addr(KEY),100000 ether,100000 ether,false);
        token.mint(address(vault),1000000 ether);token.mint(alice,10000 ether);
    }
    function signature(bytes32 digest) internal returns(bytes memory) { (uint8 v,bytes32 r,bytes32 s)=vm.sign(KEY,digest);return abi.encodePacked(r,s,v); }
    function voucher(uint256 amount) internal view returns(SheepGameVault.Withdrawal memory) { return SheepGameVault.Withdrawal(keccak256("withdraw-1"),alice,amount,block.timestamp+3600,1); }
    function testDepositMeasuresActualReceived() public {
        token.setTax(1000);vm.prank(alice);token.approve(address(vault),1000 ether);
        uint256 beforeBalance=token.balanceOf(address(vault));vm.prank(alice);vault.deposit(1000 ether);
        require(token.balanceOf(address(vault))-beforeBalance==900 ether);
    }
    function testRelayCannotRedirectAndReplayFails() public {
        SheepGameVault.Withdrawal memory w=voucher(1000 ether);bytes memory sig=signature(vault.withdrawalDigest(w));
        vm.prank(bob);vault.withdraw(w,sig);require(token.balanceOf(alice)==11000 ether&&token.balanceOf(bob)==0);
        vm.expectRevert();vault.withdraw(w,sig);
    }
    function testTamperedAmountRecipientAndDomainFail() public {
        SheepGameVault.Withdrawal memory w=voucher(1000 ether);bytes memory sig=signature(vault.withdrawalDigest(w));
        w.amount++;vm.expectRevert();vault.withdraw(w,sig);w.amount--;
        w.recipient=bob;vm.expectRevert();vault.withdraw(w,sig);w.recipient=alice;
        SheepGameVault other=new SheepGameVault(address(token),address(this),vm.addr(KEY),100000 ether,100000 ether,false);
        vm.expectRevert();other.withdraw(w,sig);
        vm.chainId(57);vm.expectRevert();vault.withdraw(w,sig);
    }
    function testExpiryAndSignerRotation() public {
        SheepGameVault.Withdrawal memory w=voucher(1000 ether);bytes memory sig=signature(vault.withdrawalDigest(w));
        vm.warp(w.deadline+1);vm.expectRevert();vault.withdraw(w,sig);
        w.deadline=block.timestamp+3600;sig=signature(vault.withdrawalDigest(w));vault.setSigner(vm.addr(KEY));
        vm.expectRevert();vault.withdraw(w,sig);
    }
    function testCancellationAndPause() public {
        SheepGameVault.Withdrawal memory w=voucher(1000 ether);bytes memory sig=signature(vault.withdrawalDigest(w));
        vault.pause();vm.expectRevert();vault.withdraw(w,sig);vault.unpause();
        vm.prank(bob);vm.expectRevert();vault.cancelAuthorization(w.id);
        vault.cancelAuthorization(w.id);vm.expectRevert();vault.withdraw(w,sig);
    }
    function testTransferTaxRollsBackVoucherAndPayment() public {
        SheepGameVault.Withdrawal memory w=voucher(1000 ether);bytes memory sig=signature(vault.withdrawalDigest(w));token.setTax(1000);
        vm.expectRevert();vault.withdraw(w,sig);require(vault.executedAt(w.id)==0&&token.balanceOf(alice)==10000 ether);
        token.setTax(0);vault.withdraw(w,sig);require(token.balanceOf(alice)==11000 ether);
    }
    function testOnlyOwnerCanFundOrExecuteBurn() public {
        vm.prank(bob);vm.expectRevert();vault.fundPool(100 ether);
        SheepGameVault.Burn memory b=SheepGameVault.Burn(keccak256("burn"),100 ether,1000 ether,block.timestamp+3600,1);
        bytes memory sig=signature(vault.burnDigest(b));vm.prank(bob);vm.expectRevert();vault.executeBurn(b,sig);
        vault.executeBurn(b,sig);require(token.balanceOf(vault.DEAD())==100 ether&&vault.totalBurned()==100 ether);
        vm.expectRevert();vault.executeBurn(b,sig);
    }
    function testBurnRespectsReserveAndLimit() public {
        SheepGameVault.Burn memory b=SheepGameVault.Burn(keccak256("burn"),100 ether,1000000 ether,block.timestamp+3600,1);
        bytes memory sig=signature(vault.burnDigest(b));vm.expectRevert();vault.executeBurn(b,sig);
        b.reserveFloor=0;b.amount=100001 ether;sig=signature(vault.burnDigest(b));vm.expectRevert();vault.executeBurn(b,sig);
    }
    function testNativeBurnReducesSupply() public {
        SheepGameVault nativeVault=new SheepGameVault(address(token),address(this),vm.addr(KEY),100000 ether,100000 ether,true);
        token.mint(address(nativeVault),1000 ether);uint256 supply=token.totalSupply();
        SheepGameVault.Burn memory b=SheepGameVault.Burn(keccak256("burn"),100 ether,900 ether,block.timestamp+3600,1);
        nativeVault.executeBurn(b,signature(nativeVault.burnDigest(b)));require(token.totalSupply()==supply-100 ether);
    }
    function testOwnerCannotSweepGameToken() public {
        (bool ok,)=address(vault).call(abi.encodeWithSignature("rescueTokens(address,uint256)",address(token),100 ether));require(!ok);
        vm.prank(bob);vm.expectRevert();vault.setSigner(bob);
    }
    function testFuzzPaymentConservation(uint96 seed) public {
        uint256 amount=uint256(seed)%(100000 ether)+1;SheepGameVault.Withdrawal memory w=voucher(amount);
        uint256 total=token.balanceOf(address(vault))+token.balanceOf(alice);vault.withdraw(w,signature(vault.withdrawalDigest(w)));
        require(token.balanceOf(address(vault))+token.balanceOf(alice)==total&&vault.totalPaid()==amount);
    }
}
