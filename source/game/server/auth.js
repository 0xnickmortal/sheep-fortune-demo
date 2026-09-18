import { verifyMessage,getAddress } from 'ethers';
import { id,hash,stmt,first,guard } from './db.js';
import { ensureDemo } from './game.js';
import { GameError } from './rules.js';
export const COOKIE='sheep_session';
export const tokenAddress=env=>(env.TOKEN_ADDRESS||'0x61bEcda3b07301889b51Fd84b0E58385311590ba').toLowerCase();
export const tokenAsset=env=>'token:56:'+tokenAddress(env);
export const cookieToken=request=>{const cookies=(request.headers.get('cookie')||'').split(';').map(x=>x.trim());const token=cookies.find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);return token&&/^[a-f0-9]{64}$/.test(token)?token:null;};
export const newToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
export const cookie=(token,request)=>`${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${new URL(request.url).protocol==='https:'?'; Secure':''}`;
export async function sessionOwner(db,request){const token=cookieToken(request);if(!token)return null;const row=await first(db,'SELECT owner FROM sessions WHERE hash=? AND expires_at>?',await hash(token),Date.now());return row?.owner??null;}
export async function walletLogout(db,request){const token=cookieToken(request);if(token)await stmt(db,'DELETE FROM sessions WHERE hash=?',await hash(token)).run();return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${new URL(request.url).protocol==='https:'?'; Secure':''}`;}
export async function requireOwner(db,request){const owner=await sessionOwner(db,request);if(!owner)throw new GameError('登录已过期，请重新进入游戏',401,'LOGIN_REQUIRED');return owner;}
export async function demoLogin(db,request,env={}){const old=await sessionOwner(db,request);if(old){const a=await first(db,'SELECT asset FROM accounts WHERE id=?',old);if(a?.asset==='demo')return {owner:old,cookie:null};}
 // Only an authenticated platform proxy may provide identity headers. Public
 // Workers endpoints must ignore client-supplied headers with these names.
 const platform=env.TRUST_PLATFORM_IDENTITY==='true'&&(request.headers.get('oai-authenticated-user-id')||request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase()),owner=platform?'demo:oai:'+await hash(platform):'demo:'+id();await ensureDemo(db,owner);const token=newToken();await stmt(db,'INSERT INTO sessions(hash,owner,expires_at) VALUES (?,?,?)',await hash(token),owner,Date.now()+86400000).run();return {owner,cookie:cookie(token,request)};}
export async function challenge(db,request,address){try{address=getAddress(address);}catch{throw new GameError('钱包地址格式不正确');}const nonce=id().replaceAll('-',''),domain=new URL(request.url).host,now=Date.now(),expires=now+300000;
 const message=`${domain} wants you to sign in with your Ethereum account:\n${address}\n\n登录羊年大吉。这不是转账或代币授权。\n\nURI: ${new URL(request.url).origin}\nVersion: 1\nChain ID: 56\nNonce: ${nonce}\nIssued At: ${new Date(now).toISOString()}\nExpiration Time: ${new Date(expires).toISOString()}`;
 await stmt(db,'INSERT INTO challenges(id,address,message,domain,expires_at,used) VALUES (?,?,?,?,?,0)',nonce,address.toLowerCase(),message,domain,expires).run();return {challengeId:nonce,message,expiresAt:expires};}
export async function walletLogin(db,request,env,{challengeId,signature}){if(typeof challengeId!=='string'||typeof signature!=='string'||signature.length>300)throw new GameError('签名信息不正确');const row=await first(db,'SELECT * FROM challenges WHERE id=?',challengeId),now=Date.now();if(!row||row.used||row.expires_at<now||row.domain!==new URL(request.url).host)throw new GameError('登录请求已过期，请重新连接',401);
 let signer;try{signer=verifyMessage(row.message,signature).toLowerCase();}catch{throw new GameError('钱包签名验证失败',401);}if(signer!==row.address)throw new GameError('钱包签名不匹配',401);
 const asset=tokenAsset(env),owner=asset+':'+signer,token=newToken();try{await db.batch([stmt(db,'UPDATE challenges SET used=1 WHERE id=? AND used=0 AND expires_at>=?',challengeId,now),...guard(db),stmt(db,'INSERT OR IGNORE INTO accounts(id,wallet,asset,available,rewards,locked,revision,last_play,created_at) VALUES (?,?,?,?,?,?,0,0,?)',owner,signer,asset,'0','0','0',now),stmt(db,'INSERT OR IGNORE INTO treasuries(asset,available,burned,fees,revision) VALUES (?,?,?,?,0)',asset,'0','0','0'),stmt(db,'INSERT INTO sessions(hash,owner,expires_at) VALUES (?,?,?)',await hash(token),owner,now+86400000)]);}catch(e){if(/cas_guard/.test(String(e.message)))throw new GameError('登录请求已使用，请重新连接',401);throw e;}return {owner,cookie:cookie(token,request)};}
