import { ensureBscNetwork, isBscChain, loginBscWallet, bscWallet } from './shared/wallet-network.js';
import { accountFeatures } from './shared/account-features.js';
import { createWheel, buildWheelSegments, landingIndex } from './wheel.js?v=6';
import { sectorText, resultText } from './outcome-view.js?v=5';
const $ = id => document.getElementById(id);
let config, account, wheel, segments = [], bet = '500', busy = false, toastTimer, drawnVersion, shownIdentity, needsWalletLogin = false, needsBscNetwork = false, watchedWallet;
const features=accountFeatures({api,mutate,account:()=>account,config:()=>config,refresh,openDialog,notice,canOperate:()=>!!account&&!needsWalletLogin&&!needsBscNetwork&&!busy});
const pendingName = 'sheep-pending-v1';
const money = value => {
  const [whole, fraction = ''] = String(value ?? '0').split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
};
const short = value => value ? value.slice(0, 6) + '…' + value.slice(-4) : '';
const text = (id, value) => { $(id).textContent = value; };
function notice(message) { text('toast', message); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
function failure(e) { notice(e.message || '网络暂时断开，请稍后重试'); }
async function api(path, data, key) {
  let response;
  try { response = await fetch('/api' + path, { method: data ? 'POST' : 'GET', credentials: 'same-origin', headers: data ? { 'Content-Type': 'application/json', 'X-Game-Request': '1', ...(key ? { 'Idempotency-Key': key } : {}) } : {}, ...(data ? { body: JSON.stringify(data) } : {}) }); }
  catch { throw Object.assign(new Error('网络暂时断开，请点重试；不会重复扣款'), { uncertain: true }); }
  let result; try { result = await response.json(); } catch { throw Object.assign(new Error('暂时无法确认操作，请稍后重试'), { uncertain: true }); }
  if (!response.ok) throw Object.assign(new Error(result.error || '操作暂未完成'), { status: response.status, code: result.code, uncertain: response.status >= 500 || result.code === 'RETRY_OPERATION' });
  return result;
}
function getPending() { try { return JSON.parse(sessionStorage.getItem(pendingName)) || null; } catch { return null; } }
function savePending(value) { if (value) sessionStorage.setItem(pendingName, JSON.stringify(value)); else sessionStorage.removeItem(pendingName); }
function identity() { return account?.wallet || 'demo'; }
async function mutate(path, data = {}) {
  const previous = getPending();
  if (previous && (previous.path !== path || previous.owner !== identity())) throw new Error('请先重试上次未确认的操作');
  if (account?.mode === 'token') await bscWallet(window.ethereum, { expectedAddress: account.wallet });
  const operation = previous || { path, data, key: crypto.randomUUID(), owner: identity() };
  savePending(operation);
  try { const result = await api(operation.path, operation.data, operation.key); savePending(null); return result; }
  catch (e) { if (!e.uncertain) savePending(null); throw e; }
}
function setBusy(value) { busy = value; render(); }
function render() {
  if (!account) return;
  if (shownIdentity !== identity()) {
    shownIdentity = identity(); drawnVersion = undefined;
    $('records').replaceChildren(); $('ingot-records').replaceChildren();
    $('round-total').hidden = true; $('wheel-stage').classList.remove('has-result');
    $('wheel-stage').setAttribute('aria-label', '幸运转盘');
    text('stage-message', '选好金额，转出你的好运');
    loadRecords().catch(failure);
  }
  if (account.rules) config.rules = account.rules;
  if (account.withdrawalFee) config.payments.withdrawalFee = account.withdrawalFee;
  if (drawnVersion !== config.rules.version) paintWheel();
  text('wheel-odds', `格子数量不代表中奖概率 · 10× ${(config.rules.outcomes.find(o => o.id === 'jackpot')?.weight || 0) * 100 / config.rules.weightTotal}%`);
  for (const id of ['balance', 'account-balance', 'withdrawable-inline']) text(id, money(account.balance));
  for (const id of ['ingots-inline', 'ingot-balance']) text(id, money(account.ingots));
  text('ingot-mode-label', account.mode==='demo'?'测试账户金元宝':'正式账户金元宝');
  text('locked-balance', money(account.locked));
  const demo = account.mode === 'demo', pending = getPending();
  text('coin-unit', demo ? '测试币' : config.payments.symbol);
  text('mode-banner', demo ? '体验版 · 使用测试币，不能提现' : config.payments.enabled ? '正式账户 · BSC ' + config.payments.symbol : '正式账户尚未开放 · 可返回测试体验');
  text('account-description', demo ? '测试币用于体验玩法' : account.benefits?.whitelisted ? '白名单账户 · 专属概率 · 免提现手续费' : '游戏余额与钱包余额分开显示');
  text('wallet-address', account.wallet || '当前使用测试账户');
  $('wallet-connect').firstElementChild.textContent = needsWalletLogin ? '重新连接钱包' : needsBscNetwork && !demo ? '切换到 BSC' : demo ? '连接钱包' : '返回测试体验';
  text('bet-note', `每局最低 ${money(config.rules.minBet)} 币 · 当前上限 ${money(account.maxBet)} 币`);
  text('pool-note', '服务器奖池余额 ' + money(account.pool) + (demo ? ' 测试币' : ' ' + config.payments.symbol));
  $('start').disabled = busy || needsWalletLogin || (!demo && needsBscNetwork) || (pending ? pending.path !== '/play' : Number(account.balance) < Number(bet) || Number(account.maxBet) < Number(bet) || (!demo && !config.payments.enabled));
  $('start').firstElementChild.textContent = busy ? '正在处理，请稍候' : pending?.path === '/play' ? '查看上次结果' : '转一下';
  text('start-cost', '本局投入 ' + money(pending?.path === '/play' ? pending.data.amount : bet) + ' 币');
  for (const button of document.querySelectorAll('#bet-choices button, #wallet-connect, #deposit-open, #withdraw-open, #withdraw-shortcut')) button.disabled = busy || !!pending;
  $('connection-message').replaceChildren();
  if (!demo && needsBscNetwork) {
    $('connection-message').append(el('p', '请将钱包切换到 BSC 主网后继续。'), button('切换到 BSC 主网', switchNetwork));
  }
  if (pending) {
    const line = document.createElement('p'); line.textContent = '上次操作还未确认，请先重试。';
    const retry = document.createElement('button'); retry.className = 'dialog-primary'; retry.textContent = '核对上次操作'; retry.disabled = busy; retry.onclick = retryPending;
    $('connection-message').append(line, retry);
  }
}
async function refresh() { const fresh=await api('/account');if(!account||fresh.mode!==account.mode||fresh.wallet!==account.wallet||fresh.revision>=account.revision)account=fresh;render(); }
function tab(name) {
  for (const section of document.querySelectorAll('.view')) { section.hidden = section.id !== name + '-view'; section.classList.toggle('active', !section.hidden); }
  for (const button of document.querySelectorAll('.bottom-nav button')) { const selected = button.dataset.tab === name; button.classList.toggle('active', selected); if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); }
  if (name === 'rewards') loadIngots().catch(failure);
  if (name === 'account') loadRecords().catch(failure);
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function openDialog(title, content) { text('dialog-title', title); $('dialog-content').replaceChildren(); if (typeof content === 'string') { const p = document.createElement('p'); p.textContent = content; $('dialog-content').append(p); } else $('dialog-content').append(content); if (!$('dialog').open) $('dialog').showModal(); }
function el(tag, message, className) { const node = document.createElement(tag); if (message !== undefined) node.textContent = message; if (className) node.className = className; return node; }
function button(label, action) { const node = el('button', label, 'dialog-primary'); node.onclick = action; return node; }
function form(title, label, initial, action, options = {}) {
  const box = el('form'), name = el('label', label), input = el('input'); input.id = 'dialog-input'; name.htmlFor = input.id; input.value = initial; input.type = 'text'; input.inputMode = options.hash ? 'text' : 'decimal'; input.autocomplete = 'off'; input.spellcheck = false; input.required = true;
  const message = el('p', options.note || ''), error = el('p', '', 'form-error'); error.setAttribute('role', 'alert'); const submit = button(options.submit || '确定', null); submit.type = 'submit';
  box.append(name, input, message, error, submit);
  box.onsubmit = async event => { event.preventDefault(); submit.disabled = true; error.textContent = ''; try { await action(input.value.trim()); } catch (e) { error.textContent = e.message; } finally { submit.disabled = false; render(); } };
  openDialog(title, box);
}
function rules() {
  const box = el('div');
  if (account?.benefits?.whitelisted) box.append(el('p', '当前钱包适用白名单专属概率，提现手续费全免。以下是本钱包实际使用的概率。'));
  box.append(el('p', '选好金额，点击“转一下”。一次下注只转一次，抽中一个倍率，结算一次奖励。可选择 500、1,000、2,000 或 5,000 币固定档位。'));
  box.append(el('p', '数字倍率表示包含本金、扣费前的返还倍数。抽中大于 1 倍的奖项，在本局结算时收取投入金额的 5%；小于或等于 1 倍不收费。例：投入 500 币，1.2 倍返还 600 币，扣 25 币，实得 575 币；1.5 倍扣 25 币，实得 725 币。'));
  box.append(el('p', '“1×”：本局本金全额退回可用余额，不收手续费。你可以自行决定是否继续，下一局仍需点击“转一下”才会下注。'));
  box.append(el('p', '“谢谢参与”：返还 0 代币，获得与本局投入等量的金元宝。0.5 倍返还投入的 50%，其余 50% 按1:1获得金元宝。例如投入1,000币，分别获得1,000或500金元宝。1倍及以上不发金元宝，手续费不换金元宝。10 倍大奖扣费后实得投入的 9.95 倍。'));
  if (config?.rules.outcomes) {
    box.append(el('h3', '本版各倍率概率'));
    const table = el('table', undefined, 'wheel-probability-table'), header = el('tr');
    header.append(el('th', '奖项'), el('th', '概率')); table.append(header);
    for (const outcome of config.rules.outcomes) { const row = el('tr'); row.append(el('td', sectorText(outcome).label), el('td', outcome.weight * 100 / config.rules.weightTotal + '%')); table.append(row); }
    box.append(table);
  }
  const [lossChance,evenChance,winChance]=config.rules.resultProbabilities;
  box.append(el('p', `同一奖项在盘面重复出现，格子数量不代表中奖概率；同名奖格按一个奖项计算，合计概率见上表。按当前概率，仅计算游戏内奖励，单次亏损概率为 ${lossChance}%，保本为 ${evenChance}%，盈利为 ${winChance}%；扣除本局手续费后的理论返还率为 ${config.rules.netRtp}。10 倍大奖概率为 ${(config.rules.outcomes.find(o => o.id === 'jackpot')?.weight || 0) * 100 / config.rules.weightTotal}%，不保证固定次数内必定出现。`));
  box.append(el('p', '这是单次开奖的概率，不保证固定比例的玩家最终盈利，也不保证连续游戏时的本金损失范围。可能连续出现同一个倍率或连续亏损。'));
  box.append(el('p', '本版每次按以上固定概率开奖。投入的 9.3% 记为待销毁额度。'));
  box.append(el('p', '每局代币返还和金元宝均自动到账，无需手动领取。每一局按抽中的倍率判断手续费，费用按代币最小单位向下取整。提币不收取游戏手续费。金元宝与代币分别记账，不能用于下注或直接提币；兑换尚未开放，后续规则另行公布。'));
  box.append(el('p', '当前默认使用测试币，测试币不能提现。测试账户金元宝与正式账户分开，不能兑换真实资产。金元宝从新规则启用后累计，历史亏损不补发。'));
  openDialog('转盘玩法', box);
}
function selectBet(value) { if (!['500', '1000', '2000', '5000'].includes(value)) return; bet = value; for (const b of document.querySelectorAll('[data-bet]')) { const yes = b.dataset.bet === value; b.classList.toggle('chosen', yes); b.setAttribute('aria-pressed', String(yes)); } render(); }
async function showRound(round) {
  const index = landingIndex(segments, round, config.rules.version);
  const copy = resultText(round);
  if (index >= 0) {
    text('stage-message', '好运正在转动…');
    await wheel.spin(index);
    $('wheel-stage').classList.add('has-result');
    $('wheel-stage').setAttribute('aria-label', '转盘结果：' + copy.title);
  }
  if (index < 0) $('wheel-stage').setAttribute('aria-label', '已恢复上次结算，请查看下方奖励');
  $('round-total').replaceChildren();
  if (index >= 0) $('round-total').append(el('div', copy.title, 'wheel-result-multiplier'));
  $('round-total').append(el('span', copy.amountLabel), el('strong', money(round.net) + ' 币'));
  $('round-total').append(el('p', copy.message));
  if(Number(round.ingots)>0){const gold=el('div',undefined,'round-ingots');gold.append(el('span','本次获得金元宝 '),el('b','+'+money(round.ingots)));$('round-total').append(gold);}
  const details = el('div', undefined, 'wheel-result-details'), net = el('div', '本次净变化'), fee = el('div', round.version === config.rules.version ? '本局手续费' : '当时已扣费用');
  net.append(el('b', (Number(round.profit) > 0 ? '+' : '') + money(round.profit) + ' 币')); fee.append(el('b', money(round.fee) + ' 币')); details.append(net, fee); $('round-total').append(details);
  $('round-total').hidden = false;
  text('stage-message', index >= 0 ? copy.message : '已恢复上次游戏的结算结果');
}
async function start() {
  if (busy) return;
  if (account?.mode === 'token' && needsBscNetwork) return switchNetwork();
  if (needsWalletLogin) return notice('钱包已切换，请重新签名登录');
  if(features.offerReferral())return;
  setBusy(true); wheel.clear(); $('round-total').hidden = true; $('wheel-stage').classList.remove('has-result'); $('wheel-stage').classList.add('is-resolving');
  text('stage-message', '正在开奖，请稍候…'); $('wheel-stage').setAttribute('aria-label', '幸运转盘，正在开奖');
  try {
    const result = await mutate('/play', { amount: bet, rulesVersion: config.rules.version });
    try { await showRound(result.round); } finally {
      if(Number.isInteger(result.revision)&&result.revision>=account.revision){Object.assign(account,{balance:result.balance,rewards:result.rewards,ingots:result.ingots,revision:result.revision});render();}
      await refresh();
    }
  } catch (e) { text('stage-message', getPending() ? '结果尚未确认，请查看上次结果' : e.message); failure(e); if (e.code === 'RULES_CHANGED') { await init(); rules(); } }
  finally { $('wheel-stage').classList.remove('is-resolving'); setBusy(false); }
}
async function claimReward() { if (busy) return; setBusy(true); try { const result = await mutate('/claim'); account.balance = result.balance; account.rewards = result.rewards; render(); notice('历史奖励已自动到账'); await refresh(); await loadRecords(); } catch (e) { failure(e); } finally { setBusy(false); } }
async function retryPending() {
  const pending = getPending(); if (!pending || busy) return;
  if (pending.path === '/play') return start(); if (pending.path === '/claim') return claimReward();
  setBusy(true); try { const result = await mutate(pending.path, pending.data); if (pending.path === '/withdrawals') { if (result.fee !== undefined) withdrawalSaved(result); else openDialog('上次提现已确认', '已恢复此前的提现申请，请到充值与提现记录查看数量和进度。'); } await refresh(); notice('上次操作已确认'); } catch (e) { failure(e); } finally { setBusy(false); }
}
async function loadRecords() {
  const owner = identity(), result = await api('/rounds'); if (owner !== identity()) return; $('records').replaceChildren();
  if (!result.rounds.length) $('records').append(el('p', '还没有游戏记录，去开启第一局吧', 'empty-note'));
  for (const round of result.rounds) { const row = el('article', undefined, 'record-row'), left = el('div'), right = el('div'); left.append(el('strong', '投入 ' + money(round.bet) + ' 币'), el('small', new Date(round.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))); right.append(el('strong', (Number(round.profit) > 0 ? '+' : '') + money(round.profit) + ' 币', Number(round.profit) > 0 ? 'positive-text' : ''), el('small', resultText(round).record + (round.outcomeKind === 'empty' ? '' : ' ' + money(round.net)))); if(Number(round.ingots)>0)right.append(el('small','金元宝 +'+money(round.ingots),'record-ingots')); row.append(left, right); $('records').append(row); }
}
async function loadIngots() {
  const owner = identity(); await refresh(); if (owner !== identity()) return; const result=await api('/ingots'); if (owner !== identity()) return; if(result.revision>=account.revision){account.ingots=result.balance;render();}$('ingot-records').replaceChildren();
  if(!result.records.length)$('ingot-records').append(el('p','还没有金元宝记录','empty-note'));
  for(const round of result.records){const row=el('article',undefined,'record-row'),left=el('div'),right=el('div');left.append(el('strong',round.multiplierBps===0?'谢谢参与':round.multiplierBps/10000+'×'),el('small','投入 '+money(round.bet)+' 币'),el('small',new Date(round.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})));right.append(el('strong','+'+money(round.ingots),'ingot-history-amount'),el('small','金元宝已到账'));row.append(left,right);$('ingot-records').append(row);}
}

function watchNetwork() {
  const provider = window.ethereum;
  if (!provider?.request || watchedWallet === provider) return;
  watchedWallet = provider;
  provider.on?.('chainChanged', chain => {
    if (account?.mode !== 'token') return;
    needsBscNetwork = !isBscChain(chain); render();
    if (needsBscNetwork) notice('当前不是 BSC 主网，请点击“切换到 BSC 主网”');
  });
}
async function checkNetwork() {
  watchNetwork(); needsBscNetwork = false;
  if (account?.mode === 'token') {
    try { needsBscNetwork = !isBscChain(await window.ethereum?.request?.({ method: 'eth_chainId' })); }
    catch { needsBscNetwork = true; }
  }
}
async function switchNetwork() {
  if (busy) return;
  setBusy(true);
  try { watchNetwork(); await ensureBscNetwork(window.ethereum); await checkNetwork(); notice('已切换到 BSC 主网'); }
  catch (e) { failure(e); }
  finally { setBusy(false); }
}

async function connectWallet() {
  if (busy) return;
  if (getPending()) return notice('请先核对上次操作');
  if (account.mode === 'token' && needsBscNetwork && !needsWalletLogin) return switchNetwork();
  if (account.mode === 'token' && !needsWalletLogin) { try { account = await api('/auth/demo', {}); needsWalletLogin = false; needsBscNetwork = false; render(); notice('已返回测试体验'); } catch (e) { failure(e); } return; }
  const box = el('div'); box.append(el('p', config.payments.enabled ? '使用钱包签名登录正式账户。签名不会转账或授权代币。' : '正式充值提现尚未开放。可以先签名连接钱包查看账户，正式账户与测试币分开。'));
  box.append(el('p', '连接时会自动请求切换到 BSC 主网，请在钱包中确认。'));
  box.append(button('连接并签名登录', async () => {
    if (busy) return;
    if (!window.ethereum?.request) { openDialog('请使用钱包浏览器', '请在支持 BSC 的钱包应用内打开本页，再点击连接钱包。普通浏览器暂不支持扫码连接。'); return; }
    setBusy(true);
    try {
      watchNetwork();
      account = await loginBscWallet(window.ethereum, api); needsWalletLogin = false;
      await checkNetwork(); $('dialog').close(); render(); notice('钱包已连接 BSC 主网'); features.offerReferral();
    } catch (e) { failure(e.code === 4001 ? new Error('你已取消钱包操作') : e); } finally { setBusy(false); }
  })); openDialog('连接钱包', box);
}
function checkPayments() { if (needsWalletLogin) { notice('钱包已切换，请重新签名登录'); return false; } if (!config.payments.enabled) { openDialog('正式充值提现暂未开放', '现在可以使用测试币体验完整游戏。测试币不可充值或提现，正式资金开通后会在这里显示收款信息。'); return false; } if (account.mode !== 'token') { openDialog('请先连接钱包', '在“我的账户”连接钱包并签名登录，即可使用正式币账户。'); return false; } return true; }
function deposit() {
  if (account.mode === 'demo') { form('充值测试币', '这次充多少测试币？', '10000', async value => { if (!/^[1-9]\d{0,6}$/.test(value) || Number(value) > 1000000) throw new Error('请输入 1 至 1,000,000 之间的整数'); const result = await mutate('/demo/topup', { amount: value }); $('dialog').close(); await refresh(); notice('已充值 ' + money(result.amount) + ' 测试币'); }, { note: '测试版调试功能：测试币只用于体验，不能提现。', submit: '充值' }); return; }
  if (!checkPayments()) return;
  if(config.payments.mode==='vault')return features.deposit();
  const box = el('div'); box.append(el('p', '仅支持 BSC 网络 ' + config.payments.symbol + '。请从当前登录钱包直接转账到下面地址，再提交交易哈希核对到账。'), el('p', config.payments.depositAddress, 'wallet-address'), el('p', '代币合约：' + config.payments.token, 'wallet-address'), el('p', `需等待 ${config.payments.confirmations} 个区块确认；按实际收到的代币数量入账。`));
  box.append(button('复制充值地址', async () => { try { await navigator.clipboard.writeText(config.payments.depositAddress); notice('已复制'); } catch { notice('请长按地址复制'); } }), button('我已转账，核对到账', () => form('核对充值到账', '粘贴完整交易哈希', '', async txHash => { const result = await mutate('/deposits', { txHash }); await refresh(); openDialog('充值已到账', money(result.amount) + ' 币已进入游戏余额。'); }, { hash: true, submit: '核对到账' })));
  openDialog('充值 ' + config.payments.symbol, box);
}
function withdrawalSaved(result) {
  if(result.status==='authorized')return features.withdrawalSaved(result);
  openDialog('提现申请已保存', money(result.amount) + ' 币已冻结，其中手续费 ' + money(result.fee) + ' 币，预计转出 ' + money(result.payout) + ' 币至 ' + short(result.recipient) + '。请到充值与提现记录查看进度。');
}
function reviewWithdrawal(quote) {
  const box = el('div', undefined, 'withdrawal-quote'), error = el('p', '', 'form-error'); error.setAttribute('role', 'alert');
  for (const [label, value] of [['申请提现', quote.amount], ['手续费（' + quote.feeBps / 100 + '%）', quote.fee], ['预计转出', quote.payout]]) {
    const row = el('div', undefined, 'account-line'); row.append(el('span', label), el('b', money(value) + ' 币')); box.append(row);
  }
  box.append(el('p', '转入当前钱包 ' + short(quote.recipient) + '。本次提现不收手续费。'));
  let submitting = false, expired = false;
  const submit = button('确认提现', async () => {
    if (submitting || busy) return;
    submitting = true; submit.disabled = true; setBusy(true); error.textContent = '';
    try {
      const result = await mutate('/withdrawals', { amount: quote.amount, feeVersion: quote.feeVersion });
      withdrawalSaved(result); await refresh();
    } catch (e) {
      error.textContent = e.message;
      if (e.code === 'FEE_CHANGED') { expired = true; box.append(button('重新查看手续费', withdraw)); }
    } finally { submitting = false; setBusy(false); submit.disabled = expired; submit.textContent = getPending() ? '重试确认' : '确认提现'; }
  });
  box.append(error, submit); openDialog('确认提现金额', box);
}
function withdraw() {
  if (!config.payments.enabled) { openDialog('正式提现暂未开放', '提现不收手续费：申请 1,000 币，预计转出 1,000 币。只有转盘抽中大于 1 倍时，按该局投入收取 5%。当前测试币不能提现。'); return; }
  if (!checkPayments()) return;
  form('申请提现', '提现数量（币）', '', async amount => {
    reviewWithdrawal(await api('/withdrawals/quote', { amount }));
  }, { note: '提现不收手续费。可用余额 ' + money(account.balance) + ' 币。下一步查看预计转出数量。', submit: '下一步' });
}
async function payments() {
  try {
    const result = await api('/payments'), box = el('div'), labels = { authorized: '待提交合约提现', queued: '待处理', submitted: '链上确认中', confirmed: '已到账', failed: '交易失败，已退回', rejected: '已退回余额' };
    if (!result.deposits.length && !result.withdrawals.length) box.append(el('p', '暂无充值与提现记录'));
    for (const d of result.deposits) box.append(el('p', '充值 +' + money(d.amount) + ' 币 · 已到账'));
    for (const w of result.withdrawals) { const row = el('div', undefined, 'payment-row'); row.append(el('p', '提现 ' + money(w.amount) + ' 币 · ' + (labels[w.status] || w.status))); row.append(el('p', ['failed', 'rejected'].includes(w.status) ? '申请数量已全额退回，不收手续费' : '手续费 ' + money(w.fee) + ' 币 · ' + (w.status === 'confirmed' ? '已转出 ' : '预计转出 ') + money(w.payout) + ' 币')); if (w.tx_hash) { const link = el('a', '查看链上记录'); link.href = 'https://bscscan.com/tx/' + w.tx_hash; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); } if (w.status === 'submitted') row.append(button('核对到账', async () => { try { await mutate('/withdrawals/' + w.id + '/check'); await refresh(); await payments(); } catch (e) { failure(e); render(); } })); row.append(...features.withdrawalActions(w)); box.append(row); }
    openDialog('充值与提现记录', box);
  } catch (e) { failure(e); }
}
function ready(action) { return () => { if (!account || !config) { notice('正在连接游戏账户，请稍候'); return; } return action(); }; }
for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => tab(b.dataset.tab);
for (const b of document.querySelectorAll('[data-bet]')) b.onclick = () => selectBet(b.dataset.bet);
$('start').onclick = start; $('refresh-records').onclick = () => loadRecords().catch(failure); $('refresh-ingots').onclick = () => loadIngots().catch(failure);
$('wheel-rules').onclick = rules; $('rules-open').onclick = rules; $('rules-account').onclick = rules; $('dialog-close').onclick = () => $('dialog').close();
$('invite-open').onclick=ready(()=>features.invite().catch(failure));
$('wallet-connect').onclick = ready(connectWallet); $('deposit-open').onclick = ready(deposit); $('withdraw-open').onclick = ready(withdraw); $('withdraw-shortcut').onclick = ready(withdraw); $('payments-open').onclick = ready(payments);
window.ethereum?.on?.('accountsChanged', addresses => { if (account?.mode !== 'token') return; needsWalletLogin = addresses?.[0]?.toLowerCase() !== account.wallet.toLowerCase(); if (needsWalletLogin) notice('钱包已切换，请重新签名登录'); render(); });
function paintWheel() {
  segments = buildWheelSegments(config.rules.outcomes); wheel = createWheel($('wheel-rotor'), segments);
  $('wheel-prizes').replaceChildren(...config.rules.outcomes.map(outcome => {
    const copy = sectorText(outcome); return el('li', copy.label, 'wheel-prize wheel-prize-' + copy.kind);
  }));
  drawnVersion = config.rules.version;
}
async function init() {
  try {
    config = await api('/config'); if (!config.rules.outcomes?.length) throw new Error('页面正在更新，请稍后重新连接');
    paintWheel();
    try { account = await api('/account'); } catch (e) { if (e.status !== 401) throw e; account = await api('/auth/demo', {}); }
    await checkNetwork(); render(); features.offerReferral();
  }
  catch (e) { $('connection-message').replaceChildren(el('p', e.message), button('重新连接', init)); }
}
init();
