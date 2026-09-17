import { formatAmount, parseAmount } from './rules.js';

export const WITHDRAWAL_FEE = Object.freeze({ bps: 0, version: 'withdrawal-no-fee-v2-20260915' });

export function withdrawalQuote(amount, policy = WITHDRAWAL_FEE) {
  const value = parseAmount(amount);
  // Round down only at the token's smallest unit, never with floating-point math.
  const fee = value * BigInt(policy.bps) / 10000n;
  return { amount: formatAmount(value), fee: formatAmount(fee), payout: formatAmount(value - fee), feeBps: policy.bps, feeVersion: policy.version };
}

export function withdrawalAmounts(row) {
  const amount = BigInt(row.amount), fee = BigInt(row.fee ?? '0');
  if (amount <= 0n || fee < 0n || fee >= amount) throw new Error('Invalid saved withdrawal amounts');
  return { amount, fee, payout: amount - fee };
}

export function withdrawalView(row) {
  const { amount, fee, payout } = withdrawalAmounts(row);
  return { ...row, amount: formatAmount(amount), fee: formatAmount(fee), payout: formatAmount(payout), feeBps: row.fee_bps ?? 0, feeVersion: row.fee_version ?? 'legacy-no-fee-v1' };
}
