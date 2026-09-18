import { Interface, getAddress } from 'ethers';
import { rpc, paymentConfig } from './payments.js';
import { tokenAsset, tokenAddress } from './auth.js';
import { GameError, formatAmount } from './rules.js';
import { first, all, stmt, operation, treasuryUpdate, transfer, guard } from './db.js';

const abi = new Interface([
  'function token() view returns(address)', 'function owner() view returns(address)',
  'function signer() view returns(address)', 'function paused() view returns(bool)',
  'function totalDeposited() view returns(uint256)', 'function totalFunded() view returns(uint256)',
  'function totalPaid() view returns(uint256)', 'function totalBurned() view returns(uint256)',
  'function directPoolIncome() view returns(uint256)', 'function maxWithdrawal() view returns(uint256)',
  'function maxBurn() view returns(uint256)',
]);
const tokenAbi = new Interface(['function balanceOf(address) view returns(uint256)']);
function poolConfig(env) {
  let vault;
  try { vault = getAddress(env.VAULT_ADDRESS).toLowerCase(); if (/^0x0{40}$/.test(vault)) throw Error(); }
  catch { throw new GameError('游戏托管合约尚未部署或未接入后台', 409, 'VAULT_NOT_CONFIGURED'); }
  if (env.PAYMENT_MODE !== 'vault' || !/^https:\/\//.test(env.BSC_RPC_URL || '')) throw new GameError('游戏池链上连接尚未配置', 503);
  return { vault, token: tokenAddress(env), asset: tokenAsset(env) };
}
async function read(env, to, iface, fn, args, tag) {
  return iface.decodeFunctionResult(fn, await rpc(env, 'eth_call', [{to, data: iface.encodeFunctionData(fn, args)}, tag]))[0];
}
export async function confirmedPool(env) {
  const c = poolConfig(env);
  if (BigInt(await rpc(env, 'eth_chainId', [])) !== 56n) throw new GameError('游戏池必须使用 BSC 主网', 503);
  const head = BigInt(await rpc(env, 'eth_blockNumber', []));
  const height = head - BigInt(paymentConfig(env).confirmations) + 1n;
  if (height < 0n) throw new GameError('等待链上确认', 409, 'CONFIRMING');
  const tag = '0x' + height.toString(16), block = await rpc(env, 'eth_getBlockByNumber', [tag, false]);
  if (!block?.hash) throw new GameError('无法读取已确认区块', 503);
  const asset = await read(env, c.vault, abi, 'token', [], tag);
  if (asset.toLowerCase() !== c.token) throw new GameError('游戏池代币与后台配置不一致', 409);
  const names = ['totalDeposited','totalFunded','totalPaid','totalBurned','directPoolIncome'];
  const values = await Promise.all(names.map(name => read(env, c.vault, abi, name, [], tag)));
  const balance = await read(env, c.token, tokenAbi, 'balanceOf', [c.vault], tag);
  // Pin every call to one confirmed height and check its canonical hash again.
  const after = await rpc(env, 'eth_getBlockByNumber', [tag, false]);
  if (after?.hash !== block.hash) throw new GameError('区块发生变化，请重试', 409, 'CONFIRMING');
  return {...c, blockNumber: Number(height), blockHash: block.hash, balance, ...Object.fromEntries(names.map((name,i)=>[name, values[i]]))};
}
export async function syncPoolIncome(db, env, key) {
  const snapshot = await confirmedPool(env), {asset,vault} = snapshot;
  await stmt(db, 'INSERT OR IGNORE INTO pool_income(asset,vault) VALUES (?,?)', asset,vault).run();
  await stmt(db, 'INSERT OR IGNORE INTO treasuries(asset,available,burned,fees,revision) VALUES (?,?,?,?,0)', asset,'0','0','0').run();
  return operation(db, 'ops', key, 'pool-income', {asset,vault}, async (op,now) => {
    const checkpoint = await first(db, 'SELECT * FROM pool_income WHERE asset=? AND vault=?',asset,vault);
    if (checkpoint.block_hash) {
      const previous = await rpc(env, 'eth_getBlockByNumber', ['0x'+checkpoint.block_number.toString(16),false]);
      if (previous?.hash !== checkpoint.block_hash) throw new GameError('已入账区块发生重组，停止自动入账并人工核对',409,'POOL_REORG');
    }
    if (snapshot.blockNumber < checkpoint.block_number) throw new GameError('本次快照较旧，请重试',409,'STALE_POOL_SNAPSHOT');
    const delta = snapshot.directPoolIncome - BigInt(checkpoint.credited);
    if (delta < 0n) throw new GameError('累计池子收入减少，停止入账并核对代币资产',409,'POOL_INCOME_MISMATCH');
    // Previously confirmed fundPool receipts remain credited; add only the
    // unaccounted cumulative capital, separately from direct game-tax income.
    const manualFunds = await all(db, 'SELECT amount FROM deposits WHERE asset=? AND owner=?', asset, 'pool:' + asset);
    const manualTotal = manualFunds.reduce((sum, row) => sum + BigInt(row.amount), 0n);
    const fundedBefore = BigInt(checkpoint.funded_credited || 0);
    const fundedDelta = env.POOL_FUND_SYNC_ENABLED === 'true' ? snapshot.totalFunded - manualTotal - fundedBefore : 0n;
    if (fundedDelta < 0n) throw new GameError('运营注资与已入账额度不一致，暂停核对',409,'POOL_FUND_MISMATCH');
    const t = await first(db,'SELECT * FROM treasuries WHERE asset=?',asset);
    return {response:{amount:formatAmount(delta),fundedAmount:formatAmount(fundedDelta),creditedTotal:formatAmount(snapshot.directPoolIncome),blockNumber:snapshot.blockNumber},statements:[
      stmt(db,'UPDATE pool_income SET credited=?,funded_credited=?,block_number=?,block_hash=?,revision=revision+1 WHERE asset=? AND vault=? AND revision=?',String(snapshot.directPoolIncome),String(fundedBefore+fundedDelta),snapshot.blockNumber,snapshot.blockHash,asset,vault,checkpoint.revision),...guard(db),
      ...(delta+fundedDelta ? [...treasuryUpdate(db,t,{available:BigInt(t.available)+delta+fundedDelta}),...transfer(db,op,asset,'external','pool:'+asset,delta+fundedDelta,now)] : []),
    ]};
  });
}
export async function poolStatus(db,env) {
  const c=poolConfig(env), t=await first(db,'SELECT * FROM treasuries WHERE asset=?',c.asset);
  const checkpoint=await first(db,'SELECT * FROM pool_income WHERE asset=? AND vault=?',c.asset,c.vault);
  const accounts=await all(db,'SELECT available,rewards,locked FROM accounts WHERE asset=?',c.asset);
  const users=accounts.reduce((sum,a)=>sum+BigInt(a.available)+BigInt(a.rewards)+BigInt(a.locked),0n);
  const s=await confirmedPool(env);
  return {vault:c.vault,token:c.token,live:paymentConfig(env).enabled,blockNumber:s.blockNumber,
    chainBalance:formatAmount(s.balance),totalDeposited:formatAmount(s.totalDeposited),totalFunded:formatAmount(s.totalFunded),
    totalPaid:formatAmount(s.totalPaid),totalBurned:formatAmount(s.totalBurned),directIncome:formatAmount(s.directPoolIncome),
    directIncomeCredited:formatAmount(checkpoint?.credited||0),availablePool:formatAmount(t?.available||0),
    userLiabilities:formatAmount(users),pendingBurn:formatAmount(t?.burned||0),
    note:'链上余额包括用户资金、奖池和未核对资金；不能全部作为奖池。直接转入包括游戏税和外部补充款，不计为个人充值。'};
}
