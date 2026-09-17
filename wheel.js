// Presentation only: the server chooses the result before the wheel is stopped.
import { sectorText } from './outcome-view.js?v=server-wheel-77-v13-20260917-bb2ad7fb8b63';
const NS = 'http://www.w3.org/2000/svg';
const mod = value => ((value % 360) + 360) % 360;
export function buildWheelSegments(outcomes) {
  const entries = outcomes.map(o => ({ outcome: o, slots: o.displaySlots ?? 1, current: 0 }));
  if (!entries.length || entries.some(e => !Number.isInteger(e.slots) || e.slots < 1)) throw new Error('Invalid wheel layout');
  const total = entries.reduce((sum, e) => sum + e.slots, 0);
  if (total < 2 || total > 72 || new Set(outcomes.map(o => o.id)).size !== outcomes.length) throw new Error('Invalid wheel layout');
  const segments = [];
  // Smoothly interleave repeated symbols, independently of the payout weights.
  for (let slot = 0; slot < total; slot++) {
    for (const entry of entries) entry.current += entry.slots;
    const selected = entries.reduce((best, entry) => entry.current > best.current ? entry : best);
    selected.current -= total;
    segments.push({ outcomeId: selected.outcome.id, multiplierBps: selected.outcome.multiplierBps, ...sectorText(selected.outcome) });
  }
  // Two empty-result pictures face each other; swapping pictures preserves
  // every award's slot count and never touches the server draw weights.
  const empty = segments.flatMap((segment, index) => segment.kind === 'empty' ? [index] : []);
  if (empty.length === 2 && total % 2 === 0 && segments[empty[0]].outcomeId === segments[empty[1]].outcomeId) {
    const opposite = (empty[0] + total / 2) % total;
    [segments[empty[1]], segments[opposite]] = [segments[opposite], segments[empty[1]]];
  }
  return segments;
}
export function landingIndex(segments, round, version) {
  if (round.version !== version) return -1;
  const matches = segments.flatMap((segment, index) => segment.outcomeId === round.outcomeId && segment.multiplierBps === round.multiplierBps ? [index] : []);
  if (!matches.length) return -1;
  // Use the saved round ID only to choose among identical pictures. Retries land
  // on the same picture; this never draws or changes the financial result.
  let hash = 2166136261;
  for (const character of String(round.id)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return matches[hash % matches.length];
}
export function stopAngle(previous, index, count) {
  if (!Number.isInteger(index) || index < 0 || index >= count || !Number.isInteger(count) || count < 2) throw new Error('Invalid wheel segment');
  const target = mod(-index * 360 / count);
  return previous + 5 * 360 + mod(target - mod(previous));
}
function svgNode(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
function point(angle, radius) {
  const a = (angle - 90) * Math.PI / 180;
  return [180 + radius * Math.cos(a), 180 + radius * Math.sin(a)];
}
export function createWheel(rotor, segments) {
  let rotation = 0;
  const groups = [], svg = svgNode('svg', { viewBox: '0 0 360 360', 'aria-hidden': 'true', focusable: 'false' });
  const size = 360 / segments.length, dense = segments.length > 12;
  svg.classList.toggle('wheel-dense', dense);
  segments.forEach((segment, i) => {
    const start = i * size - size / 2, end = start + size;
    const outerStart = point(start, 173), outerEnd = point(end, 173), innerEnd = point(end, 63), innerStart = point(start, 63);
    const group = svgNode('g', { class: 'wheel-sector' + (i % 2 ? ' wheel-sector-red' : ' wheel-sector-cream') });
    if (segment.kind === 'jackpot') group.classList.add('wheel-sector-jackpot');
    if (segment.kind === 'empty') group.classList.add('wheel-sector-empty');
    if (dense) group.classList.add('wheel-tone-' + segment.kind);
    group.append(svgNode('path', { d: `M ${outerStart} A 173 173 0 ${size > 180 ? 1 : 0} 1 ${outerEnd} L ${innerEnd} A 63 63 0 ${size > 180 ? 1 : 0} 0 ${innerStart} Z` }));
    const [x, y] = dense ? point(i * size, 133) : [180, 61];
    const label = svgNode('text', { x, y, 'text-anchor': 'middle', 'dominant-baseline': 'central', transform: dense ? `rotate(${i * size - 90} ${x} ${y})` : `rotate(${i * size} 180 180)`, class: 'wheel-label' });
    label.textContent = dense ? segment.shortLabel : segment.label;
    group.append(label);
    if (!dense && segment.detail) { const detail = svgNode('text', { x: 180, y: 83, 'text-anchor': 'middle', transform: `rotate(${i * size} 180 180)`, class: 'wheel-detail' }); detail.textContent = segment.detail; group.append(detail); }
    if (dense) { const [px, py] = point(end, 175); group.append(svgNode('circle', { cx: px, cy: py, r: 2.4, class: 'wheel-peg' })); }
    groups.push(group); svg.append(group);
  });
  rotor.replaceChildren(svg); rotor.style.transform = 'rotate(0deg)';
  return {
    clear() { groups.forEach(g => g.classList.remove('landed')); },
    async spin(index) {
      this.clear();
      const target = stopAngle(rotation, index, segments.length), reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduced && rotor.animate) {
        const animation = rotor.animate([{ transform: `rotate(${rotation}deg)` }, { transform: `rotate(${target}deg)` }], { duration: 3400, easing: 'cubic-bezier(.12,.72,.1,1)', fill: 'forwards' });
        try { await animation.finished; } finally { rotor.style.transform = `rotate(${target}deg)`; animation.cancel(); }
      } else rotor.style.transform = `rotate(${target}deg)`;
      rotation = target; groups[index].classList.add('landed');
    },
  };
}
