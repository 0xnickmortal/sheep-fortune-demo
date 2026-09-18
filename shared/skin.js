// Shared skin runtime for the themed mobile frontends. Every skin uses the
// same element ids; this module wires them to the game client and lets each
// skin supply its own labels, flavour text, seal stamps and effects.
import { createGame, money, signed, el, createSound, particles, haptic, buildWheelSvg, spinRotor, stopAngle, sectorText, recordRows, ingotRows } from './core.js?v=server-wheel-77-v13-20260917-f116db43bfca';
import { compactTokenBalance } from './wallet-network.js?v=server-wheel-77-v13-20260917-f116db43bfca';
export { particles, haptic, money, signed, el };
const $ = id => document.getElementById(id);
const text = (id, value) => { const node = $(id); if (node) node.textContent = value; };

export function mountSkin({ navSelector, startLabel = '转一下', customLabel = '自定义', longAfter = 6, longerAfter = 8, spinningMessage = '好运正在转动…', flavor = {}, stamp = null, celebrate = () => {} }) {
  const sound = createSound('sheep-sound');
  let rotation = 0, groups = [], segmentCount = 24, toastTimer;
  const stage = () => $('wheel-stage');
  function notice(message) { text('toast', message); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
  function openDialog(title, content) { text('dialog-title', title); const box = $('dialog-content'); box.replaceChildren(); box.append(typeof content === 'string' ? el('p', content) : content); if (!$('dialog').open) $('dialog').showModal(); }
  function closeDialog() { if ($('dialog').open) $('dialog').close(); }
  function message(value) { $('result').hidden = true; $('stage-message').hidden = false; text('stage-message', value); }
  const ui = {
    render(v) {
      if (!v.account) return;
      const a = v.account;
      for (const id of ['balance', 'account-balance']) text(id, v.guest ? '—' : money(a.balance));
      for (const id of ['ingots-inline', 'ingot-balance']) text(id, v.guest ? '—' : money(a.ingots));
      for (const id of ['balance', 'ingots-inline']) { const node = $(id), length = node.textContent.length; node.classList.toggle('long', length > longAfter); node.classList.toggle('longer', length > longerAfter); }
      text('ingot-mode-label', '我的金元宝');
      text('locked-balance', money(a.locked));
      text('coin-unit', v.unit); text('mode-banner', v.modeText);
      text('account-description', v.guest ? '连接钱包后查看余额' : a.benefits?.whitelisted ? '专属游戏配置 · 免提现手续费' : '游戏余额与钱包余额分开显示');
      text('wallet-address', a.wallet || '尚未连接钱包');
      const connected = !v.guest && !v.needsWalletLogin && !v.needsBscNetwork;
      const holdings = v.walletBalance;
      const walletLabel = v.needsWalletLogin ? '重新连接钱包' : v.needsBscNetwork ? '切换到 BSC' : v.guest ? '连接钱包' : a.wallet.slice(0, 6) + '…' + a.wallet.slice(-4);
      const holdingLabel = !connected ? '查看持币数量' : holdings.value !== null ? '持有 ' + compactTokenBalance(holdings.value) + ' 枚' : holdings.status === 'error' ? '余额暂不可用' : '正在读取余额…';
      text('wallet-top-label', walletLabel); text('wallet-top-balance', holdingLabel);
      const topWallet = $('wallet-top');
      if (topWallet) {
        topWallet.classList.toggle('connected', connected);
        topWallet.setAttribute('aria-label', connected ? '我的钱包 ' + a.wallet + '，' + holdingLabel + ' ' + v.unit : walletLabel);
        topWallet.title = connected && holdings.value !== null ? v.unit + '：' + money(holdings.value) + ' 枚' : walletLabel;
        topWallet.disabled = v.busy;
      }
      text('wallet-balance-detail', !connected ? '请重新连接 BSC 钱包' : holdings.value !== null ? money(holdings.value) + ' 枚' : holdings.status === 'error' ? '读取失败，请点击刷新重试' : '正在读取…');
      $('wallet-connect').firstElementChild.textContent = v.needsWalletLogin ? '重新连接钱包' : v.needsBscNetwork ? '切换到 BSC' : v.guest ? '连接钱包' : '重新连接钱包';
      text('deposit-open', '充值');
      if ($('admin-entry')) $('admin-entry').hidden = !a.admin;
      for (const b of document.querySelectorAll('[data-bet]')) { const yes = b.dataset.bet === v.bet; b.classList.toggle('chosen', yes); b.setAttribute('aria-pressed', String(yes)); }
      const custom = $('custom-bet'); custom.classList.toggle('chosen', v.isCustom); custom.setAttribute('aria-pressed', String(v.isCustom)); custom.firstElementChild.textContent = v.isCustom ? money(v.bet) : customLabel;
      $('start').disabled = !v.canPlay; $('start').firstElementChild.textContent = v.startLabel || startLabel; text('start-cost', '本局投入 ' + v.startCost + ' 币');
      for (const b of document.querySelectorAll('#bet-choices button, #wallet-connect, #deposit-open, #withdraw-open')) b.disabled = v.lockControls;
      const box = $('connection-message'); box.replaceChildren();
      if (v.needsBscNetwork) { const retry = el('button', '切换到 BSC 主网', 'dialog-primary'); retry.type = 'button'; retry.disabled = v.busy; retry.onclick = v.switchNetwork; box.append(el('p', '请将钱包切换到 BSC 主网后继续。'), retry); }
      if (v.pending) { box.append(el('p', '上次操作还未确认，请先重试。')); const retry = el('button', '核对上次操作', 'dialog-primary'); retry.type = 'button'; retry.disabled = v.busy; retry.onclick = v.retry; box.append(retry); }
    },
    openDialog, closeDialog, notice,
    resetResult() {
      stage().classList.remove('has-result', 'result-win', 'result-loss', 'result-even');
      stage().setAttribute('aria-label', '幸运转盘');
      message('选好金额，转出你的好运');
    },
    buildWheel(segments, config) {
      segmentCount = segments.length; rotation = 0;
      const built = buildWheelSvg(segments, { labelRadius: 128 }); groups = built.groups;
      $('wheel-rotor').replaceChildren(built.svg); $('wheel-rotor').style.transform = 'rotate(0deg)';
    },
    beginSpin() {
      for (const g of groups) g.classList.remove('landed');
      const s = stage(); s.classList.remove('result-win', 'result-loss', 'result-even', 'has-result'); s.classList.add('is-resolving');
      message('正在开奖，请稍候…'); s.setAttribute('aria-label', '幸运转盘，正在开奖');
    },
    async spinTo(index) {
      const s = stage(); s.classList.remove('is-resolving'); s.classList.add('is-spinning'); message(spinningMessage);
      const target = stopAngle(rotation, index, segmentCount);
      await spinRotor($('wheel-rotor'), rotation, target, { count: segmentCount, onCross: () => sound.tick() });
      rotation = target; groups[index].classList.add('landed'); s.classList.remove('is-spinning');
    },
    // A compact strip under the wheel: everything stays on one screen, no popup.
    showResult(round, { landed, copy, kind }) {
      const s = stage(), box = $('result');
      box.className = 'result result-' + kind; box.replaceChildren();
      s.classList.add('has-result'); s.setAttribute('aria-label', landed ? '转盘结果：' + copy.title : '已恢复上次结算，请查看下方奖励');
      if (landed && stamp?.[kind]) box.append(el('span', stamp[kind], 'result-stamp'));
      const main = el('div', undefined, 'result-main');
      main.append(el('b', round.outcomeKind === 'empty' ? '谢谢参与' : round.multiplierBps / 10000 + '×', 'result-multiplier'), el('span', landed ? (flavor[kind] || copy.title) : '已恢复上次结算', 'result-flavor'));
      const side = el('div', undefined, 'result-side'), ingots = Number(round.ingots) > 0;
      side.append(el('strong', copy.amountLabel + ' ' + money(round.net) + ' 币'));
      side.append(el('small', '净变化 ' + signed(round.profit) + ' 币 · ' + (round.version === game.state.config.rules.version ? '手续费 ' : '当时已扣 ') + money(round.fee) + ' 币'));
      side.append(el('small', ingots ? '金元宝 +' + money(round.ingots) : copy.message, ingots ? 'result-ingots' : 'result-message'));
      box.append(main, side);
      $('stage-message').hidden = true; box.hidden = false;
      if (landed) celebrate(kind, round, { stage: s, sound, particles, haptic });
    },
    spinFailed(value) { message(value); },
    endSpin() { stage().classList.remove('is-resolving', 'is-spinning'); },
    setTab(name) {
      for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== name + '-view';
      for (const b of document.querySelectorAll(navSelector + ' button')) { const on = b.dataset.tab === name; b.classList.toggle('active', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
      $('dock').hidden = name !== 'play';
      window.scrollTo({ top: 0, behavior: 'instant' });
    },
    renderRecords(rounds) { $('records').replaceChildren(...recordRows(rounds)); },
    renderIngots(result) { $('ingot-records').replaceChildren(...ingotRows(result.records)); },
    connectionError(value, retry) { const box = $('connection-message'); box.replaceChildren(el('p', value)); const b = el('button', '重新连接', 'dialog-primary'); b.type = 'button'; b.onclick = retry; box.append(b); text('mode-banner', '暂时无法连接游戏账户'); },
  };
  const game = createGame(ui);
  for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => { sound.click(); game.tab(b.dataset.tab); };
  for (const b of document.querySelectorAll('[data-bet]')) b.onclick = () => { sound.click(); game.selectBet(b.dataset.bet); };
  $('custom-bet').onclick = () => { sound.click(); game.customBet(); };
  $('start').onclick = () => { sound.click(); game.start(); };
  $('rules-open').onclick = () => game.rules();
  $('dialog-close').onclick = closeDialog;
  $('dialog').addEventListener('click', e => { if (e.target === $('dialog')) closeDialog(); });
  $('wallet-connect').onclick = () => game.connectWallet();
  if ($('wallet-top')) $('wallet-top').onclick = () => game.connectWallet();
  $('deposit-open').onclick = () => game.deposit();
  $('withdraw-open').onclick = () => game.withdraw();
  $('invite-open').onclick=()=>game.invite().catch(e=>notice(e.message));
  $('payments-open').onclick = () => game.payments();
  $('refresh-records').onclick = () => game.loadRecords().catch(e => notice(e.message));
  $('refresh-ingots').onclick = () => game.loadIngots().catch(e => notice(e.message));
  function paintSound() { const on = sound.enabled; $('sound').setAttribute('aria-pressed', String(on)); $('sound').setAttribute('aria-label', on ? '关闭音效' : '打开音效'); $('sound').classList.toggle('muted', !on); }
  $('sound').onclick = () => { sound.toggle(); paintSound(); notice(sound.enabled ? '音效已开启' : '音效已关闭'); };
  paintSound();
  game.init();
  return { game, sound, ui };
}
