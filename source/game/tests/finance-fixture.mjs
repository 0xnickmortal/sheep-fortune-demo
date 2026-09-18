import { openDatabase } from '../scripts/local-d1.mjs';
import { tokenAsset } from '../server/auth.js';
import { hash } from '../server/db.js';
const unit=10n**18n;
export const amount=n=>String(BigInt(n)*unit);
export const address=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
export const tx=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
export const T1=Date.parse('2026-09-17T12:00:00+08:00'),T2=Date.parse('2026-09-18T00:00:00+08:00');
export async function financeFixture() {
  const db=openDatabase(),env={DB:db,TOKEN_ADDRESS:address(999),TOKEN_SYMBOL:'羊年吉祥',ADMIN_WALLET:address(1),OPS_AUTH_KEY:'finance-test-key-is-only-for-local-fixtures',LIVE_PAYMENTS_ENABLED:'true'},asset=tokenAsset(env);
  function account(n,otherAsset=asset){const wallet=address(n),id=otherAsset+':'+wallet;db.sqlite.prepare('INSERT INTO accounts(id,wallet,asset,available,rewards,locked,created_at) VALUES(?,?,?,?,?,?,?)').run(id,wallet,otherAsset,'0','0','0',T1);return id;}
  const a=account(1),b=account(2),c=account(3),foreign=account(4,'token:56:'+address(998)),demo=account(5,'demo');
  db.sqlite.prepare('UPDATE accounts SET available=?,rewards=?,locked=? WHERE id=?').run(amount(1250),amount(50),amount(200),a);
  function deposit(n,owner,value,at=T1,rowAsset=asset){db.sqlite.prepare('INSERT INTO deposits(id,owner,tx_hash,block_hash,block_number,amount,asset,created_at) VALUES(?,?,?,?,?,?,?,?)').run('deposit-'+n,owner,tx(n),tx(0),1,value,rowAsset,at);}
  function pending(n,owner,status='pending',at=T2){db.sqlite.prepare('INSERT INTO pending_deposits(asset,tx_hash,owner,status,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(asset,tx(n),owner,status,status==='failed'?'交易未成功':null,at,at);}
  function withdrawal(n,owner,value,fee,status,at=T2){db.sqlite.prepare('INSERT INTO withdrawals(id,owner,asset,amount,fee,recipient,status,tx_hash,raw_tx,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('withdrawal-'+n,owner,asset,value,fee,owner===b?address(2):address(1),status,tx(1000+n),'SECRET_RAW_TRANSACTION',at,at);}
  function round(n,owner,bet,net,fee='0',at=T2){db.sqlite.prepare('INSERT INTO rounds(id,owner,operation,bet,gross,fee,net,burn,score,sequence,rules_version,rules_snapshot,claimed,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('round-'+n,owner,'operation-'+n,bet,String(BigInt(net)+BigInt(fee)),fee,net,'0',400,'[]','fixture','{}',1,at);}
  function referral(n,recipient,player,value,level=1,at=T2){db.sqlite.prepare('INSERT INTO referral_rewards(id,round,player,recipient,asset,level,stake,amount,policy,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('referral-'+n,'round-'+n,player,recipient,asset,level,amount(500),value,'fixture',at);}
  deposit(1,a,String(BigInt(amount(1000))+1n));deposit(2,a,amount(500),T2);deposit(3,b,amount(200));deposit(4,'pool:'+asset,amount(2000000));deposit(5,foreign,amount(900000),T1,'token:56:'+address(998));deposit(6,demo,amount(800000),T1,'demo');
  pending(1,a);pending(7,a);pending(8,a,'failed');pending(9,a,'confirmed');
  withdrawal(1,a,amount(100),amount(5),'confirmed');withdrawal(2,a,amount(200),'0','authorized');withdrawal(3,a,amount(300),'0','failed');withdrawal(4,a,amount(400),'0','rejected');withdrawal(5,b,amount(100),'0','confirmed');
  round(1,a,amount(500),amount(250),'0',T1);round(2,a,amount(500),amount(975),amount(25));round(3,b,amount(500),'0');round(4,foreign,amount(1000),amount(500000));round(5,demo,amount(500),amount(100000));
  referral(1,a,b,amount(75));referral(2,a,b,amount(25),2);
  for(const [owner,token] of [[a,'a'.repeat(64)],[b,'b'.repeat(64)]])db.sqlite.prepare('INSERT INTO sessions(hash,owner,expires_at) VALUES(?,?,?)').run(await hash(token),owner,Date.now()+86400000);
  return {db,env,asset,a,b,c,account,deposit,pending,withdrawal,round,referral,adminCookie:'sheep_session='+'a'.repeat(64),userCookie:'sheep_session='+'b'.repeat(64)};
}
