import test from 'node:test';
import assert from 'node:assert/strict';
import { financeFixture, amount, address, T1, T2 } from './finance-fixture.mjs';
import { financeOverview, financeRecords } from '../server/admin-finance.js';
import worker from '../server/worker.js';
const params=values=>new URLSearchParams(values);
async function fixture(t){const f=await financeFixture();t.after(()=>f.db.close());return f;}

test('admin finance aggregates exact wallet amounts, settled withdrawals, fees and referrals without counting other assets or pool funding',async t=>{
  const f=await fixture(t),before=f.db.sqlite.prepare('SELECT total_changes() n').get().n;
  const result=await financeOverview(f.db,f.env,params({}));
  assert.equal(result.total,3);assert.equal(result.summary.deposited,'1700.000000000000000001');assert.equal(result.summary.withdrawn,'195');
  assert.equal(result.summary.gameProfit,'-275');assert.equal(result.summary.referralIncome,'100');assert.equal(result.summary.totalProfit,'-180');
  const a=result.wallets.find(w=>w.wallet===address(1));
  assert.equal(a.deposited,'1500.000000000000000001');assert.equal(a.withdrawn,'95');assert.equal(a.withdrawalFees,'5');assert.equal(a.pendingWithdrawal,'200');
  assert.equal(a.gameProfit,'225');assert.equal(a.gameFees,'25');assert.equal(a.totalProfit,'320');assert.equal(a.balance,'1250');assert.equal(a.rewards,'50');assert.equal(a.locked,'200');
  assert.equal(a.roundCount,2);assert.equal(a.winningRounds,1);assert.equal(a.losingRounds,1);assert.equal(a.pendingDepositCount,1);assert.equal(a.failedDepositCount,1);assert.equal(a.failedWithdrawalCount,2);
  assert.equal(f.db.sqlite.prepare('SELECT total_changes() n').get().n,before,'report must not mutate accounts or money');
});

test('finance date boundaries use Beijing days; current balances remain current while movements follow period',async t=>{
  const f=await fixture(t);
  const r=await financeOverview(f.db,f.env,params({from:'2026-09-18',to:'2026-09-18',wallet:address(1)}));
  assert.equal(r.total,1);assert.equal(r.summary.deposited,'500');assert.equal(r.summary.gameProfit,'475');assert.equal(r.summary.balance,'1250');
  const previous=await financeOverview(f.db,f.env,params({to:'2026-09-17',wallet:address(1)}));
  assert.equal(previous.summary.gameProfit,'-250');assert.equal(previous.summary.withdrawn,'0');
  const future=await financeRecords(f.db,f.env,params({kind:'rounds',from:'2026-09-19'}));assert.equal(future.total,0);
});

test('profit categories, search and sort apply to the complete wallet set and summary, not the visible page',async t=>{
  const f=await fixture(t);
  for(let n=10;n<120;n++){const owner=f.account(n);f.deposit(n,owner,amount(n));}
  const page1=await financeOverview(f.db,f.env,params({pageSize:'100',sort:'deposits'}));
  const page2=await financeOverview(f.db,f.env,params({pageSize:'100',sort:'deposits',page:'2'}));
  assert.equal(page1.total,113);assert.equal(page1.wallets.length,100);assert.equal(page2.wallets.length,13);assert.deepEqual(page1.summary,page2.summary);
  assert.equal(new Set([...page1.wallets,...page2.wallets].map(x=>x.wallet)).size,113);
  const wins=await financeOverview(f.db,f.env,params({profit:'profit'}));assert.equal(wins.total,1);assert.equal(wins.summary.gameProfit,'225');
  const losses=await financeOverview(f.db,f.env,params({profit:'loss',sort:'profitAsc'}));assert.equal(losses.wallets[0].wallet,address(2));
  const unplayed=await financeOverview(f.db,f.env,params({profit:'unplayed'}));assert.equal(unplayed.total,111);
  const match=await financeOverview(f.db,f.env,params({search:address(2).toUpperCase()}));assert.equal(match.total,1);
});

test('payment details deduplicate tracked deposits and preserve unknown pending amounts and failed statuses',async t=>{
  const f=await fixture(t);
  const deposits=await financeRecords(f.db,f.env,params({kind:'deposits',wallet:address(1)}));assert.equal(deposits.total,4);
  assert.equal(deposits.records.filter(r=>r.status==='confirmed').length,2);assert.equal(deposits.records.find(r=>r.status==='pending').amount,null);
  const withdrawals=await financeRecords(f.db,f.env,params({kind:'withdrawals',wallet:address(1)}));assert.equal(withdrawals.total,4);
  const confirmed=withdrawals.records.find(r=>r.status==='confirmed');assert.equal(confirmed.amount,'100');assert.equal(confirmed.fee,'5');assert.equal(confirmed.payout,'95');
  assert.ok(!JSON.stringify(withdrawals).includes('SECRET_RAW_TRANSACTION'));
  assert.equal((await financeRecords(f.db,f.env,params({kind:'withdrawals',status:'pending'}))).total,1);
  assert.equal((await financeRecords(f.db,f.env,params({kind:'withdrawals',status:'failed'}))).total,2);
});

test('round filters retain a one-wei profit or loss on very large values and paginate all historical rounds',async t=>{
  const f=await fixture(t),large='123456789123456789123456789123456789';
  f.round(80,f.c,large,String(BigInt(large)+1n));f.round(81,f.c,large,String(BigInt(large)-1n));f.round(82,f.c,large,large);
  const positive=await financeRecords(f.db,f.env,params({kind:'rounds',wallet:address(3),status:'profit'}));assert.equal(positive.total,1);assert.equal(positive.records[0].profit,'0.000000000000000001');
  const negative=await financeRecords(f.db,f.env,params({kind:'rounds',wallet:address(3),status:'loss'}));assert.equal(negative.total,1);assert.equal(negative.records[0].profit,'-0.000000000000000001');
  assert.equal((await financeRecords(f.db,f.env,params({kind:'rounds',wallet:address(3),status:'even'}))).total,1);
  for(let n=100;n<210;n++)f.round(n,f.c,amount(500),amount(500));
  const page=await financeRecords(f.db,f.env,params({kind:'rounds',wallet:address(3),page:'5',pageSize:'25'}));assert.equal(page.total,113);assert.equal(page.records.length,13);assert.equal(page.pages,5);
});

test('referral details distinguish recipient, contributing player, direct and indirect income',async t=>{
  const f=await fixture(t);
  const r=await financeRecords(f.db,f.env,params({kind:'referrals',wallet:address(1),status:'indirect'}));
  assert.equal(r.total,1);assert.equal(r.records[0].amount,'25');assert.equal(r.records[0].counterparty,address(2));assert.equal(r.records[0].wallet,address(1));
});

test('report API requires admin authorization and rejects invalid filters; ordinary logged-in wallets get no finance data',async t=>{
  const f=await fixture(t);
  const call=(url,cookie)=>worker.fetch(new Request('https://game.example/api/admin/'+url,{headers:cookie?{Cookie:cookie}:{}}),f.env);
  for(const path of ['finance','finance/records?kind=deposits']){
    assert.equal((await call(path)).status,403);assert.equal((await call(path,f.userCookie)).status,403);
    const authorized=await call(path,f.adminCookie);assert.equal(authorized.status,200);assert.equal(authorized.headers.get('cache-control'),'no-store');
  }
  for(const query of ['page=0','pageSize=101','from=2026-02-30','from=2026-09-19&to=2026-09-18','search=%27%20OR%201=1','wallet=garbage','sort=garbage','profit=garbage'])assert.equal((await call('finance?'+query,f.adminCookie)).status,400,query);
  for(const query of ['kind=garbage','kind=deposits&status=garbage','kind=rounds&status=pending'])assert.equal((await call('finance/records?'+query,f.adminCookie)).status,400,query);
});
