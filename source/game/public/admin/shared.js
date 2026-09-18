import { loginBscWallet, bscWallet } from '../shared/wallet-network.js';
let session = null, secret = '';
export async function request(path, data, operationKey) {
  const response = await fetch('/api' + path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache:'no-store', headers: { ...(secret ? {Authorization:'Bearer '+secret} : {}), ...(data === undefined ? {} : {'Content-Type':'application/json','X-Game-Request':'1','Idempotency-Key':operationKey || crypto.randomUUID()}) }, ...(data === undefined ? {} : {body:JSON.stringify(data)}) });
  let result;try{result=await response.json();}catch{throw Error('管理服务暂时无法连接');}
  if (!response.ok) throw Object.assign(new Error(result.error || '操作未完成'), {status:response.status,code:result.code});
  return result;
}
export function useKey(value) { secret = value; session = null; }
export async function logout() { const pending=request('/auth/logout',{});secret='';session=null;await pending; }
export async function restore() { try { session=await request('/admin/session');return session; } catch(e) { if(e.status===403||e.status===401)return null;throw e; } }
export async function login() {
  if(!window.ethereum?.request)throw Error('请在支持 BSC 的钱包浏览器打开此页面');
  secret='';await loginBscWallet(window.ethereum, request);session=await request('/admin/session');return session;
}
export async function beforeWrite() {
  if(secret)return;
  if(!session)throw Error('请先连接管理员钱包');
  await bscWallet(window.ethereum,{expectedAddress:session.wallet});
}
export function watchWallet(onChange) { window.ethereum?.on?.('accountsChanged',()=>{session=null;onChange();});window.ethereum?.on?.('chainChanged',()=>{session=null;onChange();}); }
export const tokens = raw => { const n=BigInt(raw||0),whole=n/10n**18n,f=(n%10n**18n).toString().padStart(18,'0').replace(/0+$/,'');return whole.toLocaleString('en-US')+(f?'.'+f:''); };
window.addEventListener('pagehide',()=>{secret='';session=null;});
