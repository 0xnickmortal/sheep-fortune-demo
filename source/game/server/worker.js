import { withdrawalView } from './withdrawal-fee.js';
import { GameError, RULES, formatAmount } from './rules.js';
import { first, all, hash } from './db.js';
import { demoLogin, challenge, walletLogin, requireOwner, tokenAsset } from './auth.js';
import { listWhitelist, saveWhitelist } from './whitelist.js';
import { referralSummary, resolveReferral, bindReferral, activateReferral, REFERRAL_RULES } from './referrals.js';
import { prepareVaultDeposit, getVaultAuthorization, prepareBurn, finishBurn } from './vault-payments.js';
import { getState, play, claim, history, ingotState, demoTopup } from './game.js';
import { paymentConfig, creditDeposit, quoteWithdrawal, requestWithdrawal, paymentHistory, fundTreasury, attachSignedWithdrawal, broadcastWithdrawal, finishWithdrawal, rejectWithdrawal } from './payments.js';

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...extra,
  }});
}
async function body(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new GameError('请求格式不正确', 415);
  if (Number(request.headers.get('content-length')) > 16384) throw new GameError('请求过大', 413);
  const reader = request.body?.getReader(); let length = 0, chunks = [];
  if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 16384) { await reader.cancel(); throw new GameError('请求过大', 413); } chunks.push(value); }
  const buffer = new Uint8Array(length); let at = 0; for (const chunk of chunks) { buffer.set(chunk, at); at += chunk.length; }
  try { const value = JSON.parse(new TextDecoder().decode(buffer)); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); return value; } catch { throw new GameError('请求格式不正确'); }
}
async function admin(request, env) {
  const key = env.OPS_AUTH_KEY || '', supplied = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (key.length < 32 || !supplied || await hash(key) !== await hash(supplied)) throw new GameError('无管理权限', 403);
}
export async function audit(db) {
  const balances = new Map(), rows = await all(db, 'SELECT * FROM ledger');
  for (const row of rows) { const n = BigInt(row.amount); for (const [name, delta] of [[row.debit, -n], [row.credit, n]]) { const k = row.asset + '|' + name; balances.set(k, (balances.get(k) || 0n) + delta); } }
  const mismatches = [];
  function check(asset, name, expected) { const actual = balances.get(asset + '|' + name) || 0n; if (actual !== BigInt(expected)) mismatches.push({ asset, name, stored: formatAmount(expected), ledger: formatAmount(actual) }); }
  for (const a of await all(db, 'SELECT * FROM accounts')) for (const field of ['available', 'rewards', 'locked']) check(a.asset, a.id + ':' + field, a[field]);
  for (const a of await all(db, 'SELECT * FROM accounts')) check('ingots:'+a.asset,a.id+':ingots',a.ingots??'0');
  for (const t of await all(db, 'SELECT * FROM treasuries')) { check(t.asset, 'pool:' + t.asset, t.available); check(t.asset, 'burn:' + t.asset, t.burned); }
  for (const b of await all(db,"SELECT * FROM vault_authorizations WHERE kind='burn'")) check(b.asset,'burn-locked:'+b.id,b.status==='authorized'?b.amount:'0');
  return { ok: !mismatches.length, transfers: rows.length, mismatches, note: '账本一致性核对；不代表链上资产储备证明。计提、待确认与已执行销毁分别记账。' };
}
async function api(request, env) {
  const url = new URL(request.url), path = url.pathname, isAdmin = path.startsWith('/api/admin/');
  if (!env.DB) throw new GameError('游戏账户服务正在准备中', 503);
  const db = env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
  if (request.method !== 'GET' && request.method !== 'POST') throw new GameError('不支持此操作', 405);
  if (isAdmin) await admin(request, env);
  if (request.method === 'POST' && !isAdmin) {
    if (request.headers.get('origin') !== url.origin || request.headers.get('x-game-request') !== '1') throw new GameError('请从游戏页面发起操作', 403);
  }
  const data = request.method === 'POST' ? await body(request) : {}, key = request.headers.get('idempotency-key');
  const route = request.method + ' ' + path;
  if (route === 'GET /api/health') { await first(db, 'SELECT 1 AS ok'); return json({ ok: true, paymentsEnabled: paymentConfig(env).enabled }); }
  if (route === 'GET /api/config') return json({ rules: RULES, payments: paymentConfig(env), referrals: REFERRAL_RULES });
  if (route === 'POST /api/auth/demo') { const login = await demoLogin(db, request); return json(await getState(db, login.owner), 200, login.cookie ? { 'Set-Cookie': login.cookie } : {}); }
  if (route === 'POST /api/auth/challenge') return json(await challenge(db, request, data.address));
  if (route === 'POST /api/auth/verify') { const login = await walletLogin(db, request, env, data); return json(await getState(db, login.owner), 200, { 'Set-Cookie': login.cookie }); }
  if (isAdmin) {
    if (route === 'GET /api/admin/whitelist') return json(await listWhitelist(db, tokenAsset(env), url.searchParams.get('after') || ''));
    if (route === 'POST /api/admin/whitelist') return json(await saveWhitelist(db, tokenAsset(env), key, data));
    if (route === 'GET /api/admin/audit') return json(await audit(db));
    if (route === 'GET /api/admin/withdrawals') return json({ withdrawals: (await all(db, "SELECT id,recipient,amount,fee,fee_bps,fee_version,status,tx_hash,created_at FROM withdrawals WHERE status IN ('queued','submitted','authorized') ORDER BY created_at LIMIT 100")).map(withdrawalView) });
    if (route === 'POST /api/admin/treasury/fund') return json(await fundTreasury(db, env, key, data.txHash));
    if (route === 'POST /api/admin/burns') { const report=await audit(db);if(!report.ok)throw new GameError('账本核对未通过，暂停销毁',409);return json(await prepareBurn(db,env,key,data.amount)); }
    if (route === 'GET /api/admin/burns') return json({batches:await all(db,"SELECT id,status,amount,deadline,tx_hash,created_at FROM vault_authorizations WHERE kind='burn' ORDER BY created_at DESC LIMIT 100")});
    const burnMatch=/^\/api\/admin\/burns\/([a-f0-9-]{36})\/check$/.exec(path);
    if(request.method==='POST'&&burnMatch)return json(await finishBurn(db,env,key,burnMatch[1]));
    const match = /^\/api\/admin\/withdrawals\/([a-f0-9-]{36})\/(attach|broadcast|confirm|reject)$/.exec(path);
    if (request.method === 'POST' && match) {
      const [ , id, action ] = match;
      if (action === 'attach') return json(await attachSignedWithdrawal(db, env, key, id, data.rawTransaction));
      if (action === 'broadcast') return json(await broadcastWithdrawal(db, env, id));
      if (action === 'confirm') return json(await finishWithdrawal(db, env, 'ops', key, id));
      return json(await rejectWithdrawal(db, env, key, id));
    }
    throw new GameError('接口不存在', 404);
  }
  const owner = await requireOwner(db, request);
  if (route === 'GET /api/account') return json(await getState(db, owner));
  if (route === 'GET /api/referrals') return json(await referralSummary(db, owner));
  if (route === 'GET /api/referrals/resolve') { const resolved = await resolveReferral(db, owner, url.searchParams.get('code')); return json({ code: resolved.code, wallet: resolved.wallet }); }
  if (route === 'POST /api/referrals/bind') return json(await bindReferral(db, owner, key, data.code));
  if (route === 'POST /api/referrals/activate') return json(await activateReferral(db, owner, key));
  if (route === 'GET /api/rounds') return json({ rounds: await history(db, owner) });
  if (route === 'GET /api/ingots') return json(await ingotState(db, owner));
  if (route === 'POST /api/ingots/redeem') throw new GameError('金元宝兑换暂未开放，兑换规则将另行公布',409,'REDEMPTION_CLOSED');
  if (route === 'GET /api/payments') return json(await paymentHistory(db, owner));
  if (route === 'POST /api/play') {
    const a = await first(db, 'SELECT asset FROM accounts WHERE id=?', owner);
    if (a?.asset !== 'demo' && !paymentConfig(env).enabled) throw new GameError('正式游戏尚未开放，请返回测试币体验', 503, 'PAYMENTS_CLOSED');
    return json(await play(db, owner, key, data.amount, { expectedVersion: data.rulesVersion, requireRulesVersion: true }));
  }
  if (route === 'POST /api/claim') return json(await claim(db, owner, key));
  if (route === 'POST /api/demo/topup') return json(await demoTopup(db, owner, key, data.amount));
  if (route === 'POST /api/deposits') return json(await creditDeposit(db, env, owner, key, data.txHash));
  if (route === 'POST /api/deposits/prepare') return json(await prepareVaultDeposit(db,env,owner,data.amount));
  if (route === 'POST /api/withdrawals/quote') return json(await quoteWithdrawal(db, env, owner, data.amount));
  if (route === 'POST /api/withdrawals') return json(await requestWithdrawal(db, env, owner, key, data.amount, data.feeVersion));
  const voucher=/^\/api\/withdrawals\/([a-f0-9-]{36})\/authorization$/.exec(path);
  if(request.method==='GET'&&voucher)return json(await getVaultAuthorization(db,env,owner,voucher[1]));
  const check = /^\/api\/withdrawals\/([a-f0-9-]{36})\/check$/.exec(path);
  if (request.method === 'POST' && check) return json(await finishWithdrawal(db, env, owner, key, check[1]));
  throw new GameError('接口不存在', 404);
}
export default { async fetch(request, env) {
  if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  try { return await api(request, env); } catch (e) { if (!(e instanceof GameError)) console.error('Game API failure', e); return json({ error: e instanceof GameError ? e.message : '服务暂时繁忙，请使用原操作重试', code: e instanceof GameError ? e.code : 'SERVER_ERROR' }, e instanceof GameError ? e.status : 500); }
}};
