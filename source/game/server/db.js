import { GameError } from './rules.js';
export const id=()=>crypto.randomUUID();
export const stmt=(db,sql,...values)=>db.prepare(sql).bind(...values);
export const first=(db,sql,...values)=>stmt(db,sql,...values).first();
export const all=async(db,sql,...values)=>(await stmt(db,sql,...values).all()).results;
export async function hash(s){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(v=>v.toString(16).padStart(2,'0')).join('');}
export function guard(db){const key=id();return [stmt(db,'INSERT INTO cas_guards(id,ok) VALUES (?,changes())',key),stmt(db,'DELETE FROM cas_guards WHERE id=?',key)];}
export function accountUpdate(db,a,next){
 const hasIngots=next.ingots!==undefined;
 return [stmt(db,'UPDATE accounts SET available=?,rewards=?,locked=?'+(hasIngots?',ingots=?':'')+',revision=revision+1,last_play=? WHERE id=? AND revision=?',String(next.available??a.available),String(next.rewards??a.rewards),String(next.locked??a.locked),...(hasIngots?[String(next.ingots)]:[]),next.last_play??a.last_play,a.id,a.revision),...guard(db)];
}
export function treasuryUpdate(db,t,next){return [stmt(db,'UPDATE treasuries SET available=?,burned=?,fees=?,revision=revision+1 WHERE asset=? AND revision=?',String(next.available??t.available),String(next.burned??t.burned),String(next.fees??t.fees),t.asset,t.revision),...guard(db)];}
export function transfer(db,op,asset,debit,credit,amount,now){if(amount<0n)throw new Error('Negative ledger transfer');if(!amount)return [];return [stmt(db,'INSERT INTO ledger(id,operation,asset,debit,credit,amount,created_at) VALUES (?,?,?,?,?,?,?)',id(),op,asset,debit,credit,String(amount),now)];}
export async function operation(db,owner,key,kind,payload,build){if(typeof key!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(key))throw new GameError('缺少操作编号，请重新操作');const fingerprint=await hash(kind+':'+JSON.stringify(payload));for(let retry=0;retry<6;retry++){
 const prior=await first(db,'SELECT * FROM operations WHERE owner=? AND request_key=?',owner,key);if(prior){if(prior.fingerprint!==fingerprint)throw new GameError('同一操作编号不能用于不同内容',409,'IDEMPOTENCY_CONFLICT');return JSON.parse(prior.response);}
 const op=id(),now=Date.now();let built;
 try{built=await build(op,now);const statements=[stmt(db,'INSERT INTO operations(id,owner,request_key,fingerprint,kind,response,created_at) VALUES (?,?,?,?,?,?,?)',op,owner,key,fingerprint,kind,JSON.stringify(built.response),now),...built.statements];await db.batch(statements);return built.response;}
 catch(e){const completed=await first(db,'SELECT fingerprint,response FROM operations WHERE owner=? AND request_key=?',owner,key);if(completed){if(completed.fingerprint!==fingerprint)throw new GameError('同一操作编号不能用于不同内容',409,'IDEMPOTENCY_CONFLICT');return JSON.parse(completed.response);}if(e instanceof GameError)throw e;const text=String(e.message);if(!/cas_guard_ok|cas_guards|operations.owner, operations.request_key|operations_owner_key|deposits.asset, deposits.tx_hash|deposit_asset_tx/.test(text))throw e;}
 }throw new GameError('操作较多，请稍后重试；不会重复扣款',409,'RETRY_OPERATION');}
