import test from 'node:test';
import assert from 'node:assert/strict';
import { copyText } from '../public/shared/clipboard.js';

const link = 'https://sheep-fortune-game.lingolayer.workers.dev/?ref=0123456789abcdef01234567';
function field(copyResult) {
  const calls = [];
  return { value: link, calls, focus: () => calls.push('focus'), select: () => calls.push('select'), setSelectionRange: (a, b) => calls.push([a, b]), ownerDocument: { execCommand: command => { calls.push(command); if (copyResult instanceof Error) throw copyResult; return copyResult; } } };
}
test('modern clipboard copies the complete referral URL without reading the clipboard', async () => {
  const input = field(false), writes = [];
  const navigator = { clipboard: { writeText: async value => { writes.push(value); } } };
  const pending = copyText(link, input, { navigator });
  assert.deepEqual(writes, [link]); // Called synchronously in the click activation.
  assert.equal(await pending, true); assert.deepEqual(input.calls, []);
});
test('missing, denied and synchronously throwing clipboard APIs use the visible modal field', async () => {
  for (const navigator of [{}, { clipboard: { writeText: () => Promise.reject(Error('denied')) } }, { clipboard: { writeText: () => { throw Error('blocked'); } } }]) {
    const input = field(true);
    assert.equal(await copyText(link, input, { navigator }), true);
    assert.deepEqual(input.calls, ['focus', 'select', [0, link.length], 'copy']);
  }
});
test('a rejected or unsupported fallback reports failure instead of claiming a successful copy', async () => {
  for (const result of [false, undefined, Error('copy unsupported')]) assert.equal(await copyText(link, field(result), { navigator: {} }), false);
});
test('a wallet clipboard promise that never resolves cannot leave the button pending forever', async () => {
  const input = field(false), navigator = { clipboard: { writeText: () => new Promise(() => {}) } };
  assert.equal(await copyText(link, input, { navigator, timeoutMs: 10 }), false);
  assert.ok(input.calls.includes('copy'));
});
