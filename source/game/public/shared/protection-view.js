// Public terms and account status; the server alone settles money and rounds.
export const INTRO_RECOVERY_TERMS = '每局下注达到下注前可用余额（含尚未入余额的历史奖励）的50%时，不会开出0×，其他奖项按原权重比例重新计算；这条大额保护在第5把以后仍然有效。账户前5个已结算回合出现0×或0.5×，该局代币损失记为待补偿。下一次成功下注为补偿局：由玩家自行选择下一把金额，按扣费后的净盈利选择最接近前局损失的现有盈利倍率，最低1.2×、最高10×；距离相同时选较低倍率。允许少补或多补，不额外补齐，不把差额延续到后面的回合。补偿局按上述规则确定倍率，不是普通随机开奖。第5把产生的补偿在第6把兑现；第6把及以后不再产生新补偿。充值、提现不重置次数或清除待补偿。未继续游戏时待补偿保留，不会自动到账；下一把仍需足够下注余额及可用奖池。本规则允许补偿前暂时亏损超过充值本金10%，不保证任何时刻的亏损上限，也不保证7人亏、3人赚。';
export function protectionNotice(protection, rules) {
  if (!rules?.protection?.enabled) return '';
  if (!protection) return '前5把亏损可在下一把补偿，允许差额。';
  if (protection.nextRoundIsRecovery) return `下一把为补偿局：待补偿 ${protection.pendingLoss} 币，按本局金额匹配最接近损失的净盈利倍率，允许差额。`;
  if (protection.remainingQualifyingRounds > 0) return `前5把补偿：已完成 ${Math.min(5, protection.completedRounds)} / 5 把；0× / 0.5×损失在下一把补偿，期间可能亏损超过10%。`;
  return '前5把补偿已结束；下注达到可用余额50%仍有不出0×保护。';
}
export function recoveryDetail(round) {
  const p = round.protection;
  if (!p) return '';
  if (p.mode === 'recovery') return `补偿局 · 本局净盈利 ${p.netProfit ?? round.profit} 币，对应前局损失 ${p.pendingBefore} 币` + (Number(p.shortfall) > 0 ? `；未补差额 ${p.shortfall} 币不结转` : '');
  if (Number(p.pendingAfter) > 0) return `本局损失 ${p.pendingAfter} 币已记入待补偿，尚未到账`;
  return '';
}
