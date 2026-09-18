import {BrowserProvider,Contract,ContractFactory,Interface,getAddress,parseEther,formatEther,keccak256} from 'ethers';
const $=id=>document.getElementById(id),tokenAbi=[
 'function owner() view returns(address)','function decimals() view returns(uint8)','function symbol() view returns(string)',
 'function gameIntegrationEnabled() view returns(bool)','function gameIntegrationFinalized() view returns(bool)',
 'function ecosystemAddress() view returns(address)','function holderBurnEnabled() view returns(bool)',
 'function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)',
 'function approve(address,uint256) returns(bool)','function finalizeGameIntegration(address)',
];
let plan,artifact,provider,signer,wallet,busy=false,quote=null,state={},ready=false,bound=false,allowance=0n;
const buttons=['connect','prepare','deploy','restore','check','bind','approve','fund','refresh','export'];
const storageKey=()=>`sheep-game-pool:56:${plan.token.toLowerCase()}`;
const say=(message,error=false)=>{$('status').textContent=message;$('status').classList.toggle('error',error);};
function persist(){localStorage.setItem(storageKey(),JSON.stringify(state));}
const amount=id=>{const v=$(id).value;if(!/^[1-9]\d{0,8}$/.test(v))throw Error('请输入正整数币数');return parseEther(v);};
const money=n=>{const value=Number(formatEther(n));return (value>=1e8?(value/1e8).toLocaleString('zh-CN',{maximumFractionDigits:4})+'亿':value>=1e4?(value/1e4).toLocaleString('zh-CN',{maximumFractionDigits:4})+'万':value.toLocaleString('zh-CN',{maximumFractionDigits:4}))+'枚';};
function updateButtons(){
 const connected=!!signer, pending=!!state.pending;
 $('connect').disabled=busy||!plan;
 $('prepare').disabled=busy||!connected||!!state.vault||pending;
 $('deploy').disabled=busy||!quote||!!state.vault||pending;
 $('restore').disabled=busy||!connected||pending;
 $('check').disabled=busy||!connected||!pending;
 $('bind').disabled=busy||!ready||bound||pending;
 $('approve').disabled=busy||!ready||!bound||pending;
 let enough=false;try{enough=allowance>=amount('fund-amount');}catch{}
 $('fund').disabled=busy||!ready||!bound||pending||!enough;
 $('refresh').disabled=busy||!connected||!state.vault;
 $('export').disabled=busy||!state.vault;
 $('withdraw-cap').disabled=!!state.vault||pending||busy;
 $('burn-cap').disabled=!!state.vault||pending||busy;
}
async function action(fn){if(busy)return;busy=true;updateButtons();try{await fn();}catch(e){say(e.code===4001||e.code==='ACTION_REJECTED'?'已取消钱包操作。':(e.shortMessage||e.message||'操作未完成'),true);}finally{busy=false;updateButtons();}}
async function network(){
 if(!window.ethereum)throw Error('请用已安装钱包的浏览器，或手机钱包内置浏览器打开');
 let chain=await window.ethereum.request({method:'eth_chainId'});
 if(BigInt(chain)!==56n){try{await window.ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x38'}]});}catch(e){if(e.code!==4902)throw e;await window.ethereum.request({method:'wallet_addEthereumChain',params:[{chainId:'0x38',chainName:'BNB Smart Chain',nativeCurrency:{name:'BNB',symbol:'BNB',decimals:18},rpcUrls:['https://bsc-dataseed.bnbchain.org'],blockExplorerUrls:['https://bscscan.com']}]});}}
 chain=await window.ethereum.request({method:'eth_chainId'});if(BigInt(chain)!==56n)throw Error('请先切换到 BSC 主网');
}
async function authorize(){await network();const accounts=await window.ethereum.request({method:'eth_accounts'});if(accounts[0]?.toLowerCase()!==plan.owner.toLowerCase())throw Error('请使用页面显示的项目管理员钱包');if(accounts[0]?.toLowerCase()!==wallet?.toLowerCase())throw Error('钱包已变更，请重新连接');}
const token=()=>new Contract(plan.token,tokenAbi,signer);
const vault=()=>new Contract(state.vault,artifact.abi,signer);
function masked(code){let s=code.replace(/^0x/,'').toLowerCase();for(const refs of Object.values(artifact.immutableReferences||{}))for(const {start,length}of refs)s=s.slice(0,start*2)+'0'.repeat(length*2)+s.slice((start+length)*2);return s;}
async function validateVault(address,expectedCaps){
 const addr=getAddress(address),v=new Contract(addr,artifact.abi,provider),code=await provider.getCode(addr);
 if(masked(code)!==masked(artifact.runtime))throw Error('合约代码不匹配，不能绑定或存入资金');
 const [asset,admin,issuer,cap,burnCap,native]=await Promise.all([v.token(),v.owner(),v.signer(),v.maxWithdrawal(),v.maxBurn(),v.useTokenBurn()]);
 if(asset.toLowerCase()!==plan.token.toLowerCase()||admin.toLowerCase()!==plan.owner.toLowerCase()||issuer.toLowerCase()!==plan.signer.toLowerCase()||!native)throw Error('合约代币、管理员、签名人或销毁方式不匹配');
 if(expectedCaps&&(cap!==parseEther(expectedCaps.maxWithdrawal)||burnCap!==parseEther(expectedCaps.maxBurn)))throw Error('部署上限与确认参数不匹配');
 return {maxWithdrawal:formatEther(cap),maxBurn:formatEther(burnCap)};
}
async function refresh(){
 ready=false;if(!state.vault)return;
 const caps=await validateVault(state.vault,state.caps);state.caps=caps;persist();ready=true;
 $('withdraw-cap').value=String(Number(caps.maxWithdrawal));$('burn-cap').value=String(Number(caps.maxBurn));
 $('vault-input').value=state.vault;$('vault-address').textContent=state.vault;$('deploy-state').textContent='已部署';
 const t=token(),v=vault();const [finalized,recipient,balance,funded,deposited,direct,a]=await Promise.all([t.gameIntegrationFinalized(),t.ecosystemAddress(),t.balanceOf(state.vault),v.totalFunded(),v.totalDeposited(),v.directPoolIncome(),t.allowance(wallet,state.vault)]);
 bound=finalized&&recipient.toLowerCase()===state.vault.toLowerCase();allowance=a;
 if(finalized&&!bound)throw Error('代币已绑定其他游戏池，不能继续操作');
 $('bind-state').textContent=bound?'已绑定':'待确认';$('fund-state').textContent=funded>0n?'已有注资':'待存入';
 $('chain-balance').textContent=money(balance);$('funded').textContent=money(funded);$('deposited').textContent=money(deposited);$('direct-income').textContent=money(direct);
 try{const response=await fetch('/api/config',{cache:'no-store'});const c=await response.json();$('live-state').textContent=c.payments?.enabled&&c.payments?.vaultAddress?.toLowerCase()===state.vault.toLowerCase()?'已接入并开放':'等待后台接入与开放';}catch{$('live-state').textContent='后台状态暂时无法读取';}
}
async function verifyReceipt(receipt){
 if(receipt.status!==1){state.failed=[...(state.failed||[]),state.pending];delete state.pending;persist();throw Error('这笔交易链上执行失败，未完成操作。');}
 const p=state.pending;
 if(p.kind==='deploy'){
  const tx=await provider.getTransaction(p.hash);
  if(tx?.from.toLowerCase()!==plan.owner.toLowerCase()||tx.to||keccak256(tx.data)!==p.dataHash)throw Error('部署交易内容不匹配');
  await validateVault(receipt.contractAddress,p.caps);state.vault=receipt.contractAddress;state.caps=p.caps;state.deploymentBlock=receipt.blockNumber;
 }
 state.transactions=[...(state.transactions||[]),{kind:p.kind,hash:p.hash,block:receipt.blockNumber,...(p.amount?{amount:p.amount}:{})}];delete state.pending;persist();await refresh();
 say('链上已确认。请继续下一步；正式充值仍以后台开放状态为准。');
}
async function sent(tx,record){
 state.pending={...record,hash:tx.hash};persist();quote=null;$('tx-link').href=`https://bscscan.com/tx/${tx.hash}`;$('tx-link').hidden=false;
 say('交易已发送，正在等待链上确认。交易编号已保存，请勿重复提交。');
 const r=await provider.waitForTransaction(tx.hash,1,90000);if(!r)throw Error('交易仍在确认中，可点击「核对待确认交易」，不要重复部署或存入');await verifyReceipt(r);
}
$('connect').onclick=()=>action(async()=>{
 await network();await window.ethereum.request({method:'eth_requestAccounts'});provider=new BrowserProvider(window.ethereum,'any');provider.pollingInterval=1500;signer=await provider.getSigner();wallet=await signer.getAddress();
 if(wallet.toLowerCase()!==plan.owner.toLowerCase()){signer=null;throw Error('当前钱包不是本次游戏池管理员，请切换到 '+plan.owner);}
 $('wallet').textContent=wallet;say('已连接 BSC 项目钱包。');if(state.vault)await refresh();
});
$('prepare').onclick=()=>action(async()=>{
 await authorize();const t=token();const [owner,decimals,burn,enabled,finalized]=await Promise.all([t.owner(),t.decimals(),t.holderBurnEnabled(),t.gameIntegrationEnabled(),t.gameIntegrationFinalized()]);
 if(owner.toLowerCase()!==wallet.toLowerCase()||decimals!==18n||!burn||!enabled||finalized)throw Error('代币不满足本次部署条件，或已绑定游戏池，请先核对');
 if(!plan.signer)throw Error('后台独立签名地址尚未准备');
 const cap=amount('withdraw-cap'),burnCap=amount('burn-cap'),factory=new ContractFactory(artifact.abi,artifact.bytecode,signer);
 const transaction=await factory.getDeployTransaction(plan.token,plan.owner,plan.signer,cap,burnCap,true),gas=await provider.estimateGas({...transaction,from:wallet}),fee=await provider.getFeeData();
 quote={transaction,caps:{maxWithdrawal:formatEther(cap),maxBurn:formatEther(burnCap)}};
 $('estimate').textContent=`预计部署费用约 ${formatEther(gas*(fee.gasPrice||0n))} BNB，以钱包显示为准。`;
 say('参数已核对。请核对两个上限后，点击「钱包确认部署」。');
});
$('deploy').onclick=()=>action(async()=>{await authorize();if(!quote||state.pending||state.vault)throw Error('请先检查部署参数');const q=quote;const tx=await signer.sendTransaction(q.transaction);await sent(tx,{kind:'deploy',dataHash:keccak256(q.transaction.data),caps:q.caps});});
$('restore').onclick=()=>action(async()=>{await authorize();const address=getAddress($('vault-input').value.trim());const caps=await validateVault(address);state={...state,vault:address,caps};persist();await refresh();say('已恢复并核对现有游戏池。');});
$('check').onclick=()=>action(async()=>{await authorize();if(!state.pending)throw Error('没有待确认交易');const r=await provider.getTransactionReceipt(state.pending.hash);if(!r)throw Error('尚未找到确认回执，请在区块浏览器核对交易是否仍在等待');await verifyReceipt(r);});
$('bind').onclick=()=>action(async()=>{await authorize();await refresh();if(bound)throw Error('已绑定，不需要再次提交');await sent(await token().finalizeGameIntegration(state.vault),{kind:'bind'});});
$('approve').onclick=()=>action(async()=>{await authorize();await refresh();if(!bound)throw Error('请先绑定游戏池');const n=amount('fund-amount');if(await token().balanceOf(wallet)<n)throw Error('钱包代币不足');await sent(await token().approve(state.vault,n),{kind:'approve',amount:formatEther(n)});});
$('fund').onclick=()=>action(async()=>{await authorize();await refresh();if(!bound)throw Error('请先绑定游戏池');const n=amount('fund-amount');if(allowance<n)throw Error('请先授权本次数量');await sent(await vault().fundPool(n),{kind:'fund',amount:formatEther(n)});});
$('refresh').onclick=()=>action(async()=>{await authorize();await refresh();say('已刷新链上余额。用户充值、注入奖池和直接收入分别展示。');});
$('export').onclick=()=>{const content={chainId:56,token:plan.token,owner:plan.owner,signer:plan.signer,useTokenBurn:true,...state};const link=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(content,null,2)],{type:'application/json'}));link.href=url;link.download='羊年吉祥-游戏池接入记录.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
for(const id of ['withdraw-cap','burn-cap'])$(id).addEventListener('input',()=>{quote=null;updateButtons();});
$('fund-amount').addEventListener('input',updateButtons);
window.ethereum?.on?.('accountsChanged',()=>{signer=null;ready=false;quote=null;updateButtons();say('钱包账户已变更，请重新连接。',true);});
window.ethereum?.on?.('chainChanged',()=>{signer=null;ready=false;quote=null;updateButtons();say('钱包网络已变更，请重新连接并确认 BSC。',true);});
try{
 const responses=await Promise.all([fetch('/admin/pool/plan.json',{cache:'no-store'}),fetch('/admin/pool/contract.json',{cache:'no-store'})]);if(responses.some(r=>!r.ok))throw Error('部署资料尚未准备完毕');[plan,artifact]=await Promise.all(responses.map(r=>r.json()));
 for(const field of ['token','owner','signer'])getAddress(plan[field]);
 $('token').textContent=plan.token;$('owner').textContent=plan.owner;
 try{state=JSON.parse(localStorage.getItem(storageKey())||'{}');}catch{state={};}
 if(!state.vault&&plan.vault){state.vault=getAddress(plan.vault);state.caps={maxWithdrawal:plan.maxWithdrawal,maxBurn:plan.maxBurn};persist();}
 if(state.vault)$('vault-input').value=state.vault;
 if(state.pending){$('tx-link').href=`https://bscscan.com/tx/${state.pending.hash}`;$('tx-link').hidden=false;}
 say(state.pending?'有一笔待确认交易，请连接钱包后核对，勿重复提交。':state.vault?'已有托管合约，连接项目钱包后核对资金。':'方案已准备。连接项目钱包后检查部署参数。');
}catch(e){say(e.message,true);}updateButtons();
