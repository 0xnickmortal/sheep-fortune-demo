import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEther} from 'ethers';
import {vaultHarness,key} from './vault-harness.mjs';
import {first} from '../server/db.js';
import {getState} from '../server/game.js';
import {trackDeposit,syncPayments} from '../server/payment-monitor.js';
import {accountEnvironment} from '../server/admin-auth.js';
import {prepareVaultDeposit,getVaultAuthorization} from '../server/vault-payments.js';
import {quoteWithdrawal,requestWithdrawal,fundTreasury} from '../server/payments.js';
import {syncPoolIncome,poolStatus} from '../server/pool.js';
import worker,{audit} from '../server/worker.js';
import {RULES} from '../server/rules.js';

test('wallet administration and automatic custody reconciliation',async t=>{
 const h=await vaultHarness();t.after(h.cleanup);
 const {db,env,users,admin,token,vault,mine,provider}=h,[a,b]=users,v=await vault.getAddress();
 const acceptance={...env,ADMIN_WALLET:a.address,LIVE_PAYMENTS_ENABLED:'false',PAYMENTS_VALIDATION_ENABLED:'true'};
 const req=(user,path,data,origin='http://127.0.0.1:4382')=>new Request('http://127.0.0.1:4382/api'+path,{method:data===undefined?'GET':'POST',headers:{Cookie:user.cookie.split(';')[0],Origin:origin,'X-Game-Request':'1','Content-Type':'application/json','Idempotency-Key':key()},...(data===undefined?{}:{body:JSON.stringify(data)})});
 await t.test('admin cookie is signed, asset scoped and POST requires same origin',async()=>{
  assert.equal((await worker.fetch(req(a,'/admin/session'),acceptance)).status,200);
  assert.equal((await worker.fetch(req(b,'/admin/session'),acceptance)).status,403);
  assert.equal((await worker.fetch(req(a,'/admin/session'),{...acceptance,TOKEN_ADDRESS:b.address})).status,403);
  assert.equal((await worker.fetch(req(a,'/admin/payments/sync',{},'https://evil.invalid'),acceptance)).status,403);
  const aState=await(await worker.fetch(req(a,'/account'),acceptance)).json(),bState=await(await worker.fetch(req(b,'/account'),acceptance)).json();
  assert.equal(aState.admin,true);assert.equal(aState.payments.enabled,true);
  assert.equal(bState.admin,false);assert.equal(bState.payments.enabled,false);
  assert.equal((await worker.fetch(req(b,'/deposits/prepare',{amount:'50'}),acceptance)).status,503);
 });
 await t.test('admin can enable, edit and disable a wallet policy; ordinary wallet cannot',async()=>{
  const data={address:b.address,weights:RULES.outcomes.map(o=>o.id==='double'?10000:0),enabled:true,revision:0};
  assert.equal((await worker.fetch(req(b,'/admin/whitelist',data),acceptance)).status,403);
  const result=await worker.fetch(req(a,'/admin/whitelist',data),acceptance);assert.equal(result.status,200);
  const saved=await result.json();assert.equal(saved.enabled,true);
  assert.equal((await(await worker.fetch(req(b,'/account'),acceptance)).json()).benefits.withdrawalFeeExempt,true);
  const off=await worker.fetch(req(a,'/admin/whitelist',{...data,enabled:false,revision:saved.revision}),acceptance);assert.equal(off.status,200);
 });
 await t.test('a stale tab cannot read or debit another wallet after the shared login cookie changes',async()=>{
  const before=await getState(db,a.owner);
  for(const [path,data] of [['/account',undefined],['/play',{amount:'500',rulesVersion:RULES.version}],['/withdrawals/quote',{amount:'10'}]]){
   const request=req(a,path,data);request.headers.set('X-Game-Wallet',b.address);
   const response=await worker.fetch(request,acceptance);assert.equal(response.status,409);assert.equal((await response.json()).code,'WALLET_CHANGED');
  }
  assert.deepEqual(await getState(db,a.owner),before);
  const matching=req(a,'/account');matching.headers.set('X-Game-Wallet',a.address.toUpperCase());assert.equal((await worker.fetch(matching,acceptance)).status,200);
 });
 await t.test('deposit preparation checks wallet funds, approval and pause state',async()=>{
  let p=await prepareVaultDeposit(db,env,a.owner,'50');assert.equal(p.needsApproval,true);
  await(await token.connect(a.signer).approve(v,parseEther('500'))).wait();
  p=await prepareVaultDeposit(db,env,a.owner,'50');assert.equal(p.needsApproval,false);
  await assert.rejects(prepareVaultDeposit(db,env,a.owner,'999999'),/余额不足/);
  await(await vault.pause()).wait();
  await assert.rejects(prepareVaultDeposit(db,env,a.owner,'50'),e=>e.code==='VAULT_PAUSED');
  const q=await quoteWithdrawal(db,env,a.owner,'50');await assert.rejects(requestWithdrawal(db,env,a.owner,key(),'50',q.feeVersion),e=>e.code==='VAULT_PAUSED');
  assert.equal((await getState(db,a.owner)).locked,'0');await(await vault.unpause()).wait();
 });
 await t.test('pending deposit becomes one credit in background; cannot be claimed by another wallet',async()=>{
  const tx=await vault.connect(a.signer).deposit(parseEther('250'));await tx.wait();
  const scoped=await accountEnvironment(db,acceptance,a.owner);
  assert.equal((await trackDeposit(db,scoped,a.owner,tx.hash)).status,'pending');
  await assert.rejects(trackDeposit(db,env,b.owner,tx.hash),/当前账户/);
  assert.equal((await getState(db,a.owner)).balance,'10000');await mine();
  assert.equal((await syncPayments(db,acceptance)).deposits,1);
  assert.equal((await first(db,'SELECT status FROM pending_deposits WHERE tx_hash=?',tx.hash)).status,'confirmed');
  assert.equal((await getState(db,a.owner)).balance,'10250');
  await trackDeposit(db,scoped,a.owner,tx.hash);await syncPayments(db,acceptance);
  assert.equal((await getState(db,a.owner)).balance,'10250');assert.equal((await audit(db)).ok,true);
 });
 await t.test('automatic pool funding excludes earlier manual funding and all player deposits',async()=>{
  const automatic={...env,POOL_FUND_SYNC_ENABLED:'true'};
  assert.equal((await syncPoolIncome(db,automatic,key())).fundedAmount,'0');
  await(await token.mint(await admin.getAddress(),parseEther('100'))).wait();await(await token.approve(v,parseEther('100'))).wait();
  const fund=await vault.fundPool(parseEther('100'));await fund.wait();await mine();
  const r=await syncPoolIncome(db,automatic,key());assert.equal(r.fundedAmount,'100');assert.equal(r.amount,'0');
  assert.equal((await syncPoolIncome(db,automatic,key())).fundedAmount,'0');
  assert.equal((await poolStatus(db,automatic)).availablePool,'2000100');
  await assert.rejects(fundTreasury(db,automatic,key(),fund.hash),e=>e.code==='AUTOMATIC_POOL_FUNDING');
  await assert.rejects(fundTreasury(db,env,key(),fund.hash),e=>e.code==='AUTOMATIC_POOL_FUNDING');
  assert.equal((await audit(db)).ok,true);
 });
 await t.test('submitted withdrawal is finalized automatically without another player request',async()=>{
  const q=await quoteWithdrawal(db,env,a.owner,'100'),w=await requestWithdrawal(db,env,a.owner,key(),'100',q.feeVersion);
  const auth=await getVaultAuthorization(db,env,a.owner,w.id);
  await(await a.signer.sendTransaction(auth.transaction)).wait();await mine();
  const withoutLogs={...acceptance,RPC_FETCH:async(u,init)=>{if(JSON.parse(init.body).method==='eth_getLogs')throw Error('Public RPC disables logs');return env.RPC_FETCH(u,init);}};
  await syncPayments(db,withoutLogs);
  assert.equal((await first(db,'SELECT status FROM withdrawals WHERE id=?',w.id)).status,'confirmed');
  assert.equal((await getState(db,a.owner)).locked,'0');assert.equal((await getState(db,a.owner)).balance,'10150');
  await syncPayments(db,acceptance);assert.equal((await getState(db,a.owner)).balance,'10150');
 });
 await t.test('unsubmitted expired withdrawal is released by cron even if pool reading fails',async()=>{
  const q=await quoteWithdrawal(db,env,a.owner,'80'),w=await requestWithdrawal(db,env,a.owner,key(),'80',q.feeVersion);
  await provider.send('evm_increaseTime',[3602]);await mine();
  const broken={...acceptance,POOL_SYNC_ENABLED:'true',PAYMENT_SYNC_ENABLED:'true'};
  // Only fail the cumulative pool counter; authorization reads still work.
  const {Interface}=await import('ethers'),iface=new Interface(['function totalFunded() view returns(uint256)']);
  broken.RPC_FETCH=async(u,init)=>{const r=JSON.parse(init.body);if(r.method==='eth_call'&&r.params[0].data===iface.encodeFunctionData('totalFunded'))return Response.json({error:{message:'pool offline'}});return env.RPC_FETCH(u,init);};
  await assert.rejects(worker.scheduled({scheduledTime:Date.now()},broken),e=>e.code==='RPC_ERROR');
  assert.equal((await first(db,'SELECT status FROM withdrawals WHERE id=?',w.id)).status,'rejected');
  assert.equal((await getState(db,a.owner)).balance,'10150');assert.equal((await audit(db)).ok,true);
 });
 await t.test('logout revokes the signed session on the server, even if its old cookie is replayed',async()=>{
  const result=await worker.fetch(req(a,'/auth/logout',{}),acceptance);assert.equal(result.status,200);
  assert.match(result.headers.get('Set-Cookie'),/Max-Age=0/);
  assert.equal((await worker.fetch(req(a,'/admin/session'),acceptance)).status,403);
  assert.equal((await worker.fetch(req(a,'/account'),acceptance)).status,401);
 });
});
