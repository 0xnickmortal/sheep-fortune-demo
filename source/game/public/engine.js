export const RULES = Object.freeze({version:'demo-0.1',minBet:500,maxBet:50000,pauseBelow:500000,warnBelow:1000000,initialPool:2000000,initialBalance:20000,claimFeeBps:500,burnBps:930});
export const PRIZES = Object.freeze([
 {multiplier:0,weight:5500,label:'下次好运',color:'#314836'},
 {multiplier:1,weight:1500,label:'小有收获',color:'#b5d2f4'},
 {multiplier:1.5,weight:1200,label:'喜气洋洋',color:'#c4d697'},
 {multiplier:2,weight:800,label:'好事成双',color:'#d9f06b'},
 {multiplier:3,weight:600,label:'三羊开泰',color:'#95b485'},
 {multiplier:4,weight:300,label:'四季有喜',color:'#e6e9c9'},
 {multiplier:6,weight:100,label:'好运满格',color:'#d9f06b'},
]);
export const cents=n=>Math.round(n*100);
export function freshState(){return {schema:1,version:RULES.version,revision:0,balance:cents(RULES.initialBalance),pool:cents(RULES.initialPool),burned:0,paid:0,wagered:0,claimFees:0,nextId:1,rounds:[],pending:null};}
export function grossDue(s){return s.rounds.reduce((n,r)=>n+(r.claimed?0:r.gross),0);}
export function available(s){return s.pool-grossDue(s)-(s.pending?.reserve||0);}
export function maxBet(s){if(available(s)<cents(RULES.pauseBelow))return 0;return Math.min(RULES.maxBet,Math.floor(available(s)/100/300));}
export function net(gross){return gross-Math.floor(gross*RULES.claimFeeBps/10000);}
export function claimable(s){return s.rounds.reduce((n,r)=>n+(r.claimed?0:net(r.gross)),0);}
export function choosePrize(value){if(!Number.isInteger(value)||value<0||value>=10000)throw Error('随机值无效');let sum=0;return PRIZES.findIndex(p=>(sum+=p.weight)>value);}
export function randomIndex(cryptoSource=crypto){const limit=Math.floor(2**32/10000)*10000;let x;do{x=cryptoSource.getRandomValues(new Uint32Array(1))[0];}while(x>=limit);return choosePrize(x%10000);}
export function validateBet(s,bet){if(s.pending)return '本局正在开奖，请稍候';if(maxBet(s)<RULES.minBet)return '可用奖池低于安全水位，暂停新局';if(!Number.isSafeInteger(bet)||bet<RULES.minBet||bet>maxBet(s))return `请输入 ${RULES.minBet}–${maxBet(s).toLocaleString('en-US')} 的整数`;if(cents(bet)>s.balance)return '试玩余额不足，可领取奖励或重置试玩';return '';}
export function start(s,bet,index,now=Date.now()){const error=validateBet(s,bet);if(error)throw Error(error);if(!Number.isInteger(index)||!PRIZES[index])throw Error('奖项无效');const n=structuredClone(s),amount=cents(bet),burn=Math.floor(amount*RULES.burnBps/10000);n.balance-=amount;n.pool+=amount-burn;n.burned+=burn;n.wagered+=amount;n.pending={id:n.nextId++,bet:amount,index,reserve:amount*6,startedAt:now,version:RULES.version};n.revision++;assertState(n);return n;}
export function settle(s){if(!s.pending)return s;const n=structuredClone(s),r=n.pending;n.rounds.unshift({id:r.id,bet:r.bet,index:r.index,gross:Math.round(r.bet*PRIZES[r.index].multiplier),time:r.startedAt,claimed:r.index===0,version:r.version});n.rounds=n.rounds.filter((r,i)=>i<100||!r.claimed);n.pending=null;n.revision++;assertState(n);return n;}
export function claim(s){if(s.pending)throw Error('请等待本局开奖完成');const n=structuredClone(s),amount=claimable(n);if(amount<=0)throw Error('暂无可领取奖励');for(const r of n.rounds){if(!r.claimed){n.claimFees+=r.gross-net(r.gross);r.claimed=true;}}n.balance+=amount;n.pool-=amount;n.paid+=amount;n.revision++;assertState(n);return n;}
export function assertState(s){for(const key of ['balance','pool','burned','paid','wagered','claimFees','revision','nextId'])if(!Number.isSafeInteger(s[key])||s[key]<0)throw Error('试玩记录损坏');if(!Array.isArray(s.rounds)||s.rounds.length>10000||s.schema!==1||s.version!==RULES.version)throw Error('试玩记录版本无效');const ids=new Set();for(const r of s.rounds){if(!Number.isSafeInteger(r.id)||ids.has(r.id)||!Number.isSafeInteger(r.bet)||r.bet<50000||!Number.isInteger(r.index)||!PRIZES[r.index]||r.gross!==Math.round(r.bet*PRIZES[r.index].multiplier)||typeof r.claimed!=='boolean'||!Number.isFinite(r.time))throw Error('局次记录无效');ids.add(r.id);}if(s.pending&&(!PRIZES[s.pending.index]||!Number.isInteger(s.pending.index)||!Number.isSafeInteger(s.pending.bet)||s.pending.bet<50000||s.pending.reserve!==s.pending.bet*6||!Number.isFinite(s.pending.startedAt)||ids.has(s.pending.id)))throw Error('待开奖记录无效');if(s.balance+s.pool+s.burned!==cents(RULES.initialBalance+RULES.initialPool)||available(s)<0)throw Error('试玩资金账目不一致');return true;}
