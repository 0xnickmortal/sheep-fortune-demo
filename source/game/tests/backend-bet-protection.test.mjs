import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../scripts/local-d1.mjs';
import { ensureDemo, play, getState, history, demoTopup } from '../server/game.js';
import { RULES, units, drawWheel, settlement } from '../server/rules.js';
import { protectionRules, protectionPlan, isHighStake, recoveryOutcome, outcomeFor } from '../server/bet-protection.js';
import { stmt, first, transfer, accountUpdate, treasuryUpdate } from '../server/db.js';
import worker, { audit } from '../server/worker.js';

const key = () => crypto.randomUUID();
const enabled = { protectionEnabled: true, minimumInterval: 0 };
const pick = id => rules => outcomeFor(rules.outcomes.find(o => o.id === id));
async function seed(db, owner, amount = '10000', pool = '2000000') {
  await ensureDemo(db, owner);
  const a = await first(db, 'SELECT * FROM accounts WHERE id=?', owner), t = await first(db, 'SELECT * FROM treasuries WHERE asset=?', 'demo');
  const delta = units(amount) - BigInt(a.available), poolDelta = units(pool) - BigInt(t.available);
  await db.batch([
    ...accountUpdate(db, a, { available: units(amount) }),
    ...transfer(db, key(), 'demo', delta >= 0n ? 'demo-issuer' : owner + ':available', delta >= 0n ? owner + ':available' : 'demo-issuer', delta >= 0n ? delta : -delta, Date.now()),
    ...treasuryUpdate(db, t, { available: units(pool) }),
    ...transfer(db, key(), 'demo', poolDelta >= 0n ? 'demo-issuer' : 'pool:demo', poolDelta >= 0n ? 'pool:demo' : 'demo-issuer', poolDelta >= 0n ? poolDelta : -poolDelta, Date.now()),
  ]);
}
async function fixture(t, balance, pool) {
  const db = openDatabase(); t.after(() => db.close()); await seed(db, 'alice', balance, pool); return db;
}
async function lose(db, owner = 'alice', amount = '5000') {
  return play(db, owner, key(), amount, { ...enabled, outcomeFactory: pick('half') });
}

test('50% boundary is exact to the smallest token unit; protected weighted draws never hit zero', () => {
  assert.equal(isHighStake(units(5000), units(10000)), true);
  assert.equal(isHighStake(units(5000), units(10000) + 1n), false);
  const plan = protectionPlan(units(5000), units(10000), 0n);
  assert.equal(plan.drawRules.weightTotal, 7200);
  const counts = {};
  for (let i = 0; i < 7200; i++) { const id = drawWheel(() => BigInt(i), plan.drawRules).outcomeId; counts[id] = (counts[id] || 0) + 1; }
  assert.equal(counts['no-prize'], undefined);
  for (const o of RULES.outcomes.filter(o => o.multiplierBps)) assert.equal(counts[o.id], o.weight);
  const invalid = { ...RULES, outcomes: RULES.outcomes.map(o => ({ ...o, weight: o.multiplierBps === 0 ? 10000 : 0 })) };
  assert.throws(() => protectionPlan(units(5000), units(10000), 0n, invalid), e => e.code === 'PROTECTION_CONFIG');
});

test('5000 loss at 0.5x then stake 500 needs 10x; 5x leaves a 525 token shortfall', async t => {
  const db = await fixture(t), firstRound = await lose(db);
  assert.equal(firstRound.balance, '7500'); assert.equal(firstRound.round.protection.pendingAfter, '2500');
  assert.equal((await getState(db, 'alice', enabled)).protection.sourceRound, firstRound.round.id);
  const five = settlement(units(500), pick('fivefold')(RULES));
  assert.equal(units(2500) - (five.net - units(500)), units(525));
  const next = await play(db, 'alice', key(), '500', { ...enabled, outcomeFactory: () => { throw Error('Recovery must not draw again'); } });
  assert.equal(next.round.multiplierBps, 100000); assert.equal(next.round.net, '4975');
  assert.equal(next.balance, '11975'); assert.equal(next.round.protection.recovered, '2500');
  assert.equal(next.round.protection.sourceRound, firstRound.round.id);
  assert.equal((await getState(db, 'alice', enabled)).protection.pendingLoss, '0');
  assert.deepEqual((await history(db, 'alice'))[0].protection, next.round.protection);
  assert.equal((await audit(db)).ok, true);
});

test('new stake determines the smallest available multiplier, and recovery caps once at 10x', async t => {
  for (const [stake, expected] of [['500', 100000], ['1000', 50000], ['2000', 30000], ['3000', 20000], ['6000', 15000]]) {
    assert.equal(recoveryOutcome(units(stake), units(2500)).score * 50, expected);
  }
  const db = await fixture(t, '100000', '20000000'); await lose(db, 'alice', '50000');
  const next = await play(db, 'alice', key(), '500', enabled);
  assert.equal(next.round.protection.capped, true); assert.equal(next.round.protection.shortfall, '20525');
  assert.equal((await getState(db, 'alice', enabled)).protection.pendingLoss, '0');
  const later = await play(db, 'alice', key(), '500', { ...enabled, outcomeFactory: pick('no-prize') });
  assert.equal(later.round.protection.mode, 'standard'); assert.equal(later.round.multiplierBps, 0);
  assert.equal((await audit(db)).ok, true);
});

test('small stakes and disabled protection retain original zero outcome and never create recovery', async t => {
  const db = await fixture(t);
  const small = await play(db, 'alice', key(), '4999', { ...enabled, outcomeFactory: pick('half') });
  assert.equal(small.round.protection.pendingAfter, '0');
  const off = await play(db, 'alice', key(), '4000', { minimumInterval: 0, outcomeFactory: pick('no-prize') });
  assert.equal(off.round.multiplierBps, 0); assert.equal(off.round.protection, undefined);
  assert.equal(off.round.version, RULES.version);
  assert.equal((await getState(db, 'alice', enabled)).protection.pendingLoss, '0');
});

test('idempotent requests and simultaneous distinct spins consume a recovery exactly once', async t => {
  const db = await fixture(t), k = key();
  const originals = await Promise.all([1, 2].map(() => play(db, 'alice', k, '5000', { ...enabled, outcomeFactory: pick('half') })));
  assert.deepEqual(...originals);
  const options = { ...enabled, outcomeFactory: pick('break-even') };
  const results = await Promise.all([play(db, 'alice', key(), '500', options), play(db, 'alice', key(), '500', options)]);
  assert.equal(results.filter(r => r.round.protection.mode === 'recovery').length, 1);
  assert.equal(results.filter(r => r.round.multiplierBps === 100000).length, 1);
  assert.equal((await getState(db, 'alice', enabled)).balance, '11975');
  assert.equal((await first(db, 'SELECT COUNT(*) n FROM rounds')).n, 3);
  assert.equal((await getState(db, 'alice', enabled)).protection.used, 1);
  assert.equal((await audit(db)).ok, true);
});

test('failed debit, rejected stake and unavailable pool cannot consume pending recovery', async t => {
  const db = await fixture(t); await lose(db); const before = await getState(db, 'alice', enabled);
  await assert.rejects(play(db, 'alice', key(), '499', enabled));
  await assert.rejects(play(db, 'alice', key(), '10000', enabled));
  const bad = { ...db, batch: statements => db.batch([...statements, stmt(db, 'INSERT INTO cas_guards(id,ok) VALUES (?,0)', key())]) };
  await assert.rejects(play(bad, 'alice', key(), '500', enabled), e => e.code === 'RETRY_OPERATION');
  assert.deepEqual(await getState(db, 'alice', enabled), before);
  await stmt(db, "UPDATE treasuries SET available='0' WHERE asset='demo'").run();
  await assert.rejects(play(db, 'alice', key(), '500', enabled), /奖池/);
  assert.equal((await getState(db, 'alice', enabled)).protection.pendingLoss, '2500');
});

test('recovery persists on reopen, remains wallet-scoped and survives a disabled interval', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sheep-protection-')), file = join(dir, 'game.sqlite');
  let db = openDatabase(file); t.after(() => { db.close(); rmSync(dir, { recursive: true }); });
  await seed(db, 'alice'); await lose(db); db.close(); db = openDatabase(file);
  await seed(db, 'bob');
  assert.equal((await getState(db, 'bob', enabled)).protection.pendingLoss, '0');
  await play(db, 'alice', key(), '500', { minimumInterval: 0, outcomeFactory: pick('break-even') });
  assert.equal((await getState(db, 'alice', enabled)).protection.pendingLoss, '2500');
  assert.equal((await play(db, 'alice', key(), '500', enabled)).round.protection.mode, 'recovery');
  assert.equal((await audit(db)).ok, true);
});

test('server flag controls API rule version; client cannot activate or invent a compensation', async t => {
  const db = openDatabase(); t.after(() => db.close());
  const env = { DB: db, LIVE_PAYMENTS_ENABLED: 'false' }, origin = 'https://game.example';
  const request = (path, data, cookie) => new Request(origin + '/api' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Game-Request': '1', 'Idempotency-Key': key(), ...(cookie ? { Cookie: cookie } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const login = await worker.fetch(request('/auth/demo', {}), env), cookie = login.headers.get('set-cookie').split(';')[0];
  const forged = await worker.fetch(request('/play', { amount: '500', rulesVersion: RULES.version, protectionEnabled: true, pendingLoss: '999999', multiplierBps: 100000 }, cookie), env);
  assert.equal(forged.status, 200); assert.equal((await forged.json()).round.protection, undefined);
  const on = { ...env, BET_PROTECTION_ENABLED: 'true' }, config = await (await worker.fetch(request('/config'), on)).json();
  assert.equal(config.rules.version, protectionRules().version + ':high-stake-recovery-v2');
  assert.equal(config.rules.netRtp, null); assert.equal(config.rules.baseNetRtp, '77.0000%');
  const stale = await worker.fetch(request('/play', { amount: '500', rulesVersion: RULES.version }, cookie), on);
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'RULES_CHANGED');
});

test('wallet has three lifetime compensations; fourth qualifying half earns no recovery but retains no-zero protection', async t => {
  const db = await fixture(t);
  for (let used = 0; used < 3; used++) {
    await seed(db, 'alice');
    const half = await lose(db);
    assert.equal(half.round.protection.pendingAfter, '2500');
    assert.equal(half.round.protection.usedAfter, used);
    const nextKey = key();
    const next = await play(db, 'alice', nextKey, '500', enabled);
    assert.equal(next.round.protection.usedAfter, used + 1);
    assert.equal(next.round.protection.remaining, 2 - used);
    assert.deepEqual(await play(db, 'alice', nextKey, '500', enabled), next);
  }
  await seed(db, 'alice');
  const fourth = await lose(db);
  assert.equal(fourth.round.multiplierBps, 5000);
  assert.equal(fourth.round.protection.pendingAfter, '0');
  assert.equal(fourth.round.protection.usedAfter, 3);
  assert.equal(fourth.round.protection.drawWeights.find(o => o.id === 'no-prize').weight, 0);
  const later = await play(db, 'alice', key(), '500', { ...enabled, outcomeFactory: pick('no-prize') });
  assert.equal(later.round.protection.mode, 'standard');
  assert.equal(later.round.multiplierBps, 0);
  assert.equal((await getState(db, 'alice', enabled)).protection.remaining, 0);
  await seed(db, 'bob');
  assert.equal((await getState(db, 'bob', enabled)).protection.used, 0);
  assert.equal((await audit(db)).ok, true);
});

test('two concurrent requests on the last remaining compensation settle and count it once', async t => {
  const db = await fixture(t);
  for (let i = 0; i < 2; i++) { await seed(db, 'alice'); await lose(db); await play(db, 'alice', key(), '500', enabled); }
  await seed(db, 'alice'); await lose(db);
  const results = await Promise.all([1, 2].map(() => play(db, 'alice', key(), '500', { ...enabled, outcomeFactory: pick('break-even') })));
  assert.equal(results.filter(r => r.round.protection.mode === 'recovery').length, 1);
  assert.equal((await getState(db, 'alice', enabled)).protection.used, 3);
  assert.equal((await audit(db)).ok, true);
});

test('compensation count persists across restart, topup and flag toggling; failed and capped settlements count correctly', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sheep-recovery-quota-')), file = join(dir, 'game.sqlite');
  let db = openDatabase(file); t.after(() => { db.close(); rmSync(dir, { recursive: true }); });
  await seed(db, 'alice', '100000', '20000000'); await lose(db, 'alice', '50000');
  await assert.rejects(play(db, 'alice', key(), '499', enabled));
  assert.equal((await getState(db, 'alice', enabled)).protection.used, 0);
  const capped = await play(db, 'alice', key(), '500', enabled);
  assert.equal(capped.round.protection.capped, true);
  assert.equal(capped.round.protection.usedAfter, 1);
  db.close(); db = openDatabase(file);
  await ensureDemo(db, 'alice');
  await demoTopup(db, 'alice', key(), '10000');
  await play(db, 'alice', key(), '500', { minimumInterval: 0, outcomeFactory: pick('half') });
  const state = await getState(db, 'alice', enabled);
  assert.equal(state.protection.used, 1); assert.equal(state.protection.remaining, 2);
  assert.equal(state.protection.pendingLoss, '0');
  assert.equal((await audit(db)).ok, true);
});

test('migrations add zeroed recovery fields without changing existing balances or the ledger', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sheep-recovery-migration-')), migrations = join(dir, 'migrations'), file = join(dir, 'game.sqlite');
  mkdirSync(migrations);
  for (const name of readdirSync(new URL('../drizzle/', import.meta.url)).filter(n => /^000[0-7]_.*\.sql$/.test(n))) {
    copyFileSync(new URL('../drizzle/' + name, import.meta.url), join(migrations, name));
  }
  let db = openDatabase(file, pathToFileURL(migrations + '/'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true }); });
  await seed(db, 'alice');
  const old = await first(db, 'SELECT * FROM accounts WHERE id=?', 'alice');
  assert.equal(old.recovery_used, undefined);
  db.close(); db = openDatabase(file);
  const { recovery_loss, recovery_round, recovery_used, ...unchanged } = await first(db, 'SELECT * FROM accounts WHERE id=?', 'alice');
  assert.deepEqual(unchanged, old);
  assert.equal(recovery_loss, '0'); assert.equal(recovery_round, null); assert.equal(recovery_used, 0);
  assert.equal((await audit(db)).ok, true);
});
