import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEther} from 'ethers';
import {vaultHarness,key} from './vault-harness.mjs';
import {poolStatus,syncPoolIncome} from '../server/pool.js';
import {creditDeposit,fundTreasury} from '../server/payments.js';
import {getVaultAuthorization} from '../server/vault-payments.js';
import {requestWithdrawal,quoteWithdrawal,finishWithdrawal} from '../server/payments.js';
import {audit} from '../server/worker.js';
import worker from '../server/worker.js';
import {first} from '../server/db.js';

test('pool accounting separates user custody, explicit funding, and confirmed direct income',async t=>{
 const h=await vaultHarness();t.after(h.cleanup);const {db,env,token,vault,admin,mine,users}=h,v=await vault.getAddress(),a=users[0];
 assert.equal(await vault.directPoolIncome(),0n);
 await t.test('closed public payments still permit operator funding, never user deposit credits',async()=>{
  const closed={...env,LIVE_PAYMENTS_ENABLED:'false'};
  await (await token.mint(await admin.getAddress(),parseEther('1000'))).wait();await(await token.approve(v,parseEther('1000'))).wait();
  const tx=await vault.fundPool(parseEther('1000'));await tx.wait();await mine();
  await fundTreasury(db,closed,key(),tx.hash);assert.equal((await poolStatus(db,closed)).availablePool,'2001000');
  await assert.rejects(creditDeposit(db,closed,a.owner,key(),a.depositHash),e=>e.code==='PAYMENTS_CLOSED');
 });
 await t.test('uncredited user deposits and fundPool cannot be swept into the game pool',async()=>{
  await(await token.connect(a.signer).approve(v,parseEther('300'))).wait();const tx=await vault.connect(a.signer).deposit(parseEther('300'));await tx.wait();await mine();
  const before=await poolStatus(db,env);assert.equal(before.totalDeposited,'30300');assert.equal(before.userLiabilities,'30000');
  assert.equal((await syncPoolIncome(db,env,key())).amount,'0');assert.equal((await poolStatus(db,env)).availablePool,'2001000');
  await creditDeposit(db,env,a.owner,key(),tx.hash);
 });
 await t.test('direct tax/donation income only credits after confirmation, concurrently and idempotently',async()=>{
  await(await token.mint(await admin.getAddress(),parseEther('90'))).wait();await(await token.transfer(v,parseEther('90'))).wait();
  assert.equal((await syncPoolIncome(db,env,key())).amount,'0');await mine();
  const results=await Promise.all([syncPoolIncome(db,env,key()),syncPoolIncome(db,env,key())]);assert.equal(results.reduce((n,r)=>n+Number(r.amount),0),90);
  const k=key(),r=await syncPoolIncome(db,env,k);assert.deepEqual(await syncPoolIncome(db,env,k),r);
  assert.equal((await poolStatus(db,env)).availablePool,'2001090');assert.equal((await audit(db)).ok,true);
 });
 await t.test('withdrawal never reduces cumulative direct income or recredits it',async()=>{
  const q=await quoteWithdrawal(db,env,a.owner,'100'),w=await requestWithdrawal(db,env,a.owner,key(),'100',q.feeVersion),auth=await getVaultAuthorization(db,env,a.owner,w.id);
  await(await a.signer.sendTransaction(auth.transaction)).wait();await mine();await finishWithdrawal(db,env,a.owner,key(),w.id);
  assert.equal(await vault.directPoolIncome(),parseEther('90'));assert.equal((await syncPoolIncome(db,env,key())).amount,'0');
  assert.equal((await audit(db)).ok,true);
 });
 await t.test('admin routes are private; scheduled sync is opt-in and does not open payments',async()=>{
  const url='https://game.example/api/admin/pool';assert.equal((await worker.fetch(new Request(url),env)).status,403);
  const r=await worker.fetch(new Request(url,{headers:{Authorization:'Bearer '+env.OPS_AUTH_KEY}}),env);assert.equal(r.status,200);
  await worker.scheduled({scheduledTime:Date.now()},{...env,POOL_SYNC_ENABLED:'false',BSC_RPC_URL:'https://unreachable.invalid'});
  await worker.scheduled({scheduledTime:Date.now()},{...env,POOL_SYNC_ENABLED:'true',LIVE_PAYMENTS_ENABLED:'false'});
  assert.equal((await audit(db)).ok,true);
 });
 await t.test('mismatched assets and deep reorg stop new credits',async()=>{
  await assert.rejects(syncPoolIncome(db,{...env,TOKEN_ADDRESS:a.address},key()),/不一致/);
  const old=env.RPC_FETCH;env.RPC_FETCH=async(u,init)=>{const r=await old(u,init),data=await r.json();const req=JSON.parse(init.body);const row=await first(db,'SELECT * FROM pool_income');if(req.method==='eth_getBlockByNumber'&&req.params[0]==='0x'+row.block_number.toString(16))data.result.hash='0x'+'0'.repeat(64);return Response.json(data);};
  // Advance so only the previously credited block is changed, not current snapshot.
  await mine();await assert.rejects(syncPoolIncome(db,env,key()),e=>e.code==='POOL_REORG');env.RPC_FETCH=old;
 });
});
