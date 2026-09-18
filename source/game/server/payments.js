import { Interface,Transaction,getAddress } from 'ethers';
import { GameError,parseAmount,formatAmount } from './rules.js';
import { tokenAddress,tokenAsset } from './auth.js';
import { id,first,all,stmt,guard,accountUpdate,treasuryUpdate,transfer,operation } from './db.js';
import { WITHDRAWAL_FEE, withdrawalQuote, withdrawalAmounts, withdrawalView } from './withdrawal-fee.js';
import { accountPolicy, policyGuard } from './whitelist.js';
import { creditVaultDeposit, requestVaultWithdrawal, finishVaultWithdrawal } from './vault-payments.js';
const erc20=new Interface(['function transfer(address to,uint256 amount) returns (bool)','event Transfer(address indexed from,address indexed to,uint256 value)']);
const ZERO='0x0000000000000000000000000000000000000000';
const address=s=>{try{const a=getAddress(s).toLowerCase();if(a===ZERO)throw Error();return a;}catch{throw new GameError('收款配置无效',503,'PAYMENTS_NOT_CONFIGURED');}};
export function paymentConfig(env){const requested=Number(env.BSC_CONFIRMATIONS||20),confirmations=Number.isInteger(requested)&&requested>=20&&requested<=1000?requested:20,mode=env.PAYMENT_MODE||'vault';let ready=false,vaultAddress=null;try{vaultAddress=mode==='vault'?address(env.VAULT_ADDRESS):null;ready=['vault','legacy-wallet'].includes(mode)&&env.LIVE_PAYMENTS_ENABLED==='true'&&address(mode==='vault'?vaultAddress:env.DEPOSIT_ADDRESS)!==ZERO&&address(tokenAddress(env))!==ZERO&&/^https:\/\//.test(env.BSC_RPC_URL||'')&&/^\d+$/.test(env.DEPOSIT_START_BLOCK||'')&&(env.OPS_AUTH_KEY||'').length>=32&&(mode!=='vault'||/^0x[0-9a-fA-F]{64}$/.test(env.VAULT_SIGNER_PRIVATE_KEY||''));}catch{}return {enabled:!!ready,mode,chainId:56,token:tokenAddress(env),symbol:env.TOKEN_SYMBOL||'TST',decimals:18,withdrawalFee:WITHDRAWAL_FEE,vaultAddress:ready?vaultAddress:null,depositAddress:ready?(vaultAddress||env.DEPOSIT_ADDRESS):null,confirmations};}
function requireLive(env){const c=paymentConfig(env);if(!c.enabled)throw new GameError('充值提现暂未开放',503,'PAYMENTS_CLOSED');return c;}
export async function rpc(env,method,params){const f=env.RPC_FETCH||fetch;let response;try{response=await f(env.BSC_RPC_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});}catch{throw new GameError('链上服务暂时无法连接，请稍后重试',503,'RPC_UNAVAILABLE');}if(!response.ok)throw new GameError('链上服务暂时不可用',503);const data=await response.json();if(data.error)throw new GameError('链上请求未完成，请稍后核对',503,'RPC_ERROR');return data.result;}
const txHash=x=>{if(typeof x!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(x))throw new GameError('请输入完整的交易哈希');return x.toLowerCase();};
export async function receipt(env,hash){const config=requireLive(env);hash=txHash(hash);if(BigInt(await rpc(env,'eth_chainId',[]))!==56n)throw new GameError('链上服务不是 BSC 主网',503);const r=await rpc(env,'eth_getTransactionReceipt',[hash]);if(!r||r.transactionHash?.toLowerCase()!==hash)throw new GameError('交易还未上链，请稍后核对',409,'CONFIRMING');const block=await rpc(env,'eth_getBlockByNumber',[r.blockNumber,false]);if(!block||block.hash?.toLowerCase()!==r.blockHash?.toLowerCase())throw new GameError('交易所在区块发生变化，请稍后核对',409,'CONFIRMING');const head=BigInt(await rpc(env,'eth_blockNumber',[])),height=BigInt(r.blockNumber);if(head-height+1n<BigInt(config.confirmations))throw new GameError(`交易确认中，需要 ${config.confirmations} 个区块确认`,409,'CONFIRMING');return r;}
function received(r,token,from,to){let sum=0n;for(const log of r.logs??[]){if(log.removed||log.address?.toLowerCase()!==token)continue;try{const event=erc20.parseLog(log);if(event?.name==='Transfer'&&event.args.from.toLowerCase()===from&&event.args.to.toLowerCase()===to)sum+=event.args.value;}catch{}}return sum;}
async function incomingProof(env,hash,from){const c=requireLive(env);if(from===address(c.depositAddress))throw new GameError('收款钱包不能向自身充值或计入奖池');const r=await receipt(env,hash);if(BigInt(r.status)!==1n)throw new GameError('这笔充值交易未成功');if(BigInt(r.blockNumber)<BigInt(env.DEPOSIT_START_BLOCK))throw new GameError('该交易早于充值开放时间');const decimals=await rpc(env,'eth_call',[{to:c.token,data:'0x313ce567'},'latest']);if(BigInt(decimals)!==18n)throw new GameError('代币精度与当前配置不一致，暂停入账',503);const t=await rpc(env,'eth_getTransactionByHash',[hash]);if(!t||t.from?.toLowerCase()!==from||t.to?.toLowerCase()!==c.token)throw new GameError('请使用已连接钱包直接转账到充值地址');let args;try{args=erc20.parseTransaction({data:t.input,value:BigInt(t.value||'0x0')});}catch{}if(args?.name!=='transfer'||args.args.to.toLowerCase()!==address(c.depositAddress))throw new GameError('交易收款地址不匹配');const amount=received(r,c.token,from,address(c.depositAddress));if(amount<=0n)throw new GameError('这笔交易没有实际收到对应代币');return {r,amount};}
export async function creditDeposit(db,env,owner,key,hash){if(paymentConfig(env).mode==='vault')return creditVaultDeposit(db,env,owner,key,hash);requireLive(env);hash=txHash(hash);const a=await first(db,'SELECT * FROM accounts WHERE id=?',owner);if(!a?.wallet||a.asset!==tokenAsset(env))throw new GameError('请先连接正式钱包',401);const proof=await incomingProof(env,hash,a.wallet);
 return operation(db,owner,key,'deposit',{hash},async(op,now)=>{const existing=await first(db,'SELECT * FROM deposits WHERE asset=? AND tx_hash=?',a.asset,hash);if(existing){if(existing.owner!==owner)throw new GameError('该交易已经入账',409);return {response:{status:'confirmed',amount:formatAmount(existing.amount),txHash:hash},statements:[]};}const current=await first(db,'SELECT * FROM accounts WHERE id=?',owner);return {response:{status:'confirmed',amount:formatAmount(proof.amount),txHash:hash},statements:[...accountUpdate(db,current,{available:BigInt(current.available)+proof.amount}),stmt(db,'INSERT INTO deposits(id,owner,tx_hash,block_hash,block_number,amount,asset,created_at) VALUES (?,?,?,?,?,?,?,?)',id(),owner,hash,proof.r.blockHash,Number(BigInt(proof.r.blockNumber)),String(proof.amount),a.asset,now),...transfer(db,op,a.asset,'external',owner+':available',proof.amount,now)]};});}
export async function fundTreasury(db,env,key,hash){if(env.POOL_FUND_SYNC_ENABLED==='true')throw new GameError('注资已改为自动核对，请刷新游戏池状态',409,'AUTOMATIC_POOL_FUNDING');if(paymentConfig(env).mode==='vault')return creditVaultDeposit(db,env,'ops',key,hash,true);requireLive(env);const from=address(env.TREASURY_FUNDING_ADDRESS);hash=txHash(hash);const proof=await incomingProof(env,hash,from),asset=tokenAsset(env);await stmt(db,'INSERT OR IGNORE INTO treasuries(asset,available,burned,fees,revision) VALUES (?,?,?,?,0)',asset,'0','0','0').run();return operation(db,'ops',key,'fund',{hash},async(op,now)=>{if(await first(db,'SELECT id FROM deposits WHERE asset=? AND tx_hash=?',asset,hash))throw new GameError('该交易已入账，不可再次计入奖池',409);const t=await first(db,'SELECT * FROM treasuries WHERE asset=?',asset);return {response:{amount:formatAmount(proof.amount)},statements:[...treasuryUpdate(db,t,{available:BigInt(t.available)+proof.amount}),stmt(db,'INSERT INTO deposits(id,owner,tx_hash,block_hash,block_number,amount,asset,created_at) VALUES (?,?,?,?,?,?,?,?)',id(),'pool:'+asset,hash,proof.r.blockHash,Number(BigInt(proof.r.blockNumber)),String(proof.amount),asset,now),...transfer(db,op,asset,'external','pool:'+asset,proof.amount,now)]};});}
async function withdrawalAccount(db,env,owner,value) {
 const a=await first(db,'SELECT * FROM accounts WHERE id=?',owner);
 if(!a?.wallet||a.asset!==tokenAsset(env))throw new GameError('测试币不能提现');
 if(value>BigInt(a.available))throw new GameError('可用余额不足');
 return a;
}
export async function quoteWithdrawal(db,env,owner,amount) {
 requireLive(env);
 const a=await withdrawalAccount(db,env,owner,parseAmount(amount)),policy=await accountPolicy(db,a);
 return {...withdrawalQuote(amount,policy.withdrawalFee),recipient:a.wallet,feeExempt:policy.benefits.withdrawalFeeExempt};
}
export async function requestWithdrawal(db,env,owner,key,amount,feeVersion) {
 if(paymentConfig(env).mode==='vault')return requestVaultWithdrawal(db,env,owner,key,amount,feeVersion);
 requireLive(env);
 const value=parseAmount(amount);
 // Keep the original fingerprint so requests committed before migration can be recovered.
 return operation(db,owner,key,'withdraw',{amount},async(op,now)=>{
  const a=await withdrawalAccount(db,env,owner,value),policy=await accountPolicy(db,a),wid=id();
  if(feeVersion!==policy.withdrawalFee.version)throw new GameError('提现费率已更新，请重新查看手续费后确认',409,'FEE_CHANGED');
  const quote=withdrawalQuote(amount,policy.withdrawalFee);
  return {response:{id:wid,status:'queued',...quote,recipient:a.wallet,feeExempt:policy.benefits.withdrawalFeeExempt},statements:[
   ...policyGuard(db,policy.guard),
   ...accountUpdate(db,a,{available:BigInt(a.available)-value,locked:BigInt(a.locked)+value}),
   stmt(db,'INSERT INTO withdrawals(id,owner,asset,amount,fee,fee_bps,fee_version,recipient,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',wid,owner,a.asset,String(value),String(value-parseAmount(quote.payout)),quote.feeBps,quote.feeVersion,a.wallet,'queued',now,now),
   ...transfer(db,op,a.asset,owner+':available',owner+':locked',value,now)
  ]};
 });
}
export async function attachSignedWithdrawal(db,env,key,wid,raw){if(paymentConfig(env).mode!=='legacy-wallet')throw new GameError('托管模式不使用收款钱包签名转账',409);const c=requireLive(env);if(typeof raw!=='string'||raw.length>6000)throw new GameError('已签名交易格式无效');let tx;try{tx=Transaction.from(raw);}catch{throw new GameError('已签名交易格式无效');}let parsed;try{parsed=erc20.parseTransaction({data:tx.data,value:tx.value});}catch{}const w=await first(db,'SELECT * FROM withdrawals WHERE id=?',wid);if(!w)throw new GameError('提现记录不存在',404);if(!tx.isSigned()||tx.chainId!==56n||tx.from?.toLowerCase()!==address(c.depositAddress)||tx.to?.toLowerCase()!==c.token||tx.value!==0n||parsed?.name!=='transfer'||parsed.args.to.toLowerCase()!==w.recipient||parsed.args.amount!==withdrawalAmounts(w).payout)throw new GameError('签名交易与提现金额、收款人或网络不匹配');return operation(db,'ops',key,'attach-withdrawal',{wid,hash:tx.hash},async()=>{const current=await first(db,'SELECT * FROM withdrawals WHERE id=?',wid);if(current.status!=='queued')throw new GameError('该提现已处理',409);return {response:{id:wid,status:'submitted',txHash:tx.hash},statements:[stmt(db,'UPDATE withdrawals SET status=?,tx_hash=?,raw_tx=?,sender_nonce=?,updated_at=? WHERE id=? AND status=?','submitted',tx.hash,raw,`56:${tx.from.toLowerCase()}:${tx.nonce}`,Date.now(),wid,'queued'),...guard(db)]};});}
export async function broadcastWithdrawal(db,env,wid){if(paymentConfig(env).mode!=='legacy-wallet')throw new GameError('托管模式请提交合约提现凭证',409);requireLive(env);const w=await first(db,'SELECT * FROM withdrawals WHERE id=?',wid);if(!w||w.status!=='submitted'||!w.raw_tx)throw new GameError('没有待发送的已签名交易');try{const result=await rpc(env,'eth_sendRawTransaction',[w.raw_tx]);if(result?.toLowerCase()!==w.tx_hash.toLowerCase())throw new GameError('广播回执不匹配，需核对链上状态',503);}catch(e){const existing=await rpc(env,'eth_getTransactionByHash',[w.tx_hash]);if(!existing)throw e;}return {id:wid,status:'submitted',txHash:w.tx_hash};}
export async function finishWithdrawal(db,env,owner,key,wid) {
 if(paymentConfig(env).mode==='vault')return finishVaultWithdrawal(db,env,owner,key,wid);
 requireLive(env);
 const w=await first(db,'SELECT * FROM withdrawals WHERE id=?',wid);
 if(!w||(owner!=='ops'&&w.owner!==owner))throw new GameError('提现记录不存在',404);
 if(w.status==='confirmed'||w.status==='failed')return {id:wid,status:w.status,txHash:w.tx_hash};
 if(w.status!=='submitted'||!w.tx_hash)throw new GameError('提现仍在处理中',409,'CONFIRMING');
 const r=await receipt(env,w.tx_hash),success=BigInt(r.status)===1n;
 if(success&&received(r,tokenAddress(env),address(env.DEPOSIT_ADDRESS),w.recipient)!==withdrawalAmounts(w).payout)throw new GameError('实际到账金额不匹配，已保留冻结金额等待核对',409,'PAYOUT_REVIEW');
 return operation(db,owner,key,'finish-withdrawal',{wid},async(op,now)=>{
  const current=await first(db,'SELECT * FROM withdrawals WHERE id=?',wid);
  if(current.status!=='submitted')return {response:{id:wid,status:current.status,txHash:current.tx_hash},statements:[]};
  const a=await first(db,'SELECT * FROM accounts WHERE id=?',w.owner),{amount,fee,payout}=withdrawalAmounts(current);
  if(BigInt(a.locked)<amount)throw new Error('Withdrawal reserve mismatch');
  const feeStatements=[];
  if(success&&fee>0n) {
   const treasury=await first(db,'SELECT * FROM treasuries WHERE asset=?',a.asset);
   if(!treasury)throw new Error('Withdrawal treasury missing');
   feeStatements.push(...treasuryUpdate(db,treasury,{available:BigInt(treasury.available)+fee,fees:BigInt(treasury.fees)+fee}),...transfer(db,op,a.asset,w.owner+':locked','pool:'+a.asset,fee,now));
  }
  return {response:{id:wid,status:success?'confirmed':'failed',txHash:w.tx_hash},statements:[
   ...accountUpdate(db,a,{locked:BigInt(a.locked)-amount,available:BigInt(a.available)+(success?0n:amount)}),
   stmt(db,'UPDATE withdrawals SET status=?,updated_at=? WHERE id=? AND status=?',success?'confirmed':'failed',now,wid,'submitted'),...guard(db),
   ...transfer(db,op,a.asset,w.owner+':locked',success?'external':w.owner+':available',success?payout:amount,now),...feeStatements
  ]};
 });
}
export async function rejectWithdrawal(db,env,key,wid){requireLive(env);return operation(db,'ops',key,'reject-withdrawal',{wid},async(op,now)=>{const w=await first(db,'SELECT * FROM withdrawals WHERE id=?',wid);if(!w||w.status!=='queued')throw new GameError('只能退回尚未签名发送的提现',409);const a=await first(db,'SELECT * FROM accounts WHERE id=?',w.owner),amount=BigInt(w.amount);if(BigInt(a.locked)<amount)throw new Error('Reserve mismatch');return {response:{id:wid,status:'rejected'},statements:[...accountUpdate(db,a,{available:BigInt(a.available)+amount,locked:BigInt(a.locked)-amount}),stmt(db,'UPDATE withdrawals SET status=?,updated_at=? WHERE id=? AND status=?','rejected',now,wid,'queued'),...guard(db),...transfer(db,op,a.asset,w.owner+':locked',w.owner+':available',amount,now)]};});}
export async function paymentHistory(db,owner){return {deposits:(await all(db,'SELECT tx_hash,amount,created_at FROM deposits WHERE owner=? ORDER BY created_at DESC LIMIT 30',owner)).map(x=>({...x,amount:formatAmount(x.amount)})),withdrawals:(await all(db,'SELECT id,amount,fee,fee_bps,fee_version,recipient,status,tx_hash,created_at FROM withdrawals WHERE owner=? ORDER BY created_at DESC LIMIT 30',owner)).map(withdrawalView)};}
