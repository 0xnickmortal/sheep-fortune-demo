import { RULES, GameError, drawWheel, settlement, formatAmount } from './rules.js';

export const BET_PROTECTION = Object.freeze({
  version: 'first-five-high-stake-recovery-v4', qualifyingRounds: 5,
  highStakeThresholdBps: 5000, highStakeBalanceBasis: 'available-plus-unclaimed-rewards',
  highStakeExcludesZero: true,
  lossMultipliersBps: Object.freeze([0, 5000]),
  recoveryBasis: 'next-round-net-profit',
  recoveryPolicy: 'closest-listed-positive-net-profit-once',
  countBasis: 'account-lifetime-settled-rounds', carryFifthToSixth: true,
  lossCapGuaranteed: false,
});
export const protectionOptions = env => ({ protectionEnabled: env?.BET_PROTECTION_ENABLED === 'true' });

export function protectionRules(rules = RULES, enabled = false) {
  if (!enabled) return rules;
  return { ...rules, version: rules.version + ':' + BET_PROTECTION.version,
    baseNetRtp: rules.netRtp, netRtp: null, resultProbabilities: null,
    rtpScope: 'state-dependent-no-fixed-overall-rtp', protection: { ...BET_PROTECTION, enabled: true } };
}
export function protectionState(account, enabled, completedRounds = 0) {
  if (!enabled) return undefined;
  const pendingLoss = BigInt(account.recovery_loss ?? '0');
  return { ...BET_PROTECTION, enabled: true,
    used: account.recovery_used ?? 0, completedRounds,
    remainingQualifyingRounds: Math.max(0, BET_PROTECTION.qualifyingRounds - completedRounds),
    nextRoundIsRecovery: pendingLoss > 0n,
    pendingLoss: formatAmount(pendingLoss), sourceRound: account.recovery_round ?? null };
}
export function isHighStake(stake, balance) {
  return balance > 0n && stake * 10000n >= balance * BigInt(BET_PROTECTION.highStakeThresholdBps);
}
export function outcomeFor(definition) {
  return { score: definition.multiplierBps / 50, sequence: [definition.multiplierBps / 1000], outcomeId: definition.id };
}
export function recoveryOutcome(stake, loss, rules = RULES) {
  const candidates = rules.outcomes.filter(o => o.multiplierBps > 10000 && o.multiplierBps <= rules.maxPayoutBps)
    .sort((a, b) => a.multiplierBps - b.multiplierBps);
  if (!candidates.length) throw new GameError('补偿规则缺少有效倍率，请联系管理员', 503, 'PROTECTION_CONFIG');
  const distance = o => { const delta = settlement(stake, outcomeFor(o)).net - stake - loss; return delta < 0n ? -delta : delta; };
  // Compare actual net profit in the token's smallest unit. On a tie choose
  // the lower multiplier; the single-settlement difference is not carried.
  return outcomeFor(candidates.reduce((best, candidate) => distance(candidate) < distance(best) ? candidate : best));
}
export function protectionPlan(stake, balance, pendingLoss, rules = RULES, used = 0, completedRounds = 0) {
  if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(completedRounds) || completedRounds < 0 || pendingLoss < 0n) {
    throw new GameError('补偿记录异常，请联系管理员', 503, 'PROTECTION_STATE');
  }
  const state = { used, completedRounds, highStake: isHighStake(stake, balance), canEarnRecovery: completedRounds < BET_PROTECTION.qualifyingRounds };
  // Honour existing entitlements, including round 5 and the previous version.
  // Deposits and withdrawals do not reset the settled-round counter.
  if (pendingLoss > 0n) return { ...state, mode: 'recovery', outcome: recoveryOutcome(stake, pendingLoss, rules) };
  let drawRules = rules;
  if (state.highStake) {
    const outcomes = rules.outcomes.map(o => ({ ...o, weight: o.multiplierBps === 0 ? 0 : o.weight }));
    const weightTotal = outcomes.reduce((sum, o) => sum + o.weight, 0);
    if (weightTotal <= 0) throw new GameError('大额保护与当前钱包规则冲突，请联系管理员', 503, 'PROTECTION_CONFIG');
    drawRules = { ...rules, outcomes, weightTotal };
  }
  return { ...state, mode: state.canEarnRecovery ? 'intro' : state.highStake ? 'high-stake' : 'standard', drawRules };
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
  const isRecovery = plan.mode === 'recovery';
  const shortfall = isRecovery && profit < pendingLoss ? pendingLoss - profit : 0n;
  const pendingAfter = !isRecovery && plan.canEarnRecovery && BET_PROTECTION.lossMultipliersBps.includes(outcome.score * 50) ? stake - s.net : 0n;
  const usedAfter = plan.used + (isRecovery ? 1 : 0);
  return { pendingAfter, usedAfter, view: {
    version: BET_PROTECTION.version, mode: plan.mode, highStake: plan.highStake, roundNumber: plan.completedRounds + 1,
    qualifyingRounds: BET_PROTECTION.qualifyingRounds,
    usedBefore: plan.used, usedAfter,
    remainingQualifyingRounds: Math.max(0, BET_PROTECTION.qualifyingRounds - plan.completedRounds - 1),
    balanceBefore: formatAmount(balance), pendingBefore: formatAmount(pendingLoss),
    pendingAfter: formatAmount(pendingAfter), sourceRound: isRecovery ? sourceRound : null,
    recovered: formatAmount(isRecovery ? (profit < pendingLoss ? profit : pendingLoss) : 0n),
    netProfit: formatAmount(profit), shortfall: formatAmount(shortfall), differenceCarried: false,
    drawWeights: plan.drawRules ? plan.drawRules.outcomes.map(o => ({ id: o.id, weight: o.weight })) : null,
  } };
}
