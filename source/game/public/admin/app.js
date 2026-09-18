import {request,restore,login,beforeWrite,watchWallet,tokens} from './shared.js';
const $=id=>document.getElementById(id),el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
let busy=false;
function status(s,error=false){$('status').textContent=s;$('status').classList.toggle('invalid',error);}
async function action(fn){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(e){status(e.message,true);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
function record(title,detail,hash){const row=el('article','');row.className='entry';row.append(el('strong',title),el('p',detail));if(hash){const link=el('a','查看交易');link.href='https://bscscan.com/tx/'+hash;link.target='_blank';link.rel='noopener noreferrer';row.append(link);}return row;}
async function load(){
 const [pool,history]=await Promise.all([request('/admin/pool'),request('/admin/payments')]);
 const labels={chainBalance:'合约持币',availablePool:'游戏可用奖池',userLiabilities:'用户余额及冻结资金',pendingBurn:'待销毁',totalFunded:'累计注资',totalDeposited:'累计用户充值',totalPaid:'累计提币',directIncome:'游戏税等直接收入'};
 $('pool').replaceChildren(...Object.entries(labels).flatMap(([k,label])=>[el('dt',label),el('dd',Number(pool[k]).toLocaleString('zh-CN',{maximumFractionDigits:4})+' 枚')]));
 $('overview').hidden=false;$('records-section').hidden=false;
 const rows=[];for(const d of history.deposits)rows.push(record('已入账 · '+tokens(d.amount)+' 枚',d.owner.startsWith('pool:')?'运营注资':'玩家充值',d.tx_hash));
 for(const d of history.pendingDeposits.filter(d=>d.status!=='confirmed'))rows.push(record(d.status==='failed'?'充值未完成':'充值确认中',d.error||'等待链上确认',d.tx_hash));
 const labelsW={authorized:'等待钱包提交 / 链上确认',confirmed:'已到账',rejected:'已退回余额',failed:'未成功',queued:'待处理',submitted:'链上确认中'};
 for(const w of history.withdrawals)rows.push(record('提现 '+w.amount+' 枚 · '+(labelsW[w.status]||w.status),w.recipient,w.tx_hash));
 $('records').replaceChildren(...(rows.length?rows:[el('p','暂无充值提现记录')]));
 status(pool.live?'公开充值提现已开放':'公开充值提现暂未开放；管理员可进行接入验收。');
}
$('connect').onclick=()=>action(async()=>{const s=await login();$('identity').textContent=s.wallet;await load();});
$('refresh').onclick=()=>action(load);
$('sync').onclick=()=>action(async()=>{await beforeWrite();await request('/admin/pool/sync',{});await request('/admin/payments/sync',{});await load();});
watchWallet(()=>{$('overview').hidden=true;$('records-section').hidden=true;status('钱包或网络已切换，请重新登录');});
action(async()=>{const s=await restore();if(s){$('identity').textContent=s.wallet;await load();}});
