import test from 'node:test';
import assert from 'node:assert/strict';
import {createReferralMonitor, referralTotal} from '../public/shared/referral-monitor.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const summary=(directEarned='0',indirectEarned='0')=>({directEarned,indirectEarned});

test('totals preserve small decimals and amounts beyond floating point precision',()=>{
  assert.equal(referralTotal(summary('9007199254740993.000000000000000001','0.000000000000000009')),'9007199254740993.00000000000000001');
});
test('initial history is quiet; only new income is announced once, concurrent reads share a request',async()=>{
  let current=summary('150','50'),calls=0;const credits=[],updates=[];
  const m=createReferralMonitor({fetchSummary:async()=>{calls++;return current;},onUpdate:d=>updates.push(d),onCredit:v=>credits.push(v)});
  m.setOwner('A');await m.refresh();assert.deepEqual(credits,[]);
  current=summary('225','75');const one=m.refresh(),two=m.refresh();assert.equal(one,two);await one;
  await m.refresh();assert.deepEqual(credits,['100']);assert.equal(calls,3);assert.equal(updates.length,3);
});
test('late reads from a previous wallet do not leak data or produce credit notifications',async()=>{
  const old=deferred(),fresh=deferred(),updates=[],credits=[];let call=0;
  const m=createReferralMonitor({fetchSummary:()=>++call===1?old.promise:fresh.promise,onUpdate:d=>updates.push(d),onCredit:v=>credits.push(v)});
  m.setOwner('A');const a=m.refresh();m.setOwner('B');const b=m.refresh();
  fresh.resolve(summary('5'));await b;old.resolve(summary('999'));assert.equal(await a,null);
  assert.deepEqual(updates,[summary('5')]);assert.deepEqual(credits,[]);
});
test('failed reads preserve the baseline, allow retry, and reset on disconnect',async()=>{
  let current=summary('10'),fail=false;const credits=[],errors=[];
  const m=createReferralMonitor({fetchSummary:async()=>{if(fail)throw Error('offline');return current;},onUpdate:()=>{},onCredit:v=>credits.push(v),onError:e=>errors.push(e.message)});
  m.setOwner('A');await m.refresh();fail=true;await assert.rejects(m.refresh(),/offline/);
  fail=false;current=summary('25');await m.refresh();assert.deepEqual(credits,['15']);assert.deepEqual(errors,['offline']);
  m.setOwner(null);assert.equal(await m.refresh(),null);m.setOwner('A');await m.refresh();assert.deepEqual(credits,['15']);
});
