import { request, restore, login, logout, beforeWrite, watchWallet } from './shared.js';
import { copyText } from '../shared/clipboard.js';
const $ = id => document.getElementById(id);
const labels = { wallets: '地址总览', deposits: '充值记录', withdrawals: '提现记录', rounds: '游戏盈亏', referrals: '推荐收益' };
const state = { authenticated: false, busy: false, generation: 0, tab: 'wallets', page: 1, pages: 1, filters: {search:'',from:'',to:''}, detail: null, detailGeneration: 0, poolLoaded: false };
function el(tag, value, className) { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node; }
function format(value, signed = false) {
  if (value === null || value === undefined) return '待核验';
  const raw = String(value), negative = raw.startsWith('-'), [whole, decimals = ''] = raw.replace(/^-/, '').split('.');
  const fraction = decimals.slice(0, 4).replace(/0+$/, ''), remainder = /[1-9]/.test(decimals.slice(4));
  if (whole === '0' && !/[1-9]/.test(fraction) && remainder) return negative ? '> −0.0001' : '< 0.0001';
  const sign = negative ? '−' : signed && /[1-9]/.test(raw) ? '+' : '';
  return (remainder ? '≈' : '') + sign + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
}
const tone = value => String(value).startsWith('-') ? 'negative' : /[1-9]/.test(String(value)) ? 'positive' : 'neutral';
const short = wallet => wallet ? wallet.slice(0, 8) + '…' + wallet.slice(-6) : '—';
const time = value => new Intl.DateTimeFormat('zh-CN', { timeZone:'Asia/Shanghai', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date(value));
const fullTime = value => new Intl.DateTimeFormat('zh-CN', { timeZone:'Asia/Shanghai', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false }).format(new Date(value));
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('invalid', error); }
function updateControls() {
  for (const button of document.querySelectorAll('main button')) button.disabled = state.busy;
  $('prev').disabled = state.busy || state.page <= 1; $('next').disabled = state.busy || state.page >= state.pages;
  for (const control of document.querySelectorAll('#filters input, .table-options select')) control.disabled = state.busy;
  $('table-panel').setAttribute('aria-busy', String(state.busy));
}
async function action(fn) {
  if (state.busy) return;
  state.busy = true; updateControls();
  try { await fn(); }
  catch (error) { if ([401,403].includes(error.status)) clearView(); status(error.message, true); }
  finally { state.busy = false; updateControls(); }
}
function clearView() {
  state.authenticated = false; state.generation++; state.detailGeneration++; state.detail = null; state.poolLoaded = false;
  $('dashboard').hidden = true; $('login-panel').hidden = false; $('identity').hidden = true; $('logout').hidden = true; $('connect').hidden = false;
  for (const id of ['metrics','mini-metrics','main-table','pool','detail-table','detail-metrics','detail-wallet','identity']) $(id).replaceChildren();
  $('detail-status').textContent = ''; $('wallet-dialog').close();
}
function connected(session) {
  state.authenticated = true; $('identity').textContent = short(session.wallet); $('identity').title = session.wallet;
  $('identity').hidden = false; $('logout').hidden = false; $('connect').hidden = true; $('login-panel').hidden = true; $('dashboard').hidden = false;
}
function params(extra = {}) {
  const p = new URLSearchParams();
  for (const [key,value] of Object.entries({...state.filters, ...extra})) if (value !== '' && value !== undefined) p.set(key,String(value));
  return p;
}
const rangeText = () => state.filters.from || state.filters.to ? `${state.filters.from || '最早记录'} 至 ${state.filters.to || '今天'} · 北京时间` : '全部时间';
function metric(label, value, note, signed = false) {
  const card = el('article', undefined, 'metric'), number = el('strong',format(value,signed),'metric-value' + (signed ? ' '+tone(value) : ''));
  number.title = value; card.append(el('span',label,'metric-label'), number, el('span',note,'metric-note')); return card;
}
function renderMetrics(report) {
  const s = report.summary;
  $('metrics').replaceChildren(
    metric('已入账充值',s.deposited,s.depositCount+' 笔已确认'), metric('已完成提现',s.withdrawn,s.withdrawalCount+' 笔 · 按实际到账量'),
    metric('游戏净盈亏',s.gameProfit,s.roundCount+' 局 · 已扣游戏手续费',true), metric('推荐收益',s.referralIncome,s.referralCount+' 笔实际入账')
  );
  const items = [['钱包地址',s.walletCount+' 个'],['当前可用余额',format(s.balance)],['当前冻结额',format(s.locked)],['待确认充值',s.pendingDepositCount+' 笔'],['待处理提现',s.pendingWithdrawalCount+' 笔']];
  $('mini-metrics').replaceChildren(...items.map(([label,value]) => { const node = el('span',label); node.append(el('strong',value)); return node; }));
  $('token-symbol').textContent = report.symbol;
  $('updated-at').textContent = '更新于 ' + fullTime(report.generatedAt) + '（北京时间）';
  const filterLabel = state.tab === 'wallets' && $('profit').value !== 'all' ? ' · '+$('profit').selectedOptions[0].textContent : '';
  $('scope-note').textContent = (state.filters.search ? '匹配地址' : '全部地址') + ' · ' + rangeText() + filterLabel;
}
function addressCell(wallet, sub = '') {
  const td = el('td',undefined,'wallet-cell'), button = el('button',short(wallet),'address-button');
  button.type='button'; button.title=wallet; button.setAttribute('aria-label','查看地址 '+wallet+' 的资金明细'); button.onclick=()=>openWallet(wallet);
  td.append(button); if(sub) td.append(el('span',sub,'subline')); return td;
}
function amountCell(value, signed = false, sub = '') {
  const td = el('td',format(value,signed),'num'+(signed?' '+tone(value):'')); td.title = value === null ? '等待链上核验后显示实际金额' : String(value);
  if(sub)td.append(el('span',sub,'subline')); return td;
}
function badge(label, type) { return el('span',label,'badge '+type); }
function profitBadge(a) { return !a.roundCount ? badge('未游戏','') : a.gameProfit.startsWith('-') ? badge('亏损','loss') : /[1-9]/.test(a.gameProfit) ? badge('盈利','profit') : badge('持平','even'); }
function table(target, headers, rows) {
  const head = document.createElement('thead'), tr = document.createElement('tr');
  for (const header of headers) { const th = el('th', Array.isArray(header)?header[0]:header,Array.isArray(header)?header[1]:''); th.scope='col'; tr.append(th); }
  head.append(tr); const body = document.createElement('tbody'); body.append(...rows); target.replaceChildren(head,body);
  target.parentElement.tabIndex=0; target.parentElement.setAttribute('aria-label','可横向滚动查看全部列');
}
function walletTable(rows) {
  table($('main-table'),['钱包地址',['累计充值','num'],['累计提现','num'],['游戏净盈亏','num'],['推荐收益','num'],['综合净收益','num'],['当前余额','num'],'游戏表现','最近活动'], rows.map(a=>{
    const tr=el('tr'); tr.append(addressCell(a.wallet,a.roundCount+' 局游戏'),amountCell(a.deposited,false,a.depositCount+' 笔'),amountCell(a.withdrawn,false,a.withdrawalCount+' 笔'),amountCell(a.gameProfit,true),amountCell(a.referralIncome),amountCell(a.totalProfit,true),amountCell(a.balance,false,'冻结 '+format(a.locked)));
    const kind=el('td');kind.append(profitBadge(a));const at=el('td',time(a.lastActivity),'muted');at.title=fullTime(a.lastActivity);tr.append(kind,at);return tr;
  }));
}
const paymentStatus = {confirmed:['已完成','confirmed'],pending:['确认中','pending'],queued:['待处理','pending'],authorized:['待钱包提交 / 确认','pending'],submitted:['链上确认中','pending'],failed:['未成功','failed'],rejected:['已退回余额','failed']};
function recordTable(target, kind, rows, detail = false) {
  const columns = {deposits:[['充值金额','num'],'状态','交易 / 说明'],withdrawals:[['申请金额','num'],['手续费','num'],['实际 / 预计到账','num'],'状态','交易'],rounds:['倍率',['下注','num'],['实际返还','num'],['手续费','num'],['游戏净盈亏','num']],referrals:['推荐层级','贡献地址',['入账收益','num'],'关联游戏局']}[kind];
  table(target,[...(detail?[]:['钱包地址']),'时间（北京）',...columns],rows.map(r=>{
    const tr=el('tr');if(!detail)tr.append(addressCell(r.wallet));const at=el('td',time(r.createdAt),'muted');at.title=fullTime(r.createdAt);tr.append(at);
    if(kind==='deposits'||kind==='withdrawals') {
      const amount = amountCell(r.amount); if(r.amount===null&&r.status==='failed'){amount.textContent='未入账';amount.title='充值未成功，无已核验的入账金额';} tr.append(amount);
      if(kind==='withdrawals')tr.append(amountCell(r.fee),amountCell(r.payout,false,r.status==='confirmed'?'已到账':['failed','rejected'].includes(r.status)?'未转出':'预计到账'));
      const [label,type]=paymentStatus[r.status]||[r.status,''],s=el('td');s.append(badge(kind==='deposits'&&r.status==='confirmed'?'已入账':label,type));tr.append(s);
      const info=el('td');
      if(r.hash){const link=el('a','查看交易 ↗','tx-link');link.href='https://bscscan.com/tx/'+r.hash;link.target='_blank';link.rel='noopener noreferrer';link.title=r.hash;info.append(link);}
      else info.append(el('span','尚无链上交易','record-note'));
      if(r.detail){const note=el('span',r.detail,'subline record-note');note.title=r.detail;info.append(note);}
      if(kind==='withdrawals'&&r.counterparty?.toLowerCase()!==r.wallet.toLowerCase()){const recipient=el('span','收款 '+short(r.counterparty),'subline');recipient.title=r.counterparty;info.append(recipient);}
      tr.append(info);
    }else if(kind==='rounds')tr.append(el('td',r.multiplier+'×'),amountCell(r.amount),amountCell(r.net),amountCell(r.fee),amountCell(r.profit,true));
    else {const level=el('td');level.append(badge(r.status==='1'?'直推收益':'间推收益','confirmed'));const player=el('td',short(r.counterparty));player.title=r.counterparty||'';const round=el('td',r.detail.slice(0,8)+'…','muted');round.title=r.detail;tr.append(level,player,amountCell(r.amount),round);}
    return tr;
  }));
}
async function load() {
  const generation=++state.generation;
  const overviewParams=params({profit:state.tab==='wallets'?$('profit').value:'all',sort:$('sort').value,page:state.tab==='wallets'?state.page:1});
  const [report, records] = await Promise.all([request('/admin/finance?'+overviewParams),state.tab==='wallets'?null:request('/admin/finance/records?'+params({kind:state.tab,status:$('record-status').value||'all',page:state.page}))]);
  if(!state.authenticated||generation!==state.generation)return;
  renderMetrics(report);
  const data=records||report;state.page=data.page;state.pages=data.pages;
  if(records)recordTable($('main-table'),state.tab,records.records);else walletTable(report.wallets);
  $('empty').hidden=data.total>0;$('main-table').hidden=!data.total;
  $('table-caption').textContent=state.tab==='wallets'?'每个地址独立汇总，点击地址展开明细。':{deposits:'已入账、确认中和未成功的充值分状态展示。',withdrawals:'申请额、手续费与到账量分开列示。',rounds:'每局返还减下注本金；绿色为盈利，红色为亏损。',referrals:'直推与间推分层展示，仅统计实际入账。'}[state.tab];
  $('page-label').textContent=`共 ${data.total} ${state.tab==='wallets'?'个地址':'条记录'} · 第 ${data.page} / ${data.pages} 页`;
  status('');updateControls();
}
function activateTabs(container, attribute, active) {
  for(const button of container.querySelectorAll('['+attribute+']')){const selected=button.getAttribute(attribute)===active;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;}
}
function recordOptions() {
  const choices={deposits:[['all','全部状态'],['confirmed','已入账'],['pending','确认中'],['failed','未成功']],withdrawals:[['all','全部状态'],['confirmed','已完成'],['pending','待处理 / 确认中'],['failed','未成功 / 已退回']],rounds:[['all','全部结果'],['profit','盈利局'],['loss','亏损局'],['even','持平局']],referrals:[['all','全部层级'],['direct','直推收益'],['indirect','间推收益']]}[state.tab]||[];
  $('record-status').replaceChildren(...choices.map(([value,label])=>{const option=el('option',label);option.value=value;return option;}));
}
async function changeTab(tab) {
  state.tab=tab;state.page=1;activateTabs(document.querySelector('.data-panel .tabs'),'data-tab',tab);
  $('profit-wrap').hidden=tab!=='wallets';$('sort-wrap').hidden=tab!=='wallets';$('record-status-wrap').hidden=tab==='wallets';$('table-panel').setAttribute('aria-label',labels[tab]);recordOptions();await load();
}
function detailControls(busy=false) {
  $('detail-prev').disabled=busy||!state.detail||state.detail.page<=1;$('detail-next').disabled=busy||!state.detail||state.detail.page>=state.detail.pages;
  for(const b of $('detail-tabs').querySelectorAll('button'))b.disabled=busy;
}
async function loadDetail(withSummary=false) {
  const d=state.detail,generation=++state.detailGeneration;if(!d)return;
  detailControls(true);$('detail-status').textContent='正在读取明细…';$('detail-table-panel').setAttribute('aria-busy','true');
  try {
    const p=new URLSearchParams({...d.filters,wallet:d.wallet,kind:d.tab,page:String(d.page)});
    const [records,report]=await Promise.all([request('/admin/finance/records?'+p),withSummary?request('/admin/finance?'+new URLSearchParams({...d.filters,wallet:d.wallet})):null]);
    if(generation!==state.detailGeneration||!state.authenticated)return;
    if(report){const a=report.wallets[0];if(!a)throw Error('未找到此钱包账户');$('detail-metrics').replaceChildren(metric('已入账充值',a.deposited,a.depositCount+' 笔'),metric('已完成提现',a.withdrawn,a.withdrawalCount+' 笔'),metric('游戏净盈亏',a.gameProfit,a.roundCount+' 局',true),metric('推荐收益',a.referralIncome,a.referralCount+' 笔'),metric('综合净收益',a.totalProfit,'含推荐收益与提现手续费',true),metric('当前可用余额',a.balance,'当前冻结 '+format(a.locked)),metric('历史待入账奖励',a.rewards,'与当前可用余额分列'),metric('待处理提现',a.pendingWithdrawal,a.pendingWithdrawalCount+' 笔 · 预计到账量'));}
    d.page=records.page;d.pages=records.pages;recordTable($('detail-table'),d.tab,records.records,true);$('detail-empty').hidden=records.total>0;$('detail-table').hidden=!records.total;$('detail-status').textContent='';$('detail-page-label').textContent=`共 ${records.total} 条 · 第 ${d.page} / ${d.pages} 页`;
  } catch(error) {if(generation===state.detailGeneration){$('detail-status').textContent=error.message;$('detail-table').replaceChildren();if([401,403].includes(error.status)){clearView();status(error.message,true);}}}
  finally{if(generation===state.detailGeneration){detailControls();$('detail-table-panel').setAttribute('aria-busy','false');}}
}
async function openWallet(wallet) {
  if(!state.authenticated)return;
  state.detail={wallet,tab:'deposits',page:1,pages:1,filters:{from:state.filters.from,to:state.filters.to}};
  $('detail-wallet').textContent=wallet;$('wallet-explorer').href='https://bscscan.com/address/'+wallet;$('detail-range').textContent=rangeText()+' · 余额为当前值';
  $('detail-metrics').replaceChildren();$('detail-table').replaceChildren();$('detail-empty').hidden=true;$('detail-page-label').textContent='';
  activateTabs($('detail-tabs'),'data-detail-tab','deposits');$('detail-table-panel').setAttribute('aria-label','充值记录');
  if(!$('wallet-dialog').open)$('wallet-dialog').showModal();await loadDetail(true);
}
async function loadPool() {
  const generation=state.generation;$('pool-status').textContent='正在读取链上托管资金…';
  try {const pool=await request('/admin/pool');if(!state.authenticated||generation!==state.generation)return;
    const labels={chainBalance:'合约持币',availablePool:'游戏可用奖池',userLiabilities:'用户余额及冻结资金',pendingBurn:'待销毁',totalFunded:'累计运营注资',totalDeposited:'累计用户充值',totalPaid:'累计提现',directIncome:'游戏税等直接收入'};
    $('pool').replaceChildren(...Object.entries(labels).map(([key,label])=>{const item=el('div');const value=el('dd',format(pool[key]));value.title=pool[key];item.append(el('dt',label),value);return item;}));
    $('pool-status').textContent=(pool.live?'公开充值提现已开放。':'公开充值提现暂未开放。')+' 后台每分钟核对资金；本区域不受上方日期筛选影响。';state.poolLoaded=true;
  }catch(error){$('pool-status').textContent=error.message;if([401,403].includes(error.status)){clearView();status(error.message,true);}}
}
$('connect').onclick=()=>action(async()=>{const generation=state.generation;const session=await login();if(generation!==state.generation)return;connected(session);await load();});
$('logout').onclick=()=>action(async()=>{clearView();await logout();status('已退出管理');});
$('refresh').onclick=()=>action(async()=>{await load();state.poolLoaded=false;if(document.querySelector('.pool-panel').open)await loadPool();});
$('sync').onclick=()=>action(async()=>{await beforeWrite();await request('/admin/pool/sync',{});await request('/admin/payments/sync',{});await load();state.poolLoaded=false;if(document.querySelector('.pool-panel').open)await loadPool();status('资金到账已核对');});
$('filters').onsubmit=event=>{event.preventDefault();action(async()=>{state.filters={search:$('search').value.trim(),from:$('from').value,to:$('to').value};state.page=1;await load();});};
$('reset').onclick=()=>action(async()=>{for(const id of ['search','from','to'])$(id).value='';state.filters={search:'',from:'',to:''};$('profit').value='all';$('sort').value='activity';$('record-status').value='all';state.page=1;await load();});
for(const id of ['profit','sort','record-status'])$(id).onchange=()=>action(async()=>{state.page=1;await load();});
for(const b of document.querySelectorAll('[data-tab]'))b.onclick=()=>action(()=>changeTab(b.dataset.tab));
$('prev').onclick=()=>action(async()=>{state.page--;await load();});$('next').onclick=()=>action(async()=>{state.page++;await load();});
$('close-dialog').onclick=()=>$('wallet-dialog').close();
$('wallet-dialog').addEventListener('close',()=>{state.detailGeneration++;state.detail=null;});
$('wallet-dialog').addEventListener('click',event=>{if(event.target===$('wallet-dialog')){const b=event.target.getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)event.target.close();}});
$('copy-wallet').onclick=async()=>{try{const copied=await copyText($('detail-wallet').textContent);$('detail-status').textContent=copied?'地址已复制':'复制失败，请长按上方地址复制';}catch{$('detail-status').textContent='复制失败，请长按上方地址复制';}};
for(const b of document.querySelectorAll('[data-detail-tab]'))b.onclick=()=>{if(!state.detail)return;state.detail.tab=b.dataset.detailTab;state.detail.page=1;activateTabs($('detail-tabs'),'data-detail-tab',state.detail.tab);$('detail-table-panel').setAttribute('aria-label',labels[state.detail.tab]);loadDetail();};
$('detail-prev').onclick=()=>{state.detail.page--;loadDetail();};$('detail-next').onclick=()=>{state.detail.page++;loadDetail();};
document.querySelector('.pool-panel').addEventListener('toggle',event=>{if(event.target.open&&!state.poolLoaded&&state.authenticated)loadPool();});
for(const tabs of document.querySelectorAll('[role=tablist]'))tabs.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const items=[...tabs.querySelectorAll('[role=tab]')],index=items.indexOf(document.activeElement);if(index<0)return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowRight'?1:-1)+items.length)%items.length;items[next].focus();items[next].click();});
watchWallet(()=>{clearView();status('钱包或网络已切换，请重新登录',true);});
action(async()=>{const generation=state.generation;const session=await restore();if(session&&generation===state.generation){connected(session);await load();}});
