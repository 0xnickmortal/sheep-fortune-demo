// In-browser stand-in for the game API, used only by the shareable static
// build (dist-share). It applies the same published rules as the server
// (rules.js is copied from server/rules.js at build time) and keeps test
// coins in this browser only. Nothing here touches wallets or real funds.
import { RULES, WHEEL_OUTCOMES, units, formatAmount, parseAmount, maxBet, maximumPayout, settlement, ingotAward, drawWheel } from './rules.js';
const STORE = 'sheep-share-demo-v1';
const PAYMENTS = Object.freeze({ enabled: false, chainId: 56, token: '0x61bEcda3b07301889b51Fd84b0E58385311590ba', symbol: 'TST', decimals: 18, withdrawalFee: { bps: 0, version: 'withdrawal-no-fee-v2-20260915' }, depositAddress: null, confirmations: 20 });
const fail = (message, status = 400, code = 'INVALID_REQUEST') => { throw Object.assign(new Error(message), { status, code }); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fresh() { return { version: 1, account: { available: String(units(RULES.demoGrant)), ingots: '0', revision: 0, lastPlay: 0 }, pool: { available: String(units(RULES.initialDemoPool)), burned: '0', fees: '0' }, rounds: [], operations: {} }; }
let state = null;
function load() {
  if (state) return state;
  try { const parsed = JSON.parse(localStorage.getItem(STORE)); if (parsed?.version === 1 && parsed.account && parsed.pool && Array.isArray(parsed.rounds)) state = parsed; } catch {}
  return state ||= fresh();
}
function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {} }
function accountView() {
  const s = load();
  return { mode: 'demo', wallet: null, balance: formatAmount(s.account.available), rewards: '0', ingots: formatAmount(s.account.ingots), locked: '0', pool: formatAmount(s.pool.available), burned: formatAmount(s.pool.burned), maxBet: formatAmount(maxBet(BigInt(s.pool.available))), revision: s.account.revision, rules: RULES };
}
function play(data, key) {
  const s = load();
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) fail('缺少操作编号，请重新操作');
  const fingerprint = JSON.stringify(data ?? {}), prior = s.operations[key];
  if (prior) { if (prior.fingerprint !== fingerprint) fail('同一操作编号不能用于不同内容', 409, 'IDEMPOTENCY_CONFLICT'); return prior.response; }
  if (data?.rulesVersion !== RULES.version) fail('游戏规则已更新，请刷新页面确认后再转', 409, 'RULES_CHANGED');
  const stake = parseAmount(data.amount, { integer: true });
  if (stake < units(RULES.minBet) || stake > units(RULES.maxBet)) fail(`每局投入 ${RULES.minBet}–${RULES.maxBet} 币`);
  const now = Date.now();
  if (now - s.account.lastPlay < 1500) fail('上一局刚结束，请稍候再开始', 429, 'TOO_FAST');
  const available = BigInt(s.account.available), pool = BigInt(s.pool.available);
  if (stake > available) fail('余额不足，请先充值');
  if (stake > maxBet(pool)) fail('本局金额超过可用奖池限额，请降低金额');
  if (pool < maximumPayout(stake)) fail('奖池不足以覆盖最高奖励，请稍后再试', 409);
  const outcome = drawWheel(), definition = WHEEL_OUTCOMES.find(o => o.id === outcome.outcomeId), kind = definition?.kind || 'payout';
  const result = settlement(stake, outcome), awarded = ingotAward(stake, outcome);
  const nextPool = pool + stake - result.burn - result.net, nextBalance = available - stake + result.net, nextIngots = BigInt(s.account.ingots) + awarded;
  const round = { id: crypto.randomUUID(), bet: formatAmount(stake), gross: formatAmount(result.gross), fee: formatAmount(result.fee), net: formatAmount(result.net), profit: formatAmount(result.net - stake), ingots: formatAmount(awarded), sequence: outcome.sequence.map(x => x / 10), score: outcome.score, multiplierBps: outcome.score * 50, multiplierBasis: RULES.multiplierBasis, outcomeId: outcome.outcomeId, outcomeKind: kind, outcomeTitle: definition?.title ?? null, rewardDestination: result.net === 0n ? 'none' : 'balance', claimed: true, version: RULES.version, createdAt: now };
  s.account = { available: String(nextBalance), ingots: String(nextIngots), revision: s.account.revision + 1, lastPlay: now };
  s.pool = { available: String(nextPool), burned: String(BigInt(s.pool.burned) + result.burn), fees: String(BigInt(s.pool.fees) + result.fee) };
  s.rounds.unshift(round); s.rounds = s.rounds.slice(0, 200);
  const response = { round, balance: formatAmount(nextBalance), rewards: '0', ingots: formatAmount(nextIngots), revision: s.account.revision };
  s.operations[key] = { fingerprint, response };
  const keys = Object.keys(s.operations); for (const stale of keys.slice(0, Math.max(0, keys.length - 100))) delete s.operations[stale];
  save(); return response;
}
export async function localApi(path, data, key) {
  await sleep(data ? 160 : 40);
  const route = (data ? 'POST ' : 'GET ') + path;
  if (route === 'GET /config') return { rules: RULES, payments: PAYMENTS };
  if (route === 'GET /health') return { ok: true, paymentsEnabled: false };
  if (route === 'POST /auth/demo' || route === 'GET /account') return accountView();
  if (route === 'GET /rounds') return { rounds: load().rounds.slice(0, 50) };
  if (route === 'GET /ingots') { const s = load(); return { balance: formatAmount(s.account.ingots), revision: s.account.revision, mode: 'demo', records: s.rounds.filter(r => r.ingots !== '0').slice(0, 50), redemption: { enabled: false, plannedAssets: ['XAUT'], rate: null, minimum: null, message: '金元宝兑换暂未开放，兑换规则将另行公布' } }; }
  if (route === 'POST /ingots/redeem') fail('金元宝兑换暂未开放，兑换规则将另行公布', 409, 'REDEMPTION_CLOSED');
  if (route === 'GET /payments') return { deposits: [], withdrawals: [] };
  if (route === 'POST /play') return play(data, key);
  if (route === 'POST /demo/topup') {
    const s = load(), value = parseAmount(data?.amount, { integer: true });
    if (value > units('1000000')) fail('单次最多充值 1,000,000 测试币');
    const prior = s.operations[key]; if (prior) return prior.response;
    const next = BigInt(s.account.available) + value;
    s.account = { ...s.account, available: String(next), revision: s.account.revision + 1 };
    const response = { amount: formatAmount(value), balance: formatAmount(next), revision: s.account.revision };
    if (typeof key === 'string') s.operations[key] = { fingerprint: JSON.stringify(data ?? {}), response };
    save(); return response;
  }
  if (route === 'POST /claim') fail('暂时没有可领取的奖励；游戏奖励已自动到账');
  if (path.startsWith('/auth/')) fail('分享试玩版只有测试币，钱包登录请到正式站点', 503, 'PAYMENTS_CLOSED');
  if (path.startsWith('/deposits') || path.startsWith('/withdrawals')) fail('分享试玩版不支持充值提现，当前只有测试币', 503, 'PAYMENTS_CLOSED');
  fail('接口不存在', 404);
}
