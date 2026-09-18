// Mainnet reads, local fork writes only. Never connects a signer to mainnet.
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {readFile} from 'node:fs/promises';
import {Contract,ContractFactory,JsonRpcProvider,Wallet,parseEther,formatEther,keccak256,toUtf8Bytes} from 'ethers';
import assert from 'node:assert/strict';
const plan=JSON.parse(await readFile('public/admin/pool/plan.json','utf8'));
const a=JSON.parse(await readFile('artifacts/SheepGameVault.sol/SheepGameVault.json','utf8'));
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const node=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','56','--hardfork','cancun','--fork-url',process.env.BSC_RPC_URL||'https://bsc-dataseed.bnbchain.org','--silent'],{stdio:['ignore','ignore','pipe']});
let errors='';node.stderr.on('data',d=>{errors+=d.toString();});
const url='http://127.0.0.1:'+port,p=new JsonRpcProvider(url,56,{cacheTimeout:-1});p.pollingInterval=50;
try {
 let ready=false;for(let n=0;n<300;n++){try{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error('Local fork failed: '+errors.slice(-500));
 await p.send('anvil_impersonateAccount',[plan.owner]);await p.send('anvil_setBalance',[plan.owner,'0x56BC75E2D63100000']);
 const owner=await p.getSigner(plan.owner),issuer=Wallet.createRandom(),player=await p.getSigner(3),who=await player.getAddress();
 const t=new Contract(plan.token,['function owner() view returns(address)','function approve(address,uint256)','function transfer(address,uint256)','function balanceOf(address) view returns(uint256)','function totalSupply() view returns(uint256)','function finalizeGameIntegration(address)','function ecosystemAddress() view returns(address)','function gameIntegrationFinalized() view returns(bool)','function excludeHolder(address) view returns(bool)','function startTrade(uint256)','function startTradeTime() view returns(uint256)','function _mainPair() view returns(address)'],owner);
 assert.equal((await t.owner()).toLowerCase(),plan.owner.toLowerCase());
 let v;const existing=await t.gameIntegrationFinalized();
 if(existing){
  assert.equal((await t.ecosystemAddress()).toLowerCase(),plan.vault.toLowerCase());
  v=new Contract(plan.vault,a.abi,owner);
  // Local fork only: replace the issuer with an ephemeral key. Never use a production key.
  await(await v.setSigner(issuer.address)).wait();
 }else{
  v=await new ContractFactory(a.abi,a.bytecode.object,owner).deploy(plan.token,plan.owner,issuer.address,parseEther(plan.maxWithdrawal),parseEther(plan.maxBurn),true);await v.waitForDeployment();
  await(await t.finalizeGameIntegration(await v.getAddress())).wait();
 }
 const addr=await v.getAddress();assert.equal(await t.excludeHolder(addr),true);
 const originalFunded=await v.totalFunded(),originalDeposited=await v.totalDeposited(),originalDirect=await v.directPoolIncome(),epoch=await v.signerEpoch();
 const funding=existing?'100':'2000000';
 await(await t.approve(addr,parseEther(funding))).wait();await(await v.fundPool(parseEther(funding))).wait();assert.equal(await v.totalFunded()-originalFunded,parseEther(funding));assert.equal(await v.directPoolIncome(),originalDirect);
 if(await t.startTradeTime()===0n)await(await t.startTrade(1)).wait();await p.send('evm_increaseTime',[1801]);await p.send('evm_mine',[]);
 await(await t.transfer(who,parseEther('3000'))).wait();await(await t.connect(player).approve(addr,parseEther('1000'))).wait();await(await v.connect(player).deposit(parseEther('1000'))).wait();assert.equal(await v.totalDeposited()-originalDeposited,parseEther('1000'));
 const block=await p.getBlock('latest'),domain={name:'SheepGameVault',version:'1',chainId:56,verifyingContract:addr};
 const types={Withdrawal:[{name:'id',type:'bytes32'},{name:'recipient',type:'address'},{name:'amount',type:'uint256'},{name:'deadline',type:'uint256'},{name:'epoch',type:'uint256'}]};
 const w={id:keccak256(toUtf8Bytes('local-fork-withdrawal')),recipient:who,amount:parseEther('100'),deadline:block.timestamp+3600,epoch};const before=await t.balanceOf(who);await(await v.connect(player).withdraw(w,await issuer.signTypedData(domain,types,w))).wait();assert.equal(await t.balanceOf(who)-before,parseEther('100'));
 // Simulate a sale into the actual token's main pair on the local fork.
 const pair=await t._mainPair();await(await t.connect(player).transfer(pair,parseEther('1000'))).wait();assert.equal(await v.directPoolIncome()-originalDirect,parseEther('10'));
 const burnTypes={Burn:[{name:'id',type:'bytes32'},{name:'amount',type:'uint256'},{name:'reserveFloor',type:'uint256'},{name:'deadline',type:'uint256'},{name:'epoch',type:'uint256'}]};
 const b={id:keccak256(toUtf8Bytes('local-fork-burn')),amount:parseEther('100'),reserveFloor:parseEther('1900000'),deadline:block.timestamp+3600,epoch};const supply=await t.totalSupply();await(await v.executeBurn(b,await issuer.signTypedData(domain,burnTypes,b))).wait();assert.equal(supply-await t.totalSupply(),parseEther('100'));assert.equal(await v.directPoolIncome()-originalDirect,parseEther('10'));
 console.log(JSON.stringify({ok:true,network:'local BSC fork only',token:plan.token,checks:[existing?'existing vault connection':'one-time binding','excludes dividends',funding+' funding','1000 deposit','100 exact withdrawal','sell tax 1% enters vault','native burn reduces supply','direct income excludes user/funding and survives payout/burn'],finalVaultBalance:formatEther(await t.balanceOf(addr))},null,2));
}finally{p.destroy();node.kill('SIGTERM');}
