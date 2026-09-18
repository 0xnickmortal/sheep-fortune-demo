import { bscWallet } from './wallet-network.js?v=server-wheel-77-v13-20260917-6f807d16cf94';
import { copyText, selectCopyText } from './clipboard.js?v=server-wheel-77-v13-20260917-6f807d16cf94';
import { createReferralMonitor, referralTotal } from './referral-monitor.js?v=server-wheel-77-v13-20260917-6f807d16cf94';
const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
const money=n=>{const [whole,fraction='']=String(n??'0').split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction?'.'+fraction:'');};
const short=a=>a?a.slice(0,6)+'…'+a.slice(-4):'';
const inviteKey='sheep-invite-v1';
try{const code=new URL(location.href).searchParams.get('ref');if(/^[a-f0-9]{24}$/.test(code||''))localStorage.setItem(inviteKey,code);}catch{}
const pendingInvite=()=>{try{return localStorage.getItem(inviteKey)||'';}catch{return '';}};
function clearInvite(){try{localStorage.removeItem(inviteKey);}catch{}}
if(!document.querySelector('link[data-account-features]')){const link=el('link');link.rel='stylesheet';link.href=new URL('./account-features.css?v=server-wheel-77-v13-20260917-6f807d16cf94',import.meta.url).href;link.dataset.accountFeatures='1';document.head.append(link);}
export function accountFeatures({api,mutate,account,config,refresh,openDialog,notice,canOperate,walletProvider=()=>window.ethereum}) {
  const button=(label,action)=>{const b=el('button',label,'dialog-primary');b.type='button';b.onclick=async()=>{b.disabled=true;try{await action();}catch(e){notice(e.code===4001?'已取消钱包操作':e.message||'操作暂未完成');}finally{b.disabled=false;}};return b;};
  let referralCard, referralDetails, referralData, referralNotice='', referralUpdated='', referralError='';
  const referrals=createReferralMonitor({
    fetchSummary:()=>api('/referrals'),
    onCredit:amount=>{referralNotice='新返佣 +'+money(amount)+' 币，已入游戏余额';notice(referralNotice);void refresh().catch(()=>{});},
    onUpdate:data=>{referralData=data;referralError='';referralUpdated=new Date().toLocaleTimeString('zh-CN');paintReferrals();},
    onError:()=>{referralError='暂时无法更新，请稍后重试';paintReferrals();},
  });
  function syncAccount(){
    const owner=account()?.mode==='token'?account().wallet:null;
    let changed=referrals.setOwner(owner);
    if(changed){
      referralData=null;referralNotice='';referralUpdated='';referralError='';
      if(referralDetails?.isConnected)referralDetails.replaceChildren(el('p','钱包已切换，请重新打开邀请好友。'));
      referralDetails=null;
    }
    const entry=document.getElementById('invite-open');
    if(!referralCard&&entry){referralCard=el('section',undefined,'referral-card');referralCard.id='referral-summary';referralCard.setAttribute('aria-label','我的返佣');entry.before(referralCard);changed=true;}
    if(referralCard){referralCard.hidden=!owner;if(changed)paintReferralCard();}
  }
  function summaryLine(){
    return referralError||(referralUpdated?'已更新 '+referralUpdated+' · 每15秒自动刷新':'正在读取返佣记录…');
  }
  function creditStatus(){
    const status=el('p',referralNotice,'referral-credit-status');status.setAttribute('role','status');return status;
  }
  function paintReferralCard(){
    if(!referralCard)return;
    const title=el('div',undefined,'referral-heading');title.append(el('h2','累计返佣'));
    const details=button('查看明细',async()=>{await invite();referralDetails?.scrollIntoView({block:'start'});});details.className='referral-action';title.append(details);
    const total=el('strong',referralData?money(referralTotal(referralData))+' 币':'—','referral-total');
    const split=el('p',referralData?'直推 '+money(referralData.directEarned)+' 币 · 间推 '+money(referralData.indirectEarned)+' 币':'直推与间推奖励汇总','referral-split');
    referralCard.replaceChildren(title,total,split,creditStatus(),el('p','已计入游戏余额，可继续玩或提现；累计返佣不等于当前可提现余额。','referral-note'),el('small',summaryLine(),'referral-update'));
  }
  function paintReferralDetails(){
    if(!referralDetails?.isConnected||!referralData)return;
    const data=referralData,heading=el('div',undefined,'referral-heading');heading.append(el('h3','我的返佣'));
    const reload=button('刷新返佣',async()=>{await referrals.refresh();await refresh();});reload.className='referral-action';heading.append(reload);
    const total=el('div',undefined,'referral-detail-total');total.append(el('span','累计返佣'),el('strong',money(referralTotal(data))+' 币'));
    const totals=el('div',undefined,'invite-stats');
    for(const [label,count,value] of [['直推',data.directCount,data.directEarned],['间推',data.indirectCount,data.indirectEarned]]){const card=el('div');card.append(el('small',label+' · '+count+' 人'),el('strong',money(value)+' 币'),el('small','累计已入游戏余额'));totals.append(card);}
    referralDetails.replaceChildren(heading,total,totals,creditStatus(),el('p','返佣已计入游戏余额，可继续玩或提现。提现经链上确认后，代币才进入钱包；累计返佣不会因下注或提现而减少。','referral-note'),el('small',summaryLine(),'referral-update'),el('h3','最近50笔返佣'));
    if(!data.records.length)referralDetails.append(el('p','暂未产生返佣。好友确认绑定并开始游戏后，返佣会自动显示在这里。'));
    for(const r of data.records){const row=el('div',undefined,'invite-record');row.append(el('span',(r.level===1?'直推':'间推')+' · '+short(r.player)),el('strong','+'+money(r.amount)+' 币'),el('small','好友下注 '+money(r.stake)+' 币 · 已入游戏余额'),el('small',new Date(r.createdAt).toLocaleString('zh-CN')));referralDetails.append(row);}
  }
  function paintReferrals(){paintReferralCard();paintReferralDetails();}
  function sharing(box,code){
    const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('ref',code);
    const label=el('label','我的邀请链接'),input=el('input');input.value=url.href;input.readOnly=true;input.setAttribute('aria-label',label.textContent);input.className='copy-link-field';input.onclick=()=>selectCopyText(input);label.append(input);box.append(label);
    const status=el('p','','invite-copy-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.setAttribute('aria-atomic','true');
    const copy=button('复制邀请链接',async()=>{
      copy.textContent='正在复制…';status.textContent='正在复制邀请链接…';status.dataset.state='pending';
      const copied=await copyText(url.href,input);
      copy.textContent=copied?'已复制 · 再复制一次':'重试复制';
      status.textContent=copied?'邀请链接已复制，可以粘贴发送给好友。':'暂时无法自动复制，请长按上方链接，选择“复制”。';
      status.dataset.state=copied?'success':'manual';
    });
    box.append(copy,status);
    if(navigator.share)box.append(button('分享给好友',async()=>{try{await navigator.share({title:'羊年大吉 · 邀请好友',url:url.href});}catch(e){if(e.name!=='AbortError')throw e;}}));
  }
  async function invite(){
    syncAccount();
    const box=el('div',undefined,'invite-center'),data=await referrals.refresh();
    if(!data)return;
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
    referralDetails=el('section',undefined,'referral-details');box.append(referralDetails);
    openDialog('邀请好友',box);
    paintReferralDetails();
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
    syncAccount();
    if(monitoring||!account()?.wallet||document.hidden)return;
    monitoring=true;const owner=account().wallet;
    try{
      try{await referrals.refresh();}catch{}
      if(owner!==account()?.wallet||!config()?.payments.enabled)return;
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
      if(account()?.wallet&&!document.hidden)monitor=setTimeout(resume,15000);
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
  return {invite,offerReferral,deposit,withdrawalSaved,withdrawalActions,resume,syncAccount,isTransferring:()=>transferBusy,pause:()=>{clearTimeout(monitor);monitor=null;referrals.setOwner(null);referralData=null;referralNotice='';referralDetails=null;}};
}
