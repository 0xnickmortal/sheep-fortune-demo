import { all, first } from './db.js';
import { tokenAsset } from './auth.js';
import { GameError, formatAmount } from './rules.js';

const pendingWithdrawals = new Set(['queued', 'authorized', 'submitted']);
const amountFields = ['balance', 'rewards', 'locked', 'deposited', 'withdrawn', 'withdrawalFees', 'pendingWithdrawal', 'bet', 'returned', 'gameFees', 'gameProfit', 'referralIncome', 'totalProfit'];
const countFields = ['depositCount', 'withdrawalCount', 'pendingDepositCount', 'failedDepositCount', 'pendingWithdrawalCount', 'failedWithdrawalCount', 'roundCount', 'winningRounds', 'losingRounds', 'referralCount'];
const newTotals = () => Object.fromEntries([...amountFields.map(k => [k, 0n]), ...countFields.map(k => [k, 0])]);
const view = row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? formatAmount(v) : v]));

function integer(value, fallback, max) {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new GameError('分页参数不正确');
  return Number(value);
}
function dateBoundary(value, end = false) {
  if (!value) return end ? Number.MAX_SAFE_INTEGER : 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new GameError('日期格式不正确');
  const utc = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== value) throw new GameError('日期不正确');
  return utc - 8 * 3600000 + (end ? 86400000 : 0);
}
function options(params) {
  const from = dateBoundary(params.get('from')), to = dateBoundary(params.get('to'), true);
  if (from >= to) throw new GameError('开始日期不能晚于结束日期');
  const search = (params.get('search') || '').trim().toLowerCase();
  if (search.length > 42 || (search && !/^(?:0x)?[a-f0-9]+$/.test(search))) throw new GameError('请输入钱包地址或地址片段');
  const wallet = (params.get('wallet') || '').toLowerCase();
  if (wallet && !/^0x[a-f0-9]{40}$/.test(wallet)) throw new GameError('钱包地址格式不正确');
  return { from, to, search, wallet, page: integer(params.get('page'), 1, 1000000), pageSize: integer(params.get('pageSize'), 25, 100) };
}

// One read gives a consistent snapshot. Values remain TEXT in SQLite and are
// summed with BigInt: SUM/CAST on 18-decimal token amounts loses precision.
// Account rows are always included; dated movements only affect period totals.
export async function financeOverview(db, env, params) {
  const o = options(params), asset = tokenAsset(env);
  const profitFilter = params.get('profit') || 'all', sort = params.get('sort') || 'activity';
  if (!['all', 'profit', 'loss', 'even', 'unplayed'].includes(profitFilter)) throw new GameError('盈亏分类不正确');
  if (!['activity', 'deposits', 'withdrawals', 'profitDesc', 'profitAsc', 'balance'].includes(sort)) throw new GameError('排序方式不正确');
  // D1 permits at most five terms in a compound SELECT. Keep the two deposit
  // states in their own CTE so the outer snapshot stays within that limit.
  const rows = await all(db, `WITH members AS (
    SELECT * FROM accounts WHERE asset=? AND wallet IS NOT NULL
      AND instr(lower(wallet),?)>0 AND (?='' OR lower(wallet)=?)
  ), depositEvents AS (
    SELECT 'deposit' kind,owner,amount,created_at,'confirmed' status FROM deposits WHERE asset=?
    UNION ALL SELECT 'pendingDeposit',p.owner,'0',p.created_at,p.status FROM pending_deposits p
      WHERE p.asset=? AND p.status<>'confirmed'
      AND NOT EXISTS (SELECT 1 FROM deposits d WHERE d.asset=p.asset AND d.tx_hash=p.tx_hash)
  )
  SELECT 'account' kind,id owner,wallet,available a,rewards b,locked c,created_at at,'' status FROM members
  UNION ALL SELECT d.kind,d.owner,NULL,d.amount,'0','0',d.created_at,d.status
    FROM depositEvents d JOIN members m ON m.id=d.owner WHERE d.created_at>=? AND d.created_at<?
  UNION ALL SELECT 'withdrawal',w.owner,NULL,w.amount,w.fee,'0',w.created_at,w.status
    FROM withdrawals w JOIN members m ON m.id=w.owner WHERE w.asset=? AND w.created_at>=? AND w.created_at<?
  UNION ALL SELECT 'round',r.owner,NULL,r.bet,r.net,r.fee,r.created_at,''
    FROM rounds r JOIN members m ON m.id=r.owner WHERE r.created_at>=? AND r.created_at<?
  UNION ALL SELECT 'referral',r.recipient,NULL,r.amount,'0','0',r.created_at,''
    FROM referral_rewards r JOIN members m ON m.id=r.recipient WHERE r.asset=? AND r.created_at>=? AND r.created_at<?`,
  asset, o.search, o.wallet, o.wallet, asset, asset, o.from, o.to, asset, o.from, o.to, o.from, o.to, asset, o.from, o.to);
  const accounts = new Map();
  for (const row of rows) if (row.kind === 'account') accounts.set(row.owner, { ...newTotals(), wallet: row.wallet, createdAt: row.at, lastActivity: row.at, balance: BigInt(row.a), rewards: BigInt(row.b), locked: BigInt(row.c) });
  for (const row of rows) {
    if (row.kind === 'account') continue;
    const a = accounts.get(row.owner), value = BigInt(row.a), second = BigInt(row.b);
    a.lastActivity = Math.max(a.lastActivity, row.at);
    if (row.kind === 'deposit') { a.deposited += value; a.depositCount++; }
    if (row.kind === 'withdrawal') {
      if (row.status === 'confirmed') { a.withdrawn += value - second; a.withdrawalFees += second; a.withdrawalCount++; }
      else if (pendingWithdrawals.has(row.status)) { a.pendingWithdrawal += value - second; a.pendingWithdrawalCount++; }
      else { a.failedWithdrawalCount++; }
    }
    if (row.kind === 'round') {
      a.bet += value; a.returned += second; a.gameFees += BigInt(row.c); a.gameProfit += second - value; a.roundCount++;
      if (second > value) a.winningRounds++; else if (second < value) a.losingRounds++;
    }
    if (row.kind === 'referral') { a.referralIncome += value; a.referralCount++; }
    if (row.kind === 'pendingDeposit') { if (row.status === 'pending') a.pendingDepositCount++; else a.failedDepositCount++; }
  }
  let wallets = [...accounts.values()];
  for (const a of wallets) a.totalProfit = a.gameProfit + a.referralIncome - a.withdrawalFees;
  wallets = wallets.filter(a => profitFilter === 'all' || (profitFilter === 'profit' ? a.gameProfit > 0n : profitFilter === 'loss' ? a.gameProfit < 0n : profitFilter === 'unplayed' ? !a.roundCount : a.roundCount > 0 && a.gameProfit === 0n));
  const totals = newTotals();
  for (const a of wallets) for (const key of [...amountFields, ...countFields]) totals[key] += a[key];
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const field = { activity: 'lastActivity', deposits: 'deposited', withdrawals: 'withdrawn', profitDesc: 'gameProfit', profitAsc: 'gameProfit', balance: 'balance' }[sort];
  wallets.sort((a, b) => (sort === 'profitAsc' ? 1 : -1) * compare(a[field], b[field]) || a.wallet.localeCompare(b.wallet));
  const total = wallets.length, pages = Math.max(1, Math.ceil(total / o.pageSize)), page = Math.min(o.page, pages);
  return { generatedAt: Date.now(), symbol: env.TOKEN_SYMBOL || '代币', total, page, pageSize: o.pageSize, pages,
    summary: { ...view(totals), walletCount: total, profitableWallets: wallets.filter(a => a.gameProfit > 0n).length, losingWallets: wallets.filter(a => a.gameProfit < 0n).length },
    wallets: wallets.slice((page - 1) * o.pageSize, page * o.pageSize).map(view) };
}

export async function financeRecords(db, env, params) {
  const o = options(params), asset = tokenAsset(env), kind = params.get('kind') || 'deposits', status = params.get('status') || 'all';
  const base = `WITH members AS (SELECT id,wallet FROM accounts WHERE asset=? AND wallet IS NOT NULL AND instr(lower(wallet),?)>0 AND (?='' OR lower(wallet)=?))`;
  let source, values = [asset, o.search, o.wallet, o.wallet];
  if (kind === 'deposits') {
    if (!['all', 'confirmed', 'pending', 'failed'].includes(status)) throw new GameError('充值状态不正确');
    source = `SELECT d.id,m.wallet,d.amount,'0' fee,'0' net,d.tx_hash hash,d.created_at createdAt,'confirmed' status,'' detail,'' counterparty FROM deposits d JOIN members m ON m.id=d.owner WHERE d.asset=?
      UNION ALL SELECT p.tx_hash,m.wallet,NULL,'0','0',p.tx_hash,p.created_at,p.status,coalesce(p.error,''),'' FROM pending_deposits p JOIN members m ON m.id=p.owner WHERE p.asset=? AND p.status<>'confirmed'
      AND NOT EXISTS (SELECT 1 FROM deposits d WHERE d.asset=p.asset AND d.tx_hash=p.tx_hash)`;
    values.push(asset, asset);
  } else if (kind === 'withdrawals') {
    if (!['all', 'confirmed', 'pending', 'failed'].includes(status)) throw new GameError('提现状态不正确');
    source = `SELECT w.id,m.wallet,w.amount,w.fee,'0' net,w.tx_hash hash,w.created_at createdAt,w.status,'' detail,w.recipient counterparty FROM withdrawals w JOIN members m ON m.id=w.owner WHERE w.asset=?`;
    values.push(asset);
  } else if (kind === 'rounds') {
    if (!['all', 'profit', 'loss', 'even'].includes(status)) throw new GameError('游戏分类不正确');
    source = `SELECT r.id,m.wallet,r.bet amount,r.fee,r.net,NULL hash,r.created_at createdAt,'' status,CAST(r.score AS TEXT) detail,'' counterparty FROM rounds r JOIN members m ON m.id=r.owner`;
  } else if (kind === 'referrals') {
    if (!['all', 'direct', 'indirect'].includes(status)) throw new GameError('推荐分类不正确');
    source = `SELECT r.id,m.wallet,r.amount,'0' fee,'0' net,NULL hash,r.created_at createdAt,CAST(r.level AS TEXT) status,r.round detail,p.wallet counterparty FROM referral_rewards r JOIN members m ON m.id=r.recipient LEFT JOIN accounts p ON p.id=r.player WHERE r.asset=?`;
    values.push(asset);
  } else throw new GameError('记录分类不正确');
  let condition = 'createdAt>=? AND createdAt<?';
  values.push(o.from, o.to);
  if (status !== 'all') {
    if (kind === 'withdrawals' && status === 'pending') condition += " AND status IN ('queued','authorized','submitted')";
    else if (kind === 'withdrawals' && status === 'failed') condition += " AND status IN ('failed','rejected')";
    else if (kind === 'rounds') {
      // Positive integer TEXT comparison, exact even above SQLite's integer range.
      const comparison = status === 'profit' ? '>' : '<';
      condition += status === 'even' ? ' AND net=amount' : ` AND (length(net)${comparison}length(amount) OR (length(net)=length(amount) AND net${comparison}amount COLLATE BINARY))`;
    } else { condition += ' AND status=?'; values.push(kind === 'referrals' ? (status === 'direct' ? '1' : '2') : status); }
  }
  const query = `${base}, records AS (${source})`;
  const { total } = await first(db, `${query} SELECT COUNT(*) total FROM records WHERE ${condition}`, ...values);
  const pages = Math.max(1, Math.ceil(total / o.pageSize)), page = Math.min(o.page, pages);
  const rows = await all(db, `${query} SELECT * FROM records WHERE ${condition} ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?`, ...values, o.pageSize, (page - 1) * o.pageSize);
  return { kind, total, page, pages, pageSize: o.pageSize, records: rows.map(r => ({ ...r,
    amount: r.amount === null ? null : formatAmount(r.amount), fee: formatAmount(r.fee),
    ...(kind === 'withdrawals' ? { payout: formatAmount(BigInt(r.amount) - BigInt(r.fee)) } : {}),
    ...(kind === 'rounds' ? { net: formatAmount(r.net), profit: formatAmount(BigInt(r.net) - BigInt(r.amount)), multiplier: Number(r.detail) / 200 } : {}),
  })) };
}
