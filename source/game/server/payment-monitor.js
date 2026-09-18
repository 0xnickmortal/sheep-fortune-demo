import { first, all, stmt } from './db.js';
import { tokenAsset } from './auth.js';
import { GameError } from './rules.js';
import { creditDeposit, finishWithdrawal, paymentConfig, rpc } from './payments.js';
import { accountEnvironment } from './admin-auth.js';

export async function trackDeposit(db, env, owner, txHash) {
  if (!paymentConfig(env).enabled) throw new GameError('充值暂未开放', 503, 'PAYMENTS_CLOSED');
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) throw new GameError('请输入完整交易哈希');
  txHash = txHash.toLowerCase();
  const account = await first(db, 'SELECT wallet,asset FROM accounts WHERE id=?', owner);
  if (!account?.wallet || account.asset !== tokenAsset(env)) throw new GameError('请先连接钱包', 401);
  const existing = await first(db, 'SELECT * FROM pending_deposits WHERE asset=? AND tx_hash=?', account.asset, txHash);
  if (existing && existing.owner !== owner) throw new GameError('此交易不属于当前账户', 409);
  if (!existing) {
    const count = await first(db, "SELECT COUNT(*) n FROM pending_deposits WHERE owner=? AND status='pending'", owner);
    if (count.n >= 10) throw new GameError('请先等待已有充值到账', 409);
    const tx = await rpc(env, 'eth_getTransactionByHash', [txHash]);
    if (!tx) throw new GameError('交易正在广播，请稍后自动重试', 409, 'CONFIRMING');
    if (tx.from?.toLowerCase() !== account.wallet || tx.to?.toLowerCase() !== paymentConfig(env).vaultAddress) throw new GameError('充值交易的钱包或托管地址不匹配');
    // Validate the deposit call before persisting a background job.
    const { vaultInterface } = await import('./vault-payments.js');
    let call; try { call = vaultInterface.parseTransaction({data:tx.input}); } catch {}
    if (call?.name !== 'deposit' || call.args.amount <= 0n) throw new GameError('此交易不是有效充值');
    await stmt(db, "INSERT OR IGNORE INTO pending_deposits(asset,tx_hash,owner,status,created_at,updated_at) VALUES (?,?,?,'pending',?,?)", account.asset, txHash, owner, Date.now(), Date.now()).run();
    const saved = await first(db, 'SELECT owner FROM pending_deposits WHERE asset=? AND tx_hash=?', account.asset, txHash);
    if (saved.owner !== owner) throw new GameError('此交易不属于当前账户', 409);
  }
  return checkDeposit(db, env, owner, txHash);
}
export async function checkDeposit(db, env, owner, txHash) {
  try {
    const result = await creditDeposit(db, env, owner, 'deposit-monitor-' + txHash, txHash);
    await stmt(db, "UPDATE pending_deposits SET status='confirmed',error=NULL,updated_at=? WHERE asset=? AND tx_hash=? AND owner=?", Date.now(), tokenAsset(env), txHash, owner).run();
    return result;
  } catch (e) {
    if (e.code === 'CONFIRMING' || e.status >= 500) return {status:'pending',txHash,message:e.message};
    await stmt(db, "UPDATE pending_deposits SET status='failed',error=?,updated_at=? WHERE asset=? AND tx_hash=? AND owner=?", e.message, Date.now(), tokenAsset(env), txHash, owner).run();
    throw e;
  }
}
export async function syncPayments(db, env) {
  const asset = tokenAsset(env), result = {deposits:0,withdrawals:0,pending:0,errors:0};
  const deposits = await all(db, "SELECT * FROM pending_deposits WHERE asset=? AND status='pending' ORDER BY updated_at LIMIT 2", asset);
  for (const row of deposits) {
    const scoped = await accountEnvironment(db, env, row.owner); if (!paymentConfig(scoped).enabled) continue;
    try { const r = await checkDeposit(db, scoped, row.owner, row.tx_hash); result[r.status==='confirmed'?'deposits':'pending']++; }
    catch { result.errors++; }
    await stmt(db, 'UPDATE pending_deposits SET updated_at=? WHERE asset=? AND tx_hash=?', Date.now(), asset, row.tx_hash).run();
  }
  const withdrawals = await all(db, "SELECT id,owner FROM withdrawals WHERE asset=? AND status='authorized' ORDER BY updated_at LIMIT 2", asset);
  for (const row of withdrawals) {
    const scoped = await accountEnvironment(db, env, row.owner); if (!paymentConfig(scoped).enabled) continue;
    try { await finishWithdrawal(db, scoped, row.owner, 'withdraw-monitor-' + row.id, row.id); result.withdrawals++; }
    catch (e) { result[e.code==='CONFIRMING'?'pending':'errors']++; }
    await stmt(db, 'UPDATE withdrawals SET updated_at=? WHERE id=?', Date.now(), row.id).run();
  }
  return result;
}
