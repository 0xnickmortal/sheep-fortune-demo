import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Wallet } from 'ethers';
import { parseAmount } from '../server/rules.js';

const origin = new URL(process.argv[2] || 'http://localhost:4391').origin;
async function request(path, { body, cookie, key, headers = {} } = {}) {
  const response = await fetch(origin + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json', 'X-Game-Request': '1' }), ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000),
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
const health = await request('/health');
assert.equal(health.status, 200); assert.equal(health.data.ok, true);
// This smoke test only creates unfunded wallets and nonwithdrawable demo coins.
assert.equal(health.data.paymentsEnabled, false, 'Use an environment with live payments disabled');
const config = await request('/config'); assert.equal(config.status, 200);
assert.equal((await request('/account')).status, 401);
const demo = await request('/auth/demo', { body: {} }); assert.equal(demo.status, 200);
const cookie = demo.cookie; assert.ok(cookie);
const key = crypto.randomUUID(), body = { amount: '500', rulesVersion: config.data.rules.version };
const first = await request('/play', { body, cookie, key }); assert.equal(first.status, 200, JSON.stringify(first.data));
const retry = await request('/play', { body, cookie, key }); assert.equal(retry.status, 200); assert.deepEqual(retry.data, first.data);
const after = await request('/account', { cookie }); assert.equal(after.status, 200);
assert.equal(parseAmount(after.data.balance), parseAmount(demo.data.balance) - parseAmount('500') + BigInt(first.data.round.net === '0' ? '0' : parseAmount(first.data.round.net)));
assert.equal(after.data.rewards, '0'); assert.equal(after.data.ingots, first.data.ingots);
const rounds = await request('/rounds', { cookie }); assert.equal(rounds.data.rounds.length, 1);
const csrf = await request('/play', { cookie, key: crypto.randomUUID(), body, headers: { Origin: 'https://wrong.example' } }); assert.equal(csrf.status, 403);
assert.equal((await request('/admin/audit')).status, 403);
const wallet = Wallet.createRandom();
const challenge = await request('/auth/challenge', { body: { address: wallet.address } }); assert.equal(challenge.status, 200);
const loginBody = { challengeId: challenge.data.challengeId, signature: await wallet.signMessage(challenge.data.message) };
const walletLogin = await request('/auth/verify', { body: loginBody }); assert.equal(walletLogin.status, 200, JSON.stringify(walletLogin.data));
assert.equal(walletLogin.data.wallet, wallet.address.toLowerCase()); assert.equal(walletLogin.data.balance, '0');
assert.equal((await request('/auth/verify', { body: loginBody })).status, 401);
const referral = await request('/referrals', { cookie: walletLogin.cookie }); assert.equal(referral.status, 200); assert.equal(referral.data.supported, true); assert.equal(referral.data.eligible, false);
const activation = await request('/referrals/activate', { cookie: walletLogin.cookie, key: crypto.randomUUID(), body: {} }); assert.equal(activation.status, 409); assert.equal(activation.data.code, 'PLAY_REQUIRED');
const closed = await request('/play', { cookie: walletLogin.cookie, key: crypto.randomUUID(), body }); assert.equal(closed.status, 503); assert.equal(closed.data.code, 'PAYMENTS_CLOSED');
let audit;
if (process.env.OPS_KEY_FILE) {
  const secret = (await readFile(process.env.OPS_KEY_FILE, 'utf8')).trim();
  const report = await request('/admin/audit', { headers: { Authorization: 'Bearer ' + secret } });
  assert.equal(report.status, 200); assert.equal(report.data.ok, true, JSON.stringify(report.data.mismatches));
  audit = { ok: report.data.ok, transfers: report.data.transfers };
}
console.log(JSON.stringify({ ok: true, origin, rulesVersion: health.data.rulesVersion, checks: ['D1 health', 'server demo settlement', 'idempotent replay', 'immediate balance and ingots', 'saved round', 'session isolation', 'CSRF rejection', 'admin authentication', 'signed wallet login', 'signature replay rejection', 'referral eligibility', 'live payment gate'], ...(audit ? { audit } : {}) }, null, 2));
