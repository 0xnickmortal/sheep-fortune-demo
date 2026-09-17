import { getAddress } from 'ethers';
import { RULES, GameError } from './rules.js';
import { WITHDRAWAL_FEE } from './withdrawal-fee.js';
import { first, all, stmt, id, hash, operation } from './db.js';

const ZERO = '0x0000000000000000000000000000000000000000';
export function whitelistAddress(value) {
  try {
    if (typeof value !== 'string') throw Error();
    const address = getAddress(value.trim()).toLowerCase();
    if (address === ZERO) throw Error();
    return address;
  } catch { throw new GameError('请输入有效的 BSC 钱包地址'); }
}
export function validateWeights(weights) {
  if (!Array.isArray(weights) || weights.length !== RULES.outcomes.length || weights.some(w => !Number.isInteger(w) || w < 0 || w > 10000) || weights.reduce((s, w) => s + w, 0) !== 10000) {
    throw new GameError('请填写全部9档概率，精确到0.01%，合计必须为100%');
  }
  return [...weights];
}
function view(row) {
  return { address: row.wallet, weights: JSON.parse(row.weights), enabled: !!row.enabled, revision: row.revision, withdrawalFeeExempt: !!row.enabled, updatedAt: row.updated_at };
}
export async function listWhitelist(db, asset, after = '') {
  const rows = await all(db, 'SELECT * FROM wallet_policies WHERE asset=? AND wallet>? ORDER BY wallet LIMIT 101', asset, after);
  return { entries: rows.slice(0, 100).map(view), nextCursor: rows.length > 100 ? rows[99].wallet : null, outcomes: RULES.outcomes.map(({ id, multiplierBps }) => ({ id, multiplierBps })), defaultWeights: RULES.outcomes.map(o => o.weight), roundFee: RULES.roundFee };
}
export async function saveWhitelist(db, asset, key, input) {
  const address = whitelistAddress(input.address), weights = validateWeights(input.weights);
  if (typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new GameError('请提供启用状态和当前配置版本');
  return operation(db, 'ops', key, 'whitelist-save', { asset, address, weights, enabled: input.enabled, revision: input.revision }, async (op, now) => {
    const old = await first(db, 'SELECT * FROM wallet_policies WHERE asset=? AND wallet=?', asset, address);
    if ((old?.revision ?? 0) !== input.revision) throw new GameError('该地址配置已更新，请重新读取后保存', 409, 'POLICY_CHANGED');
    const revision = input.revision + 1;
    return { response: { address, weights, enabled: input.enabled, revision, withdrawalFeeExempt: input.enabled, updatedAt: now }, statements: [
      ...policyGuard(db, { asset, wallet: address, revision: input.revision }),
      stmt(db, 'INSERT INTO wallet_policies(asset,wallet,weights,enabled,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(asset,wallet) DO UPDATE SET weights=excluded.weights,enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at', asset, address, JSON.stringify(weights), Number(input.enabled), revision, old?.created_at ?? now, now),
    ] };
  });
}
// The session's verified account supplies wallet + asset; callers cannot select
// another address by adding a field to a play or withdrawal request.
export async function accountPolicy(db, account) {
  const normal = { rules: RULES, benefits: { whitelisted: false, withdrawalFeeExempt: false }, withdrawalFee: WITHDRAWAL_FEE, guard: null };
  if (!account?.wallet || account.asset === 'demo') return normal;
  const wallet = whitelistAddress(account.wallet), asset = account.asset;
  const row = await first(db, 'SELECT * FROM wallet_policies WHERE asset=? AND wallet=?', asset, wallet);
  const guard = { asset, wallet, revision: row?.revision ?? 0 };
  if (!row?.enabled) return { ...normal, guard };
  const weights = validateWeights(JSON.parse(row.weights));
  const outcomes = RULES.outcomes.map((o, i) => ({ ...o, weight: weights[i] }));
  const suffix = (await hash(JSON.stringify({ asset, wallet, revision: row.revision, weights }))).slice(0, 24);
  const version = RULES.version + ':whitelist:' + suffix;
  const resultProbabilities = [0, 0, 0]; let weightedNet = 0;
  for (const o of outcomes) {
    const net = o.multiplierBps - (o.multiplierBps > RULES.roundFee.aboveMultiplierBps ? RULES.roundFee.bps : 0);
    resultProbabilities[net < 10000 ? 0 : net === 10000 ? 1 : 2] += o.weight;
    weightedNet += net * o.weight;
  }
  return {
    guard, benefits: { whitelisted: true, withdrawalFeeExempt: true },
    withdrawalFee: { bps: 0, version: 'withdrawal-whitelist-free-v1:' + suffix },
    rules: { ...RULES, version, outcomes, resultProbabilities: resultProbabilities.map(w => w / 100), netRtp: (weightedNet / 1000000).toFixed(4) + '%', profile: { type: 'whitelist', label: '白名单专属概率', revision: row.revision } },
  };
}
// Check the policy inside the same transaction as the debit/withdrawal. A
// concurrent change rolls back everything; committed retries keep snapshots.
export function policyGuard(db, policy) {
  if (!policy) return [];
  const key = id(), { asset, wallet, revision } = policy;
  return [
    stmt(db, 'INSERT INTO cas_guards(id,ok) SELECT ?,CASE WHEN COALESCE((SELECT revision FROM wallet_policies WHERE asset=? AND wallet=?),0)=? THEN 1 ELSE 0 END', key, asset, wallet, revision),
    stmt(db, 'DELETE FROM cas_guards WHERE id=?', key),
  ];
}
