import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {readFile} from 'node:fs/promises';
import {Wallet,JsonRpcProvider,ContractFactory,parseEther} from 'ethers';
import {openDatabase} from '../scripts/local-d1.mjs';
import {challenge,walletLogin} from '../server/auth.js';
import {creditDeposit,fundTreasury} from '../server/payments.js';
export const key=()=>crypto.randomUUID();
export async function vaultHarness(){
 const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const process=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','56','--hardfork','cancun','--silent'],{stdio:'ignore'});
 const url='http://127.0.0.1:'+port;let ready=false;
 for(let n=0;n<100;n++){try{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
 if(!ready){process.kill();throw Error('Local Anvil did not start');}
 const provider=new JsonRpcProvider(url,56,{cacheTimeout:-1});provider.pollingInterval=20;
 const db=openDatabase(),issuer=Wallet.createRandom(),admin=await provider.getSigner(0);
 const cleanup=()=>{provider.destroy();db.close();process.kill('SIGTERM');};
 try{
  const ta=JSON.parse(await readFile(new URL('../artifacts/SheepGameVault.t.sol/MockGameToken.json',import.meta.url),'utf8'));
  const va=JSON.parse(await readFile(new URL('../artifacts/SheepGameVault.sol/SheepGameVault.json',import.meta.url),'utf8'));
  const token=await new ContractFactory(ta.abi,ta.bytecode.object,admin).deploy();await token.waitForDeployment();
  const vault=await new ContractFactory(va.abi,va.bytecode.object,admin).deploy(await token.getAddress(),await admin.getAddress(),issuer.address,parseEther('100000'),parseEther('100000'),false);await vault.waitForDeployment();
  const env={DB:db,PAYMENT_MODE:'vault',LIVE_PAYMENTS_ENABLED:'true',TOKEN_ADDRESS:await token.getAddress(),VAULT_ADDRESS:await vault.getAddress(),VAULT_SIGNER_PRIVATE_KEY:issuer.privateKey,BSC_RPC_URL:'https://local-anvil.invalid',DEPOSIT_START_BLOCK:'0',OPS_AUTH_KEY:'local-test-admin-key-never-for-production',TOKEN_SYMBOL:'QA',RPC_FETCH:(_u,init)=>fetch(url,init)};
  const mine=()=>provider.send('anvil_mine',['0x14']);
  await (await token.mint(await admin.getAddress(),parseEther('2000000'))).wait();await (await token.approve(await vault.getAddress(),parseEther('2000000'))).wait();
  const funding=await vault.fundPool(parseEther('2000000'));await funding.wait();await mine();await fundTreasury(db,env,key(),funding.hash);
  const users=[];
  for(let i=1;i<=3;i++){
   const signer=await provider.getSigner(i),address=await signer.getAddress(),req=new Request('http://127.0.0.1:4382/'),c=await challenge(db,req,address);
   const login=await walletLogin(db,req,env,{challengeId:c.challengeId,signature:await signer.signMessage(c.message)});
   await (await token.mint(address,parseEther('20000'))).wait();await (await token.connect(signer).approve(await vault.getAddress(),parseEther('10000'))).wait();
   const deposit=await vault.connect(signer).deposit(parseEther('10000'));await deposit.wait();await mine();await creditDeposit(db,env,login.owner,key(),deposit.hash);
   users.push({...login,signer,address:address.toLowerCase(),depositHash:deposit.hash});
  }
  return {db,env,issuer,admin,provider,token,vault,users,mine,cleanup};
 }catch(e){cleanup();throw e;}
}
