import { bscWallet } from './wallet-network.js';
const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
const money=n=>String(n??'0').replace(/\B(?=(\d{3})+(?!\d))/g,',');
const short=a=>a?a.slice(0,6)+'…'+a.slice(-4):'';
const inviteKey='sheep-invite-v1';
try{const code=new URL(location.href).searchParams.get('ref');if(/^[a-f0-9]{24}$/.test(code||''))localStorage.setItem(inviteKey,code);}catch{}
const pendingInvite=()=>{try{return localStorage.getItem(inviteKey)||'';}catch{return '';}};
function clearInvite(){try{localStorage.removeItem(inviteKey);}catch{}}
if(!document.querySelector('link[data-account-features]')){const link=el('link');link.rel='stylesheet';link.href=new URL('./account-features.css',import.meta.url).href;link.dataset.accountFeatures='1';document.head.append(link);}
export function accountFeatures({api,mutate,account,config,refresh,openDialog,notice,canOperate,walletProvider=()=>window.ethereum}) {
  const button=(label,action)=>{const b=el('button',label,'dialog-primary');b.type='button';b.onclick=async()=>{b.disabled=true;try{await action();}catch(e){notice(e.code===4001?'已取消钱包操作':e.message||'操作暂未完成');}finally{b.disabled=false;}};return b;};
  function sharing(box,code){
    const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('ref',code);
    const label=el('label','我的邀请链接'),input=el('input');input.value=url.href;input.readOnly=true;input.setAttribute('aria-label',label.textContent);label.append(input);box.append(label);
    box.append(button('复制邀请链接',async()=>{try{await navigator.clipboard.writeText(url.href);notice('邀请链接已复制');}catch{input.focus();input.select();notice('请长按链接复制');}}));
    if(navigator.share)box.append(button('分享给好友',async()=>{try{await navigator.share({title:'羊年大吉 · 邀请好友',url:url.href});}catch(e){if(e.name!=='AbortError')throw e;}}));
  }
  async function invite(){
    const box=el('div',undefined,'invite-center'),data=await api('/referrals');
    box.append(el('p','邀请好友，一起转出好运','invite-lead'));
    if(!data.supported){
      box.append(el('p','请连接钱包并完成一局游戏，再生成邀请链接。'));
      openDialog('邀请好友',box);return;
    }
    const stats=el('div',undefined,'invite-stats');
    for(const [label,value] of [['直推奖励',(data.policy?.directBps??1500)/100+'%'],['间推奖励',(data.policy?.indirectBps??500)/100+'%']]){const card=el('div');card.append(el('small',label),el('strong',value));stats.append(card);}box.append(stats);
    box.append(el('p','按好友每局实际下注额计算，各倍率均计提；奖励自动进入游戏余额，无需手动领取。'));
    if(data.parent)box.append(el('p','我的邀请人：'+short(data.parent)));
    if(data.canBind){
      const label=el('label','邀请码（可选）'),input=el('input');input.value=pendingInvite();input.placeholder='粘贴好友的邀请码';input.autocomplete='off';input.maxLength=24;label.append(input);box.append(label);
      box.append(button('查看并确认邀请人',async()=>{
        if(!canOperate())return;const resolved=await api('/referrals/resolve?code='+encodeURIComponent(input.value.trim()));
        const confirm=el('div');confirm.append(el('p','确认绑定以下邀请人？仅可在首次游戏前绑定一次，之后不能更换。'),el('p',resolved.wallet,'wallet-address'));
        confirm.append(button('确认绑定',async()=>{if(!canOperate())return;await mutate('/referrals/bind',{code:resolved.code});clearInvite();await refresh();await invite();notice('邀请人已绑定');}));openDialog('确认邀请人',confirm);
      }));
      if(pendingInvite())box.append(button('不绑定，继续游戏',()=>{clearInvite();document.querySelector('dialog').close();}));
    }else if(!data.parent)box.append(el('p','首次游戏已完成，未绑定邀请人。'));
    if(data.active){
      sharing(box,data.code);
    }else if(data.eligible)box.append(button('生成我的邀请链接',async()=>{if(!canOperate())return;await mutate('/referrals/activate',{});await refresh();await invite();}));
    else box.append(el('p','完成一局游戏后，即可生成自己的邀请链接。','invite-hint'));
    box.append(el('h3','我的邀请与奖励'));
    const totals=el('div',undefined,'invite-stats');
    for(const [label,count,amount] of [['直推',data.directCount,data.directEarned],['间推',data.indirectCount,data.indirectEarned]]){const card=el('div');card.append(el('small',label+' '+count+' 人'),el('strong',money(amount)),el('small','币 · 累计奖励'));totals.append(card);}box.append(totals);
    box.append(el('h3','最近奖励记录'));
    if(!data.records.length)box.append(el('p','好友开始游戏后，奖励会显示在这里。'));
    for(const r of data.records){const row=el('div',undefined,'invite-record');row.append(el('span',(r.level===1?'直推':'间推')+' · '+short(r.player)),el('strong','+'+money(r.amount)+' 币'),el('small',new Date(r.createdAt).toLocaleString('zh-CN')));box.append(row);}
    openDialog('邀请好友',box);
  }
  function offerReferral(){if(account()?.mode==='token'&&account()?.referral?.canBind&&pendingInvite()){invite().catch(e=>notice(e.message));return true;}return false;}
  async function connectedWallet(){
    if(!canOperate())throw Error('请重新签名连接当前钱包');
    return bscWallet(walletProvider(),{expectedAddress:account().wallet});
  }
  async function send(transaction){const from=await connectedWallet();return walletProvider().request({method:'eth_sendTransaction',params:[{...transaction,from}]});}
  async function waitMined(hash){
    for(let i=0;i<45;i++){const r=await walletProvider().request({method:'eth_getTransactionReceipt',params:[hash]});if(r){if(BigInt(r.status)!==1n)throw Error('链上交易未成功，请在钱包中查看');return;}await new Promise(r=>setTimeout(r,2000));}
    throw Error('授权交易仍在确认，确认成功后再继续充值');
  }
  const depositKey=()=> 'sheep-vault-deposit:'+config().payments.vaultAddress+':'+account().wallet;
  let transferBusy=false, monitor=null, monitoring=false;
  async function checkSavedDeposit(hash, quiet=false) {
    const owner=account()?.wallet;
    try {
      const result=await api('/deposits/track',{txHash:hash});
      if(owner!==account()?.wallet)return;
      if(result.status==='confirmed'){
        try{localStorage.removeItem(depositKey());}catch{}
        await refresh();notice('充值到账：'+money(result.amount)+' 币');
        if(!quiet)openDialog('充值成功',money(result.amount)+' 币已进入游戏余额');
      }else if(!quiet)notice('充值确认中，到账后自动更新余额');
      return result;
    }catch(e){
      if(e.status>=400&&e.status<500&&e.status!==401&&e.code!=='CONFIRMING'){
        try{if(localStorage.getItem(depositKey())===hash)localStorage.removeItem(depositKey());}catch{}
        if(quiet)notice(e.message);
      }
      if(!quiet)throw e;
    }
  }
  function depositReview(hash){
    const box=el('div');box.append(el('p','充值已提交，等待链上确认后自动到账。可以关闭弹窗，稍后余额会自动更新。'));
    const link=el('a','查看链上进度');link.href='https://bscscan.com/tx/'+hash;link.target='_blank';link.rel='noopener noreferrer';box.append(link);
    box.append(button('刷新到账状态',()=>checkSavedDeposit(hash)));
    openDialog('充值确认中',box);resume();
  }
  async function resume(){
    if(monitoring||!account()?.wallet||!config()?.payments.enabled)return;
    monitoring=true;const owner=account().wallet;
    try{
      let hash;try{hash=localStorage.getItem(depositKey());}catch{}
      if(hash)await checkSavedDeposit(hash,true);
      if(owner!==account()?.wallet)return;
      const history=await api('/payments');
      for(const w of history.withdrawals.filter(w=>w.status==='authorized').slice(0,3)){
        if(owner!==account()?.wallet)return;
        try{const r=await api('/withdrawals/'+w.id+'/check',{},'withdraw-monitor-'+w.id);if(r.status==='confirmed'||r.status==='rejected'){await refresh();notice(r.status==='confirmed'?'提现已到账':'未执行的提现已退回余额');}}catch{}
      }
      // A scheduled job may have finished before this tab checked history.
      // Refresh both available and frozen balances even without pending rows.
      if(owner===account()?.wallet)await refresh();
    }catch{}finally{
      monitoring=false;clearTimeout(monitor);
      if(account()?.wallet&&config()?.payments.enabled)monitor=setTimeout(resume,15000);
    }
  }
  function deposit(){
    const c=config().payments,box=el('div');let prior;try{prior=localStorage.getItem(depositKey());}catch{}
    if(prior)box.append(button('核对上次充值',()=>depositReview(prior)));
    box.append(el('p','充值进入游戏托管合约，按实际到账数量计入余额。请通过下方按钮充值，不要直接向合约地址转币。'));
    const label=el('label','充值数量（币）'),input=el('input');input.inputMode='decimal';input.placeholder='输入充值数量';label.append(input);box.append(label);
    box.append(button('授权并充值',async()=>{
      if(!canOperate()||transferBusy)return;transferBusy=true;
      try { const owner=account().wallet,prepared=await api('/deposits/prepare',{amount:input.value.trim()});
      if(prepared.account!==owner||prepared.approval.to!==c.token||prepared.transaction.to!==c.vaultAddress)throw Error('充值配置不匹配，请刷新后再试');
      if(prepared.needsApproval!==false)await waitMined(await send(prepared.approval));
      if(account().wallet!==owner)throw Error('钱包已切换，请重新操作');
      const hash=await send(prepared.transaction);try{localStorage.setItem(depositKey(),hash);}catch{}depositReview(hash);
      } finally { transferBusy=false; }
    }));
    const manualLabel=el('label','已有充值交易？粘贴交易哈希'),manual=el('input');manual.placeholder='0x…';manualLabel.append(manual);box.append(manualLabel,button('核对已有充值',()=>{if(!/^0x[0-9a-fA-F]{64}$/.test(manual.value.trim()))throw Error('请输入完整交易哈希');try{localStorage.setItem(depositKey(),manual.value.trim());}catch{}depositReview(manual.value.trim());}));
    box.append(el('small','钱包余额足够且授权充足时仅需确认充值；链上 Gas 由钱包支付。到账需等待 '+c.confirmations+' 个区块确认。'));
    openDialog('充值 '+c.symbol,box);
  }
  async function claimWithdrawal(wid){
    if(!canOperate()||transferBusy)return;transferBusy=true;
    try { const auth=await api('/withdrawals/'+wid+'/authorization');
    if(auth.recipient!==account().wallet||auth.transaction.to!==config().payments.vaultAddress)throw Error('提现凭证与当前钱包不匹配');
    const hash=await send(auth.transaction);resume();const box=el('div');box.append(el('p','提现交易已提交，确认后自动更新记录。转入 '+short(auth.recipient)),el('p',hash,'wallet-address'));
    box.append(button('核对提现到账',async()=>{await mutate('/withdrawals/'+wid+'/check',{});await refresh();openDialog('提现状态已更新','请在充值与提现记录中查看。');}));openDialog('提现确认中',box);
    } finally { transferBusy=false; }
  }
  function withdrawalSaved(result){
    const box=el('div');box.append(el('p','已冻结 '+money(result.amount)+' 币，手续费 '+money(result.fee)+' 币，预计到账 '+money(result.payout)+' 币。'));
    box.append(button('确认提到钱包',()=>claimWithdrawal(result.id)),el('p','凭证有效期1小时。钱包取消操作不会自动解冻；过期后可在记录中核对并退回余额。'));
    openDialog('提币到钱包',box);
  }
  function withdrawalActions(w){
    if(w.status!=='authorized')return [];
    return [button('提到钱包',()=>claimWithdrawal(w.id)),button('核对到账 / 过期退回',async()=>{if(!canOperate())return;const r=await mutate('/withdrawals/'+w.id+'/check',{});await refresh();openDialog('提现状态',r.status==='confirmed'?'提现已到账':'过期或已撤销的提现已退回游戏余额');})];
  }
  window.addEventListener('focus',resume);document.addEventListener('visibilitychange',()=>{if(!document.hidden)resume();});
  return {invite,offerReferral,deposit,withdrawalSaved,withdrawalActions,resume,isTransferring:()=>transferBusy,pause:()=>{clearTimeout(monitor);monitor=null;}};
}
