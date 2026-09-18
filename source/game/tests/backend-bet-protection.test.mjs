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

test('stakes below 50% retain base probabilities, while the first-five window still expires', () => {
  for (const completed of [0, 4]) {
    const p = protectionPlan(units(500), units(10000), 0n, RULES, 0, completed);
    assert.equal(p.mode, 'intro'); assert.deepEqual(p.drawRules.outcomes, RULES.outcomes);
  }
  assert.equal(protectionPlan(units(500), units(10000), 0n, RULES, 0, 5).mode, 'standard');
  assert.throws(() => protectionPlan(units(500), units(10000), 0n, RULES, 0, -1), /异常/);
});

test('50% threshold is exact, removes only zero and persists after the fifth round', () => {
  assert.equal(isHighStake(units(5000), units(10000)), true);
  assert.equal(isHighStake(units(5000), units(10000) + 1n), false);
  for (const completed of [0, 4, 5, 100]) {
    const p = protectionPlan(units(5000), units(10000), 0n, RULES, 0, completed);
    assert.equal(p.highStake, true); assert.equal(p.drawRules.weightTotal, 7200);
    assert.equal(p.mode, completed < 5 ? 'intro' : 'high-stake');
    const counts = {};
    for (let ticket = 0; ticket < 7200; ticket++) { const id = drawWheel(() => BigInt(ticket), p.drawRules).outcomeId; counts[id] = (counts[id] || 0) + 1; }
    assert.equal(counts['no-prize'], undefined);
    for (const o of RULES.outcomes.filter(o => o.multiplierBps > 0)) assert.equal(counts[o.id], o.weight);
  }
  const invalid = { ...RULES, outcomes: RULES.outcomes.map(o => ({ ...o, weight: o.multiplierBps === 0 ? 10000 : 0 })) };
  assert.throws(() => protectionPlan(units(5000), units(10000), 0n, invalid), e => e.code === 'PROTECTION_CONFIG');
});

test('500 at zero or half then 5000 at 1.2x covers the loss after fees and adds a small profit', async t => {
  for (const [outcome, loss, expected] of [['no-prize', '500', '10250'], ['half', '250', '10500']]) {
    const db = await fixture(t);
    const lost = await play(db, 'alice', key(), '500', { ...enabled, outcomeFactory: pick(outcome) });
    assert.equal(lost.round.protection.pendingAfter, loss);
    const next = await play(db, 'alice', key(), '5000', { ...enabled, outcomeFactory: () => { throw Error('Published recovery must not draw randomly'); } });
    assert.equal(next.round.multiplierBps, 12000); assert.equal(next.round.net, '5750'); assert.equal(next.round.fee, '250');
    assert.equal(next.balance, expected); assert.equal(next.round.protection.recovered, loss);
    assert.equal(next.round.protection.sourceRound, lost.round.id);
    assert.deepEqual((await history(db, 'alice')).find(r => r.id === next.round.id).protection, next.round.protection);
    assert.equal((await audit(db)).ok, true);
  }
});

test('each freely selected next stake uses closest net profit, allows differences and clears once', async t => {
  for (const [stake, multiplier, profit, shortfall] of [['500', 20000, '475', '25'], ['1000', 15000, '450', '50'], ['2000', 12000, '300', '200'], ['5000', 12000, '750', '0']]) {
    const db = await fixture(t);
    await play(db, 'alice', key(), '500', { ...enabled, outcomeFactory: pick('no-prize') });
    const next = await play(db, 'alice', key(), stake, enabled);
    assert.equal(next.round.multiplierBps, multiplier); assert.equal(next.round.profit, profit);
    assert.equal(next.round.protection.shortfall, shortfall); assert.equal(next.round.protection.differenceCarried, false);
    assert.equal((await getState(db, 'alice', enabled)).protection.pendingLoss, '0');
    assert.equal((await audit(db)).ok, true);
  }
});

test('closest multiplier uses exact net units and lower multiplier on ties, with a 10x ceiling', async t => {
  // At stake 1000, 1.2x nets +150 and 1.5x nets +450: loss 300 is a tie.
  assert.equal(recoveryOutcome(units(1000), units(300)).score * 50, 12000);
  assert.equal(recoveryOutcome(units(1000), units(300) + 1n).score * 50, 15000);
  const db = await fixture(t, '20000');
  await play(db, 'alice', key(), '5000', { ...enabled, outcomeFactory: pick('no-prize') });
  const next = await play(db, 'alice', key(), '500', enabled);
  assert.equal(next.round.multiplierBps, 100000); assert.equal(next.round.net, '4975'); assert.equal(next.round.fee, '25');
  assert.equal(next.balance, '19475'); assert.equal(next.round.protection.recovered, '4475'); assert.equal(next.round.protection.shortfall, '525');
  assert.equal((await getState(db, 'alice', enabled)).protection.pendingLoss, '0'); assert.equal((await audit(db)).ok, true);
});

test('round 5 loss is recovered on round 6; a small round 7 bet has no new recovery or zero exclusion', async t => {
  const db = await fixture(t);
  for (let i = 0; i < 4; i++) await play(db, 'alice', key(), '500', { ...enabled, outcomeFactory: pick('break-even') });
  const fifth = await play(db, 'alice', key(), '500', { ...enabled, outcomeFactory: pick('no-prize') });
  assert.equal(fifth.round.protection.roundNumber, 5); assert.equal(fifth.round.protection.pendingAfter, '500');
  const sixth = await play(db, 'alice', key(), '5000', enabled);
  assert.equal(sixth.round.protection.roundNumber, 6); assert.equal(sixth.round.protection.mode, 'recovery');
  const seventh = await play(db, 'alice', key(), '500', { ...enabled, outcomeFactory: pick('no-prize') });
  assert.equal(seventh.round.protection.mode, 'standard'); assert.equal(seventh.round.multiplierBps, 0); assert.equal(seventh.round.protection.pendingAfter, '0');
  const state = (await getState(db, 'alice', enabled)).protection;
  assert.equal(state.completedRounds, 7); assert.equal(state.remainingQualifyingRounds, 0); assert.equal(state.used, 1);
  assert.equal((await audit(db)).ok, true);
});

test('round 6 still excludes zero for a large bet but a half outcome does not create new compensation', async t => {
  const db = await fixture(t);
  for (let i = 0; i < 5; i++) await play(db, 'alice', key(), '500', { ...enabled, outcomeFactory: pick('break-even') });
  await assert.rejects(play(db, 'alice', key(), '5000', { ...enabled, outcomeFactory: pick('no-prize') }), e => e.code === 'INVALID_PROTECTED_OUTCOME');
  const sixth = await play(db, 'alice', key(), '5000', { ...enabled, outcomeFactory: pick('half') });
  assert.equal(sixth.round.protection.mode, 'high-stake'); assert.equal(sixth.round.multiplierBps, 5000); assert.equal(sixth.round.protection.pendingAfter, '0');
  assert.equal((await getState(db, 'alice', enabled)).protection.nextRoundIsRecovery, false);
});

test('idempotency and simultaneous distinct spins consume compensation and increment rounds once', async t => {
  const db = await fixture(t), k = key();
  const originals = await Promise.all([1, 2].map(() => play(db, 'alice', k, '500', { ...enabled, outcomeFactory: pick('no-prize') })));
  assert.deepEqual(...originals);
  const results = await Promise.all([1, 2].map(() => play(db, 'alice', key(), '5000', { ...enabled, outcomeFactory: pick('break-even') })));
  assert.equal(results.filter(r => r.round.protection.mode === 'recovery').length, 1);
  assert.deepEqual(results.map(r => r.round.protection.roundNumber).sort(), [2, 3]);
  const state = await getState(db, 'alice', enabled);
  assert.equal(state.balance, '10250'); assert.equal(state.protection.completedRounds, 3); assert.equal(state.protection.used, 1);
  assert.equal((await audit(db)).ok, true);
});

test('concurrent boundary requests cannot earn a second entitlement after round 5', async t => {
  const db = await fixture(t);
  for (let i = 0; i < 4; i++) await play(db, 'alice', key(), '500', { ...enabled, outcomeFactory: pick('break-even') });
  const results = await Promise.all([1, 2].map(() => play(db, 'alice', key(), '500', { ...enabled, outcomeFactory: pick('half') })));
  assert.deepEqual(results.map(r => r.round.protection.mode).sort(), ['intro', 'recovery']);
  assert.deepEqual(results.map(r => r.round.protection.roundNumber).sort(), [5, 6]);
  const next = await play(db, 'alice', key(), '500', { ...enabled, outcomeFactory: pick('half') });
  assert.equal(next.round.protection.pendingAfter, '0'); assert.equal((await audit(db)).ok, true);
});

test('rejected stakes, balance shortage, failed debit and unavailable pool do not consume entitlement or round', async t => {
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

test('round count and entitlement survive topup, restart and disabled interval; another wallet starts separately', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sheep-intro-')), file = join(dir, 'game.sqlite');
  let db = openDatabase(file); t.after(() => { db.close(); rmSync(dir, { recursive: true }); });
  await seed(db, 'alice'); await lose(db); db.close(); db = openDatabase(file);
  await seed(db, 'bob'); await demoTopup(db, 'alice', key(), '10000');
  await play(db, 'alice', key(), '500', { minimumInterval: 0, outcomeFactory: pick('break-even') });
  const a = (await getState(db, 'alice', enabled)).protection, b = (await getState(db, 'bob', enabled)).protection;
  assert.equal(a.pendingLoss, '2500'); assert.equal(a.completedRounds, 2); assert.equal(b.completedRounds, 0);
  assert.equal((await play(db, 'alice', key(), '500', enabled)).round.protection.mode, 'recovery');
  assert.equal((await audit(db)).ok, true);
});

test('older accounts do not get five new rounds on upgrade; existing legacy entitlement remains payable', async t => {
  const db = await fixture(t);
  for (let i = 0; i < 8; i++) await play(db, 'alice', key(), '500', { minimumInterval: 0, outcomeFactory: pick('break-even') });
  assert.equal((await getState(db, 'alice', enabled)).protection.remainingQualifyingRounds, 0);
  await stmt(db, 'UPDATE accounts SET recovery_loss=?,recovery_used=3 WHERE id=?', String(units(500)), 'alice').run();
  const next = await play(db, 'alice', key(), '5000', enabled);
  assert.equal(next.round.protection.mode, 'recovery'); assert.equal(next.round.protection.usedAfter, 4);
});

test('server rule version and flag control the policy; client cannot forge entitlement or round count', async t => {
  const db = openDatabase(); t.after(() => db.close());
  const env = { DB: db, LIVE_PAYMENTS_ENABLED: 'false' }, origin = 'https://game.example';
  const request = (path, data, cookie) => new Request(origin + '/api' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Game-Request': '1', 'Idempotency-Key': key(), ...(cookie ? { Cookie: cookie } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const login = await worker.fetch(request('/auth/demo', {}), env), cookie = login.headers.get('set-cookie').split(';')[0];
  const forged = await worker.fetch(request('/play', { amount: '500', rulesVersion: RULES.version, protectionEnabled: true, completedRounds: 0, pendingLoss: '999999' }, cookie), env);
  assert.equal(forged.status, 200); assert.equal((await forged.json()).round.protection, undefined);
  const on = { ...env, BET_PROTECTION_ENABLED: 'true' }, config = await (await worker.fetch(request('/config'), on)).json();
  assert.equal(config.rules.version, protectionRules(RULES, true).version);
  assert.equal(config.rules.netRtp, null); assert.equal(config.rules.baseNetRtp, '77.0000%'); assert.equal(config.rules.protection.lossCapGuaranteed, false);
  const stale = await worker.fetch(request('/play', { amount: '500', rulesVersion: RULES.version }, cookie), on);
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'RULES_CHANGED');
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
