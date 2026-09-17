import test from 'node:test';
import assert from 'node:assert/strict';
import { REFERRAL_RULES } from '../server/referrals.js';
import { Wallet } from 'ethers';
import { openDatabase } from '../scripts/local-d1.mjs';
import { RULES, units, drawWheel } from '../server/rules.js';
import { saveWhitelist, accountPolicy, listWhitelist } from '../server/whitelist.js';
import { ensureDemo, getState, play, history } from '../server/game.js';
import { first, stmt, transfer } from '../server/db.js';
import { challenge, walletLogin, tokenAsset } from '../server/auth.js';
import { quoteWithdrawal, requestWithdrawal, rejectWithdrawal } from '../server/payments.js';
import { withdrawalQuote, WITHDRAWAL_FEE } from '../server/withdrawal-fee.js';
import worker, { audit } from '../server/worker.js';

const key = () => crypto.randomUUID(), origin = 'https://game.example';
const weights = id => RULES.outcomes.map(o => o.id === id ? 10000 : 0);
const environment = db => ({ DB: db, PAYMENT_MODE:'legacy-wallet',LIVE_PAYMENTS_ENABLED: 'true', TOKEN_ADDRESS: '0x0000000000000000000000000000000000000011', DEPOSIT_ADDRESS: '0x0000000000000000000000000000000000000022', BSC_RPC_URL: 'https://rpc.example', DEPOSIT_START_BLOCK: '1', OPS_AUTH_KEY: 'test-only-admin-key-never-used-in-production' });
function database(t) { const db = openDatabase(); t.after(() => db.close()); return db; }
function request(path, data, cookie, extra = {}) {
  return new Request(origin + '/api' + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Game-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
}
async function walletAccount(db, env, wallet = Wallet.createRandom()) {
  const req = request('/auth/challenge', {}), c = await challenge(db, req, wallet.address);
  const login = await walletLogin(db, req, env, { challengeId: c.challengeId, signature: await wallet.signMessage(c.message) });
  const now = Date.now(), asset = tokenAsset(env), a = await first(db, 'SELECT * FROM accounts WHERE id=?', login.owner);
  await db.batch([
    stmt(db, 'UPDATE accounts SET available=? WHERE id=?', String(units(10000)), a.id),
    ...transfer(db, key(), asset, 'test-funding', a.id + ':available', units(10000), now),
  ]);
  const pool = await first(db, 'SELECT * FROM treasuries WHERE asset=?', asset);
  if (pool.available === '0') await db.batch([
    stmt(db, 'UPDATE treasuries SET available=? WHERE asset=?', String(units(2000000)), asset),
    ...transfer(db, key(), asset, 'test-funding', 'pool:' + asset, units(2000000), now),
  ]);
  return { ...login, wallet, asset };
}
async function policy(db, user, outcome = 'double', revision = 0, enabled = true) {
  return saveWhitelist(db, user.asset, key(), { address: user.wallet.address, weights: weights(outcome), enabled, revision });
}

test('signed wallet gets its own exact distribution, while other wallets and demo keep 77%', async t => {
  const db = database(t), env = environment(db), alice = await walletAccount(db, env), bob = await walletAccount(db, env);
  await policy(db, alice);
  const a = await getState(db, alice.owner), b = await getState(db, bob.owner);
  assert.equal(a.benefits.whitelisted, true); assert.equal(a.rules.netRtp, '195.0000%');
  assert.deepEqual(b.rules, RULES); assert.equal(b.benefits.whitelisted, false);
  for (let i = 0; i < 10000; i++) assert.equal(drawWheel(() => BigInt(i), a.rules).outcomeId, 'double');
  await ensureDemo(db, 'demo'); assert.deepEqual((await getState(db, 'demo')).rules, RULES);
  const result = await play(db, alice.owner, key(), '500', { expectedVersion: a.rules.version, requireRulesVersion: true });
  assert.equal(result.round.net, '975'); assert.equal(result.round.fee, '25'); assert.equal(result.balance, '10475');
  const saved = await first(db, 'SELECT * FROM rounds WHERE id=?', result.round.id);
  assert.deepEqual(JSON.parse(saved.rules_snapshot), {...a.rules,referral:{...REFERRAL_RULES,recipients:[]}}); assert.equal((await audit(db)).ok, true);
  // Same wallet on another token has no privileges unless configured for it.
  assert.equal((await accountPolicy(db, { wallet: alice.wallet.address, asset: 'token:56:other' })).benefits.whitelisted, false);
});

test('admin authentication, exact probabilities, stale edits and idempotent updates are enforced', async t => {
  const db = database(t), env = environment(db), alice = await walletAccount(db, env);
  assert.equal((await worker.fetch(request('/admin/whitelist'), env)).status, 403);
  const payload = { address: alice.wallet.address, weights: weights('break-even'), enabled: true, revision: 0 };
  assert.equal((await worker.fetch(request('/admin/whitelist', payload, alice.cookie), env)).status, 403);
  const headers = { Authorization: 'Bearer ' + env.OPS_AUTH_KEY, 'Idempotency-Key': key() };
  const response = await worker.fetch(request('/admin/whitelist', payload, null, headers), env);
  assert.equal(response.status, 200); const saved = await response.json(); assert.equal(saved.revision, 1);
  assert.deepEqual(await (await worker.fetch(request('/admin/whitelist', payload, null, headers), env)).json(), saved);
  assert.equal((await worker.fetch(request('/admin/whitelist', payload, null, { ...headers, 'Idempotency-Key': key() }), env)).status, 409);
  for (const bad of [[], [10000], weights('double').map(x => x + 1), weights('double').map(x => x + .1)]) {
    await assert.rejects(saveWhitelist(db, alice.asset, key(), { ...payload, revision: 1, weights: bad }), /概率/);
  }
  await assert.rejects(saveWhitelist(db, alice.asset, key(), { ...payload, address: '0x0000000000000000000000000000000000000000' }), /钱包地址/);
  const publicConfig = await (await worker.fetch(request('/config'), env)).json();
  assert.deepEqual(publicConfig.rules, RULES); assert.ok(!JSON.stringify(publicConfig).includes(alice.wallet.address.toLowerCase()));
  assert.equal((await listWhitelist(db, alice.asset)).entries[0].address, alice.wallet.address.toLowerCase());
});

test('client cannot spoof a whitelisted wallet, profile or chosen result', async t => {
  const db = database(t), env = environment(db), alice = await walletAccount(db, env), bob = await walletAccount(db, env);
  await policy(db, alice, 'jackpot'); const a = await getState(db, alice.owner);
  const rejected = await worker.fetch(request('/play', { amount: '500', rulesVersion: a.rules.version, address: alice.wallet.address, whitelisted: true }, bob.cookie, { 'Idempotency-Key': key() }), env);
  assert.equal(rejected.status, 409); assert.equal((await rejected.json()).code, 'RULES_CHANGED');
  assert.equal((await getState(db, bob.owner)).balance, '10000');
  const ok = await worker.fetch(request('/play', { amount: '500', rulesVersion: RULES.version, address: alice.wallet.address, weights: weights('jackpot'), outcomeId: 'jackpot' }, bob.cookie, { 'Idempotency-Key': key() }), env);
  assert.equal(ok.status, 200); const result = await ok.json();
  assert.equal(result.round.version, RULES.version);
  assert.deepEqual(JSON.parse((await first(db, 'SELECT rules_snapshot FROM rounds WHERE id=?', result.round.id)).rules_snapshot), {...RULES,referral:{...REFERRAL_RULES,recipients:[]}});
});

test('changing or disabling policies preserves committed rounds and blocks stale new stakes', async t => {
  const db = database(t), env = environment(db), alice = await walletAccount(db, env); await policy(db, alice);
  const before = await getState(db, alice.owner), k = key();
  const options = { expectedVersion: before.rules.version, requireRulesVersion: true, minimumInterval: 0 };
  const original = await play(db, alice.owner, k, '500', options);
  await policy(db, alice, 'break-even', 1);
  assert.deepEqual(await play(db, alice.owner, k, '500', options), original);
  await assert.rejects(play(db, alice.owner, key(), '500', options), e => e.code === 'RULES_CHANGED');
  assert.equal((await history(db, alice.owner))[0].version, before.rules.version);
  await policy(db, alice, 'break-even', 2, false);
  assert.deepEqual((await getState(db, alice.owner)).rules, RULES);
  assert.equal((await getState(db, alice.owner)).benefits.withdrawalFeeExempt, false);
});

test('a concurrent policy change rolls back the entire debit and retries with a stale-rule error', async t => {
  const db = database(t), env = environment(db), alice = await walletAccount(db, env); await policy(db, alice);
  const state = await getState(db, alice.owner); let changed = false;
  const racing = { ...db, batch: async statements => {
    if (!changed) { changed = true; await policy(db, alice, 'no-prize', 1); }
    return db.batch(statements);
  } };
  await assert.rejects(play(racing, alice.owner, key(), '500', { expectedVersion: state.rules.version, requireRulesVersion: true }), e => e.code === 'RULES_CHANGED');
  assert.equal((await getState(db, alice.owner)).balance, state.balance);
  assert.equal((await history(db, alice.owner)).length, 0); assert.equal((await audit(db)).ok, true);
});

test('whitelisted withdrawals have zero fees and preserve their exemption snapshot after removal', async t => {
  const db = database(t), env = environment(db), alice = await walletAccount(db, env); await policy(db, alice);
  const quote = await quoteWithdrawal(db, env, alice.owner, '1000');
  assert.equal(quote.fee, '0'); assert.equal(quote.payout, '1000'); assert.equal(quote.feeExempt, true);
  assert.match(quote.feeVersion, /^withdrawal-whitelist-free-v1:/);
  const k = key(), result = await requestWithdrawal(db, env, alice.owner, k, '1000', quote.feeVersion);
  await policy(db, alice, 'double', 1, false);
  assert.deepEqual(await requestWithdrawal(db, env, alice.owner, k, '1000', quote.feeVersion), result);
  const saved = await first(db, 'SELECT * FROM withdrawals WHERE id=?', result.id);
  assert.equal(saved.fee_bps, 0); assert.equal(saved.fee, '0'); assert.equal(saved.fee_version, quote.feeVersion);
  await assert.rejects(requestWithdrawal(db, env, alice.owner, key(), '1000', quote.feeVersion), e => e.code === 'FEE_CHANGED');
  await rejectWithdrawal(db, env, key(), result.id); assert.equal((await getState(db, alice.owner)).balance, '10000');
  assert.equal((await audit(db)).ok, true);
  assert.equal(withdrawalQuote('1000', { bps: 500, version: 'test-5-percent' }).fee, '50');
  assert.equal(withdrawalQuote('1000', { bps: quote.feeBps, version: quote.feeVersion }).fee, '0');
  assert.equal((await quoteWithdrawal(db, env, alice.owner, '1000')).feeVersion, WITHDRAWAL_FEE.version);
});

test('a concurrent whitelist change cannot apply an expired withdrawal quote', async t => {
  const db = database(t), env = environment(db), alice = await walletAccount(db, env); await policy(db, alice);
  const quote = await quoteWithdrawal(db, env, alice.owner, '1000'); let changed = false;
  const racing = { ...db, batch: async statements => {
    if (!changed) { changed = true; await policy(db, alice, 'double', 1, false); }
    return db.batch(statements);
  } };
  await assert.rejects(requestWithdrawal(racing, env, alice.owner, key(), '1000', quote.feeVersion), e => e.code === 'FEE_CHANGED');
  assert.equal((await first(db, 'SELECT COUNT(*) n FROM withdrawals')).n, 0);
  const a = await getState(db, alice.owner); assert.equal(a.balance, '10000'); assert.equal(a.locked, '0');
});

test('wallet login exposes only the verified wallet policy, and no signature means no access', async t => {
  const db = database(t), env = environment(db), alice = await walletAccount(db, env); await policy(db, alice);
  const c = await (await worker.fetch(request('/auth/challenge', { address: alice.wallet.address }), env)).json();
  const bad = await worker.fetch(request('/auth/verify', { challengeId: c.challengeId, signature: await Wallet.createRandom().signMessage(c.message) }), env);
  assert.equal(bad.status, 401);
  const good = await worker.fetch(request('/auth/verify', { challengeId: c.challengeId, signature: await alice.wallet.signMessage(c.message) }), env);
  assert.equal(good.status, 200); const a = await good.json();
  assert.equal(a.benefits.whitelisted, true); assert.equal(a.rules.netRtp, '195.0000%'); assert.equal(a.withdrawalFee.bps, 0);
  assert.equal((await worker.fetch(request('/account'), env)).status, 401);
});
