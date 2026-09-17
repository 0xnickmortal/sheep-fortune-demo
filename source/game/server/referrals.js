import { GameError, formatAmount } from './rules.js';
import { first, all, stmt, id, accountUpdate, transfer, operation } from './db.js';

export const REFERRAL_RULES = Object.freeze({ version: 'referral-stake-15-5-v1', enabled: true, basis: 'stake', directBps: 1500, indirectBps: 500, settlement: 'auto-balance' });
export async function ensureReferral(db, owner) {
  await stmt(db, 'INSERT OR IGNORE INTO referral_profiles(owner) VALUES (?)', owner).run();
  return first(db, 'SELECT * FROM referral_profiles WHERE owner=?', owner);
}
async function account(db, owner) {
  const a = await first(db, 'SELECT * FROM accounts WHERE id=?', owner);
  if (!a?.wallet || a.asset === 'demo') throw new GameError('请先连接正式钱包；测试币不参与推荐返佣', 403, 'TOKEN_ONLY');
  return a;
}
export async function referralStatus(db, a) {
  if (!a?.wallet || a.asset === 'demo') return { supported: false, policy: REFERRAL_RULES };
  const profile = await ensureReferral(db, a.id);
  return { supported: true, eligible: a.last_play > 0, active: !!profile.code, code: profile.code, bound: !!profile.parent, canBind: !profile.parent && a.last_play === 0, policy: REFERRAL_RULES };
}
export async function resolveReferral(db, owner, code) {
  const a = await account(db, owner);
  if (typeof code !== 'string' || !/^[a-f0-9]{24}$/.test(code)) throw new GameError('邀请链接或邀请码无效');
  const p = await first(db, 'SELECT p.*,a.wallet,a.asset,a.last_play FROM referral_profiles p JOIN accounts a ON a.id=p.owner WHERE p.code=?', code);
  if (!p || p.asset !== a.asset || !p.activated_at || !p.last_play) throw new GameError('该邀请码尚未生效或不属于当前代币');
  if (p.owner === owner) throw new GameError('不能绑定自己的邀请码');
  return { profile: p, wallet: p.wallet, code };
}
export async function bindReferral(db, owner, key, code) {
  await ensureReferral(db, owner);
  return operation(db, owner, key, 'referral-bind', { code }, async () => {
    const a = await account(db, owner), own = await first(db, 'SELECT * FROM referral_profiles WHERE owner=?', owner);
    if (a.last_play > 0 || own.parent) throw new GameError('推荐人只能在首次游戏前绑定一次', 409, 'REFERRAL_LOCKED');
    const { profile: p, wallet } = await resolveReferral(db, owner, code);
    // Binding is only allowed before a first game, while inviters must already
    // have played. The explicit traversal also rejects corrupt/legacy cycles.
    const ancestors = await all(db, 'WITH RECURSIVE chain(owner) AS (SELECT ? UNION SELECT p.parent FROM referral_profiles p JOIN chain c ON p.owner=c.owner WHERE p.parent IS NOT NULL) SELECT owner FROM chain', p.owner);
    if (ancestors.some(x => x.owner === owner)) throw new GameError('该推荐关系会形成循环');
    return { response: { bound: true, wallet, code }, statements: [
      ...accountUpdate(db, a, {}),
      stmt(db, 'UPDATE referral_profiles SET parent=?,bound_at=? WHERE owner=?', p.owner, Date.now(), owner),
    ] };
  });
}
export async function activateReferral(db, owner, key) {
  await account(db, owner); await ensureReferral(db, owner);
  return operation(db, owner, key, 'referral-activate', {}, async () => {
    const a = await account(db, owner), p = await first(db, 'SELECT * FROM referral_profiles WHERE owner=?', owner);
    if (!a.last_play) throw new GameError('完成至少一局游戏后，才能开启邀请奖励', 409, 'PLAY_REQUIRED');
    if (p.code) return { response: { code: p.code }, statements: [] };
    const code = id().replaceAll('-', '').slice(0, 24);
    return { response: { code }, statements: [...accountUpdate(db, a, {}), stmt(db, 'UPDATE referral_profiles SET code=?,activated_at=? WHERE owner=?', code, Date.now(), owner)] };
  });
}
export async function referralSettlement(db, a, stake, roundId, op, now) {
  const profile = await ensureReferral(db, a.id), payments = [];
  let cursor = profile.parent;
  for (const [level, bps] of [[1, REFERRAL_RULES.directBps], [2, REFERRAL_RULES.indirectBps]]) {
    if (!cursor || a.asset === 'demo') break;
    const recipient = await first(db, 'SELECT * FROM accounts WHERE id=?', cursor), p = await first(db, 'SELECT * FROM referral_profiles WHERE owner=?', cursor);
    if (!recipient || recipient.asset !== a.asset || recipient.id === a.id || payments.some(x => x.recipient.id === recipient.id)) throw new Error('Invalid referral graph');
    const amount = stake * BigInt(bps) / 10000n;
    if (REFERRAL_RULES.enabled && p?.activated_at && recipient.last_play > 0 && amount) payments.push({ recipient, amount, level });
    cursor = p?.parent;
  }
  return { total: payments.reduce((s, p) => s + p.amount, 0n), snapshot: { ...REFERRAL_RULES, recipients: payments.map(p => ({ wallet: p.recipient.wallet, level: p.level, amount: formatAmount(p.amount) })) }, statements: payments.flatMap(p => [
    ...accountUpdate(db, p.recipient, { available: BigInt(p.recipient.available) + p.amount }),
    ...transfer(db, op, a.asset, 'pool:' + a.asset, p.recipient.id + ':available', p.amount, now),
    stmt(db, 'INSERT INTO referral_rewards(id,round,player,recipient,asset,level,stake,amount,policy,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id(), roundId, a.id, p.recipient.id, a.asset, p.level, String(stake), String(p.amount), JSON.stringify(REFERRAL_RULES), now),
  ]) };
}
export async function referralSummary(db, owner) {
  const a = await first(db, 'SELECT * FROM accounts WHERE id=?', owner), status = await referralStatus(db, a);
  if (!status.supported) return { ...status, message: '连接钱包并完成一局游戏后，可以生成专属邀请链接。试玩账户不产生真实推荐奖励。' };
  const profile = await first(db, 'SELECT * FROM referral_profiles WHERE owner=?', owner);
  const parent = profile.parent ? await first(db, 'SELECT wallet FROM accounts WHERE id=?', profile.parent) : null;
  const direct = await first(db, 'SELECT COUNT(*) n FROM referral_profiles WHERE parent=?', owner);
  const indirect = await first(db, 'SELECT COUNT(*) n FROM referral_profiles c JOIN referral_profiles p ON c.parent=p.owner WHERE p.parent=?', owner);
  const rewards = await all(db, 'SELECT amount,level FROM referral_rewards WHERE recipient=?', owner);
  const records = await all(db, 'SELECT r.*,a.wallet FROM referral_rewards r JOIN accounts a ON a.id=r.player WHERE recipient=? ORDER BY r.created_at DESC,r.id DESC LIMIT 50', owner);
  return { ...status, parent: parent?.wallet || null, directCount: direct.n, indirectCount: indirect.n,
    directEarned: formatAmount(rewards.filter(x => x.level === 1).reduce((s, x) => s + BigInt(x.amount), 0n)),
    indirectEarned: formatAmount(rewards.filter(x => x.level === 2).reduce((s, x) => s + BigInt(x.amount), 0n)),
    records: records.map(r => ({ id: r.id, roundId: r.round, player: r.wallet, level: r.level, stake: formatAmount(r.stake), amount: formatAmount(r.amount), createdAt: r.created_at })) };
}
