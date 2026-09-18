import { MODEL } from './bags.js?v=server-wheel-77-v13-20260917-3003acd5632b';
export const UNIT=10n**18n;
export const WHEEL_OUTCOMES = Object.freeze([
 // displaySlots controls the repeated visual layout only; weight controls draws.
 // Approved 77% table (2026-09-17): net return after the >1x stake fee.
 Object.freeze({id:'no-prize',title:'谢谢参与',kind:'empty',multiplierBps:0,weight:2800,displaySlots:2}),
 Object.freeze({id:'half',title:'0.5倍返还',kind:'payout',multiplierBps:5000,weight:1800,displaySlots:5}),
 Object.freeze({id:'break-even',title:'1×',kind:'replay',multiplierBps:10000,weight:3800,displaySlots:5}),
 Object.freeze({id:'small-win',title:'小赚',kind:'payout',multiplierBps:12000,weight:500,displaySlots:6}),
 Object.freeze({id:'one-half',title:'1.5倍奖励',kind:'payout',multiplierBps:15000,weight:270,displaySlots:2}),
 Object.freeze({id:'double',title:'2倍奖励',kind:'payout',multiplierBps:20000,weight:500,displaySlots:1}),
 Object.freeze({id:'triple',title:'3倍奖励',kind:'payout',multiplierBps:30000,weight:300,displaySlots:1}),
 Object.freeze({id:'fivefold',title:'5倍奖励',kind:'payout',multiplierBps:50000,weight:25,displaySlots:1}),
 Object.freeze({id:'jackpot',title:'大奖',kind:'payout',multiplierBps:100000,weight:5,displaySlots:1}),
]);
export const MAX_PAYOUT_BPS = Math.max(...WHEEL_OUTCOMES.map(o => o.multiplierBps));
export const ROUND_FEE = Object.freeze({bps:500,basis:'stake',aboveMultiplierBps:10000});
export const RULES = Object.freeze({
 version:'server-wheel-77-v13-20260917',multiplierBasis:'gross',minBet:'500',maxBet:'50000',
 poolDivisor:300,jackpotReserveMultiple:3,maxPayoutBps:MAX_PAYOUT_BPS,pauseBelow:'500000',
 roundFee:ROUND_FEE,claimFeeBps:0,replayFeeBps:0,replaySettlement:'return-principal',burnBps:930,subresults:1,scoreDenominator:200,
 rewardSettlement:'auto-balance',ingots:Object.freeze({eligibleMultiplierBps:[0,5000],basis:'stake-minus-net',ratioBps:10000,redemptionEnabled:false}),
 rtpScope:'game-rewards-after-round-fee',outcomes:WHEEL_OUTCOMES,weightTotal:10000,
 resultProbabilities:WHEEL_OUTCOMES.reduce((totals,o)=>{const net=o.multiplierBps-(o.multiplierBps>ROUND_FEE.aboveMultiplierBps?ROUND_FEE.bps:0);totals[net<10000?0:net===10000?1:2]+=o.weight;return totals;},[0,0,0]).map(weight=>weight/100),
 netRtp:(WHEEL_OUTCOMES.reduce((sum,o)=>sum+(o.multiplierBps-(o.multiplierBps>ROUND_FEE.aboveMultiplierBps?ROUND_FEE.bps:0))*o.weight,0)/10000/100).toFixed(4)+'%',
 demoGrant:'20000',initialDemoPool:'2000000',
});
export class GameError extends Error{constructor(message,status=400,code='INVALID_REQUEST'){super(message);this.status=status;this.code=code;}}
export const units=(x)=>BigInt(x)*UNIT;
export function parseAmount(s,{integer=false}={}){if(typeof s!=='string'||s.length>40||!(integer?/^[1-9]\d{0,8}$/:/^(0|[1-9]\d{0,8})(\.\d{1,18})?$/).test(s))throw new GameError(integer?'请输入整数币数量':'请输入有效币数量，最多 18 位小数');const [a,b='']=s.split('.'),value=BigInt(a)*UNIT+BigInt(b.padEnd(18,'0'));if(value<=0n)throw new GameError('金额必须大于零');return value;}
export function formatAmount(n){n=BigInt(n);const sign=n<0?'-':'';if(n<0)n=-n;const fraction=(n%UNIT).toString().padStart(18,'0').replace(/0+$/,'');return sign+(n/UNIT)+(fraction?'.'+fraction:'');}
export function randomBelow(limit){limit=BigInt(limit);if(limit<=0n)throw new Error('Invalid random bound');const bits=limit.toString(2).length,bytes=Math.ceil(bits/8);for(;;){const a=crypto.getRandomValues(new Uint8Array(bytes));a[0]&=(1<<((bits-1)%8+1))-1;let value=0n;for(const x of a)value=value*256n+BigInt(x);if(value<limit)return value;}}
// Retained only for historical model verification. New rounds use drawWheel.
// Sample a legal ordering with remaining multiplicity * number of legal completions.
// Memoization is per selected bag/request; no growing global cache in a Worker.
export function drawBag(random=randomBelow){let roll=Number(random(54600n)),idx=0;for(;idx<MODEL.weights.length-1;idx++){if(roll<MODEL.weights[idx])break;roll-=MODEL.weights[idx];}const initial=MODEL.counts[idx],delta=[-105,-48,9,85,180],cache=new Map();
 function ways(rem,last,run){const key=rem.join(',')+'|'+last+'|'+run;if(cache.has(key))return cache.get(key);const pnl=initial.reduce((s,n,i)=>s+(n-rem[i])*delta[i],0);if(pnl< -1400||pnl>1200||run>3)return 0n;if(!rem.some(Boolean))return 1n;let total=0n;for(let i=0;i<5;i++)if(rem[i]){const next=rem.slice();next[i]--;const sign=i<2?-1:1;total+=BigInt(rem[i])*ways(next,sign,sign===last?run+1:1);}cache.set(key,total);return total;}
 let rem=initial.slice(),last=0,run=0;const sequence=[];for(let step=0;step<20;step++){const options=[];let total=0n;for(let i=0;i<5;i++)if(rem[i]){const next=rem.slice();next[i]--;const sign=i<2?-1:1,nr=sign===last?run+1:1,w=BigInt(rem[i])*ways(next,sign,nr);if(w){options.push({i,next,sign,nr,w});total+=w;}}let x=random(total);const o=options.find(o=>{if(x<o.w)return true;x-=o.w;return false;});if(!o)throw new Error('No valid bag sequence');sequence.push([5,8,11,15,20][o.i]);rem=o.next;last=o.sign;run=o.nr;}
 return {score:MODEL.scores[idx],sequence,bag:idx};}
export function drawWheel(random=randomBelow,rules=RULES){let roll=Number(random(BigInt(rules.weightTotal)));for(const o of rules.outcomes){if(roll<o.weight)return {score:o.multiplierBps/50,sequence:[o.multiplierBps/1000],outcomeId:o.id};roll-=o.weight;}throw new Error('Invalid wheel draw');}
export function settlement(stake,outcome) {
 const gross=stake*BigInt(outcome.score)/BigInt(RULES.scoreDenominator);
 // Charge once at settlement, on the stake, only when the drawn multiplier exceeds 1x.
 const fee=outcome.score*50>RULES.roundFee.aboveMultiplierBps?stake*BigInt(RULES.roundFee.bps)/10000n:0n,net=gross-fee;
 return {gross,fee,net,burn:stake*BigInt(RULES.burnBps)/10000n};
}
export function maximumPayout(stake) {
 return stake*BigInt(RULES.maxPayoutBps)/10000n;
}
export function maxBet(pool) {
 if(pool<units(RULES.pauseBelow))return 0n;
 const ordinaryCap=pool/UNIT/BigInt(RULES.poolDivisor)*UNIT;
 const reserveCap=pool*10000n/(BigInt(RULES.maxPayoutBps)*BigInt(RULES.jackpotReserveMultiple))/UNIT*UNIT;
 const cap=ordinaryCap<reserveCap?ordinaryCap:reserveCap;
 if(cap<units(RULES.minBet))return 0n;
 return cap<units(RULES.maxBet)?cap:units(RULES.maxBet);
}

export function ingotAward(stake,outcome) {
 const multiplierBps=outcome.score*50;
 if(!RULES.ingots.eligibleMultiplierBps.includes(multiplierBps))return 0n;
 const loss=stake-settlement(stake,outcome).net;
 return loss>0n?loss*BigInt(RULES.ingots.ratioBps)/10000n:0n;
}
