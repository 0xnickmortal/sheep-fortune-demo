import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDatabase} from '../scripts/local-d1.mjs';
import {ensureDemo,play,getState,history,claim,ingotState} from '../server/game.js';
import {RULES,WHEEL_OUTCOMES,units,parseAmount,formatAmount,drawWheel,ingotAward} from '../server/rules.js';
import {first,stmt,transfer,hash} from '../server/db.js';
import worker,{audit} from '../server/worker.js';
import {quoteWithdrawal,requestWithdrawal,rejectWithdrawal} from '../server/payments.js';
const key=()=>crypto.randomUUID();
const opts=id=>({minimumInterval:0,outcomeFactory:()=>{let offset=0;for(const o of WHEEL_OUTCOMES){if(o.id===id)return drawWheel(()=>BigInt(offset));offset+=o.weight;}}});
const database=t=>{const db=openDatabase();t.after(()=>db.close());return db;};
test('all nine outcomes auto-credit tokens; only 0x and 0.5x award lost units as ingots',async t=>{
 const db=database(t);
 for(const o of WHEEL_OUTCOMES){await ensureDemo(db,o.id);const r=await play(db,o.id,key(),'1000',opts(o.id));
  const expected=o.multiplierBps===0?'1000':o.multiplierBps===5000?'500':'0';
  assert.equal(r.round.ingots,expected);assert.equal(r.ingots,expected);assert.equal(r.rewards,'0');assert.equal(r.round.claimed,true);
  const a=await getState(db,o.id);assert.equal(a.balance,formatAmount(units(19000)+BigInt(Math.round(Number(r.round.net)*100))*10n**16n));assert.equal(a.ingots,expected);
  assert.equal((await history(db,o.id))[0].ingots,expected);assert.equal((await ingotState(db,o.id)).records.length,expected==='0'?0:1);
  await assert.rejects(claim(db,o.id,key()),/自动到账/);
 }
 assert.equal((await audit(db)).ok,true);
 assert.equal(formatAmount(ingotAward(units(501),{score:100})),'250.5');
 assert.equal(ingotAward(units(1000),{score:160}),0n);
 assert.equal(ingotAward(units(1000),{score:240}),0n);
});
test('concurrent retries and failed transactions cannot mint twice or debit points as tokens',async t=>{
 const db=database(t);await ensureDemo(db,'retry');const k=key();
 const rs=await Promise.all([play(db,'retry',k,'1000',opts('no-prize')),play(db,'retry',k,'1000',opts('no-prize'))]);assert.deepEqual(...rs);
 await Promise.all([play(db,'retry',key(),'1000',opts('half')),play(db,'retry',key(),'501',opts('half'))]);
 const state=await getState(db,'retry');assert.equal(state.balance,'18249.5');assert.equal(state.ingots,'1750.5');assert.equal(state.rewards,'0');
 assert.equal((await first(db,'SELECT COUNT(*) n FROM rounds')).n,3);
 let failed=false;const faulty={...db,batch:async statements=>{if(!failed){failed=true;return db.batch([...statements,stmt(db,'INSERT INTO cas_guards(id,ok) VALUES (?,0)',key())]);}return db.batch(statements);}};
 await play(faulty,'retry',key(),'1000',opts('no-prize'));assert.ok(failed);
 assert.equal((await getState(db,'retry')).ingots,'2750.5');assert.equal((await first(db,'SELECT COUNT(*) n FROM rounds')).n,4);assert.equal((await audit(db)).ok,true);
});
test('migration preserves exact old balances, credits pending rewards once and never backfills ingots',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'sheep-ingots-')),legacy=join(dir,'legacy'),file=join(dir,'state.sqlite');mkdirSync(legacy);
 for(const name of ['0000_volatile_genesis.sql','0001_overconfident_polaris.sql'])copyFileSync(new URL('../drizzle/'+name,import.meta.url),join(legacy,name));
 let db=openDatabase(file,pathToFileURL(legacy+'/'));t.after(()=>{db.close();rmSync(dir,{recursive:true});});
 await ensureDemo(db,'legacy');const now=Date.now(),pending=parseAmount('475.123456789123456789'),available=parseAmount('900000000.000000000000000001'),oldKey=key(),rid=key();
 const oldRules={version:'server-wheel-smallwin-v9-20260915',outcomes:[{id:'return-80',kind:'payout',multiplierBps:8000}]},response={round:{id:rid,bet:'1000',net:formatAmount(pending),version:oldRules.version},balance:formatAmount(available),rewards:formatAmount(pending)};
 await db.batch([stmt(db,'UPDATE accounts SET available=?,rewards=? WHERE id=?',String(available),String(pending),'legacy'),...transfer(db,key(),'demo','legacy-funding','legacy:available',available-units(20000),now),...transfer(db,key(),'demo','legacy-funding','legacy:rewards',pending,now),stmt(db,'INSERT INTO rounds(id,owner,operation,bet,gross,fee,net,burn,score,sequence,rules_version,rules_snapshot,claimed,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?)',rid,'legacy',key(),String(units(1000)),String(pending),'0',String(pending),'0',160,'[80]',oldRules.version,JSON.stringify(oldRules),now),stmt(db,'INSERT INTO operations(id,owner,request_key,fingerprint,kind,response,created_at) VALUES (?,?,?,?,?,?,?)',key(),'legacy',oldKey,await hash('play:'+JSON.stringify({amount:'1000'})),'play',JSON.stringify(response),now)]);
 db.close();db=openDatabase(file);
 const states=await Promise.all([getState(db,'legacy'),getState(db,'legacy')]);
 for(const a of states){assert.equal(a.balance,'900000475.12345678912345679');assert.equal(a.rewards,'0');assert.equal(a.ingots,'0');}
 assert.equal((await first(db,"SELECT COUNT(*) n FROM ledger WHERE debit='legacy:rewards'")).n,1);
 const saved=await first(db,'SELECT * FROM rounds WHERE id=?',rid);assert.equal(saved.net,String(pending));assert.equal(saved.rules_snapshot,JSON.stringify(oldRules));assert.equal(saved.claimed,1);assert.equal(saved.ingots,'0');
 assert.deepEqual(await play(db,'legacy',oldKey,'1000',{expectedVersion:oldRules.version,requireRulesVersion:true}),response);
 assert.equal((await audit(db)).ok,true);
 db.close();db=openDatabase(file);assert.equal((await getState(db,'legacy')).balance,states[0].balance);
});
test('ingot endpoints require ownership and closed redemption cannot spend points or tokens',async t=>{
 const db=database(t),env={DB:db},origin='https://game.example';
 const req=(path,cookie,body)=>new Request(origin+'/api'+path,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json','X-Game-Request':'1',...(cookie?{Cookie:cookie}:{}),'Idempotency-Key':key()},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await worker.fetch(req('/ingots'),env)).status,401);
 const login=await worker.fetch(req('/auth/demo',null,{}),env),cookie=login.headers.get('set-cookie').split(';')[0];
 const res=await worker.fetch(req('/play',cookie,{amount:'1000',rulesVersion:RULES.version,ingots:'99999999',multiplierBps:0}),env);assert.equal(res.status,200);const draw=await res.json();
 assert.equal(draw.round.ingots,draw.round.multiplierBps===0?'1000':draw.round.multiplierBps===5000?'500':'0');
 const points=await (await worker.fetch(req('/ingots',cookie),env)).json();assert.equal(points.balance,draw.ingots);assert.equal(points.redemption.enabled,false);assert.equal(points.redemption.rate,null);
 const before=await (await worker.fetch(req('/account',cookie),env)).json(),ledgerBefore=await audit(db);
 const redeem=await worker.fetch(req('/ingots/redeem',cookie,{amount:'1',asset:'XAUT',rate:1,enabled:true}),env);assert.equal(redeem.status,409);assert.equal((await redeem.json()).code,'REDEMPTION_CLOSED');
 assert.deepEqual(await (await worker.fetch(req('/account',cookie),env)).json(),before);assert.deepEqual(await audit(db),ledgerBefore);
 const other=await worker.fetch(req('/auth/demo',null,{}),env),cookie2=other.headers.get('set-cookie').split(';')[0],isolated=await (await worker.fetch(req('/ingots',cookie2),env)).json();assert.equal(isolated.balance,'0');assert.equal(isolated.records.length,0);
});
test('formal-account withdrawals use tokens only and preserve earned ingots on reservation and refund',async t=>{
 const db=database(t),wallet='0x'+'1'.repeat(40),token='0x'+'3'.repeat(40),asset='token:56:'+token,owner=asset+':'+wallet,now=Date.now();
 const env={DB:db,PAYMENT_MODE:'legacy-wallet',LIVE_PAYMENTS_ENABLED:'true',TOKEN_ADDRESS:token,DEPOSIT_ADDRESS:'0x'+'2'.repeat(40),BSC_RPC_URL:'https://rpc.invalid',DEPOSIT_START_BLOCK:'0',OPS_AUTH_KEY:'x'.repeat(32)};
 await db.batch([stmt(db,'INSERT INTO accounts(id,wallet,asset,available,rewards,locked,created_at) VALUES (?,?,?,?,?,?,?)',owner,wallet,asset,String(units(1000)),'0','0',now),stmt(db,'INSERT INTO treasuries(asset,available,burned,fees) VALUES (?,?,?,?)',asset,String(units(2000000)),'0','0'),...transfer(db,key(),asset,'external',owner+':available',units(1000),now),...transfer(db,key(),asset,'external','pool:'+asset,units(2000000),now)]);
 await play(db,owner,key(),'1000',opts('no-prize'));assert.equal((await getState(db,owner)).ingots,'1000');
 await assert.rejects(quoteWithdrawal(db,env,owner,'1'),/不足/);await assert.rejects(play(db,owner,key(),'500',opts('break-even')),/余额不足/);
 await db.batch([stmt(db,'UPDATE accounts SET available=?,revision=revision+1 WHERE id=?',String(units(100)),owner),...transfer(db,key(),asset,'external',owner+':available',units(100),now)]);
 const q=await quoteWithdrawal(db,env,owner,'100'),w=await requestWithdrawal(db,env,owner,key(),'100',q.feeVersion);
 assert.equal((await getState(db,owner)).balance,'0');assert.equal((await getState(db,owner)).locked,'100');assert.equal((await getState(db,owner)).ingots,'1000');
 await rejectWithdrawal(db,env,key(),w.id);assert.equal((await getState(db,owner)).balance,'100');assert.equal((await getState(db,owner)).ingots,'1000');assert.equal((await audit(db)).ok,true);
});
