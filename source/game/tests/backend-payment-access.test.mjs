import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'ethers';
import { vaultHarness, key } from './vault-harness.mjs';
import { tokenAsset } from '../server/auth.js';
import { first } from '../server/db.js';
import { saveWhitelist } from '../server/whitelist.js';
import { syncPayments } from '../server/payment-monitor.js';
import { validationWallets } from '../server/admin-auth.js';
import { RULES } from '../server/rules.js';
import worker, { audit } from '../server/worker.js';

test('public launch lets an ordinary wallet deposit, play with protection and withdraw without granting admin rights', async t => {
  const h = await vaultHarness(); t.after(h.cleanup);
  const { db, env, users, token, vault, mine } = h, [admin, member, outsider] = users;
  const live = { ...env, ADMIN_WALLET: admin.address, LIVE_PAYMENTS_ENABLED: 'true', PAYMENTS_VALIDATION_ENABLED: 'false', PAYMENTS_VALIDATION_WALLETS: JSON.stringify([member.address]), BET_PROTECTION_ENABLED: 'true' };
  const call = (user, path, data) => worker.fetch(new Request('http://127.0.0.1:4382/api' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { ...(user ? { Cookie: user.cookie.split(';')[0] } : {}), Origin: 'http://127.0.0.1:4382', 'X-Game-Request': '1', 'Content-Type': 'application/json', 'Idempotency-Key': key() },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), live);
  const ok = async response => { const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body; };
  assert.equal(await first(db, 'SELECT * FROM wallet_policies WHERE asset=? AND wallet=?', tokenAsset(env), outsider.address), null);
  assert.equal((await ok(await call(null, '/config'))).payments.enabled, true);
  const initial = await ok(await call(outsider, '/account'));
  assert.equal(initial.payments.enabled, true); assert.equal(initial.admin, false);
  assert.equal(initial.benefits.whitelisted, false); assert.equal(initial.benefits.withdrawalFeeExempt, false);
  assert.deepEqual(initial.rules.outcomes.map(o => o.weight), RULES.outcomes.map(o => o.weight));
  assert.equal(initial.protection.qualifyingRounds, 5);
  assert.equal((await call(outsider, '/admin/session')).status, 403);
  assert.equal((await call(outsider, '/admin/whitelist', {})).status, 403);
  assert.equal((await call(null, '/deposits/prepare', { amount: '500' })).status, 401);

  const prepared = await ok(await call(outsider, '/deposits/prepare', { amount: '500' }));
  if (prepared.needsApproval) await (await outsider.signer.sendTransaction(prepared.approval)).wait();
  const deposit = await outsider.signer.sendTransaction(prepared.transaction); await deposit.wait();
  await ok(await call(outsider, '/deposits/track', { txHash: deposit.hash }));
  await mine(); await syncPayments(db, live);
  const funded = await ok(await call(outsider, '/account'));
  assert.equal(funded.balance, '10500'); assert.equal(funded.protection.completedRounds, 0);
  const spin = await ok(await call(outsider, '/play', { amount: '5500', rulesVersion: funded.rules.version }));
  assert.equal(spin.round.protection.mode, 'intro'); assert.equal(spin.round.protection.highStake, true); assert.notEqual(spin.round.multiplierBps, 0);
  assert.equal(parseEther(spin.balance), parseEther('5000') + parseEther(spin.round.net));

  const walletBefore = await token.balanceOf(outsider.address);
  const quote = await ok(await call(outsider, '/withdrawals/quote', { amount: '100' }));
  const withdrawal = await ok(await call(outsider, '/withdrawals', { amount: '100', feeVersion: quote.feeVersion }));
  assert.equal(withdrawal.feeExempt, false);
  const authorization = await ok(await call(outsider, '/withdrawals/' + withdrawal.id + '/authorization'));
  assert.equal((await call(member, '/withdrawals/' + withdrawal.id + '/authorization')).status, 404);
  await (await outsider.signer.sendTransaction(authorization.transaction)).wait(); await mine();
  await syncPayments(db, live);
  assert.equal((await first(db, 'SELECT status FROM withdrawals WHERE id=?', withdrawal.id)).status, 'confirmed');
  assert.equal(await token.balanceOf(outsider.address), walletBefore + parseEther(quote.payout));
  const after = await ok(await call(outsider, '/account'));
  assert.equal(after.locked, '0'); assert.equal(parseEther(after.balance), parseEther(spin.balance) - parseEther('100'));
  assert.equal(after.protection.pendingLoss, spin.round.protection.pendingAfter);
  assert.equal(after.protection.used, 0); assert.equal(after.protection.completedRounds, 1);
  assert.equal((await audit(db)).ok, true);
});

test('limited wallet cohort can deposit, play and withdraw while public access stays closed', async t => {
  const h = await vaultHarness(); t.after(h.cleanup);
  const { db, env, users, token, vault, mine } = h, [admin, member, outsider] = users;
  const acceptance = { ...env, ADMIN_WALLET: admin.address, LIVE_PAYMENTS_ENABLED: 'false', PAYMENTS_VALIDATION_ENABLED: 'true', PAYMENTS_VALIDATION_WALLETS: JSON.stringify([member.address, member.address]) };
  const weights = RULES.outcomes.map(outcome => outcome.weight);
  for (const user of [member, outsider]) await saveWhitelist(db, tokenAsset(env), key(), { address: user.address, weights, enabled: true, revision: 0 });
  const request = (user, path, data) => new Request('http://127.0.0.1:4382/api' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { ...(user ? { Cookie: user.cookie.split(';')[0] } : {}), Origin: 'http://127.0.0.1:4382', 'X-Game-Request': '1', 'Content-Type': 'application/json', 'Idempotency-Key': key() },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const call = (user, path, data, config = acceptance) => worker.fetch(request(user, path, data), config);
  const ok = async response => { const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body; };
  const account = (user, config = acceptance) => call(user, '/account', undefined, config).then(ok);

  await t.test('access is private, asset-scoped and separate from admin and whitelist benefits', async () => {
    assert.equal((await ok(await call(null, '/config'))).payments.enabled, false);
    assert.equal((await ok(await call(null, '/health'))).paymentsEnabled, false);
    const state = await account(member);
    assert.equal(state.payments.enabled, true); assert.equal(state.admin, false);
    assert.equal(state.benefits.withdrawalFeeExempt, true);
    assert.deepEqual(state.rules.outcomes.map(o => o.weight), weights);
    assert.equal((await account(admin)).payments.enabled, true);
    assert.equal((await account(outsider)).payments.enabled, false);
    assert.equal((await account(outsider)).benefits.whitelisted, true);
    assert.equal((await call(member, '/admin/session')).status, 403);
    assert.equal((await call(member, '/admin/whitelist', {})).status, 403);
    assert.deepEqual((await ok(await call(admin, '/admin/session'))).validationWallets, [member.address]);
    assert.equal((await account(member, { ...acceptance, TOKEN_ADDRESS: outsider.address })).payments.enabled, false);
    assert.equal((await account(member, { ...acceptance, VAULT_SIGNER_PRIVATE_KEY: '' })).payments.enabled, false);
  });

  await t.test('unlisted or unsigned users cannot prepare deposits, play or request withdrawals', async () => {
    const before = await account(outsider);
    for (const [path, data] of [
      ['/deposits/prepare', { amount: '50', address: member.address }],
      ['/deposits/track', { txHash: member.depositHash }],
      ['/deposits', { txHash: member.depositHash }],
      ['/play', { amount: '500', rulesVersion: before.rules.version, wallet: member.address }],
      ['/withdrawals/quote', { amount: '100' }],
      ['/withdrawals', { amount: '100', feeVersion: before.withdrawalFee.version }],
    ]) {
      assert.equal((await call(outsider, path, data)).status, 503, path);
      assert.equal((await call(null, path, data)).status, 401, path);
    }
    const spoof = request(outsider, '/deposits/prepare', { amount: '50' });
    spoof.headers.set('X-Game-Wallet', member.address);
    assert.equal((await worker.fetch(spoof, acceptance)).status, 409);
    assert.equal((await account(outsider)).balance, before.balance);
  });

  await t.test('missing or invalid cohort configuration fails closed, and disabled policies lose access', async () => {
    for (const value of ['', '{}', 'not json', JSON.stringify([member.address, 'invalid']), JSON.stringify(['0x' + '0'.repeat(40)])]) {
      assert.deepEqual(validationWallets({ PAYMENTS_VALIDATION_WALLETS: value }), []);
      assert.equal((await account(member, { ...acceptance, PAYMENTS_VALIDATION_WALLETS: value })).payments.enabled, false);
    }
    assert.equal((await account(member, { ...acceptance, PAYMENTS_VALIDATION_ENABLED: 'false' })).payments.enabled, false);
    await saveWhitelist(db, tokenAsset(env), key(), { address: member.address, weights, enabled: false, revision: 1 });
    assert.equal((await account(member)).payments.enabled, false);
    assert.equal((await call(member, '/deposits/prepare', { amount: '50' })).status, 503);
    await saveWhitelist(db, tokenAsset(env), key(), { address: member.address, weights, enabled: true, revision: 2 });
    assert.equal((await account(member)).payments.enabled, true);
  });

  await t.test('a cohort deposit is confirmed once by the background monitor', async () => {
    const v = await vault.getAddress();
    await (await token.connect(member.signer).approve(v, parseEther('50'))).wait();
    assert.equal((await ok(await call(member, '/deposits/prepare', { amount: '50' }))).needsApproval, false);
    const tx = await vault.connect(member.signer).deposit(parseEther('50')); await tx.wait();
    assert.equal((await ok(await call(member, '/deposits/track', { txHash: tx.hash }))).status, 'pending');
    await mine(); assert.equal((await syncPayments(db, acceptance)).deposits, 1);
    assert.equal((await account(member)).balance, '10050');
    await ok(await call(member, '/deposits/track', { txHash: tx.hash })); await syncPayments(db, acceptance);
    assert.equal((await account(member)).balance, '10050');
  });

  await t.test('one spin debits the stake and credits its result immediately without changing rules', async () => {
    const before = await account(member);
    const result = await ok(await call(member, '/play', { amount: '500', rulesVersion: before.rules.version }));
    assert.equal(parseEther(result.balance), parseEther(before.balance) - parseEther('500') + parseEther(result.round.net));
    const after = await account(member);
    assert.equal(after.balance, result.balance); assert.equal(after.rewards, '0');
    assert.equal(after.rules.version, before.rules.version);
    assert.deepEqual(after.rules.outcomes.map(o => o.weight), weights);
  });

  await t.test('cohort withdrawal keeps its fee exemption, pays through the vault and reconciles automatically', async () => {
    const before = await account(member), walletBefore = await token.balanceOf(member.address);
    const quote = await ok(await call(member, '/withdrawals/quote', { amount: '100' }));
    assert.equal(quote.fee, '0'); assert.equal(quote.payout, '100');
    const withdrawal = await ok(await call(member, '/withdrawals', { amount: '100', feeVersion: quote.feeVersion }));
    const auth = await ok(await call(member, '/withdrawals/' + withdrawal.id + '/authorization'));
    await (await member.signer.sendTransaction(auth.transaction)).wait(); await mine();
    assert.equal((await syncPayments(db, acceptance)).withdrawals, 1);
    assert.equal((await first(db, 'SELECT status FROM withdrawals WHERE id=?', withdrawal.id)).status, 'confirmed');
    assert.equal(await token.balanceOf(member.address), walletBefore + parseEther('100'));
    const after = await account(member);
    assert.equal(after.locked, '0'); assert.equal(parseEther(after.balance), parseEther(before.balance) - parseEther('100'));
    await syncPayments(db, acceptance); assert.equal((await account(member)).balance, after.balance);
    assert.equal((await audit(db)).ok, true);
    assert.equal(acceptance.LIVE_PAYMENTS_ENABLED, 'false');
    assert.equal((await account(outsider)).payments.enabled, false);
  });
});
