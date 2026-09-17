import { Interface, Wallet, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { GameError, parseAmount, formatAmount } from './rules.js';
import { tokenAsset, tokenAddress } from './auth.js';
import { first, all, stmt, id, guard, operation, accountUpdate, treasuryUpdate, transfer } from './db.js';
import { accountPolicy, policyGuard } from './whitelist.js';
import { withdrawalQuote, withdrawalAmounts } from './withdrawal-fee.js';
import { vaultControl, custodyGuard } from './vault-guard.js';
import { rpc, receipt, paymentConfig } from './payments.js';

export const VAULT_ABI = [
  'function token() view returns(address)', 'function signer() view returns(address)', 'function signerEpoch() view returns(uint256)',
  'function maxWithdrawal() view returns(uint256)', 'function maxBurn() view returns(uint256)', 'function owner() view returns(address)',
  'function cancelled(bytes32) view returns(bool)', 'function executedAt(bytes32) view returns(uint256)',
  'function deposit(uint256 amount)', 'function fundPool(uint256 amount)',
  'function withdraw((bytes32 id,address recipient,uint256 amount,uint256 deadline,uint256 epoch) w,bytes signature)',
  'function executeBurn((bytes32 id,uint256 amount,uint256 reserveFloor,uint256 deadline,uint256 epoch) b,bytes signature)',
  'event Deposited(address indexed account,uint256 amount)', 'event PoolFunded(address indexed funder,uint256 amount)',
  'event Withdrawn(bytes32 indexed id,address indexed recipient,uint256 amount)', 'event Burned(bytes32 indexed id,uint256 amount,bool reducedTotalSupply)',
];
export const vaultInterface = new Interface(VAULT_ABI);
const erc20 = new Interface(['function balanceOf(address) view returns(uint256)', 'function approve(address,uint256) returns(bool)']);
export const WITHDRAWAL_TYPES = { Withdrawal: [{ name:'id',type:'bytes32' },{ name:'recipient',type:'address' },{ name:'amount',type:'uint256' },{ name:'deadline',type:'uint256' },{ name:'epoch',type:'uint256' }] };
export const BURN_TYPES = { Burn: [{ name:'id',type:'bytes32' },{ name:'amount',type:'uint256' },{ name:'reserveFloor',type:'uint256' },{ name:'deadline',type:'uint256' },{ name:'epoch',type:'uint256' }] };
export const vaultDomain = vault => ({ name:'SheepGameVault',version:'1',chainId:56,verifyingContract:vault });
export const authorizationId = value => keccak256(toUtf8Bytes('sheep-vault:' + value));
const lower = a => getAddress(a).toLowerCase();
function config(env) { const c=paymentConfig(env); if (!c.enabled || c.mode!=='vault') throw new GameError('托管充值提现尚未开放',503,'PAYMENTS_CLOSED'); return c; }
async function call(env, to, iface, method, args=[], block='latest') {
  const raw=await rpc(env,'eth_call',[{to,data:iface.encodeFunctionData(method,args)},block]);
  return iface.decodeFunctionResult(method,raw)[0];
}
async function setup(env) {
  const c=config(env);
  if(BigInt(await rpc(env,'eth_chainId',[]))!==56n)throw new GameError('托管合约网络配置错误',503);
  if (lower(await call(env,c.vaultAddress,vaultInterface,'token'))!==c.token) throw new GameError('托管合约代币不匹配',503);
  let issuer; try { issuer=new Wallet(env.VAULT_SIGNER_PRIVATE_KEY); } catch { throw new GameError('托管签名服务尚未配置',503); }
  if (lower(await call(env,c.vaultAddress,vaultInterface,'signer'))!==issuer.address.toLowerCase()) throw new GameError('托管签名服务配置不匹配',503);
  const epoch=String(await call(env,c.vaultAddress,vaultInterface,'signerEpoch'));
  const block=await rpc(env,'eth_getBlockByNumber',['latest',false]);
  if(!block?.timestamp)throw new GameError('暂时无法确认链上时间',503);
  return {c,issuer,epoch,chainTime:BigInt(block.timestamp)};
}
async function tokenAccount(db, env, owner) {
  const a=await first(db,'SELECT * FROM accounts WHERE id=?',owner);
  if(!a?.wallet || a.asset!==tokenAsset(env))throw new GameError('请先连接正式钱包',401);
  return a;
}
function events(r,c,name) {
  return (r.logs||[]).filter(l=>!l.removed&&l.address?.toLowerCase()===c.vaultAddress).flatMap(l=>{try {const e=vaultInterface.parseLog(l);return e?.name===name?[e]:[];}catch{return [];} });
}
export async function prepareVaultDeposit(db,env,owner,amount) {
  const {c}=await setup(env),a=await tokenAccount(db,env,owner),value=parseAmount(amount);
  return { amount, account:a.wallet, approval:{to:c.token,data:erc20.encodeFunctionData('approve',[c.vaultAddress,value]),value:'0x0'}, transaction:{to:c.vaultAddress,data:vaultInterface.encodeFunctionData('deposit',[value]),value:'0x0'} };
}
export async function creditVaultDeposit(db,env,owner,key,txHash,pool=false) {
  const {c}=await setup(env); if(!/^0x[0-9a-fA-F]{64}$/.test(txHash||''))throw new GameError('请输入完整交易哈希'); txHash=txHash.toLowerCase();
  const a=pool?null:await tokenAccount(db,env,owner),asset=tokenAsset(env),r=await receipt(env,txHash);
  if(BigInt(r.status)!==1n||BigInt(r.blockNumber)<BigInt(env.DEPOSIT_START_BLOCK))throw new GameError('充值交易无效或早于开放时间');
  // PoolFunded can only be emitted by the owner at transaction time; ownership may change later.
  const entries=events(r,c,pool?'PoolFunded':'Deposited').filter(e=>pool||String(e.args[0]).toLowerCase()===a.wallet);
  if(entries.length!==1||entries[0].args.amount<=0n)throw new GameError('未找到当前钱包的托管充值记录；直接转币不能作为充值入账');
  const amount=entries[0].args.amount,accountId=pool?'pool:'+asset:owner;
  return operation(db,owner,key,pool?'vault-fund':'vault-deposit',{txHash},async(op,now)=>{
    const prior=await first(db,'SELECT * FROM deposits WHERE asset=? AND tx_hash=?',asset,txHash);
    if(prior) {if(prior.owner!==accountId)throw new GameError('该交易已计入其他账户',409);return {response:{amount:formatAmount(prior.amount),status:'confirmed',txHash},statements:[]};}
    let updates;
    if(pool){await stmt(db,'INSERT OR IGNORE INTO treasuries(asset,available,burned,fees,revision) VALUES (?,?,?,?,0)',asset,'0','0','0').run();const t=await first(db,'SELECT * FROM treasuries WHERE asset=?',asset);updates=treasuryUpdate(db,t,{available:BigInt(t.available)+amount});}
    else {const current=await tokenAccount(db,env,owner);updates=accountUpdate(db,current,{available:BigInt(current.available)+amount});}
    return {response:{amount:formatAmount(amount),status:'confirmed',txHash},statements:[...updates,
      stmt(db,'INSERT INTO deposits(id,owner,tx_hash,block_hash,block_number,amount,asset,created_at) VALUES (?,?,?,?,?,?,?,?)',id(),accountId,txHash,r.blockHash,Number(BigInt(r.blockNumber)),String(amount),asset,now),
      ...transfer(db,op,asset,'external',pool?accountId:owner+':available',amount,now)]};
  });
}
function saveAuthorization(db,entry,now) {
  return stmt(db,'INSERT INTO vault_authorizations(id,kind,asset,vault,authorization_id,payload,signature,deadline,status,amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',entry.id,entry.kind,entry.asset,entry.vault,entry.payload.id,JSON.stringify(entry.payload),entry.signature,Number(entry.payload.deadline),'authorized',String(entry.amount),now,now);
}
export async function requestVaultWithdrawal(db,env,owner,key,amount,feeVersion) {
  const value=parseAmount(amount);
  return operation(db,owner,key,'withdraw',{amount},async(op,now)=>{
    const {c,issuer,epoch,chainTime}=await setup(env),a=await tokenAccount(db,env,owner),policy=await accountPolicy(db,a),control=await vaultControl(db,a.asset);
    if(policy.withdrawalFee.version!==feeVersion)throw new GameError('提现费率已更新，请重新查看手续费后确认',409,'FEE_CHANGED');
    if(value>BigInt(a.available))throw new GameError('可用余额不足');
    const checks=custodyGuard(db,control),quote=withdrawalQuote(amount,policy.withdrawalFee),payout=parseAmount(quote.payout),wid=id();
    if(payout>await call(env,c.vaultAddress,vaultInterface,'maxWithdrawal'))throw new GameError('超过托管合约单笔提现上限，请分次提现');
    const payload={id:authorizationId(wid),recipient:a.wallet,amount:String(payout),deadline:String(chainTime+3600n),epoch};
    const signature=await issuer.signTypedData(vaultDomain(c.vaultAddress),WITHDRAWAL_TYPES,payload);
    return {response:{id:wid,status:'authorized',...quote,recipient:a.wallet,feeExempt:policy.benefits.withdrawalFeeExempt},statements:[
      ...checks,...policyGuard(db,policy.guard),...accountUpdate(db,a,{available:BigInt(a.available)-value,locked:BigInt(a.locked)+value}),
      stmt(db,'INSERT INTO withdrawals(id,owner,asset,amount,fee,fee_bps,fee_version,recipient,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',wid,owner,a.asset,String(value),String(value-payout),quote.feeBps,quote.feeVersion,a.wallet,'authorized',now,now),
      saveAuthorization(db,{id:wid,kind:'withdrawal',asset:a.asset,vault:c.vaultAddress,payload,signature,amount:payout},now),
      ...transfer(db,op,a.asset,owner+':available',owner+':locked',value,now),
    ]};
  });
}
async function authorization(db,env,wid) {
  const c=config(env),v=await first(db,'SELECT * FROM vault_authorizations WHERE id=?',wid);
  if(!v||v.asset!==tokenAsset(env)||v.vault!==c.vaultAddress)throw new GameError('托管凭证不存在或配置已变更',404);
  return {...v,payload:JSON.parse(v.payload)};
}
export async function getVaultAuthorization(db,env,owner,wid) {
  const v=await authorization(db,env,wid),w=await first(db,'SELECT * FROM withdrawals WHERE id=? AND owner=?',wid,owner);
  if(!w||v.kind!=='withdrawal')throw new GameError('提现记录不存在',404);
  if(v.status!=='authorized'||w.status!=='authorized')throw new GameError('该提现已处理',409);
  return {id:wid,deadline:v.deadline,recipient:w.recipient,payout:formatAmount(v.amount),transaction:{to:v.vault,data:vaultInterface.encodeFunctionData('withdraw',[v.payload,v.signature]),value:'0x0'}};
}
async function confirmedBlock(env) {
  const c=config(env),head=BigInt(await rpc(env,'eth_blockNumber',[])),height=head-BigInt(c.confirmations)+1n;
  if(height<0n)throw new GameError('等待链上确认',409,'CONFIRMING');
  const tag='0x'+height.toString(16),block=await rpc(env,'eth_getBlockByNumber',[tag,false]);
  if(!block)throw new GameError('等待链上确认',409,'CONFIRMING');
  return {tag,time:BigInt(block.timestamp)};
}
async function execution(env,v) {
  const c=config(env),block=await call(env,v.vault,vaultInterface,'executedAt',[v.payload.id]);
  if(block===0n)return null;
  const tag='0x'+block.toString(16),eventName=v.kind==='burn'?'Burned':'Withdrawn';
  const logs=await rpc(env,'eth_getLogs',[{address:v.vault,fromBlock:tag,toBlock:tag,topics:[vaultInterface.getEvent(eventName).topicHash,v.payload.id]}]);
  const tx=logs.find(l=>!l.removed)?.transactionHash;
  if(!tx)throw new GameError('等待托管合约记录同步',409,'CONFIRMING');
  const r=await receipt(env,tx),entries=events(r,c,eventName).filter(e=>e.args.id===v.payload.id&&String(e.args.amount)===v.amount);
  if(BigInt(r.status)!==1n||entries.length!==1||(v.kind==='withdrawal'&&entries[0].args.recipient.toLowerCase()!==v.payload.recipient))throw new GameError('托管结算记录不匹配',409,'PAYOUT_REVIEW');
  return tx;
}
async function canRelease(env,v) {
  const block=await confirmedBlock(env);
  if(await call(env,v.vault,vaultInterface,'executedAt',[v.payload.id],block.tag)!==0n)return false;
  const revoked=await call(env,v.vault,vaultInterface,'cancelled',[v.payload.id],block.tag);
  const epoch=await call(env,v.vault,vaultInterface,'signerEpoch',[],block.tag);
  return revoked||epoch>BigInt(v.payload.epoch)||block.time>BigInt(v.payload.deadline);
}
export async function finishVaultWithdrawal(db,env,owner,key,wid) {
  const v=await authorization(db,env,wid),w=await first(db,'SELECT * FROM withdrawals WHERE id=?',wid);
  if(!w||(owner!=='ops'&&w.owner!==owner))throw new GameError('提现记录不存在',404);
  if(w.status!=='authorized')return {id:wid,status:w.status,txHash:w.tx_hash};
  const tx=await execution(env,v);
  if(!tx&&!await canRelease(env,v))throw new GameError('提现凭证仍有效，可继续提交；尚不能退回冻结余额',409,'CONFIRMING');
  return operation(db,owner,key,'vault-finish-withdrawal',{wid},async(op,now)=>{
    const current=await first(db,'SELECT * FROM withdrawals WHERE id=?',wid);
    if(current.status!=='authorized')return {response:{id:wid,status:current.status,txHash:current.tx_hash},statements:[]};
    const a=await first(db,'SELECT * FROM accounts WHERE id=?',current.owner),{amount,fee,payout}=withdrawalAmounts(current),status=tx?'confirmed':'rejected';
    if(BigInt(a.locked)<amount)throw new Error('Withdrawal reserve mismatch');
    const feeStatements=[];
    if(tx&&fee){const t=await first(db,'SELECT * FROM treasuries WHERE asset=?',a.asset);feeStatements.push(...treasuryUpdate(db,t,{available:BigInt(t.available)+fee,fees:BigInt(t.fees)+fee}),...transfer(db,op,a.asset,a.id+':locked','pool:'+a.asset,fee,now));}
    return {response:{id:wid,status,txHash:tx},statements:[
      ...accountUpdate(db,a,{locked:BigInt(a.locked)-amount,available:BigInt(a.available)+(tx?0n:amount)}),
      stmt(db,'UPDATE withdrawals SET status=?,tx_hash=?,updated_at=? WHERE id=? AND status=?',status,tx,now,wid,'authorized'),...guard(db),
      stmt(db,'UPDATE vault_authorizations SET status=?,tx_hash=?,updated_at=? WHERE id=?',status,tx,now,wid),
      ...transfer(db,op,a.asset,a.id+':locked',tx?'external':a.id+':available',tx?payout:amount,now),...feeStatements,
    ]};
  });
}
export async function prepareBurn(db,env,key,amount) {
  const value=parseAmount(amount),asset=tokenAsset(env);
  return operation(db,'ops',key,'vault-burn',{amount},async(op,now)=>{
    const {c,issuer,epoch,chainTime}=await setup(env),control=await vaultControl(db,asset),t=await first(db,'SELECT * FROM treasuries WHERE asset=?',asset),bid=id();
    const checks=custodyGuard(db,control,bid);
    if(!t||value>BigInt(t.burned))throw new GameError('销毁金额超过已计提的待销毁额度');
    const pending=await first(db,"SELECT COUNT(*) n FROM withdrawals WHERE asset=? AND status IN ('queued','submitted','authorized')",asset);
    if(pending.n)throw new GameError('请先处理所有待完成提现，再执行批量销毁',409);
    if(value>await call(env,c.vaultAddress,vaultInterface,'maxBurn'))throw new GameError('超过单批销毁上限');
    const users=await all(db,'SELECT available,rewards,locked FROM accounts WHERE asset=?',asset);
    const liabilities=users.reduce((s,a)=>s+BigInt(a.available)+BigInt(a.rewards)+BigInt(a.locked),0n);
    const expected=liabilities+BigInt(t.available)+BigInt(t.burned);
    if(await call(env,c.token,erc20,'balanceOf',[c.vaultAddress])<expected)throw new GameError('链上储备不足或账目尚未同步，不能销毁',409,'RESERVE_MISMATCH');
    const payload={id:authorizationId(bid),amount:String(value),reserveFloor:String(expected-value),deadline:String(chainTime+3600n),epoch};
    const signature=await issuer.signTypedData(vaultDomain(c.vaultAddress),BURN_TYPES,payload);
    return {response:{id:bid,amount,reserveFloor:formatAmount(expected-value),deadline:Number(payload.deadline),transaction:{to:c.vaultAddress,data:vaultInterface.encodeFunctionData('executeBurn',[payload,signature]),value:'0x0'}},statements:[
      ...checks,...treasuryUpdate(db,t,{burned:BigInt(t.burned)-value}),
      saveAuthorization(db,{id:bid,kind:'burn',asset,vault:c.vaultAddress,payload,signature,amount:value},now),
      ...transfer(db,op,asset,'burn:'+asset,'burn-locked:'+bid,value,now),
    ]};
  });
}
export async function finishBurn(db,env,key,bid) {
  const v=await authorization(db,env,bid);if(v.kind!=='burn')throw new GameError('销毁批次不存在',404);
  if(v.status!=='authorized')return {id:bid,status:v.status,txHash:v.tx_hash};
  const tx=await execution(env,v);if(!tx&&!await canRelease(env,v))throw new GameError('销毁待确认；凭证过期或链上取消后才能释放额度',409,'CONFIRMING');
  return operation(db,'ops',key,'vault-finish-burn',{bid},async(op,now)=>{
    const current=await first(db,'SELECT * FROM vault_authorizations WHERE id=?',bid);
    if(current.status!=='authorized')return {response:{id:bid,status:current.status,txHash:current.tx_hash},statements:[]};
    const t=await first(db,'SELECT * FROM treasuries WHERE asset=?',v.asset),amount=BigInt(v.amount),status=tx?'confirmed':'rejected';
    return {response:{id:bid,status,txHash:tx},statements:[
      ...(!tx?treasuryUpdate(db,t,{burned:BigInt(t.burned)+amount}):[]),
      stmt(db,'UPDATE vault_authorizations SET status=?,tx_hash=?,updated_at=? WHERE id=? AND status=?',status,tx,now,bid,'authorized'),...guard(db),
      stmt(db,'UPDATE vault_controls SET burning=NULL,revision=revision+1 WHERE asset=? AND burning=?',v.asset,bid),...guard(db),
      ...transfer(db,op,v.asset,'burn-locked:'+bid,tx?'external-burn':'burn:'+v.asset,amount,now),
    ]};
  });
}
