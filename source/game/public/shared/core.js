import { createWalletRegistry, chooseWalletAccount, releaseWallet } from './wallet-providers.js';
import { ensureBscNetwork, isBscChain, loginBscWallet, bscWallet, readWalletTokenBalance } from './wallet-network.js';
// Shared client for the alternative mobile frontends (/night/ and /jade/).
// The server decides every result and balance. This module only sends
// requests, keeps the unconfirmed-operation record, and runs the account
// flows; each frontend supplies its own presentation through the `ui`
// adapter passed to createGame().
//
// ui adapter contract:
//   render(view)                      repaint balances, bet chips, buttons
//   openDialog(title, node|string)    show the themed dialog
//   closeDialog()
//   notice(message)                   short toast
//   buildWheel(segments, config)      draw the 24-slot wheel and prize list
//   beginSpin()                       clear the last result, show "resolving"
//   spinTo(index, round) -> Promise   animate to the server-selected slot
//   showResult(round, {landed, copy}) present the settled round
//   spinFailed(message)
//   endSpin()
//   setTab(name)                      'play' | 'rewards' | 'account'
//   renderRecords(rounds)
//   renderIngots(result)
//   connectionError(message, retry)
import { accountFeatures } from './account-features.js';
import { buildWheelSegments, landingIndex, stopAngle } from '/wheel.js?v=6';
import { sectorText, resultText } from '/outcome-view.js?v=5';
export { buildWheelSegments, landingIndex, stopAngle, sectorText, resultText };

const PENDING_KEY = 'sheep-pending-v1';
export const QUICK_BETS = Object.freeze(['500', '1000', '2000']);
const NS = 'http://www.w3.org/2000/svg';

export const money = value => { const [whole, fraction = ''] = String(value ?? '0').split('.'); return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : ''); };
export const signed = value => (Number(value) > 0 ? '+' : '') + money(value);
export const short = value => value ? value.slice(0, 6) + '…' + value.slice(-4) : '';
export const when = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export function el(tag, text, className, attrs) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  if (attrs) for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
export function svgNode(name, attrs = {}) { const node = document.createElementNS(NS, name); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); return node; }
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export function haptic(pattern) { try { navigator.vibrate?.(pattern); } catch {} }

// Classifies a settled round for sounds and effects only; amounts are never derived here.
export function resultKind(round) {
  if (round.outcomeKind === 'empty') return 'empty';
  if (round.outcomeKind === 'replay') return 'even';
  if (round.multiplierBps >= 100000) return 'jackpot';
  if (round.multiplierBps >= 20000) return 'bonus';
  if (round.multiplierBps > 10000) return 'win';
  return 'loss';
}

// Static Pages shows the same interface and sends wallet actions to the game site.
const LOCAL = typeof document !== 'undefined' && !!document.querySelector('meta[name="sheep-backend"][content="local"]');
const staticRules = LOCAL ? (await import('./rules.js')).RULES : null;
let accountWallet = null, onWalletMismatch = () => {};
export async function api(path, data, key) {
  if (LOCAL) {
    if (path === '/config') return { rules: staticRules, payments: { enabled: false, symbol: '羊年吉祥' } };
    throw Object.assign(new Error('请前往游戏站点连接钱包'), { status: 401, uncertain: false });
  }
  let response; const expectedWallet = accountWallet;
  const headers = { ...(expectedWallet && !path.startsWith('/auth/') ? { 'X-Game-Wallet': expectedWallet } : {}), ...(data ? { 'Content-Type': 'application/json', 'X-Game-Request': '1', ...(key ? { 'Idempotency-Key': key } : {}) } : {}) };
  try { response = await fetch('/api' + path, { method: data ? 'POST' : 'GET', credentials: 'same-origin', headers, ...(data ? { body: JSON.stringify(data) } : {}) }); }
  catch { throw Object.assign(new Error('网络暂时断开，请点重试；不会重复扣款'), { uncertain: true }); }
  let result;
  try { result = await response.json(); } catch { throw Object.assign(new Error('暂时无法确认操作，请稍后重试'), { uncertain: true }); }
  if (result.code === 'WALLET_CHANGED' && expectedWallet === accountWallet) onWalletMismatch();
  if (!response.ok) throw Object.assign(new Error(result.error || '操作暂未完成'), { status: response.status, code: result.code, uncertain: response.status >= 500 || result.code === 'RETRY_OPERATION' });
  return result;
}
export function getPending(owner) {
  try {
    const legacy = JSON.parse(sessionStorage.getItem(PENDING_KEY));
    if (legacy?.owner === owner) return legacy;
    return JSON.parse(sessionStorage.getItem(PENDING_KEY + ':' + owner)) || null;
  } catch { return null; }
}
export function savePending(value, owner) {
  try {
    const key = PENDING_KEY + ':' + owner;
    if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key);
    const legacy = JSON.parse(sessionStorage.getItem(PENDING_KEY));
    if (legacy?.owner === owner) sessionStorage.removeItem(PENDING_KEY);
  } catch {}
}

// Small WebAudio sound set. Nothing plays until the player has tapped something.
export function createSound(storageKey = 'sheep-sound') {
  let context = null, enabled = true;
  try { enabled = localStorage.getItem(storageKey) !== 'off'; } catch {}
  function ensure() {
    if (!enabled) return null;
    try { context ||= new (window.AudioContext || window.webkitAudioContext)(); if (context.state === 'suspended') context.resume(); return context; } catch { return null; }
  }
  function tone(frequency, { type = 'sine', at = 0, duration = 0.15, gain = 0.05, slide = null } = {}) {
    const ctx = ensure(); if (!ctx) return;
    const oscillator = ctx.createOscillator(), amp = ctx.createGain(), start = ctx.currentTime + at;
    oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, start);
    if (slide) oscillator.frequency.exponentialRampToValueAtTime(slide, start + duration);
    amp.gain.setValueAtTime(0.0001, start); amp.gain.exponentialRampToValueAtTime(gain, start + 0.01); amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(amp); amp.connect(ctx.destination); oscillator.start(start); oscillator.stop(start + duration + 0.02);
  }
  return {
    get enabled() { return enabled; },
    toggle() { enabled = !enabled; try { localStorage.setItem(storageKey, enabled ? 'on' : 'off'); } catch {} if (enabled) tone(880, { type: 'triangle', duration: 0.08, gain: 0.04 }); return enabled; },
    click() { tone(720, { type: 'triangle', duration: 0.05, gain: 0.03 }); },
    tick() { tone(1500, { type: 'square', duration: 0.025, gain: 0.018 }); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, { type: 'triangle', at: i * 0.1, duration: 0.28, gain: 0.05 })); },
    jackpot() { [523, 659, 784, 1047, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, { type: 'triangle', at: i * 0.11, duration: 0.34, gain: 0.06 })); },
    refund() { tone(494, { type: 'sine', duration: 0.14, gain: 0.04 }); tone(494, { at: 0.16, duration: 0.2, gain: 0.04 }); },
    lose() { tone(392, { type: 'sine', duration: 0.18, gain: 0.035 }); tone(311, { at: 0.17, duration: 0.3, gain: 0.035 }); },
    ingot() { tone(1046, { type: 'triangle', duration: 0.18, gain: 0.04, slide: 1568 }); tone(1568, { at: 0.12, type: 'triangle', duration: 0.22, gain: 0.035 }); },
  };
}

// Canvas particles: a burst from a point, or a rain from the top edge.
function roundedRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function drawShape(ctx, shape, s, color) {
  ctx.fillStyle = color;
  if (shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, s / 2, 0, Math.PI * 2); ctx.fill(); }
  else if (shape === 'ingot') {
    ctx.beginPath(); ctx.moveTo(-s, 0); ctx.quadraticCurveTo(-s * 0.6, -s * 0.5, 0, -s * 0.35); ctx.quadraticCurveTo(s * 0.6, -s * 0.5, s, 0); ctx.quadraticCurveTo(s * 0.7, s * 0.55, 0, s * 0.6); ctx.quadraticCurveTo(-s * 0.7, s * 0.55, -s, 0); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.45)'; ctx.beginPath(); ctx.arc(0, -s * 0.12, s * 0.26, 0, Math.PI * 2); ctx.fill();
  }
  else if (shape === 'tile') { ctx.fillStyle = '#f7efd9'; roundedRect(ctx, -s * 0.45, -s * 0.6, s * 0.9, s * 1.2, s * 0.15); ctx.fill(); ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, s * 0.2, 0, Math.PI * 2); ctx.fill(); }
  else if (shape === 'star') { ctx.beginPath(); for (let i = 0; i < 10; i++) { const r = i % 2 ? s * 0.25 : s * 0.55, a = i * Math.PI / 5 - Math.PI / 2; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); } ctx.closePath(); ctx.fill(); }
  else ctx.fillRect(-s / 2, -s / 4, s, s / 2);
}
export function particles({ mode = 'burst', colors = ['#ffd166', '#ef476f', '#ffffff'], count = 120, shapes = ['rect', 'circle'], duration = 2600, origin = { x: 0.5, y: 0.42 }, power = 1 } = {}) {
  if (reducedMotion()) return;
  const canvas = document.createElement('canvas'); canvas.className = 'fx-canvas'; canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '60' });
  document.body.append(canvas);
  const ctx = canvas.getContext('2d'), dpr = Math.min(window.devicePixelRatio || 1, 2), w = innerWidth, h = innerHeight;
  canvas.width = w * dpr; canvas.height = h * dpr; ctx.scale(dpr, dpr);
  const items = Array.from({ length: count }, () => {
    const angle = Math.random() * Math.PI * 2, speed = (4 + Math.random() * 9) * power, burst = mode === 'burst';
    return { x: burst ? w * origin.x : Math.random() * w, y: burst ? h * origin.y : -30 - Math.random() * h * 0.6, vx: burst ? Math.cos(angle) * speed : (Math.random() - 0.5) * 1.2, vy: burst ? Math.sin(angle) * speed - 5 : 2.5 + Math.random() * 3, size: 7 + Math.random() * 9, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.25, color: colors[Math.floor(Math.random() * colors.length)], shape: shapes[Math.floor(Math.random() * shapes.length)], sway: Math.random() * Math.PI * 2 };
  });
  const started = performance.now();
  function frame(now) {
    const t = now - started, fade = t > duration - 500 ? Math.max(0, (duration - t) / 500) : 1;
    ctx.clearRect(0, 0, w, h);
    for (const p of items) {
      if (mode === 'burst') { p.vy += 0.3; p.vx *= 0.985; p.vy *= 0.985; } else { p.sway += 0.05; p.x += Math.sin(p.sway) * 0.9; }
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save(); ctx.globalAlpha = fade; ctx.translate(p.x, p.y); ctx.rotate(p.rot); drawShape(ctx, p.shape, p.size, p.color); ctx.restore();
    }
    if (t < duration) requestAnimationFrame(frame); else canvas.remove();
  }
  requestAnimationFrame(frame);
}

// Geometry for the 24-slot ring wheel. Colours and decoration come from each theme's CSS.
function point(angle, radius) { const a = (angle - 90) * Math.PI / 180; return [180 + radius * Math.cos(a), 180 + radius * Math.sin(a)]; }
export function buildWheelSvg(segments, { outer = 172, inner = 62, labelRadius = 130, pegRadius = 176, pegs = true, radial = true } = {}) {
  const svg = svgNode('svg', { viewBox: '0 0 360 360', 'aria-hidden': 'true', focusable: 'false', class: 'wheel-svg' });
  const size = 360 / segments.length, groups = [], sectors = svgNode('g', { class: 'sectors' });
  segments.forEach((segment, i) => {
    const start = i * size - size / 2, end = start + size;
    const [ax, ay] = point(start, outer), [bx, by] = point(end, outer), [cx, cy] = point(end, inner), [dx, dy] = point(start, inner);
    const group = svgNode('g', { class: `seg seg-${segment.kind} ${i % 2 ? 'seg-odd' : 'seg-even'}`, 'data-index': i });
    group.append(svgNode('path', { class: 'seg-fill', d: `M ${ax} ${ay} A ${outer} ${outer} 0 0 1 ${bx} ${by} L ${cx} ${cy} A ${inner} ${inner} 0 0 0 ${dx} ${dy} Z` }));
    const [x, y] = point(i * size, labelRadius);
    const label = svgNode('text', { x, y, class: 'seg-label', 'text-anchor': 'middle', 'dominant-baseline': 'central', transform: `rotate(${i * size - (radial ? 90 : 0)} ${x} ${y})` });
    label.textContent = segment.shortLabel; group.append(label);
    groups.push(group); sectors.append(group);
  });
  svg.append(sectors);
  if (pegs) { const ring = svgNode('g', { class: 'pegs' }); segments.forEach((s, i) => { const [px, py] = point(i * size + size / 2, pegRadius); ring.append(svgNode('circle', { cx: px, cy: py, r: 3.2, class: 'peg' })); }); svg.append(ring); }
  return { svg, groups, size };
}
// Animates the rotor and reports each slot boundary passing the fixed top pointer.
export function spinRotor(rotor, from, to, { duration = 3800, easing = 'cubic-bezier(.12,.72,.1,1)', count = 24, onCross } = {}) {
  if (reducedMotion() || !rotor.animate) { rotor.style.transform = `rotate(${to}deg)`; return Promise.resolve(); }
  return new Promise(resolve => {
    const animation = rotor.animate([{ transform: `rotate(${from}deg)` }, { transform: `rotate(${to}deg)` }], { duration, easing, fill: 'forwards' });
    const size = 360 / count; let last = -1, raf = 0;
    const read = () => {
      const matrix = getComputedStyle(rotor).transform;
      if (matrix && matrix !== 'none') { const [a, b] = matrix.slice(7, -1).split(',').map(Number); const angle = Math.atan2(b, a) * 180 / Math.PI; const index = Math.round((((-angle) % 360) + 360) % 360 / size) % count; if (index !== last) { last = index; onCross?.(index); } }
      raf = requestAnimationFrame(read);
    };
    if (onCross) raf = requestAnimationFrame(read);
    const finish = () => { cancelAnimationFrame(raf); rotor.style.transform = `rotate(${to}deg)`; animation.cancel(); resolve(); };
    animation.finished.then(finish, finish);
  });
}

export function createGame(ui) {
  const state = { config: null, account: null, bet: '500', busy: false, segments: [], needsWalletLogin: false, needsBscNetwork: false, walletBalance: { status: 'idle', value: null } };
  let drawnVersion, shownIdentity, publicConfig, authGeneration = 0;
  let walletStorage; try { walletStorage = window.sessionStorage; } catch {}
  const wallets = createWalletRegistry(window, walletStorage), observedWallets = new WeakSet();
  let stopWalletList = () => {};
  let balanceRequest = 0, balanceUpdatedAt = 0, balanceKey = '';
  const features=accountFeatures({api,mutate,walletProvider:()=>wallets.current(),account:()=>state.account,config:()=>state.config,refresh,openDialog:ui.openDialog,notice:ui.notice,canOperate:()=>ready()&&!state.needsWalletLogin&&!state.needsBscNetwork&&!state.busy});
  const identity = () => state.account?.wallet || 'demo';
  const failure = e => ui.notice(e.message || '网络暂时断开，请稍后重试');
  onWalletMismatch = () => { if (state.account?.mode === 'token') { state.needsWalletLogin = true; clearWalletBalance(); render(); ui.notice('登录钱包已在其他页面改变，请断开后重新选择钱包'); } };
  const playerAccount = account => account?.mode === 'token' ? account : { mode: 'guest', wallet: null, balance: '0', ingots: '0', locked: '0', rewards: '0', maxBet: state.config.rules.maxBet, revision: 0, rules: state.config.rules };
  async function mutate(path, data = {}) {
    const owner = identity();
    const previous = getPending(identity());
    if (previous && (previous.path !== path || previous.owner !== identity())) throw new Error('请先重试上次未确认的操作');
    if (state.account?.mode === 'token') await bscWallet(wallets.current(), { expectedAddress: state.account.wallet });
    const operation = previous || { path, data, key: crypto.randomUUID(), owner: identity() };
    savePending(operation, owner);
    try { const result = await api(operation.path, operation.data, operation.key); savePending(null, owner); return result; }
    catch (e) { if (!e.uncertain) savePending(null, owner); throw e; }
  }
  function view() {
    const a = state.account, c = state.config, guest = a?.mode !== 'token', pending = guest ? null : getPending(identity());
    return {
      config: c, account: a, bet: state.bet, busy: state.busy, pending, guest, quick: QUICK_BETS, needsWalletLogin: state.needsWalletLogin, needsBscNetwork: !guest && state.needsBscNetwork, switchNetwork, walletBalance: state.walletBalance,
      unit: c?.payments.symbol || '币',
      modeText: guest ? '连接钱包，开启好运' : c?.payments.enabled ? 'BSC · ' + c.payments.symbol : '充值提现暂未开放',
      canPlay: !!a && !state.busy && (guest || state.needsWalletLogin || state.needsBscNetwork || (pending ? pending.path === '/play' : c.payments.enabled && Number(a.balance) >= Number(state.bet) && Number(a.maxBet) >= Number(state.bet))),
      startLabel: state.busy ? '正在处理，请稍候' : guest || state.needsWalletLogin ? '连接钱包' : state.needsBscNetwork ? '切换到 BSC' : pending?.path === '/play' ? '查看上次结果' : !c?.payments.enabled ? '暂未开放' : null,
      startCost: money(pending?.path === '/play' ? pending.data.amount : state.bet),
      isCustom: !QUICK_BETS.includes(state.bet),
      lockControls: state.busy || !!pending,
      retry: retryPending,
    };
  }
  function render() {
    accountWallet = state.account?.mode === 'token' ? state.account.wallet : null;
    if (state.account && shownIdentity !== identity()) {
      shownIdentity = identity(); drawnVersion = undefined;
      ui.renderRecords([]); ui.renderIngots({ records: [] }); ui.resetResult?.();
      if (state.account.mode === 'token') loadRecords().catch(failure);
    }
    if (state.account?.rules && state.config) {
      state.config.rules = state.account.rules;
      if (state.account.payments) state.config.payments = state.account.payments;
      if (state.account.withdrawalFee) state.config.payments.withdrawalFee = state.account.withdrawalFee;
      if (drawnVersion !== state.config.rules.version) {
        state.segments = buildWheelSegments(state.config.rules.outcomes);
        ui.buildWheel(state.segments, state.config); drawnVersion = state.config.rules.version;
      }
    }
    ui.render(view());
    features.syncAccount();
  }
  function setBusy(value) { state.busy = value; render(); }
  async function refresh() { const generation = authGeneration; const response = await api('/account'); if (generation !== authGeneration) return; const fresh = playerAccount(response); if (!state.account || fresh.mode !== state.account.mode || fresh.wallet !== state.account.wallet || fresh.revision >= state.account.revision) state.account = fresh; render(); void refreshWalletBalance(); }
  function clearWalletBalance() {
    balanceRequest++; balanceUpdatedAt = 0; balanceKey = '';
    state.walletBalance = { status: 'idle', value: null };
  }
  async function refreshWalletBalance({ force = false } = {}) {
    if (!state.config || !state.account || LOCAL) return;
    if (state.account.mode !== 'token' || state.needsWalletLogin || state.needsBscNetwork) {
      clearWalletBalance(); render(); return;
    }
    const { token, decimals } = state.config.payments, address = state.account.wallet;
    const key = address.toLowerCase() + ':' + token?.toLowerCase();
    if (key !== balanceKey) { clearWalletBalance(); balanceKey = key; }
    if (state.walletBalance.status === 'loading' || (!force && Date.now() - balanceUpdatedAt < 10000)) return;
    const request = ++balanceRequest;
    state.walletBalance = { ...state.walletBalance, status: 'loading' }; render();
    let timer;
    try {
      const value = await Promise.race([
        readWalletTokenBalance(wallets.current(), { address, token, decimals }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('持币数量读取超时，请重试')), 12000); }),
      ]);
      if (request === balanceRequest) state.walletBalance = { status: 'ready', value };
    } catch (error) {
      if (request === balanceRequest) state.walletBalance = { status: 'error', value: null, error: error.message };
    } finally {
      clearTimeout(timer);
      if (request === balanceRequest) { balanceUpdatedAt = Date.now(); render(); }
    }
  }
  function button(label, action) { const node = el('button', label, 'dialog-primary'); node.type = 'button'; if (action) node.onclick = action; return node; }
  function form(title, label, initial, action, options = {}) {
    const box = el('form', undefined, 'dialog-form'), name = el('label', label), input = el('input');
    input.id = 'dialog-input'; name.htmlFor = input.id; input.value = initial; input.type = 'text'; input.inputMode = options.inputMode || (options.hash ? 'text' : 'decimal'); input.autocomplete = 'off'; input.spellcheck = false; input.required = true;
    const note = el('p', options.note || '', 'form-note'), error = el('p', '', 'form-error'); error.setAttribute('role', 'alert');
    const submit = button(options.submit || '确定'); submit.type = 'submit';
    box.append(name, input, note, error, submit);
    box.onsubmit = async event => { event.preventDefault(); submit.disabled = true; error.textContent = ''; try { await action(input.value.trim()); } catch (e) { error.textContent = e.message; } finally { submit.disabled = false; render(); } };
    ui.openDialog(title, box); setTimeout(() => input.focus(), 60);
  }
  function rules() {
    const box = el('div', undefined, 'rules');
    if (state.account?.benefits?.whitelisted) box.append(el('p', '当前钱包适用专属游戏配置，提现手续费全免。'));
    box.append(el('p', '选好金额，点击开始。一次下注只转一次，抽中一个倍率，结算一次奖励。每次至少投入 500 币，可自定义整数金额。'));
    box.append(el('p', '数字倍率表示包含本金、扣费前的返还倍数。抽中大于 1 倍的奖项，在本局结算时收取投入金额的 5%；小于或等于 1 倍不收费。例：投入 500 币，1.2 倍返还 600 币，扣 25 币，实得 575 币；1.5 倍扣 25 币，实得 725 币。'));
    box.append(el('p', '“1×”：本局本金全额退回可用余额，不收手续费。你可以自行决定是否继续，下一局仍需再次点击开始才会下注。'));
    box.append(el('p', '“谢谢参与”：返还 0 代币，获得与本局投入等量的金元宝。0.5 倍返还投入的 50%，其余 50% 按 1:1 获得金元宝。例如投入 1,000 币，分别获得 1,000 或 500 金元宝。1 倍及以上不发金元宝，手续费不换金元宝。10 倍大奖扣费后实得投入的 9.95 倍。'));
    box.append(el('p', '每局代币返还和金元宝均自动到账，无需手动领取。每一局按抽中的倍率判断手续费，费用按代币最小单位向下取整。提币不收取游戏手续费。金元宝与代币分别记账，不能用于下注或直接提币；兑换尚未开放，后续规则另行公布。'));
    if (state.config.rules.protection?.enabled) box.append(el('p', '大额保护：单局投入达到下注前可用游戏余额的50%时，不会出现“谢谢参与”。每个钱包累计最多补偿'+state.config.rules.protection.maxCompensations+'次，充值、重连不重置。额度未用完时，该局抽中0.5倍才会记录下局补偿额，小额下注不产生补偿。下一次成功下注按新的投入金额，选择扣费后净盈利足以补回这笔损失的最小现有倍率，最高10倍。补偿成功结算记1次；达到10倍仍不够补回的，差额不再延续。次数用完后，大额局仍不会出现“谢谢参与”，但0.5倍不再产生补偿。金元宝继续按原规则入账。'));
    ui.openDialog('转盘玩法', box);
  }
  function selectBet(value) { state.bet = value; render(); }
  function customBet() {
    if (!ready()) return;
    form('自定义投入', '这一局投入多少币？', state.bet, async value => {
      if (!/^[1-9]\d{0,8}$/.test(value) || BigInt(value) < BigInt(state.config.rules.minBet) || Number(value) > Number(state.account.maxBet)) throw new Error('请输入 ' + state.config.rules.minBet + ' 至 ' + money(state.account.maxBet) + ' 之间的整数');
      selectBet(value); ui.closeDialog();
    }, { note: '请按自己的预算选择，每局投入可能发生亏损。', inputMode: 'numeric' });
  }
  async function showRound(round) {
    const index = landingIndex(state.segments, round, state.config.rules.version), copy = resultText(round);
    if (index >= 0) await ui.spinTo(index, round);
    ui.showResult(round, { landed: index >= 0, copy, kind: resultKind(round) });
  }
  async function start() {
    if (state.busy || !state.account) return;
    if (state.account.mode !== 'token' || state.needsWalletLogin) return connectWallet();
    if (state.account.mode === 'token' && state.needsBscNetwork) return switchNetwork();
    if (!state.config.payments.enabled && !getPending(identity())) return checkPayments();
    if(features.offerReferral())return;
    setBusy(true); ui.beginSpin();
    try {
      const result = await mutate('/play', { amount: state.bet, rulesVersion: state.config.rules.version });
      try { await showRound(result.round); }
      finally {
        if (Number.isInteger(result.revision) && result.revision >= state.account.revision) { Object.assign(state.account, { balance: result.balance, rewards: result.rewards, ingots: result.ingots, revision: result.revision }); render(); }
        await refresh();
      }
    } catch (e) {
      ui.spinFailed(getPending(identity()) ? '结果尚未确认，请查看上次结果' : e.message); failure(e);
      if (e.code === 'RULES_CHANGED') { await init(); rules(); }
    } finally { ui.endSpin(); setBusy(false); }
  }
  // Compatibility path for a claim request that was submitted by an older page.
  async function claimReward() { if (state.busy) return; setBusy(true); try { const result = await mutate('/claim'); state.account.balance = result.balance; state.account.rewards = result.rewards; render(); ui.notice('历史奖励已自动到账'); await refresh(); await loadRecords(); } catch (e) { failure(e); } finally { setBusy(false); } }
  async function retryPending() {
    const pending = getPending(identity()); if (!pending || state.busy) return;
    if (pending.path === '/play') return start();
    if (pending.path === '/claim') return claimReward();
    setBusy(true);
    try { const result = await mutate(pending.path, pending.data); if (pending.path === '/withdrawals') { if (result.fee !== undefined) withdrawalSaved(result); else ui.openDialog('上次提现已确认', '已恢复此前的提现申请，请到充值与提现记录查看数量和进度。'); } await refresh(); ui.notice('上次操作已确认'); }
    catch (e) { failure(e); } finally { setBusy(false); }
  }
  async function loadRecords() { if (state.account?.mode !== 'token') { ui.renderRecords([]); return; } const owner = identity(), result = await api('/rounds'); if (owner === identity()) ui.renderRecords(result.rounds); }
  async function loadIngots() { if (state.account?.mode !== 'token') { ui.renderIngots({ records: [] }); return; } const owner = identity(); await refresh(); if (owner !== identity()) return; const result = await api('/ingots'); if (owner !== identity()) return; if (result.revision >= state.account.revision) { state.account.ingots = result.balance; render(); } ui.renderIngots(result); }
  function tab(name) { ui.setTab(name); if (name === 'rewards') loadIngots().catch(failure); if (name === 'account') loadRecords().catch(failure); }
  function ready() { if (!state.account || !state.config) { ui.notice('正在连接游戏账户，请稍候'); return false; } return true; }

  function watchNetwork() {
    const provider = wallets.current();
    if (!provider?.request || observedWallets.has(provider)) return;
    observedWallets.add(provider);
    provider.on?.('chainChanged', chain => {
      if (state.account?.mode !== 'token' || wallets.current() !== provider) return;
      state.needsBscNetwork = !isBscChain(chain); clearWalletBalance(); render(); void refreshWalletBalance();
      if (state.needsBscNetwork) ui.notice('当前不是 BSC 主网，请点击“切换到 BSC 主网”');
    });
    provider.on?.('accountsChanged', addresses => {
      if (state.account?.mode !== 'token' || wallets.current() !== provider) return;
      state.needsWalletLogin = addresses?.[0]?.toLowerCase() !== state.account.wallet.toLowerCase();
      clearWalletBalance(); render(); void refreshWalletBalance();
      if (state.needsWalletLogin) ui.notice('钱包已切换，请重新签名登录');
    });
  }
  async function checkNetwork() {
    watchNetwork(); state.needsBscNetwork = false;
    if (state.account?.mode === 'token') {
      try {
        state.needsBscNetwork = !isBscChain(await wallets.current()?.request?.({ method: 'eth_chainId' }));
        const accounts = await wallets.current()?.request?.({ method: 'eth_accounts' });
        state.needsWalletLogin = accounts?.[0]?.toLowerCase() !== state.account.wallet.toLowerCase();
      }
      catch { state.needsBscNetwork = true; }
    }
  }
  async function switchNetwork() {
    if (state.busy) return;
    setBusy(true);
    try { watchNetwork(); await ensureBscNetwork(wallets.current()); await checkNetwork(); ui.notice('已切换到 BSC 主网'); }
    catch (e) { failure(e); }
    finally { setBusy(false); void refreshWalletBalance({ force: true }); }
  }

  async function connectWallet() {
    if (!ready()) return;
    if (state.busy) return;
    if (LOCAL) {
      const box = el('div'), link = el('a', '前往游戏站点', 'dialog-primary'), target = new URL('https://sheep-fortune-game.lingolayer.workers.dev/');
      const ref = new URL(location.href).searchParams.get('ref'); if (/^[a-f0-9]{24}$/.test(ref || '')) target.searchParams.set('ref', ref);
      link.href = target.href; box.append(el('p', '请在游戏站点连接钱包，查看余额并参与游戏。'), link); ui.openDialog('连接钱包', box); return;
    }
    stopWalletList();
    const box = el('div');
    if (state.account.mode === 'token') {
      box.append(el('p', state.account.wallet, 'wallet-address'), el('p', '钱包持有 · ' + state.config.payments.symbol));
      box.append(el('p', '', 'wallet-holding-detail', { id: 'wallet-balance-detail' }));
      if (state.needsBscNetwork && !state.needsWalletLogin) box.append(button('切换到 BSC 主网', switchNetwork));
      else if (!state.needsWalletLogin) box.append(button('刷新持币数量', () => refreshWalletBalance({ force: true })));
      box.append(button('断开连接', disconnectWallet));
      box.append(el('p', '断开后可选择其他钱包。游戏余额和记录会保留。'));
      ui.openDialog('我的钱包', box); render(); void refreshWalletBalance(); return;
    }
    box.append(el('p', '选择要连接的钱包，在钱包中选择账户并签名登录。签名不会转账。'));
    const choices = el('div', undefined, 'wallet-choices'); box.append(choices);
    box.append(el('p', '', 'form-note', { id: 'wallet-selection-status', role: 'status' }));
    function showChoices() {
      choices.replaceChildren();
      for (const entry of wallets.list()) choices.append(button(entry.name, () => loginWithWallet(entry.provider)));
      if (!wallets.list().length) choices.append(el('p', '尚未检测到钱包。请在 MetaMask、OKX 等支持 BSC 的钱包浏览器中打开本页。'));
    }
    box.append(el('p', '只显示当前浏览器可用的钱包；连接时会请求切换到 BSC 主网。'));
    box.append(button('刷新钱包列表', () => { wallets.discover(); showChoices(); }));
    showChoices();
    stopWalletList = wallets.subscribe(() => { if (box.isConnected) showChoices(); });
    ui.openDialog('选择钱包', box); wallets.discover();
  }
  async function loginWithWallet(provider) {
    if (state.busy) return;
    const generation = ++authGeneration;
    setBusy(true);
    try {
      wallets.select(provider); watchNetwork();
      await chooseWalletAccount(provider);
      clearWalletBalance(); const account = await loginBscWallet(provider, api);
      if (generation !== authGeneration) return;
      state.account = account; state.needsWalletLogin = false;
      await checkNetwork(); stopWalletList(); ui.closeDialog(); render();
      ui.notice('钱包已连接 BSC 主网'); features.offerReferral(); features.resume();
      void refreshWalletBalance({ force: true });
    } catch (e) { failure(e.code === 4001 ? new Error('已取消连接钱包') : e); }
    finally { setBusy(false); }
  }
  async function disconnectWallet() {
    if (!ready() || state.busy) return;
    if (features.isTransferring()) return ui.notice('请先完成或取消钱包中的操作，再断开连接');
    if (state.account.mode !== 'token') return connectWallet();
    const provider = wallets.current();
    ++authGeneration; setBusy(true);
    try {
      await api('/auth/logout', {});
      ++authGeneration;
      // Do not delete pending operations: each wallet keeps its own retry record.
      clearWalletBalance(); wallets.clear(); stopWalletList(); features.pause();
      state.config = structuredClone(publicConfig); state.account = playerAccount(null);
      state.needsWalletLogin = false; state.needsBscNetwork = false;
      ui.closeDialog(); render();
      await releaseWallet(provider);
      setBusy(false); ui.notice('已断开连接，请选择钱包'); connectWallet();
    } catch (e) { failure(e); }
    finally { setBusy(false); }
  }

  function checkPayments() {
    if (state.account.mode !== 'token') { connectWallet(); return false; }
    if (state.needsWalletLogin) { ui.notice('钱包已切换，请重新签名登录'); return false; }
    if (!state.config.payments.enabled) { ui.openDialog('充值提现暂未开放', '开通后可在这里充值和提币，请稍后再来。'); return false; }
    return true;
  }
  function deposit() {
    if (!ready()) return;
    if (!checkPayments()) return;
    if(state.config.payments.mode==='vault')return features.deposit();
    const c = state.config, box = el('div');
    box.append(el('p', '仅支持 BSC 网络 ' + c.payments.symbol + '。请从当前登录钱包直接转账到下面地址，再提交交易哈希核对到账。'), el('p', c.payments.depositAddress, 'wallet-address'), el('p', '代币合约：' + c.payments.token, 'wallet-address'), el('p', `需等待 ${c.payments.confirmations} 个区块确认；按实际收到的代币数量入账。`));
    box.append(button('复制充值地址', async () => { try { await navigator.clipboard.writeText(c.payments.depositAddress); ui.notice('已复制'); } catch { ui.notice('请长按地址复制'); } }), button('我已转账，核对到账', () => form('核对充值到账', '粘贴完整交易哈希', '', async txHash => { const result = await mutate('/deposits', { txHash }); await refresh(); ui.openDialog('充值已到账', money(result.amount) + ' 币已进入游戏余额。'); }, { hash: true, submit: '核对到账' })));
    ui.openDialog('充值 ' + c.payments.symbol, box);
  }
  function withdrawalSaved(result) { if(result.status==='authorized')return features.withdrawalSaved(result); ui.openDialog('提现申请已保存', money(result.amount) + ' 币已冻结，其中手续费 ' + money(result.fee) + ' 币，预计转出 ' + money(result.payout) + ' 币至 ' + short(result.recipient) + '。请到充值与提现记录查看进度。'); }
  function reviewWithdrawal(quote) {
    const box = el('div', undefined, 'withdrawal-quote'), error = el('p', '', 'form-error'); error.setAttribute('role', 'alert');
    for (const [label, value] of [['申请提现', quote.amount], ['手续费（' + quote.feeBps / 100 + '%）', quote.fee], ['预计转出', quote.payout]]) { const row = el('div', undefined, 'account-line'); row.append(el('span', label), el('b', money(value) + ' 币')); box.append(row); }
    box.append(el('p', '转入当前钱包 ' + short(quote.recipient) + (quote.feeExempt ? '。白名单免提现手续费。' : quote.feeBps === 0 ? '。本次提现不收手续费。' : '。手续费以本次报价为准。')));
    let submitting = false, expired = false;
    const submit = button('确认提现', async () => {
      if (submitting || state.busy) return;
      submitting = true; submit.disabled = true; setBusy(true); error.textContent = '';
      try { const result = await mutate('/withdrawals', { amount: quote.amount, feeVersion: quote.feeVersion }); withdrawalSaved(result); await refresh(); }
      catch (e) { error.textContent = e.message; if (e.code === 'FEE_CHANGED') { expired = true; box.append(button('重新查看手续费', withdraw)); } }
      finally { submitting = false; setBusy(false); submit.disabled = expired; submit.textContent = getPending(identity()) ? '重试确认' : '确认提现'; }
    });
    box.append(error, submit); ui.openDialog('确认提现金额', box);
  }
  function withdraw() {
    if (!ready()) return;
    if (!checkPayments()) return;
    form('申请提现', '提现数量（币）', '', async amount => { reviewWithdrawal(await api('/withdrawals/quote', { amount })); }, { note: '提现不收手续费。可用余额 ' + money(state.account.balance) + ' 币。下一步查看预计转出数量。', submit: '下一步' });
  }
  async function payments() {
    if (!ready()) return;
    if (state.account.mode !== 'token') return connectWallet();
    try {
      const result = await api('/payments'), box = el('div'), labels = { authorized: '待提交合约提现', queued: '待处理', submitted: '链上确认中', confirmed: '已到账', failed: '交易失败，已退回', rejected: '已退回余额' };
      if (!result.deposits.length && !result.withdrawals.length && !result.pendingDeposits?.length) box.append(el('p', '暂无充值与提现记录'));
      for (const d of result.pendingDeposits || []) { const row=el('div',undefined,'payment-row');row.append(el('p',d.status==='failed'?'充值未完成':'充值确认中'),el('p',d.error||'到账后自动更新余额'));const link=el('a','查看链上记录');link.href='https://bscscan.com/tx/'+d.tx_hash;link.target='_blank';link.rel='noopener noreferrer';row.append(link);box.append(row); }
      for (const d of result.deposits) box.append(el('p', '充值 +' + money(d.amount) + ' 币 · 已到账', 'payment-row'));
      for (const w of result.withdrawals) {
        const row = el('div', undefined, 'payment-row'); row.append(el('p', '提现 ' + money(w.amount) + ' 币 · ' + (labels[w.status] || w.status)));
        row.append(el('p', ['failed', 'rejected'].includes(w.status) ? '申请数量已全额退回，不收手续费' : '手续费 ' + money(w.fee) + ' 币 · ' + (w.status === 'confirmed' ? '已转出 ' : '预计转出 ') + money(w.payout) + ' 币'));
        if (w.tx_hash) { const link = el('a', '查看链上记录'); link.href = 'https://bscscan.com/tx/' + w.tx_hash; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
        if (w.status === 'submitted') row.append(button('核对到账', async () => { try { await mutate('/withdrawals/' + w.id + '/check'); await refresh(); await payments(); } catch (e) { failure(e); render(); } }));
        row.append(...features.withdrawalActions(w));
        box.append(row);
      }
      ui.openDialog('充值与提现记录', box);
    } catch (e) { failure(e); }
  }
  async function init() {
    try {
      state.config = await api('/config'); publicConfig = structuredClone(state.config); if (!state.config.rules.outcomes?.length) throw new Error('页面正在更新，请稍后重新连接');
      state.segments = buildWheelSegments(state.config.rules.outcomes); ui.buildWheel(state.segments, state.config); drawnVersion = state.config.rules.version;
      try { state.account = playerAccount(await api('/account')); } catch (e) { if (e.status !== 401) throw e; state.account = playerAccount(null); }
      if (getPending('demo')) savePending(null, 'demo');
      await checkNetwork(); render(); features.offerReferral(); features.resume();
      void refreshWalletBalance({ force: true });
    } catch (e) { ui.connectionError(e.message, init); }
  }
  // Read-only refreshes also pick up deposits and withdrawals made outside this tab.
  setInterval(() => { if (!document.hidden) void refreshWalletBalance(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshWalletBalance({ force: true }); });
  window.addEventListener('focus', () => { void refreshWalletBalance(); });
  return { invite:()=>state.account?.mode === 'token' ? features.invite() : connectWallet(), state, init, start, selectBet, customBet, rules, tab, refresh, retryPending, loadRecords, loadIngots, connectWallet, disconnectWallet, deposit, withdraw, payments, claimReward, view };
}

// Generic record rows shared by both frontends; each theme styles the classes.
export function recordRows(rounds) {
  if (!rounds.length) return [el('p', '还没有游戏记录，去开启第一局吧', 'empty-note')];
  return rounds.map(round => {
    const row = el('article', undefined, 'record-row record-' + resultKind(round)), main = el('div', undefined, 'record-main'), side = el('div', undefined, 'record-side');
    main.append(el('strong', (round.outcomeKind === 'empty' ? '谢谢参与' : round.multiplierBps / 10000 + '×') + ' · 投入 ' + money(round.bet) + ' 币'), el('small', when(round.createdAt)));
    side.append(el('strong', signed(round.profit) + ' 币', Number(round.profit) > 0 ? 'positive' : Number(round.profit) < 0 ? 'negative' : ''), el('small', resultText(round).record + (round.outcomeKind === 'empty' ? '' : ' ' + money(round.net))));
    if (Number(round.ingots) > 0) side.append(el('small', '金元宝 +' + money(round.ingots), 'record-ingots'));
    row.append(main, side); return row;
  });
}
export function ingotRows(records) {
  if (!records.length) return [el('p', '还没有金元宝记录', 'empty-note')];
  return records.map(round => {
    const row = el('article', undefined, 'record-row record-ingot'), main = el('div', undefined, 'record-main'), side = el('div', undefined, 'record-side');
    main.append(el('strong', round.multiplierBps === 0 ? '谢谢参与' : round.multiplierBps / 10000 + '×'), el('small', '投入 ' + money(round.bet) + ' 币 · ' + when(round.createdAt)));
    side.append(el('strong', '+' + money(round.ingots), 'ingot-amount'), el('small', '金元宝已到账'));
    row.append(main, side); return row;
  });
}
