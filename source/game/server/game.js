import { RULES,UNIT,units,formatAmount,parseAmount,maxBet,maximumPayout,settlement,ingotAward,drawWheel,GameError } from './rules.js';
import { id,first,all,stmt,accountUpdate,treasuryUpdate,transfer,operation } from './db.js';
import { accountPolicy, policyGuard } from './whitelist.js';
import { referralStatus, referralSettlement } from './referrals.js';
import { vaultControl, custodyGuard } from './vault-guard.js';
import { protectionRules, protectionState, protectionPlan, selectProtectedOutcome, protectionSettlement } from './bet-protection.js';
export async function ensureDemo(db,owner){const now=Date.now(),grant=units(RULES.demoGrant),pool=units(RULES.initialDemoPool);await db.batch([
 stmt(db,'INSERT OR IGNORE INTO treasuries(asset,available,burned,fees,revision) VALUES (?,?,?,?,0)','demo',String(pool),'0','0'),
 stmt(db,'INSERT OR IGNORE INTO ledger(id,operation,asset,debit,credit,amount,created_at) VALUES (?,?,?,?,?,?,?)','demo-pool-seed','demo-pool-seed','demo','demo-issuer','pool:demo',String(pool),now),
 stmt(db,'INSERT OR IGNORE INTO accounts(id,wallet,asset,available,rewards,locked,revision,last_play,created_at) VALUES (?,NULL,?,?,?,?,0,0,?)',owner,'demo',String(grant),'0','0',now),
 stmt(db,'INSERT OR IGNORE INTO ledger(id,operation,asset,debit,credit,amount,created_at) VALUES (?,?,?,?,?,?,?)','grant:'+owner,'grant:'+owner,'demo','demo-issuer',owner+':available',String(grant),now)
]);return first(db,'SELECT * FROM accounts WHERE id=?',owner);}
// Existing claimable rewards are credited exactly once, using BigInt rather
// than SQLite numeric casts, so old 18-decimal balances keep every unit.
export async function settleLegacyRewards(db,owner) {
 const initial=await first(db,'SELECT * FROM accounts WHERE id=?',owner);
 if(!initial||BigInt(initial.rewards)===0n)return;
 return operation(db,owner,'auto-credit-legacy-rewards-'+initial.revision,'auto-credit-rewards',{},async(op,now)=>{
  const a=await first(db,'SELECT * FROM accounts WHERE id=?',owner),amount=BigInt(a.rewards);
  const response={amount:formatAmount(amount),balance:formatAmount(BigInt(a.available)+amount),rewards:'0'};
  if(!amount)return {response,statements:[]};
  return {response,statements:[...accountUpdate(db,a,{available:BigInt(a.available)+amount,rewards:0n}),stmt(db,'UPDATE rounds SET claimed=1 WHERE owner=? AND claimed=0',owner),...transfer(db,op,a.asset,owner+':rewards',owner+':available',amount,now)]};
 });
}
export async function getState(db,owner,{protectionEnabled=false}={}) {
 await settleLegacyRewards(db,owner);
 const a=await first(db,'SELECT * FROM accounts WHERE id=?',owner);
 if(!a)throw new GameError('请先进入游戏',401,'LOGIN_REQUIRED');
 const t=await first(db,'SELECT * FROM treasuries WHERE asset=?',a.asset);
 if(!t)throw new GameError('奖池暂未准备好',503);
 const policy=await accountPolicy(db,a);
 const completedRounds=protectionEnabled?(await first(db,'SELECT COUNT(*) n FROM rounds WHERE owner=?',owner)).n:0;
 return {mode:a.asset==='demo'?'demo':'token',wallet:a.wallet,balance:formatAmount(a.available),rewards:formatAmount(a.rewards),ingots:formatAmount(a.ingots??'0'),locked:formatAmount(a.locked),pool:formatAmount(t.available),burned:formatAmount(t.burned),maxBet:formatAmount(maxBet(BigInt(t.available))),revision:a.revision,rules:protectionRules(policy.rules,protectionEnabled),...(protectionEnabled?{protection:protectionState(a,true,completedRounds)}:{}),benefits:policy.benefits,withdrawalFee:policy.withdrawalFee,referral:await referralStatus(db,a)};
}
export async function play(db,owner,key,amount,{outcomeFactory,minimumInterval=1500,expectedVersion,requireRulesVersion=false,protectionEnabled=false}={}) {
 const stake=parseAmount(amount,{integer:true});
 if(stake<units(RULES.minBet)||stake>units(RULES.maxBet))throw new GameError(`每局投入 ${RULES.minBet}–${RULES.maxBet} 币`);
 let outcome,outcomeVersion;
 return operation(db,owner,key,'play',{amount},async(op,now)=>{
  const a=await first(db,'SELECT * FROM accounts WHERE id=?',owner),t=a&&await first(db,'SELECT * FROM treasuries WHERE asset=?',a.asset);
  if(!a||!t)throw new GameError('请先进入游戏',401);
  const custody=await vaultControl(db,a.asset);
  if(custody?.burning)throw new GameError('奖池正在执行批量销毁，请稍后再开始',409,'BURN_IN_PROGRESS');
  const policy=await accountPolicy(db,a),rules=protectionRules(policy.rules,protectionEnabled);
  if(requireRulesVersion&&expectedVersion!==rules.version)throw new GameError('游戏规则已更新，请刷新页面确认后再转',409,'RULES_CHANGED');
  if(now-a.last_play<minimumInterval)throw new GameError('上一局刚结束，请稍候再开始',429,'TOO_FAST');
  const legacy=BigInt(a.rewards),spendable=BigInt(a.available)+legacy;
  if(stake>spendable)throw new GameError('余额不足，请先充值');
  if(stake>maxBet(BigInt(t.available)))throw new GameError('本局金额超过可用奖池限额，请降低金额');
  if(BigInt(t.available)<maximumPayout(stake))throw new GameError('奖池不足以覆盖最高奖励，请稍后再试',409);
  const pendingLoss=protectionEnabled?BigInt(a.recovery_loss??'0'):0n;
  const completedRounds=protectionEnabled?(await first(db,'SELECT COUNT(*) n FROM rounds WHERE owner=?',owner)).n:0;
  const plan=protectionEnabled?protectionPlan(stake,spendable,pendingLoss,rules,a.recovery_used??0,completedRounds):null;
  // A competing deposit, withdrawal or spin can change eligibility. Redraw
  // against the newly committed balance instead of reusing an obsolete bonus.
  const drawVersion=protectionEnabled?rules.version+':account:'+a.revision:rules.version;
  if(!outcome||outcomeVersion!==drawVersion){outcome=plan?selectProtectedOutcome(plan,outcomeFactory):outcomeFactory?outcomeFactory(rules):drawWheel(undefined,rules);outcomeVersion=drawVersion;}
  const protection=plan?protectionSettlement(plan,stake,spendable,pendingLoss,a.recovery_round??null,outcome):null;
  const definition=rules.outcomes.find(o=>o.id===outcome.outcomeId),kind=definition?.kind||'payout',s=settlement(stake,outcome),awarded=ingotAward(stake,outcome);
  const roundId=id(),referral=await referralSettlement(db,a,stake,roundId,op,now);
  if(BigInt(t.available)+stake<maximumPayout(stake)+s.burn+referral.total)throw new GameError('奖池不足以覆盖本局最高赔付和推荐奖励',409);
  const nextPool=BigInt(t.available)+stake-s.burn-s.net-referral.total,nextBalance=spendable-stake+s.net,nextIngots=BigInt(a.ingots??'0')+awarded;
  if(nextPool<0n)throw new Error('Negative pool');
  const response={round:{id:roundId,bet:amount,gross:formatAmount(s.gross),fee:formatAmount(s.fee),net:formatAmount(s.net),profit:formatAmount(s.net-stake),ingots:formatAmount(awarded),sequence:outcome.sequence.map(x=>x/10),score:outcome.score,multiplierBps:outcome.score*50,outcomeId:outcome.outcomeId??null,multiplierBasis:rules.multiplierBasis,outcomeKind:kind,outcomeTitle:definition?.title??null,rewardDestination:s.net===0n?'none':'balance',claimed:true,version:rules.version,createdAt:now,referralPaid:formatAmount(referral.total),...(protection?{protection:protection.view}:{})},balance:formatAmount(nextBalance),rewards:'0',ingots:formatAmount(nextIngots),revision:a.revision+1};
  return {response,statements:[
   ...custodyGuard(db,custody),
   ...policyGuard(db,policy.guard),
   ...accountUpdate(db,a,{available:nextBalance,rewards:0n,ingots:nextIngots,last_play:now,...(protection?{recoveryLoss:protection.pendingAfter,recoveryRound:protection.pendingAfter>0n?roundId:null,recoveryUsed:protection.usedAfter}:{})}),
   ...treasuryUpdate(db,t,{available:nextPool,burned:BigInt(t.burned)+s.burn,fees:BigInt(t.fees)+s.fee}),
   ...(legacy?[stmt(db,'UPDATE rounds SET claimed=1 WHERE owner=? AND claimed=0',owner),...transfer(db,op,a.asset,owner+':rewards',owner+':available',legacy,now)]:[]),
   stmt(db,'INSERT INTO rounds(id,owner,operation,bet,gross,fee,net,burn,ingots,score,sequence,rules_version,rules_snapshot,claimed,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',roundId,owner,op,String(stake),String(s.gross),String(s.fee),String(s.net),String(s.burn),String(awarded),outcome.score,JSON.stringify(outcome.sequence),rules.version,JSON.stringify({...rules,referral:referral.snapshot,...(protection?{roundProtection:protection.view}:{})}),1,now),
   ...referral.statements,
   ...transfer(db,op,a.asset,owner+':available','pool:'+a.asset,stake,now),
   ...transfer(db,op,a.asset,'pool:'+a.asset,'burn:'+a.asset,s.burn,now),
   ...transfer(db,op,a.asset,'pool:'+a.asset,owner+':available',s.net,now),
   ...transfer(db,op,'ingots:'+a.asset,'ingot-issuer',owner+':ingots',awarded,now)
  ]};
 });
}
// Compatibility for previously submitted claim requests. New spins never
// create claimable rewards, and the UI has no manual claim step.
export async function claim(db,owner,key) {
 return operation(db,owner,key,'claim',{},async(op,now)=>{
  const a=await first(db,'SELECT * FROM accounts WHERE id=?',owner);
  if(!a)throw new GameError('请先进入游戏',401);
  const amount=BigInt(a.rewards);
  if(amount<=0n)throw new GameError('暂时没有可领取的奖励；游戏奖励已自动到账');
  return {response:{amount:formatAmount(amount),balance:formatAmount(BigInt(a.available)+amount),rewards:'0'},statements:[...accountUpdate(db,a,{available:BigInt(a.available)+amount,rewards:0n}),stmt(db,'UPDATE rounds SET claimed=1 WHERE owner=? AND claimed=0',owner),...transfer(db,op,a.asset,owner+':rewards',owner+':available',amount,now)]};
 });
}
function roundView(r) {
 const snapshot=JSON.parse(r.rules_snapshot),definition=snapshot.outcomes?.find(o=>o.multiplierBps===r.score*50),kind=definition?.kind||'payout';
 return {id:r.id,bet:formatAmount(r.bet),gross:formatAmount(r.gross),fee:formatAmount(r.fee),net:formatAmount(r.net),profit:formatAmount(BigInt(r.net)-BigInt(r.bet)),ingots:formatAmount(r.ingots??'0'),sequence:JSON.parse(r.sequence).map(x=>x/10),multiplierBps:r.score*50,multiplierBasis:snapshot.multiplierBasis||'gross',outcomeKind:kind,outcomeTitle:definition?.title??null,rewardDestination:BigInt(r.net)===0n?'none':snapshot.rewardSettlement==='auto-balance'||kind==='replay'?'balance':'rewards',version:r.rules_version,claimed:!!r.claimed,createdAt:r.created_at,...(snapshot.roundProtection?{protection:snapshot.roundProtection}:{})};
}
export async function history(db,owner) {
 return (await all(db,'SELECT * FROM rounds WHERE owner=? ORDER BY created_at DESC,id DESC LIMIT 50',owner)).map(roundView);
}
// Test builds only: demo accounts can add test coins to try the wheel. Token accounts are refused.
export async function demoTopup(db,owner,key,amount) {
 const value=parseAmount(amount,{integer:true});
 if(value>units('1000000'))throw new GameError('单次最多充值 1,000,000 测试币');
 return operation(db,owner,key,'demo-topup',{amount},async(op,now)=>{
  const a=await first(db,'SELECT * FROM accounts WHERE id=?',owner);
  if(!a)throw new GameError('请先进入游戏',401);
  if(a.asset!=='demo')throw new GameError('只有测试账户可以充值测试币',403,'DEMO_ONLY');
  const next=BigInt(a.available)+value;
  return {response:{amount:formatAmount(value),balance:formatAmount(next),revision:a.revision+1},statements:[...accountUpdate(db,a,{available:next}),...transfer(db,op,a.asset,'demo-issuer',owner+':available',value,now)]};
 });
}
export async function ingotState(db,owner) {
 const a=await first(db,'SELECT * FROM accounts WHERE id=?',owner);
 if(!a)throw new GameError('请先进入游戏',401);
 const rows=await all(db,"SELECT * FROM rounds WHERE owner=? AND ingots!='0' ORDER BY created_at DESC,id DESC LIMIT 50",owner);
 return {balance:formatAmount(a.ingots),revision:a.revision,mode:a.asset==='demo'?'demo':'token',records:rows.map(roundView),redemption:{enabled:false,plannedAssets:['XAUT'],rate:null,minimum:null,message:'金元宝兑换暂未开放，兑换规则将另行公布'}};
}
