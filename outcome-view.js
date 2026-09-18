// Presentation helpers; balances and awarded amounts always come from the server.
export function sectorText(outcome) {
  if (outcome.kind === 'empty') return { label: '谢谢参与', shortLabel: '参与', detail: '获得金元宝', kind: 'empty' };
  if (outcome.kind === 'replay') return { label: '1×', shortLabel: '1×', detail: '本金全返', kind: 'replay' };
  return { label: outcome.multiplierBps / 10000 + '×', shortLabel: String(outcome.multiplierBps / 10000), detail: outcome.id === 'jackpot' ? '两千分之一' : outcome.id === 'small-win' ? '小赚' : '返还倍率', kind: outcome.id === 'jackpot' ? 'jackpot' : outcome.multiplierBps >= 20000 ? 'bonus' : outcome.multiplierBps > 10000 ? 'win' : 'payout' };
}
export function resultText(round) {
  if (round.protection?.mode === 'recovery') return { title: '补偿局 ' + round.multiplierBps / 10000 + '×', amountLabel: '本次合计到账', message: '按已公布的补偿规则结算', record: '补偿局已到账' };
  if (round.outcomeKind === 'empty') return { title: '谢谢参与', amountLabel: '本次代币返还', message: Number(round.ingots)>0?'金元宝已到账':'本次未获得代币奖励', record: Number(round.ingots)>0?'已获得金元宝':'未获得代币奖励' };
  if (round.outcomeKind === 'replay') return { title: '本次转中 1×', amountLabel: '已退回本金', message: '本金已全额退回，不收手续费', record: '本金已退回' };
  return { title: '本次转中 ' + round.multiplierBps / 10000 + '×', amountLabel: '本次代币返还', message: round.rewardDestination==='balance'?'代币已自动到账':round.claimed?'代币已到账':'历史奖励已保存，重新连接后自动到账', record: round.claimed?'已到账':'历史奖励' };
}
