import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet} from 'ethers';
import {openDatabase} from '../scripts/local-d1.mjs';
import {challenge,walletLogin,tokenAsset} from '../server/auth.js';
import {first,stmt,transfer} from '../server/db.js';
import {units,RULES} from '../server/rules.js';
import {getState,play,ensureDemo} from '../server/game.js';
import {activateReferral,bindReferral,referralSummary,resolveReferral} from '../server/referrals.js';
import {audit} from '../server/worker.js';
const key=()=>crypto.randomUUID(),env={TOKEN_ADDRESS:'0x0000000000000000000000000000000000000011'};
const outcome=id=>{const o=RULES.outcomes.find(o=>o.id===id);return {minimumInterval:0,outcomeFactory:()=>({outcomeId:id,score:o.multiplierBps/50,sequence:[o.multiplierBps/1000]})};};
async function fixture(t){const db=openDatabase();t.after(()=>db.close());const asset=tokenAsset(env);await db.batch([stmt(db,'INSERT INTO treasuries(asset,available,burned,fees,revision) VALUES (?,?,?,?,0)',asset,String(units(2000000)),'0','0'),...transfer(db,key(),asset,'test-funding','pool:'+asset,units(2000000),Date.now())]);return db;}
async function user(db,otherEnv=env){const w=Wallet.createRandom(),req=new Request('https://game.test'),c=await challenge(db,req,w.address),login=await walletLogin(db,req,otherEnv,{challengeId:c.challengeId,signature:await w.signMessage(c.message)});await db.batch([stmt(db,'UPDATE accounts SET available=? WHERE id=?',String(units(20000)),login.owner),...transfer(db,key(),tokenAsset(otherEnv),'test-funding',login.owner+':available',units(20000),Date.now())]);return login.owner;}
async function activate(db,owner){await play(db,owner,key(),'500',outcome('break-even'));return (await activateReferral(db,owner,key())).code;}

test('play before activating; bind once before first game; missing referral stays in pool',async t=>{
 const db=await fixture(t),a=await user(db),b=await user(db);
 await assert.rejects(activateReferral(db,a,key()),e=>e.code==='PLAY_REQUIRED');
 const code=await activate(db,a);await assert.rejects(resolveReferral(db,a,code),/自己的/);
 await bindReferral(db,b,key(),code);await assert.rejects(bindReferral(db,b,key(),code),e=>e.code==='REFERRAL_LOCKED');
 const before=await getState(db,a);await play(db,b,key(),'1000',outcome('no-prize'));
 assert.equal(Number((await getState(db,a)).balance)-Number(before.balance),150);
 assert.equal((await referralSummary(db,a)).directEarned,'150');assert.equal((await referralSummary(db,a)).indirectEarned,'0');
 assert.equal((await audit(db)).ok,true);
});
test('A invites B, B invites C; every multiplier pays 15% and 5% atomically, including 0x',async t=>{
 const db=await fixture(t),a=await user(db),b=await user(db),c=await user(db);
 const ac=await activate(db,a);await bindReferral(db,b,key(),ac);const bc=await activate(db,b);await bindReferral(db,c,key(),bc);
 for(const o of RULES.outcomes){const beforeA=await getState(db,a),beforeB=await getState(db,b),beforeC=await getState(db,c);const r=await play(db,c,key(),'500',outcome(o.id));
 assert.equal(Number((await getState(db,a)).balance)-Number(beforeA.balance),25);assert.equal(Number((await getState(db,b)).balance)-Number(beforeB.balance),75);
 assert.equal(r.round.referralPaid,'100');assert.equal(Number((await getState(db,c)).balance)-Number(beforeC.balance),Number(r.round.net)-500);
 assert.equal((await audit(db)).ok,true);}
 const summary=await referralSummary(db,a);assert.equal(summary.directCount,1);assert.equal(summary.indirectCount,1);assert.equal(summary.indirectEarned,'225');
 assert.equal((await referralSummary(db,b)).directEarned,'675');
});
test('retries and concurrent referrals credit once and preserve recipient balance',async t=>{
 const db=await fixture(t),a=await user(db),b=await user(db),c=await user(db),code=await activate(db,a);
 await bindReferral(db,b,key(),code);await bindReferral(db,c,key(),code);const k=key(),before=Number((await getState(db,a)).balance);
 await Promise.all([play(db,b,k,'500',outcome('break-even')),play(db,b,k,'500',outcome('break-even')),play(db,c,key(),'500',outcome('break-even'))]);
 assert.equal(Number((await getState(db,a)).balance)-before,150);assert.equal((await first(db,'SELECT COUNT(*) n FROM referral_rewards')).n,2);assert.equal((await audit(db)).ok,true);
});
test('late binding, self referral, cross token codes and demo activation are rejected',async t=>{
 const db=await fixture(t),a=await user(db),b=await user(db),code=await activate(db,a);
 await play(db,b,key(),'500',outcome('break-even'));await assert.rejects(bindReferral(db,b,key(),code),e=>e.code==='REFERRAL_LOCKED');
 const other=await user(db,{TOKEN_ADDRESS:'0x0000000000000000000000000000000000000033'});await assert.rejects(bindReferral(db,other,key(),code),/当前代币/);
 await ensureDemo(db,'demo:test');await assert.rejects(activateReferral(db,'demo:test',key()),e=>e.code==='TOKEN_ONLY');
 assert.equal((await referralSummary(db,'demo:test')).supported,false);
});
test('concurrent first play and referral binding do not retroactively pay a completed round',async t=>{
 const db=await fixture(t),a=await user(db),b=await user(db),code=await activate(db,a);
 await Promise.allSettled([play(db,b,key(),'500',outcome('break-even')),bindReferral(db,b,key(),code)]);
 const rewards=await first(db,'SELECT COUNT(*) n FROM referral_rewards'),profile=await first(db,'SELECT parent FROM referral_profiles WHERE owner=?',b);
 assert.equal(rewards.n,profile.parent?1:0);assert.equal((await audit(db)).ok,true);
 await assert.rejects(bindReferral(db,b,key(),code),e=>e.code==='REFERRAL_LOCKED');
});
