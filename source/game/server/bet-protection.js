import { RULES, GameError, drawWheel, settlement, formatAmount } from './rules.js';

export const BET_PROTECTION = Object.freeze({
  version: 'high-stake-recovery-v2', thresholdBps: 5000, lossMultiplierBps: 5000, maxCompensations: 3,
  balanceBasis: 'available-plus-unclaimed-rewards', recoveryBasis: 'next-round-net-profit',
  recoveryPolicy: 'smallest-listed-multiplier-or-cap-once',
});
export const protectionOptions = env => ({ protectionEnabled: env?.BET_PROTECTION_ENABLED === 'true' });

export function protectionRules(rules = RULES, enabled = false) {
  if (!enabled) return rules;
  // The original table remains the base distribution, not the overall RTP
  // once outcomes also depend on stake size and a previous round.
  return { ...rules, version: rules.version + ':' + BET_PROTECTION.version,
    baseNetRtp: rules.netRtp, netRtp: null, resultProbabilities: null,
    rtpScope: 'state-dependent-no-fixed-overall-rtp', protection: { ...BET_PROTECTION, enabled: true } };
}
export function protectionState(account, enabled) {
  if (!enabled) return undefined;
  return { ...BET_PROTECTION, enabled: true,
    used: account.recovery_used ?? 0, remaining: BET_PROTECTION.maxCompensations - (account.recovery_used ?? 0),
    balanceBefore: formatAmount(BigInt(account.available) + BigInt(account.rewards)),
    pendingLoss: formatAmount(account.recovery_loss ?? '0'), sourceRound: account.recovery_round ?? null };
}
export function isHighStake(stake, balance) {
  return balance > 0n && stake * 10000n >= balance * BigInt(BET_PROTECTION.thresholdBps);
}
export function outcomeFor(definition) {
  return { score: definition.multiplierBps / 50, sequence: [definition.multiplierBps / 1000], outcomeId: definition.id };
}
export function recoveryOutcome(stake, loss, rules = RULES) {
  const candidates = rules.outcomes.filter(o => o.multiplierBps > 10000 && o.multiplierBps <= rules.maxPayoutBps)
    .sort((a, b) => a.multiplierBps - b.multiplierBps);
  if (!candidates.length) throw new GameError('补偿规则缺少有效倍率，请联系管理员', 503, 'PROTECTION_CONFIG');
  return outcomeFor(candidates.find(o => settlement(stake, outcomeFor(o)).net - stake >= loss) ?? candidates.at(-1));
}
export function protectionPlan(stake, balance, pendingLoss, rules = RULES, used = 0) {
  if (!Number.isInteger(used) || used < 0 || used > BET_PROTECTION.maxCompensations || (pendingLoss > 0n && used === BET_PROTECTION.maxCompensations)) {
    throw new GameError('补偿记录异常，请联系管理员', 503, 'PROTECTION_STATE');
  }
  const quota = { used, canEarnRecovery: used < BET_PROTECTION.maxCompensations };
  const highStake = isHighStake(stake, balance);
  if (pendingLoss > 0n) return { ...quota, mode: 'recovery', highStake, outcome: recoveryOutcome(stake, pendingLoss, rules) };
  if (!highStake) return { ...quota, mode: 'standard', highStake, drawRules: rules };
  const outcomes = rules.outcomes.map(o => ({ ...o, weight: o.multiplierBps === 0 ? 0 : o.weight }));
  const weightTotal = outcomes.reduce((sum, o) => sum + o.weight, 0);
  if (weightTotal <= 0) throw new GameError('大额保护与当前钱包规则冲突，请联系管理员', 503, 'PROTECTION_CONFIG');
  return { ...quota, mode: 'high-stake', highStake, drawRules: { ...rules, outcomes, weightTotal } };
}
export function selectProtectedOutcome(plan, outcomeFactory) {
  if (plan.outcome) return plan.outcome;
  const outcome = outcomeFactory ? outcomeFactory(plan.drawRules) : drawWheel(undefined, plan.drawRules);
  const valid = plan.drawRules.outcomes.find(o => o.id === outcome.outcomeId && o.weight > 0 && o.multiplierBps === outcome.score * 50);
  if (!valid) throw new GameError('开奖结果不符合本局规则', 503, 'INVALID_PROTECTED_OUTCOME');
  return outcome;
}
export function protectionSettlement(plan, stake, balance, pendingLoss, sourceRound, outcome) {
  const s = settlement(stake, outcome), profit = s.net - stake;
  const pendingAfter = plan.canEarnRecovery && plan.mode === 'high-stake' && outcome.score * 50 === BET_PROTECTION.lossMultiplierBps ? stake - s.net : 0n;
  const recovered = plan.mode === 'recovery' ? (profit < pendingLoss ? profit : pendingLoss) : 0n;
  const usedAfter = plan.used + (plan.mode === 'recovery' ? 1 : 0);
  return { pendingAfter, usedAfter, view: {
    version: BET_PROTECTION.version, mode: plan.mode, highStake: plan.highStake,
    maxCompensations: BET_PROTECTION.maxCompensations, usedBefore: plan.used, usedAfter,
    remaining: BET_PROTECTION.maxCompensations - usedAfter,
    balanceBefore: formatAmount(balance), pendingBefore: formatAmount(pendingLoss),
    pendingAfter: formatAmount(pendingAfter), sourceRound: plan.mode === 'recovery' ? sourceRound : null,
    recovered: formatAmount(recovered), shortfall: formatAmount(plan.mode === 'recovery' ? pendingLoss - recovered : 0n),
    capped: plan.mode === 'recovery' && profit < pendingLoss,
    drawWeights: plan.drawRules ? plan.drawRules.outcomes.map(o => ({ id: o.id, weight: o.weight })) : null,
  } };
}
