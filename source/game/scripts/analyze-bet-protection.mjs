import { mkdir, writeFile } from 'node:fs/promises';
import { RULES, units, settlement, formatAmount } from '../server/rules.js';
import { BET_PROTECTION, protectionPlan, recoveryOutcome, outcomeFor } from '../server/bet-protection.js';

// Exact enumeration, not a sampled run: start with 10,000, wager 5,000,
// and only after a half payout wager 500 for the one-time recovery.
const stake = units(5000), secondStake = units(500);
const plan = protectionPlan(stake, units(10000), 0n);
let expectedWager = 0n, expectedNet = 0n, expectedIngots = 0n;
const rows = plan.drawRules.outcomes.filter(o => o.weight).map(o => {
  const first = settlement(stake, outcomeFor(o));
  const recover = o.multiplierBps === 5000 ? recoveryOutcome(secondStake, stake - first.net) : null;
  const second = recover ? settlement(secondStake, recover) : null;
  const wager = stake + (recover ? secondStake : 0n), net = first.net + (second?.net ?? 0n);
  expectedWager += wager * BigInt(o.weight); expectedNet += net * BigInt(o.weight);
  if(recover)expectedIngots += (stake-first.net)*BigInt(o.weight);
  return [o.multiplierBps/10000, (o.weight/plan.drawRules.weightTotal*100).toFixed(6),formatAmount(first.net),recover?recover.score/200:'',second?formatAmount(second.net):'',formatAmount(net-wager),formatAmount(units(10000)+net-wager)];
});
const denominator=BigInt(plan.drawRules.weightTotal);
const pct=(num,den)=>Number(num*1000000n/den)/10000;
const baseNet=RULES.outcomes.reduce((n,o)=>n+settlement(stake,outcomeFor(o)).net*BigInt(o.weight),0n);
const triggerProbability = plan.drawRules.outcomes.find(o => o.multiplierBps === 5000).weight / plan.drawRules.weightTotal;
const report={
  method:'exact-weighted-enumeration', unit:'游戏代币',
  model:'大额时移除0倍，其余权重按比例归一化；每钱包累计最多3次补偿，按手续费后的净盈利选择最小现有倍率，上限10倍且差额不延续。',
  compensationLimitPerWallet: BET_PROTECTION.maxCompensations,
  trigger: { conditions:'下注达到当前游戏可用余额50%，无待补偿且次数未用完；结果为0.5倍',
    perQualifyingDrawPercent:triggerProbability*100,
    atLeastOnceWithin5QualifyingDrawsPercent:100*(1-(1-triggerProbability)**5),
    atLeastOnceWithin10QualifyingDrawsPercent:100*(1-(1-triggerProbability)**10),
    scope:'普通基础权重；连续独立的符合条件抽取，不含确定性补偿局，不代表所有玩家的触发占比' },
  baseNetRtpPercent:pct(baseNet,stake*10000n),
  protectedFirstSpinNetRtpPercent:pct(baseNet,stake*denominator),
  cycle:{initialBalance:10000,firstStake:5000,nextStakeOnlyAfterHalf:500,
    averageWager:Number(expectedWager/denominator)/1e18,
    averagePlayerNetProfit:Number((expectedNet-expectedWager)/denominator)/1e18,
    rewardRtpPercent:pct(expectedNet,expectedWager),
    poolRetentionBeforeBurnReferralsPercent:pct(expectedWager-expectedNet,expectedWager),
    poolRetentionAfterBurnNoReferralsPercent:pct(expectedWager-expectedNet-expectedWager*930n/10000n,expectedWager),
    poolRetentionAfterBurnBothReferralsPercent:pct(expectedWager-expectedNet-expectedWager*2930n/10000n,expectedWager),
    averageIngotAward:Number(expectedIngots/denominator)/1e18},
  limits:'cycle只代表额度未用完前的一次特定策略组合，不是3次额度的全生命周期或所有玩家统一返还率。额度用完后仍保留大额不出0倍。未包含充值/提币链上成本、交易税或金元宝兑换成本。'};
const out=new URL('../outputs/bet-protection/',import.meta.url); await mkdir(out,{recursive:true});
await writeFile(new URL('analysis.json',out),JSON.stringify(report,null,2)+'\n');
await writeFile(new URL('scenarios.csv',out),'\uFEFF第一局倍率,第一局占比%,第一局实得币,补偿局倍率,补偿局实得币,合计净赚赔币,最终游戏余额币\n'+rows.map(r=>r.join(',')).join('\n')+'\n');
console.log(JSON.stringify(report,null,2));
