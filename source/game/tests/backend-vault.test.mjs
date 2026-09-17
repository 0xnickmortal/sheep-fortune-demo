import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEther} from 'ethers';
import {vaultHarness,key} from './vault-harness.mjs';
import {getState,play} from '../server/game.js';
import {activateReferral,bindReferral,referralSummary} from '../server/referrals.js';
import {creditDeposit,requestWithdrawal,quoteWithdrawal,finishWithdrawal,rejectWithdrawal,paymentConfig} from '../server/payments.js';
import {getVaultAuthorization,prepareBurn,finishBurn,prepareVaultDeposit} from '../server/vault-payments.js';
import {saveWhitelist} from '../server/whitelist.js';
import {first} from '../server/db.js';
import {RULES,formatAmount} from '../server/rules.js';
import {audit} from '../server/worker.js';
const options=id=>{const o=RULES.outcomes.find(x=>x.id===id);return {minimumInterval:0,outcomeFactory:()=>({outcomeId:id,score:o.multiplierBps/50,sequence:[o.multiplierBps/1000]})};};
test('real local EVM: contract custody, referral credits, signed payouts and batch burn',async t=>{
 const h=await vaultHarness();t.after(h.cleanup);const {db,env,admin,provider,token,vault,users,mine}=h,[a,b,c]=users;
 await t.test('credits actual contract deposit once, refuses ordinary transfers and another wallet deposit',async()=>{
  assert.equal(paymentConfig(env).mode,'vault');assert.equal((await getState(db,a.owner)).balance,'10000');
  await creditDeposit(db,env,a.owner,key(),a.depositHash);assert.equal((await getState(db,a.owner)).balance,'10000');
  await assert.rejects(creditDeposit(db,env,b.owner,key(),a.depositHash),/充值记录/);
  const tx=await token.connect(a.signer).transfer(await vault.getAddress(),parseEther('1'));await tx.wait();await mine();await assert.rejects(creditDeposit(db,env,a.owner,key(),tx.hash),/充值记录/);
  const prepared=await prepareVaultDeposit(db,env,a.owner,'50');assert.equal(prepared.transaction.to,(await vault.getAddress()).toLowerCase());assert.equal(prepared.account,a.address);
  assert.equal((await audit(db)).ok,true);
 });
 await t.test('three-wallet referral chain pays direct and indirect into withdrawable balances',async()=>{
  await play(db,a.owner,key(),'500',options('break-even'));const ac=await activateReferral(db,a.owner,key());await bindReferral(db,b.owner,key(),ac.code);
  await play(db,b.owner,key(),'500',options('break-even'));const bc=await activateReferral(db,b.owner,key());await bindReferral(db,c.owner,key(),bc.code);
  const beforeA=Number((await getState(db,a.owner)).balance),beforeB=Number((await getState(db,b.owner)).balance);
  await play(db,c.owner,key(),'1000',options('small-win'));
  assert.equal(Number((await getState(db,a.owner)).balance)-beforeA,50);assert.equal(Number((await getState(db,b.owner)).balance)-beforeB,150);
  assert.equal((await referralSummary(db,a.owner)).indirectCount,1);assert.equal((await audit(db)).ok,true);
 });
 await t.test('whitelist exemption and idempotent payout: wallet receives exactly the signed amount',async()=>{
  await saveWhitelist(db,(await first(db,'SELECT asset FROM accounts WHERE id=?',c.owner)).asset,key(),{address:c.address,weights:RULES.outcomes.map(o=>o.id==='double'?10000:0),enabled:true,revision:0});
  const quote=await quoteWithdrawal(db,env,c.owner,'1000');assert.equal(quote.feeExempt,true);const k=key(),w=await requestWithdrawal(db,env,c.owner,k,'1000',quote.feeVersion);
  assert.deepEqual(await requestWithdrawal(db,env,c.owner,k,'1000',quote.feeVersion),w);
  await assert.rejects(getVaultAuthorization(db,env,a.owner,w.id),/不存在/);
  const auth=await getVaultAuthorization(db,env,c.owner,w.id),before=await token.balanceOf(c.address);
  const tx=await b.signer.sendTransaction(auth.transaction);await tx.wait();await mine();
  assert.equal(await token.balanceOf(c.address)-before,parseEther('1000'));
  await finishWithdrawal(db,env,c.owner,key(),w.id);assert.equal((await getState(db,c.owner)).locked,'0');
  assert.equal((await finishWithdrawal(db,env,c.owner,key(),w.id)).status,'confirmed');assert.equal((await audit(db)).ok,true);
 });
 await t.test('cannot release a still-valid voucher; confirmed expiry releases funds once',async()=>{
  const quote=await quoteWithdrawal(db,env,a.owner,'100'),before=(await getState(db,a.owner)).balance,w=await requestWithdrawal(db,env,a.owner,key(),'100',quote.feeVersion);
  await assert.rejects(finishWithdrawal(db,env,a.owner,key(),w.id),e=>e.code==='CONFIRMING');
  await assert.rejects(rejectWithdrawal(db,env,key(),w.id),/只能退回/);
  await provider.send('evm_increaseTime',[3602]);await mine();await finishWithdrawal(db,env,a.owner,key(),w.id);
  assert.equal((await getState(db,a.owner)).balance,before);assert.equal((await getState(db,a.owner)).locked,'0');
  await finishWithdrawal(db,env,a.owner,key(),w.id);assert.equal((await getState(db,a.owner)).balance,before);assert.equal((await audit(db)).ok,true);
 });
 await t.test('burn reserves quota, freezes new operations, confirms chain burn and never repeats',async()=>{
  const asset=(await first(db,'SELECT asset FROM accounts WHERE id=?',a.owner)).asset,pending=(await first(db,'SELECT burned FROM treasuries WHERE asset=?',asset)).burned;
  const burn=await prepareBurn(db,env,key(),formatAmount(pending));assert.equal((await audit(db)).ok,true);
  await assert.rejects(play(db,a.owner,key(),'500',options('break-even')),e=>e.code==='BURN_IN_PROGRESS');
  const q=await quoteWithdrawal(db,env,a.owner,'100');await assert.rejects(requestWithdrawal(db,env,a.owner,key(),'100',q.feeVersion),e=>e.code==='BURN_IN_PROGRESS');
  const tx=await admin.sendTransaction(burn.transaction);await tx.wait();await mine();const done=await finishBurn(db,env,key(),burn.id);assert.equal(done.status,'confirmed');
  assert.equal(await token.balanceOf(await vault.DEAD()),BigInt(pending));assert.equal((await audit(db)).ok,true);
  assert.equal((await finishBurn(db,env,key(),burn.id)).status,'confirmed');
  await play(db,a.owner,key(),'500',options('break-even'));
 });
 await t.test('cancelled burn releases reserved quota; low reserves block signing a burn',async()=>{
  const asset=(await first(db,'SELECT asset FROM accounts WHERE id=?',a.owner)).asset,pending=(await first(db,'SELECT burned FROM treasuries WHERE asset=?',asset)).burned;
  const burn=await prepareBurn(db,env,key(),formatAmount(pending)),record=await first(db,'SELECT payload FROM vault_authorizations WHERE id=?',burn.id);
  await (await vault.cancelAuthorization(JSON.parse(record.payload).id)).wait();await mine();assert.equal((await finishBurn(db,env,key(),burn.id)).status,'rejected');
  assert.equal((await first(db,'SELECT burned FROM treasuries WHERE asset=?',asset)).burned,pending);assert.equal((await audit(db)).ok,true);
  // A modelled token rebase/asset shortfall must prevent a new burn voucher.
  await provider.send('anvil_setBalance',[await vault.getAddress(),'0x10000000000000000']);
  await provider.send('anvil_impersonateAccount',[await vault.getAddress()]);const impersonated=await provider.getSigner(await vault.getAddress());
  await (await token.connect(impersonated).transfer(await admin.getAddress(),parseEther('100'))).wait();
  await assert.rejects(prepareBurn(db,env,key(),formatAmount(pending)),e=>e.code==='RESERVE_MISMATCH');
 });
});
