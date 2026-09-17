import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { RULES } from '../server/rules.js';
import { versionAssets } from './version-assets.mjs';
import { serverSkinPage } from './frontend-entry.mjs';
const cloudflare = process.argv.includes('--cloudflare');
if (!cloudflare) {
 const hosting = JSON.parse(await readFile('.openai/hosting.json', 'utf8'));
 if (hosting.project_id !== 'appgprj_6aa80f60f8d08191ae75edcdf4a7a223' || hosting.d1 !== 'DB' || hosting.static) throw Error('Incorrect game hosting configuration');
}
await rm('dist', { recursive: true, force: true });
await mkdir('dist/server', { recursive: true });
if (!cloudflare) await mkdir('dist/.openai', { recursive: true });
await cp('public', 'dist/client', { recursive: true });
for (const skin of ['red', 'night', 'jade']) {
 const html = serverSkinPage(await readFile(`public/${skin}/index.html`, 'utf8'));
 await writeFile(`dist/client/${skin}/index.html`, html);
 if (skin === 'red') await writeFile('dist/client/index.html', html);
}
await versionAssets('dist/client', RULES.version);
await build({ entryPoints: ['server/worker.js'], outfile: 'dist/server/index.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof' });
if (!cloudflare) {
 await cp('.openai/hosting.json', 'dist/.openai/hosting.json');
 await cp('drizzle', 'dist/.openai/drizzle', { recursive: true });
 await writeFile('dist/server/wrangler.json', JSON.stringify({ name: 'sheep-fortune-game', main: 'index.js', compatibility_date: '2026-09-01', vars: { TRUST_PLATFORM_IDENTITY: 'true' }, assets: { directory: '../client', binding: 'ASSETS', run_worker_first: ['/api/*'] } }, null, 2));
}
console.log('Built server-backed mobile game and D1 migrations. Live payments default to disabled.');
