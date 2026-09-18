import { mkdir, writeFile } from 'node:fs/promises';
import { RULES, units, settlement, formatAmount } from '../server/rules.js';
import { BET_PROTECTION, protectionPlan, protectionSettlement, outcomeFor } from '../server/bet-protection.js';

// Exact enumeration of one introductory round and its conditional recovery.
// This is a specified strategy, not the return of all users or five rounds.
const stake = units(5000), secondStake = units(500), initialBalance = units(10000);
const firstPlan = protectionPlan(stake, initialBalance, 0n);
let wagerSum = 0n, payoutSum = 0n;
const rows = firstPlan.drawRules.outcomes.filter(o => o.weight).map(o => {
  const outcome = outcomeFor(o), first = settlement(stake, outcome);
  const firstProtection = protectionSettlement(firstPlan, stake, initialBalance, 0n, null, outcome);
  const loss = firstProtection.pendingAfter;
  const recovery = loss > 0n ? protectionPlan(secondStake, initialBalance - stake + first.net, loss, RULES, 0, 1) : null;
  const second = recovery ? settlement(secondStake, recovery.outcome) : null;
  const recovered = recovery ? protectionSettlement(recovery, secondStake, initialBalance - stake + first.net, loss, 'example-first-round', recovery.outcome) : null;
  const wager = stake + (recovery ? secondStake : 0n), payout = first.net + (second?.net ?? 0n);
  wagerSum += wager * BigInt(o.weight); payoutSum += payout * BigInt(o.weight);
  return { firstMultiplier: o.multiplierBps / 10000, probability: o.weight / firstPlan.drawRules.weightTotal,
    pendingLoss: formatAmount(loss), recoveryMultiplier: recovery ? recovery.outcome.score / 200 : null,
    unrecoveredDifference: recovered?.view.shortfall ?? '0', totalWager: formatAmount(wager), totalPayout: formatAmount(payout), profit: formatAmount(payout - wager) };
});
const denominator = BigInt(firstPlan.drawRules.weightTotal);
const report = { version: BET_PROTECTION.version, method: 'exact-weighted-enumeration',
  conditions: '初始余额10000，首局下注5000，仅在0倍或0.5倍后下注500执行补偿；首局达到余额50%，排除0倍并按剩余基础权重重算概率；账户仍处于前5把。',
  averageWager: formatAmount(wagerSum / denominator), averagePayout: formatAmount(payoutSum / denominator),
  averagePlayerProfit: formatAmount((payoutSum - wagerSum) / denominator),
  rewardRtpPercent: Number(payoutSum * 1000000n / wagerSum) / 10000,
  averagePoolChangeBeforeBurnReferrals: formatAmount((wagerSum - payoutSum) / denominator),
  averagePoolChangeAfterBurnAndBothReferrals: formatAmount((wagerSum - payoutSum - wagerSum * 2930n / 10000n) / denominator),
  limits: '不是账户全生命周期返还率，不保证10%最大亏损或7亏3赚。推荐按满足两层全部条件计入20%流水成本，销毁另计9.3%。未计金元宝未来兑换、交易税和Gas。', rows };
const out = new URL('../outputs/first-five-recovery/', import.meta.url); await mkdir(out, { recursive: true });
await writeFile(new URL('analysis.json', out), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
