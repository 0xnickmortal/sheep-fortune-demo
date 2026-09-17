import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, Interface } from 'ethers';
import { openDatabase } from '../scripts/local-d1.mjs';
import { ensureDemo, play, claim, getState, history } from '../server/game.js';
import { units, parseAmount, formatAmount, drawBag, drawWheel, WHEEL_OUTCOMES, RULES, settlement, maxBet, maximumPayout } from '../server/rules.js';
import { MODEL } from '../server/bags.js';
import { first, stmt, transfer, hash } from '../server/db.js';
import { challenge, walletLogin, demoLogin, tokenAsset } from '../server/auth.js';
import { creditDeposit, requestWithdrawal, rejectWithdrawal, attachSignedWithdrawal, broadcastWithdrawal, finishWithdrawal, paymentConfig, quoteWithdrawal, paymentHistory } from '../server/payments.js';
import { WITHDRAWAL_FEE, withdrawalQuote } from '../server/withdrawal-fee.js';
import worker, { audit } from '../server/worker.js';
const key = () => crypto.randomUUID(), fixed = () => ({ score: 170, sequence: [5,11,8,5,11,11,11,5,5,15,5,11,11,11,8,8,5,11,5,8] });
const opts = { outcomeFactory: fixed, minimumInterval: 0 };
function database(t) { const db = openDatabase(); t.after(() => db.close()); return db; }
const origin = 'https://game.example';
function request(path, data, cookie, extra = {}) { return new Request(origin + '/api' + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Game-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); }

test('18-decimal quantities are exact and malformed values cannot debit accounts', () => {
  for (const n of ['1', '500', '999999999.123456789123456789', '0.000000000000000001']) assert.equal(formatAmount(parseAmount(n)), n);
  for (const n of ['-1', '0', '1e3', 'NaN', 500, '0.0000000000000000001', ' 500']) assert.throws(() => parseAmount(n));
});
test('legacy model: all 103 bag types admit a complete sequence; loss/profit buckets have exact configured weights', () => {
  let loss = 0, middle = 0, win = 0, offset = 0;
  for (let i = 0; i < MODEL.scores.length; i++) {
    let first = true; const result = drawBag(limit => { if (first) { first = false; return BigInt(offset); } return limit / 2n; });
    assert.equal(result.bag, i); assert.equal(result.sequence.length, 20); assert.equal(result.sequence.reduce((s, x) => s + x, 0), result.score);
    let sum = 0, last = 0, run = 0;
    for (const x of result.sequence) { assert.ok([5,8,11,15,20].includes(x)); const sign = x < 10 ? -1 : 1; run = last === sign ? run + 1 : 1; last = sign; assert.ok(run <= 3); sum += x * 19 - 200; assert.ok(sum >= -1400 && sum <= 1200); }
    const gross = units(2000) * BigInt(result.score) / 200n, net = gross - gross / 20n; if (net < units(1800)) loss += MODEL.weights[i]; else if (net > units(2000)) win += MODEL.weights[i]; else middle += MODEL.weights[i]; offset += MODEL.weights[i];
  }
  assert.equal(offset, 54600); assert.equal(loss / offset, .9); assert.equal(middle / offset, .02); assert.equal(win / offset, .08);
});
test('automatic payout, exact ledger conservation and repeated/concurrent idempotency', async t => {
  const db = database(t); await ensureDemo(db, 'alice'); const k = key();
  const results = await Promise.all([play(db, 'alice', k, '500', opts), play(db, 'alice', k, '500', opts)]); assert.deepEqual(...results);
  assert.equal((await getState(db, 'alice')).balance, '19925'); assert.equal(results[0].round.net, '425');
  assert.equal((await first(db, 'SELECT COUNT(*) n FROM rounds')).n, 1);
  await assert.rejects(play(db, 'alice', k, '1000', opts), /不同内容/);
  await assert.rejects(claim(db,'alice',key()),/自动到账/);
  assert.equal((await getState(db, 'alice')).balance, '19925'); assert.equal((await getState(db, 'alice')).rewards, '0');
  assert.equal((await audit(db)).ok, true);
});
test('atomic CAS rolls back failed writes and concurrent distinct stakes preserve balances', async t => {
  const db = database(t); await ensureDemo(db, 'alice'); await ensureDemo(db, 'bob');
  await Promise.all([play(db, 'alice', key(), '500', opts), play(db, 'alice', key(), '500', opts), play(db, 'bob', key(), '500', opts)]);
  assert.equal((await getState(db, 'alice')).balance, '19850'); assert.equal((await getState(db, 'alice')).rewards, '0');
  const before = await getState(db, 'alice');
  await assert.rejects(db.batch([stmt(db, "UPDATE accounts SET available='0' WHERE id='alice'"), stmt(db, 'INSERT INTO cas_guards(id,ok) VALUES (?,0)', key())]));
  assert.deepEqual(await getState(db, 'alice'), before); assert.equal((await audit(db)).ok, true);
});
test('minimum, fractional stakes, balance, pool cap and cooldown enforced on server', async t => {
  const db = database(t); await ensureDemo(db, 'alice');
  for (const amount of ['499', '500.1', '50001', '10000']) await assert.rejects(play(db, 'alice', key(), amount, opts));
  await play(db, 'alice', key(), '500'); await assert.rejects(play(db, 'alice', key(), '500'), /稍候/);
  await stmt(db, "UPDATE accounts SET available='1' WHERE id='alice'").run(); await assert.rejects(play(db, 'alice', key(), '500', opts), /余额不足/);
});
test('balances survive database close/reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sheep-test-')), path = join(dir, 'game.sqlite'); let db = openDatabase(path);
  try { await ensureDemo(db, 'persist'); await play(db, 'persist', key(), '500', opts); db.close(); db = openDatabase(path); assert.equal((await getState(db, 'persist')).balance, '19925'); assert.equal((await audit(db)).ok, true); } finally { db.close(); rmSync(dir, { recursive: true }); }
});
test('HTTP session ownership, CSRF, response cache control, forged results ignored', async t => {
  const db = database(t), env = { DB: db };
  assert.equal((await worker.fetch(request('/account'), env)).status, 401);
  let r = await worker.fetch(request('/auth/demo', {}), env); const cookie = r.headers.get('set-cookie').split(';')[0]; assert.match(r.headers.get('set-cookie'), /HttpOnly/); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await worker.fetch(request('/play', { amount: '500' }, cookie, { Origin: 'https://evil.example' }), env)).status, 403);
  r = await worker.fetch(request('/play', { amount: '500', rulesVersion: RULES.version, owner: 'someone-else', score: 999999, outcomeId: 'jackpot' }, cookie, { 'Idempotency-Key': key() }), env); assert.equal(r.status, 200); const round = (await r.json()).round; assert.equal(round.sequence.length, 1); assert.ok(WHEEL_OUTCOMES.some(x => x.id === round.outcomeId && x.multiplierBps === round.multiplierBps)); assert.equal(round.score * 50, round.multiplierBps);
  const other = await worker.fetch(request('/auth/demo', {}), env), cookie2 = other.headers.get('set-cookie').split(';')[0]; assert.equal((await (await worker.fetch(request('/rounds', undefined, cookie2), env)).json()).rounds.length, 0);
  assert.equal((await worker.fetch(request('/admin/audit'), env)).status, 403);
  assert.equal((await worker.fetch(request('/withdrawals', { amount: '500' }, cookie, { 'Idempotency-Key': key() }), env)).status, 503);
});
test('wallet signature challenge rejects wrong signer, replay, expiry and other domain', async t => {
  const db = database(t), wallet = Wallet.createRandom(), wrong = Wallet.createRandom(), req = request('/auth/verify', {});
  const c = await challenge(db, req, wallet.address); await assert.rejects(walletLogin(db, req, {}, { challengeId: c.challengeId, signature: await wrong.signMessage(c.message) }), /不匹配/);
  const signature = await wallet.signMessage(c.message); const login = await walletLogin(db, req, {}, { challengeId: c.challengeId, signature }); assert.equal((await getState(db, login.owner)).balance, '0');
  await assert.rejects(walletLogin(db, req, {}, { challengeId: c.challengeId, signature }), /过期/);
  const expired = await challenge(db, req, wallet.address); await stmt(db, 'UPDATE challenges SET expires_at=0 WHERE id=?', expired.challengeId).run(); await assert.rejects(walletLogin(db, req, {}, { challengeId: expired.challengeId, signature: await wallet.signMessage(expired.message) }), /过期/);
  const domain = await challenge(db, req, wallet.address); await assert.rejects(walletLogin(db, new Request('https://other.example/api/auth/verify'), {}, { challengeId: domain.challengeId, signature: await wallet.signMessage(domain.message) }), /过期/);
});
const iface = new Interface(['function transfer(address to,uint256 amount)','event Transfer(address indexed from,address indexed to,uint256 value)']);
async function paymentFixture(t,databaseOverride) {
  const db = databaseOverride || database(t), user = Wallet.createRandom(), collector = Wallet.createRandom(), token = Wallet.createRandom().address.toLowerCase(), txHash = '0x' + 'a'.repeat(64), blockHash = '0x' + 'b'.repeat(64);
  const env = { DB: db, PAYMENT_MODE:'legacy-wallet',LIVE_PAYMENTS_ENABLED: 'true', BSC_RPC_URL: 'https://rpc.invalid', DEPOSIT_ADDRESS: collector.address, TOKEN_ADDRESS: token, DEPOSIT_START_BLOCK: '50', OPS_AUTH_KEY: 'x'.repeat(32) };
  let activeHash = txHash;
  const state = { chain: '0x38', head: '0x78', blockHash, status: '0x1', from: user.address.toLowerCase(), to: collector.address.toLowerCase(), token, amount: units(1000), broadcasts: 0, tx: null };
  env.RPC_FETCH = async (_url, init) => { const { method, params } = JSON.parse(init.body); let result;
    if (method === 'eth_chainId') result = state.chain;
    else if (method === 'eth_getBlockByNumber') result = { hash: state.blockHash };
    else if (method === 'eth_blockNumber') result = state.head;
    else if (method === 'eth_call') result = '0x12';
    else if (method === 'eth_getTransactionReceipt') { const event = iface.encodeEventLog('Transfer', [state.from, state.to, state.amount]); result = { transactionHash: params[0], blockHash, blockNumber: '0x64', status: state.status, logs: [{ address: state.token, ...event }] }; }
    else if (method === 'eth_getTransactionByHash') result = state.tx || { from: user.address, to: token, input: iface.encodeFunctionData('transfer', [collector.address, state.amount]), value: '0x0' };
    else if (method === 'eth_sendRawTransaction') { state.broadcasts++; result = activeHash; }
    else throw Error(method);
    return Response.json({ result });
  };
  const req = request('/auth/verify', {}), c = await challenge(db, req, user.address), login = await walletLogin(db, req, env, { challengeId: c.challengeId, signature: await user.signMessage(c.message) });
  return { db, env, user, collector, token, txHash, state, cookie: login.cookie.split(';')[0], owner: login.owner, setHash: value => activeHash = value };
}
test('deposit proves chain, finality, canonical block, token, sender and recipient; self-transfer rejected', async t => {
  const f = await paymentFixture(t), { db, env, state, owner, txHash } = f;
  for (const [field, invalid] of [['chain','0x1'],['head','0x65'],['blockHash','0x'+'c'.repeat(64)],['status','0x0'],['token',Wallet.createRandom().address.toLowerCase()],['from',Wallet.createRandom().address.toLowerCase()],['to',Wallet.createRandom().address.toLowerCase()]]) {
    const old = state[field]; state[field] = invalid; await assert.rejects(creditDeposit(db, env, owner, key(), txHash)); state[field] = old; assert.equal((await getState(db, owner)).balance, '0');
  }
  state.amount = parseAmount('1000.123456789123456789');
  await Promise.all([creditDeposit(db, env, owner, key(), txHash), creditDeposit(db, env, owner, key(), txHash)]);
  assert.equal((await getState(db, owner)).balance, '1000.123456789123456789'); assert.equal((await first(db, 'SELECT COUNT(*) n FROM deposits')).n, 1); assert.equal((await audit(db)).ok, true);
});
test('withdrawal reservation cannot overdraw; reject refunds once; demo cannot withdraw', async t => {
  const { db, env, owner, txHash } = await paymentFixture(t); await creditDeposit(db, env, owner, key(), txHash);
  const id = key(), requests = await Promise.all([requestWithdrawal(db, env, owner, id, '500', WITHDRAWAL_FEE.version), requestWithdrawal(db, env, owner, id, '500', WITHDRAWAL_FEE.version)]); assert.deepEqual(...requests);
  assert.equal((await getState(db, owner)).balance, '500'); assert.equal((await getState(db, owner)).locked, '500');
  await assert.rejects(requestWithdrawal(db, env, owner, key(), '501', WITHDRAWAL_FEE.version), /不足/); const k = key(); await rejectWithdrawal(db, env, k, requests[0].id); await rejectWithdrawal(db, env, k, requests[0].id); assert.equal((await getState(db, owner)).balance, '1000');
  await ensureDemo(db, 'demo'); await assert.rejects(requestWithdrawal(db, env, 'demo', key(), '500', WITHDRAWAL_FEE.version), /测试币/); assert.equal((await audit(db)).ok, true);
});
test('signed outbox validates recipient and value; broadcast retries same tx; confirmation releases reserve once', async t => {
  const f = await paymentFixture(t), { db, env, owner, txHash, collector, user, token, state } = f; await creditDeposit(db, env, owner, key(), txHash);
  const w = await requestWithdrawal(db, env, owner, key(), '500', WITHDRAWAL_FEE.version);
  const make = amount => collector.signTransaction({ chainId: 56, type: 0, nonce: 1, gasLimit: 150000, gasPrice: 1000000000, to: token, value: 0, data: iface.encodeFunctionData('transfer', [user.address, units(amount)]) });
  await assert.rejects(attachSignedWithdrawal(db, env, key(), w.id, await make(475)), /不匹配/);
  const raw = await make(500), attached = await attachSignedWithdrawal(db, env, key(), w.id, raw); f.setHash(attached.txHash);
  await assert.rejects(rejectWithdrawal(db, env, key(), w.id), /尚未签名/);
  await broadcastWithdrawal(db, env, w.id); await broadcastWithdrawal(db, env, w.id); assert.equal(state.broadcasts, 2);
  state.from = collector.address.toLowerCase(); state.to = user.address.toLowerCase(); state.amount = units(499); await assert.rejects(finishWithdrawal(db, env, owner, key(), w.id), /实际到账/); assert.equal((await getState(db, owner)).locked, '500');
  state.amount = units(500); await Promise.all([finishWithdrawal(db, env, owner, key(), w.id), finishWithdrawal(db, env, owner, key(), w.id)]);
  assert.equal((await getState(db, owner)).locked, '0'); assert.equal((await getState(db, owner)).balance, '500');
  const treasury=await first(db,'SELECT * FROM treasuries WHERE asset=?',tokenAsset(env));
  assert.equal(treasury.available,'0'); assert.equal(treasury.fees,'0');
  assert.equal((await paymentHistory(db,owner)).withdrawals[0].payout,'500');
  assert.equal((await audit(db)).ok, true);
});
test('confirmed reverted payout restores user balance rather than recording successful withdrawal', async t => {
  const { db, env, owner, txHash, collector, user, token, state } = await paymentFixture(t); await creditDeposit(db, env, owner, key(), txHash);
  const w = await requestWithdrawal(db, env, owner, key(), '500', WITHDRAWAL_FEE.version), raw = await collector.signTransaction({ chainId: 56, type: 0, nonce: 2, gasLimit: 150000, gasPrice: 1000000000, to: token, data: iface.encodeFunctionData('transfer', [user.address, units(500)]) }); await attachSignedWithdrawal(db, env, key(), w.id, raw);
  state.status = '0x0'; assert.equal((await finishWithdrawal(db, env, owner, key(), w.id)).status, 'failed'); assert.equal((await getState(db, owner)).balance, '1000'); assert.equal((await audit(db)).ok, true);
  assert.equal(paymentConfig({}).enabled, false);
  assert.equal((await first(db,'SELECT fees FROM treasuries WHERE asset=?',tokenAsset(env))).fees,'0');
});

// Sites currently forwards the email identity even when there is no user-id header.
test('platform identity reuses the same demo account after a session ends', async t => {
  const db = database(t), req = request('/auth/demo', {}, undefined, {'oai-authenticated-user-email':'Example@EXAMPLE.COM'});
  const env = { TRUST_PLATFORM_IDENTITY: 'true' };
  const a = await demoLogin(db, req, env); await play(db, a.owner, key(), '500', opts);
  const b = await demoLogin(db, req, env); assert.equal(b.owner, a.owner); assert.equal((await getState(db,b.owner)).balance, '19925');
});

test('public Workers ignore forged platform identity headers and retain cookie sessions', async t => {
  const db = database(t), req = request('/auth/demo', {}, undefined, {'oai-authenticated-user-id':'forged', 'oai-authenticated-user-email':'victim@example.com'});
  const a = await demoLogin(db, req), b = await demoLogin(db, req);
  assert.notEqual(a.owner, b.owner);
  assert.ok(!a.owner.startsWith('demo:oai:'));
  const again = await demoLogin(db, request('/auth/demo', {}, a.cookie.split(';')[0]));
  assert.equal(again.owner, a.owner);
});

const drawFor = id => {
  let offset = 0;
  for (const o of WHEEL_OUTCOMES) { if (o.id === id) return drawWheel(() => BigInt(offset)); offset += o.weight; }
  throw Error('Unknown test outcome');
};
test('all 10,000 tickets produce exactly the disclosed distribution, including five jackpots', () => {
  const counts = new Map(); let loss = 0, even = 0, win = 0, weightedNet = 0n;
  for (let ticket = 0; ticket < RULES.weightTotal; ticket++) {
    const draw = drawWheel(limit => { assert.equal(limit, 10000n); return BigInt(ticket); });
    const o = WHEEL_OUTCOMES.find(x => x.id === draw.outcomeId);
    counts.set(o.id, (counts.get(o.id) || 0) + 1);
    assert.equal(draw.sequence.length, 1); assert.equal(draw.score * 50, o.multiplierBps);
    const s = settlement(units(10000), draw); weightedNet += s.net;
    assert.equal(s.gross, BigInt(o.multiplierBps) * 10n ** 18n); assert.equal(s.fee,o.multiplierBps>10000?units(500):0n); assert.equal(s.net,s.gross-s.fee);
    if (s.net < units(9000)) loss++; else if (s.net > units(10000)) win++; else even++;
  }
  for (const o of WHEEL_OUTCOMES) assert.equal(counts.get(o.id), o.weight);
  assert.equal(counts.get('jackpot'), 5); assert.equal(counts.get('no-prize'), 2800);
  assert.equal(loss, 4600); assert.equal(even, 3800); assert.equal(win, 1600);
  assert.equal(weightedNet / 10000n, parseAmount('7700')); assert.equal(RULES.netRtp, '77.0000%');
  assert.deepEqual(RULES.resultProbabilities,[46,38,16]);
  assert.ok(!WHEEL_OUTCOMES.some(o => o.multiplierBps === 8000)); assert.equal(WHEEL_OUTCOMES.filter(o => o.multiplierBps < 10000).length, 2);
});
test('1.2 and 1.5 stake-fee examples are exact at minimum, custom and maximum amounts', () => {
  for (const [bps, gross, fee, net] of [[12000,'600','25','575'], [15000,'750','25','725']]) {
    const s = settlement(units(500), { score: bps / 50 });
    assert.equal(formatAmount(s.gross), gross); assert.equal(formatAmount(s.fee), fee); assert.equal(formatAmount(s.net), net);
    for (const stake of [units(501),units(50000)]) {
      const r=settlement(stake,{score:bps/50});
      assert.equal(r.gross,stake*BigInt(bps)/10000n); assert.equal(r.fee,stake/20n); assert.equal(r.net,r.gross-r.fee);
    }
  }
});
test('10x spin settles one stake, one history row and a 9.95x net reward', async t => {
  const db=database(t); await ensureDemo(db,'single');
  const roll=await play(db,'single',key(),'500',{minimumInterval:0,outcomeFactory:()=>drawFor('jackpot')});
  assert.equal(roll.round.outcomeId,'jackpot'); assert.equal(roll.round.multiplierBps,100000); assert.deepEqual(roll.round.sequence,[10]);
  assert.equal(roll.round.gross,'5000'); assert.equal(roll.round.fee,'25'); assert.equal(roll.round.net,'4975'); assert.equal(roll.balance,'24475');
  assert.equal(roll.round.rewardDestination,'balance'); assert.equal(roll.round.claimed,true);
  const row=await first(db,'SELECT * FROM rounds WHERE owner=?','single'); assert.deepEqual(JSON.parse(row.sequence),[100]); assert.equal(JSON.parse(row.rules_snapshot).subresults,1);
  assert.equal((await first(db,'SELECT COUNT(*) n FROM rounds')).n,1); assert.equal((await audit(db)).ok,true);
});
test('1x refunds full principal immediately, keeps prior rewards, charges no fee and never auto-spins', async t => {
  const db=database(t); await ensureDemo(db,'replay');
  await play(db,'replay',key(),'500',{minimumInterval:0,outcomeFactory:()=>drawFor('small-win')});
  const before=await getState(db,'replay'), k=key(), options={minimumInterval:0,outcomeFactory:()=>drawFor('break-even')};
  const results=await Promise.all([play(db,'replay',k,'1000',options),play(db,'replay',k,'1000',options)]); assert.deepEqual(...results);
  const r=results[0]; assert.equal(r.round.gross,'1000'); assert.equal(r.round.net,'1000'); assert.equal(r.round.fee,'0'); assert.equal(r.round.profit,'0');
  assert.equal(r.balance,before.balance); assert.equal(r.rewards,before.rewards); assert.equal(r.round.rewardDestination,'balance'); assert.equal(r.round.claimed,true);
  assert.equal((await first(db,'SELECT COUNT(*) n FROM rounds')).n,2);
  const h=(await history(db,'replay')).find(x=>x.id===r.round.id); assert.equal(h.outcomeKind,'replay'); assert.equal(h.claimed,true); assert.equal(h.rewardDestination,'balance');
  await assert.rejects(claim(db,'replay',key()),/自动到账/); assert.equal((await audit(db)).ok,true);
});
test('谢谢参与 returns zero and cannot create an unclaimable pending reward', async t => {
  const db=database(t); await ensureDemo(db,'empty');
  const r=await play(db,'empty',key(),'500',{minimumInterval:0,outcomeFactory:()=>drawFor('no-prize')});
  assert.equal(r.round.net,'0'); assert.equal(r.round.fee,'0'); assert.equal(r.round.profit,'-500'); assert.equal(r.balance,'19500'); assert.equal(r.rewards,'0');
  assert.equal(r.round.rewardDestination,'none'); assert.equal(r.round.claimed,true);
  assert.equal((await history(db,'empty'))[0].outcomeKind,'empty');
  await assert.rejects(claim(db,'empty',key()),/没有可领取/); assert.equal((await audit(db)).ok,true);
});
test('pool reserves cover 10x before drawing; concurrent largest stakes cannot use stale limits', async t => {
  assert.equal(maximumPayout(units(500)),units(5000));
  for (const pool of [units(500000),units(2000000),units(200000000)]) {
    assert.ok(maximumPayout(maxBet(pool))*3n<=pool); assert.ok(maxBet(pool)<=units(50000));
  }
  assert.equal(maxBet(units(499999)),0n);
  const db=database(t); await ensureDemo(db,'cap-a'); await ensureDemo(db,'cap-b'); let draws=0;
  const options={minimumInterval:0,outcomeFactory:()=>{ draws++; return drawFor('jackpot'); }};
  await assert.rejects(play(db,'cap-a',key(),'6667',options),/限额/); assert.equal(draws,0);
  const results=await Promise.allSettled([play(db,'cap-a',key(),'6666',options),play(db,'cap-b',key(),'6666',options)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1); assert.equal(results.filter(x=>x.status==='rejected').length,1);
  assert.ok(draws<=2); assert.ok(BigInt((await first(db,"SELECT available FROM treasuries WHERE asset='demo'")).available)>0n);
  assert.equal((await audit(db)).ok,true);
});
test('outdated pages cannot place new stakes, but committed retries restore their original result', async t => {
  const db=database(t),env={DB:db},login=await worker.fetch(request('/auth/demo',{}),env),cookie=login.headers.get('set-cookie').split(';')[0];
  for(const rulesVersion of [undefined,'server-wheel-v1-20260915','server-wheel-replay-v2-20260915','server-wheel-withdrawal-fee-v5-20260915']) {
    const response=await worker.fetch(request('/play',{amount:'500',rulesVersion},cookie,{'Idempotency-Key':key()}),env);
    assert.equal(response.status,409); assert.equal((await response.json()).code,'RULES_CHANGED');
  }
  assert.equal((await first(db,'SELECT COUNT(*) n FROM rounds')).n,0);
  const k=key(),response=await worker.fetch(request('/play',{amount:'500',rulesVersion:RULES.version},cookie,{'Idempotency-Key':k}),env); assert.equal(response.status,200);
  const original=await response.json();
  const retry=await worker.fetch(request('/play',{amount:'500',rulesVersion:'server-wheel-v1-20260915'},cookie,{'Idempotency-Key':k}),env);
  assert.deepEqual(await retry.json(),original); assert.equal((await first(db,'SELECT COUNT(*) n FROM rounds')).n,1); assert.equal((await audit(db)).ok,true);
});
test('historical 1x remains fee-bearing and claimable rather than being reclassified as current fee-free 1x', async t=>{
  const db=database(t); await ensureDemo(db,'old');
  const r=await play(db,'old',key(),'500',{minimumInterval:0,outcomeFactory:()=>({score:200,sequence:[10],outcomeId:'old-one'})});
  const oldRules={version:'server-wheel-v1-20260915',outcomes:[{id:'one',multiplierBps:10000}],claimFeeBps:500};
  const treasury=await first(db,"SELECT * FROM treasuries WHERE asset='demo'");
  await db.batch([
    stmt(db,'UPDATE rounds SET rules_version=?,rules_snapshot=?,fee=?,net=?,claimed=0 WHERE id=?',oldRules.version,JSON.stringify(oldRules),String(units(25)),String(units(475)),r.round.id),
    stmt(db,'UPDATE accounts SET available=?,rewards=? WHERE id=?',String(units(19500)),String(units(475)),'old'),
    stmt(db,"UPDATE treasuries SET available=?,fees=? WHERE asset='demo'",String(BigInt(treasury.available)+units(25)),String(units(25))),
    ...transfer(db,key(),'demo','old:available','old:rewards',units(500),Date.now()),
    ...transfer(db,key(),'demo','old:rewards','pool:demo',units(25),Date.now())
  ]);
  const h=(await history(db,'old'))[0]; assert.equal(h.outcomeKind,'payout'); assert.equal(h.net,'475'); assert.equal(h.fee,'25'); assert.equal(h.claimed,false);
  assert.equal((await claim(db,'old',key())).amount,'475'); assert.equal((await audit(db)).ok,true);
});

test('every restored middle tier credits balance exactly once without claiming', async t => {
  const db=database(t); await ensureDemo(db,'middle');
  for (const [id,multiplier,gross,fee,net] of [
    ['one-half',1.5,'750','25','725'],
    ['double',2,'1000','25','975'],
    ['triple',3,'1500','25','1475'],
    ['fivefold',5,'2500','25','2475'],
  ]) {
    const k=key(),options={minimumInterval:0,outcomeFactory:()=>drawFor(id)};
    const r=await play(db,'middle',k,'500',options);
    assert.equal(r.round.outcomeId,id); assert.deepEqual(r.round.sequence,[multiplier]);
    assert.equal(r.round.gross,gross); assert.equal(r.round.fee,fee); assert.equal(r.round.net,net);
    assert.deepEqual(await play(db,'middle',k,'500',options),r);
    const saved=(await history(db,'middle')).find(h=>h.id===r.round.id);
    assert.equal(saved.net,net); assert.equal(saved.multiplierBps,multiplier*10000); assert.equal(saved.claimed,true);
    assert.equal(r.rewards,'0'); assert.equal(r.round.rewardDestination,'balance');
    await assert.rejects(claim(db,'middle',key()),/没有可领取/);
  }
  assert.equal((await first(db,'SELECT COUNT(*) n FROM rounds')).n,4);
  assert.equal((await audit(db)).ok,true);
});

test('new withdrawals preserve every unit and charge no fee', () => {
  assert.deepEqual(withdrawalQuote('1000'), { amount:'1000',fee:'0',payout:'1000',feeBps:0,feeVersion:WITHDRAWAL_FEE.version });
  for (const input of ['0.000000000000000001','0.000000000000000019','0.000000000000000020','1000.123456789123456789','999999999.999999999999999999']) {
    const quote=withdrawalQuote(input), amount=parseAmount(input), fee=0n;
    assert.equal(quote.fee,formatAmount(fee)); assert.equal(parseAmount(quote.payout)+fee,amount);
  }
  assert.equal(withdrawalQuote('0.000000000000000019').fee,'0');
  assert.equal(withdrawalQuote('0.000000000000000020').fee,'0');
});

test('HTTP quote has no ledger effects; fee consent is required; client fee tampering is ignored', async t => {
  const {db,env,owner,txHash,cookie}=await paymentFixture(t); await creditDeposit(db,env,owner,key(),txHash);
  const before=await getState(db,owner),auditBefore=await audit(db);
  const q=await worker.fetch(request('/withdrawals/quote',{amount:'1000'},cookie),env);
  assert.equal(q.status,200); const quote=await q.json(); assert.equal(quote.fee,'0'); assert.equal(quote.payout,'1000');
  assert.deepEqual(await getState(db,owner),before); assert.deepEqual(await audit(db),auditBefore);
  await assert.rejects(quoteWithdrawal(db,env,owner,'1001'),/不足/);
  for(const feeVersion of [undefined,'legacy-no-fee-v1','withdrawal-fee-v1-20260915']) {
    const response=await worker.fetch(request('/withdrawals',{amount:'500',feeVersion},cookie,{'Idempotency-Key':key()}),env);
    assert.equal(response.status,409); assert.equal((await response.json()).code,'FEE_CHANGED');
  }
  assert.equal((await first(db,'SELECT COUNT(*) n FROM withdrawals')).n,0);
  const k=key(),payload={amount:'500',feeVersion:quote.feeVersion,fee:'25',payout:'475',recipient:Wallet.createRandom().address};
  const response=await worker.fetch(request('/withdrawals',payload,cookie,{'Idempotency-Key':k}),env);
  assert.equal(response.status,200); const saved=await response.json(); assert.equal(saved.fee,'0'); assert.equal(saved.payout,'500'); assert.equal(saved.recipient,quote.recipient);
  // Lost responses can recover the original operation, even after a fee-policy change.
  const retry=await worker.fetch(request('/withdrawals',{amount:'500',feeVersion:'outdated'},cookie,{'Idempotency-Key':k}),env);
  assert.deepEqual(await retry.json(),saved); assert.equal((await first(db,'SELECT COUNT(*) n FROM withdrawals')).n,1);
  const adminList=await worker.fetch(request('/admin/withdrawals',undefined,undefined,{Authorization:'Bearer '+env.OPS_AUTH_KEY}),env);
  assert.equal((await adminList.json()).withdrawals[0].payout,'500');
  const fees=await first(db,'SELECT fees FROM treasuries WHERE asset=?',tokenAsset(env)); assert.equal(fees.fees,'0');
  await rejectWithdrawal(db,env,key(),saved.id); const history=(await paymentHistory(db,owner)).withdrawals[0];
  assert.equal(history.status,'rejected'); assert.equal(history.fee,'0'); assert.equal(history.payout,'500');
  assert.equal((await getState(db,owner)).balance,'1000'); assert.equal((await audit(db)).ok,true);
});

test('migration preserves queued and already signed no-fee withdrawals and committed request retries', async t => {
  const dir=mkdtempSync(join(tmpdir(),'sheep-migrate-')),path=join(dir,'game.sqlite'),migrations=join(dir,'legacy');
  mkdirSync(migrations); writeFileSync(join(migrations,'0000_volatile_genesis.sql'),readFileSync(new URL('../drizzle/0000_volatile_genesis.sql',import.meta.url)));
  let db=openDatabase(path,pathToFileURL(migrations+'/'));
  t.after(()=>{db.close();rmSync(dir,{recursive:true});});
  const f=await paymentFixture(t,db),{env,owner,txHash,user,collector,token,state}=f;
  await creditDeposit(db,env,owner,key(),txHash);
  const ids=[key(),key()],oldKey=key(),now=Date.now(),oldResponse={id:ids[0],status:'queued',amount:'500',recipient:user.address.toLowerCase()};
  const fingerprint=await hash('withdraw:'+JSON.stringify({amount:'500'}));
  await db.batch([
    stmt(db,'UPDATE accounts SET available=?,locked=?,revision=revision+1 WHERE id=?','0',String(units(1000)),owner),
    ...ids.map(wid=>stmt(db,'INSERT INTO withdrawals(id,owner,asset,amount,recipient,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',wid,owner,tokenAsset(env),String(units(500)),user.address.toLowerCase(),'queued',now,now)),
    stmt(db,'INSERT INTO operations(id,owner,request_key,fingerprint,kind,response,created_at) VALUES (?,?,?,?,?,?,?)',key(),owner,oldKey,fingerprint,'withdraw',JSON.stringify(oldResponse),now),
    ...transfer(db,key(),tokenAsset(env),owner+':available',owner+':locked',units(1000),now)
  ]);
  const sign=nonce=>collector.signTransaction({chainId:56,type:0,nonce,gasLimit:150000,gasPrice:1000000000,to:token,value:0,data:iface.encodeFunctionData('transfer',[user.address,units(500)])});
  await attachSignedWithdrawal(db,env,key(),ids[1],await sign(8));
  db.close();db=openDatabase(path);env.DB=db;
  for(const wid of ids) { const row=await first(db,'SELECT * FROM withdrawals WHERE id=?',wid);assert.equal(row.fee,'0');assert.equal(row.fee_bps,0);assert.equal(row.fee_version,'legacy-no-fee-v1'); }
  assert.deepEqual(await requestWithdrawal(db,env,owner,oldKey,'500'),oldResponse);
  await attachSignedWithdrawal(db,env,key(),ids[0],await sign(9));
  state.from=collector.address.toLowerCase();state.to=user.address.toLowerCase();state.amount=units(500);
  await Promise.all(ids.map(wid=>finishWithdrawal(db,env,owner,key(),wid)));
  assert.equal((await getState(db,owner)).locked,'0');
  assert.equal((await first(db,'SELECT fees FROM treasuries WHERE asset=?',tokenAsset(env))).fees,'0');
  assert.ok((await paymentHistory(db,owner)).withdrawals.every(w=>w.payout==='500'&&w.fee==='0'&&w.status==='confirmed'));
  assert.equal((await audit(db)).ok,true);
});

test('only multipliers strictly above 1x charge 5% of stake, across all nine outcomes', () => {
  const examples=[['no-prize','0','0'],['half','250','0'],['break-even','500','0'],['small-win','575','25'],['one-half','725','25'],['double','975','25'],['triple','1475','25'],['fivefold','2475','25'],['jackpot','4975','25']];
  for(const [id,net,fee] of examples){const s=settlement(units(500),drawFor(id));assert.equal(formatAmount(s.net),net);assert.equal(formatAmount(s.fee),fee);}
  for(const bet of [500,501,50000]) {
    for(const id of ['no-prize','half','break-even'])assert.equal(settlement(units(bet),drawFor(id)).fee,0n);
  }
  assert.equal(RULES.claimFeeBps,0);assert.equal(RULES.roundFee.basis,'stake');assert.equal(WITHDRAWAL_FEE.bps,0);
});

test('one winning spin credits once and can be withdrawn without a reward claim', async t=>{
  const f=await paymentFixture(t),{db,env,owner,txHash,collector,user,token,state}=f;
  state.amount=units(50000);await creditDeposit(db,env,owner,key(),txHash);
  const asset=tokenAsset(env),now=Date.now();
  await db.batch([stmt(db,'UPDATE treasuries SET available=?,revision=revision+1 WHERE asset=?',String(units(2000000)),asset),...transfer(db,key(),asset,'external','pool:'+asset,units(2000000),now)]);
  const k=key(),options={minimumInterval:0,outcomeFactory:()=>drawFor('small-win')};
  const results=await Promise.all([play(db,owner,k,'500',options),play(db,owner,k,'500',options)]);assert.deepEqual(...results);
  assert.equal(results[0].round.fee,'25');assert.equal(results[0].round.net,'575');
  await assert.rejects(claim(db,owner,key()),/自动到账/);assert.equal(results[0].rewards,'0');
  assert.equal((await getState(db,owner)).balance,'50075');
  const q=await quoteWithdrawal(db,env,owner,'50075');assert.equal(q.fee,'0');assert.equal(q.payout,'50075');
  const w=await requestWithdrawal(db,env,owner,key(),q.amount,q.feeVersion);
  const raw=await collector.signTransaction({chainId:56,type:0,nonce:11,gasLimit:150000,gasPrice:1000000000,to:token,data:iface.encodeFunctionData('transfer',[user.address,units(50075)])});
  await attachSignedWithdrawal(db,env,key(),w.id,raw);state.from=collector.address.toLowerCase();state.to=user.address.toLowerCase();state.amount=units(50075);
  await Promise.all([finishWithdrawal(db,env,owner,key(),w.id),finishWithdrawal(db,env,owner,key(),w.id)]);
  assert.equal((await getState(db,owner)).balance,'0');assert.equal((await getState(db,owner)).locked,'0');
  assert.equal((await first(db,'SELECT fees FROM treasuries WHERE asset=?',asset)).fees,String(units(25)));assert.equal((await audit(db)).ok,true);
});

test('saved 5% withdrawal snapshot and retry remain unchanged after new withdrawals become free', async t=>{
  const {db,env,owner,txHash,user,collector,token,state}=await paymentFixture(t);await creditDeposit(db,env,owner,key(),txHash);
  const k=key(),created=await requestWithdrawal(db,env,owner,k,'500',WITHDRAWAL_FEE.version);
  // Recreate a committed v1 fee-bearing withdrawal, including its cached original response.
  const saved={...created,fee:'25',payout:'475',feeBps:500,feeVersion:'withdrawal-fee-v1-20260915'};
  await db.batch([
    stmt(db,'UPDATE withdrawals SET fee=?,fee_bps=?,fee_version=? WHERE id=?',String(units(25)),500,saved.feeVersion,created.id),
    stmt(db,'UPDATE operations SET response=? WHERE owner=? AND request_key=?',JSON.stringify(saved),owner,k)
  ]);
  assert.deepEqual(await requestWithdrawal(db,env,owner,k,'500',saved.feeVersion),saved);
  const sign=n=>collector.signTransaction({chainId:56,type:0,nonce:12,gasLimit:150000,gasPrice:1000000000,to:token,data:iface.encodeFunctionData('transfer',[user.address,units(n)])});
  await assert.rejects(attachSignedWithdrawal(db,env,key(),saved.id,await sign(500)),/不匹配/);
  await attachSignedWithdrawal(db,env,key(),saved.id,await sign(475));
  state.from=collector.address.toLowerCase();state.to=user.address.toLowerCase();state.amount=units(475);
  await Promise.all([finishWithdrawal(db,env,owner,key(),saved.id),finishWithdrawal(db,env,owner,key(),saved.id)]);
  assert.equal((await first(db,'SELECT fees FROM treasuries WHERE asset=?',tokenAsset(env))).fees,String(units(25)));
  assert.equal((await getState(db,owner)).balance,'500');assert.equal((await audit(db)).ok,true);
});
