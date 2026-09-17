import test from 'node:test';
import assert from 'node:assert/strict';
import { stopAngle, buildWheelSegments, landingIndex } from '../public/wheel.js';

test('wheel stops the server-selected sector exactly under the fixed top pointer', () => {
  for (const previous of [0, 31, 350, 1820, 5432]) for (let index = 0; index < 24; index++) {
    const target = stopAngle(previous, index, 24);
    assert.ok(target - previous >= 1800);
    assert.equal((target + index * 15) % 360, 0);
  }
});

test('unknown outcomes cannot produce a false wheel landing', () => {
  assert.throws(() => stopAngle(0, -1, 24));
  assert.throws(() => stopAngle(0, 24, 24));
});

import { sectorText, resultText } from '../public/outcome-view.js';
import { WHEEL_OUTCOMES, RULES, drawWheel } from '../server/rules.js';
test('zero uses clear words and 1x displays its multiplier without a misleading claim prompt', () => {
  const empty=sectorText(WHEEL_OUTCOMES.find(o=>o.kind==='empty'));
  const replay=sectorText(WHEEL_OUTCOMES.find(o=>o.kind==='replay'));
  assert.equal(empty.label,'谢谢参与'); assert.equal(empty.detail,'获得金元宝'); assert.equal(replay.label,'1×'); assert.equal(replay.shortLabel,'1×'); assert.equal(resultText({outcomeKind:'replay'}).title,'本次转中 1×');
  assert.equal(resultText({outcomeKind:'empty',ingots:'500'}).message,'金元宝已到账');
  assert.equal(resultText({outcomeKind:'replay'}).amountLabel,'已退回本金');
  assert.match(resultText({outcomeKind:'replay'}).message,/不收手续费/);
  assert.equal(sectorText(WHEEL_OUTCOMES.find(o=>o.id==='jackpot')).label,'10×');
});

test('24 repeated sectors include every award and do not change the server probabilities', () => {
  const segments=buildWheelSegments(WHEEL_OUTCOMES);
  assert.equal(segments.length,24);
  const emptyPositions=segments.flatMap((s,i)=>s.outcomeId==='no-prize'?[i]:[]);
  assert.equal(emptyPositions.length,2);
  assert.equal(emptyPositions[1]-emptyPositions[0],segments.length/2);
  assert.equal(WHEEL_OUTCOMES.find(o=>o.id==='no-prize').weight/RULES.weightTotal,.28);
  assert.equal(segments.filter(s=>s.multiplierBps===10000&&s.label==='1×'&&s.shortLabel==='1×').length,5);
  for(const o of WHEEL_OUTCOMES) {
    assert.equal(segments.filter(s=>s.outcomeId===o.id).length,o.displaySlots);
    assert.ok(segments.some(s=>s.multiplierBps===o.multiplierBps));
  }
  assert.deepEqual([...new Set(segments.map(s=>s.multiplierBps))].sort((a,b)=>a-b),[0,5000,10000,12000,15000,20000,30000,50000,100000]);
  const changedWeights=WHEEL_OUTCOMES.map(o=>({...o,weight:1}));
  assert.deepEqual(buildWheelSegments(changedWeights),segments);
  const hits=new Map();
  for(let ticket=0;ticket<RULES.weightTotal;ticket++) {
    const outcome=drawWheel(()=>BigInt(ticket)),round={id:'round-'+ticket,version:RULES.version,outcomeId:outcome.outcomeId,multiplierBps:outcome.score*50};
    const index=landingIndex(segments,round,RULES.version);
    assert.ok(index>=0&&index<24); assert.equal(segments[index].outcomeId,round.outcomeId);
    assert.equal(landingIndex(segments,round,RULES.version),index);
    const positions=hits.get(round.outcomeId)||new Set(); positions.add(index); hits.set(round.outcomeId,positions);
  }
  assert.ok(hits.get('half').size>1);
  assert.equal(hits.get('no-prize').size,2);
  assert.equal(hits.get('break-even').size,5);
  assert.equal(hits.get('jackpot').size,1);
});
test('older results and mismatched multipliers cannot land on a misleading current segment', () => {
  const segments=buildWheelSegments(WHEEL_OUTCOMES);
  assert.equal(landingIndex(segments,{id:'old',outcomeId:'small-win',multiplierBps:12000,version:'server-wheel-replay-v2-20260915'},RULES.version),-1);
  assert.equal(landingIndex(segments,{id:'wrong',outcomeId:'small-win',multiplierBps:100000,version:RULES.version},RULES.version),-1);
  assert.throws(()=>buildWheelSegments([{id:'bad',displaySlots:0}]));
});
