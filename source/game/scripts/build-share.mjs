// Builds dist-share/: the three mobile skins with wallet actions linked to
// the server-backed game. Static Pages never settles balances locally.
// dist-share/index.html is a complete document for any static host (a tunnel,
// GitHub Pages, a CDN); dist-share/artifact.html is the same page as a body
// fragment for the claude.ai artifact host, which adds its own skeleton.
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { RULES } from '../server/rules.js';
import { versionAssets } from './version-assets.mjs';
const out = 'dist-share';
await rm(out, { recursive: true, force: true });
for (const dir of ['shared', 'assets', 'night', 'jade', 'red']) await mkdir(`${out}/${dir}`, { recursive: true });
function replaceAll(text, pairs, label) {
  for (const [from, to] of pairs) { if (!text.includes(from)) throw new Error(`${label}: expected "${from}"`); text = text.split(from).join(to); }
  return text;
}
async function transform(source, target, pairs) { await writeFile(target, replaceAll(await readFile(source, 'utf8'), pairs, source)); }
await transform('public/shared/core.js', `${out}/shared/core.js`, [["'/wheel.js?v=6'", "'../wheel.js?v=6'"], ["'/outcome-view.js?v=5'", "'../outcome-view.js?v=5'"]]);
await transform('public/shared/skin.js', `${out}/shared/skin.js`, [["'/shared/core.js?v=1'", "'./core.js?v=1'"]]);
await cp('public/shared/account-features.js', `${out}/shared/account-features.js`);
await cp('public/shared/wallet-network.js', `${out}/shared/wallet-network.js`);
await cp('public/shared/account-features.css', `${out}/shared/account-features.css`);
await cp('server/rules.js', `${out}/shared/rules.js`);
await cp('server/bags.js', `${out}/shared/bags.js`);
await cp('public/wheel.js', `${out}/wheel.js`);
await cp('public/outcome-view.js', `${out}/outcome-view.js`);
await cp('public/assets/fortune-sheep.png', `${out}/assets/fortune-sheep.png`);
const skins = ['night', 'jade', 'red'];
function pageLinks(html, prefix) {
  return replaceAll(html, [
    ['<a href="/">经典红金</a>', ''],
    ['href="/night/"', `href="${prefix}night/index.html"`],
    ['href="/jade/"', `href="${prefix}jade/index.html"`],
    ['href="/red/"', `href="${prefix}index.html"`],
    ['<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="sheep-backend" content="local">'],
  ], 'links');
}
for (const skin of skins) {
  await cp(`public/${skin}/style.css`, `${out}/${skin}/style.css`);
  await transform(`public/${skin}/app.js`, `${out}/${skin}/app.js`, [["'/shared/skin.js?v=1'", "'../shared/skin.js?v=1'"]]);
}
for (const skin of ['night', 'jade']) {
  const html = pageLinks(await readFile(`public/${skin}/index.html`, 'utf8'), '../');
  await writeFile(`${out}/${skin}/index.html`, replaceAll(html, [
    [`href="/${skin}/style.css?v=1"`, 'href="style.css?v=1"'], [`src="/${skin}/app.js?v=1"`, 'src="app.js?v=1"'],
    ['src="/assets/fortune-sheep.png"', 'src="../assets/fortune-sheep.png"'], ['href="/assets/fortune-sheep.png"', 'href="../assets/fortune-sheep.png"'],
  ], skin));
}
// The red skin is the front page. The artifact host wraps the fragment in its own skeleton.
const red = replaceAll(pageLinks(await readFile('public/red/index.html', 'utf8'), ''), [
  ['href="/red/style.css?v=1"', 'href="red/style.css?v=1"'], ['src="/red/app.js?v=1"', 'src="red/app.js?v=1"'],
  ['src="/assets/fortune-sheep.png"', 'src="assets/fortune-sheep.png"'], ['href="/assets/fortune-sheep.png"', 'href="assets/fortune-sheep.png"'],
  ['<title>红运当头 · 羊年大吉</title>', '<title>羊年大吉转盘</title>'],
], 'red');
await writeFile(`${out}/index.html`, red);
const body = red.slice(red.indexOf('<body>') + '<body>'.length, red.lastIndexOf('</body>')).trim();
const fragment = `<title>羊年大吉转盘</title>\n<meta name="sheep-backend" content="local">\n<link rel="stylesheet" href="red/style.css?v=1">\n${body}\n`;
await writeFile(`${out}/artifact.html`, fragment);
await versionAssets(out, RULES.version);
console.log('Built dist-share: 红运当头, night/ and jade/, with wallet actions linked to the game site.');
