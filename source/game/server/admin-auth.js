import { getAddress } from 'ethers';
import { sessionOwner, tokenAsset } from './auth.js';
import { first, hash } from './db.js';
import { GameError } from './rules.js';

export function adminWallet(env) {
  try { const address = getAddress(env.ADMIN_WALLET).toLowerCase(); return /^0x0{40}$/.test(address) ? null : address; } catch { return null; }
}
export async function isAdminAccount(db, env, owner) {
  const expected = adminWallet(env);
  if (!expected || !owner) return false;
  const account = await first(db, 'SELECT wallet,asset FROM accounts WHERE id=?', owner);
  return account?.asset === tokenAsset(env) && account.wallet?.toLowerCase() === expected;
}
export async function authorizeAdmin(db, request, env) {
  const header = request.headers.get('authorization');
  if (header) {
    const key = env.OPS_AUTH_KEY || '', supplied = header.replace(/^Bearer /, '');
    if (key.length >= 32 && await hash(key) === await hash(supplied)) return 'key';
    throw new GameError('无管理权限', 403);
  }
  if (!await isAdminAccount(db, env, await sessionOwner(db, request))) throw new GameError('请使用项目管理员钱包签名登录', 403, 'ADMIN_REQUIRED');
  if (request.method !== 'GET' && (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('x-game-request') !== '1')) throw new GameError('请从管理页面发起操作', 403);
  return 'wallet';
}
// An optional owner-only acceptance phase; it never opens funds to the public.
export async function accountEnvironment(db, env, owner) {
  if (env.PAYMENTS_VALIDATION_ENABLED === 'true' && await isAdminAccount(db, env, owner)) return { ...env, LIVE_PAYMENTS_ENABLED: 'true' };
  return env;
}
