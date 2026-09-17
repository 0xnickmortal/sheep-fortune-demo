import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// The public repository contains the playable static build and a reproducible
// source snapshot. Copy an explicit allowlist, never local data or credentials.
const root = resolve(import.meta.dirname, '..');
const target = resolve(process.argv[2] || join(root, '.pages-repo'));
if (target === root || !(await stat(join(target, '.git')).catch(() => null))) throw Error('Target must be a separate Git checkout');
const dirs = ['contracts', 'db', 'design', 'docs', 'drizzle', 'public', 'scripts', 'server', 'tests'];
const files = ['.env.example', '.gitignore', '.openai/hosting.json', 'README.md', 'drizzle.config.ts', 'foundry.toml', 'package.json', 'package-lock.json', 'wrangler.json'];
const allowed = /\.(?:js|mjs|ts|py|sol|json|md|css|html|sql|png|svg|webp|sh)$/;
async function collect(dir) {
  const found = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'artifacts'].includes(entry.name)) continue;
    const name = dir + '/' + entry.name;
    if (entry.isSymbolicLink()) throw Error('Source snapshot cannot contain symlinks: ' + name);
    if (entry.isDirectory()) found.push(...await collect(name));
    else if (allowed.test(entry.name)) found.push(name);
  }
  return found;
}
for (const dir of dirs) files.push(...await collect(dir));
for (const file of files) await stat(join(root, file));
const assets = ['index.html', 'assets', 'jade', 'night', 'red', 'shared', 'outcome-view.js', 'wheel.js'];
for (const file of assets) await stat(join(root, 'dist-share', file));
for (const file of assets) {
  await rm(join(target, file), { recursive: true, force: true });
  await cp(join(root, 'dist-share', file), join(target, file), { recursive: true });
}
const source = join(target, 'source/game');
await rm(source, { recursive: true, force: true });
for (const file of files) {
  const dest = join(source, file);
  await mkdir(resolve(dest, '..'), { recursive: true });
  await cp(join(root, file), dest);
}
await writeFile(join(target, '.nojekyll'), '');
await writeFile(join(target, 'README.md'), `# 羊年大吉

[打开云端后台体验版](https://sheep-fortune-game.lingolayer.workers.dev/) · [静态手机试玩](https://0xnickmortal.github.io/sheep-fortune-demo/)

仓库根目录是 GitHub Pages 静态试玩页面；完整前端、后端、托管合约及测试源码在 [source/game](source/game)。

本次包含“我的账户 → 邀请好友”、直推15%/间推5%返佣、托管充值、签名提现及批量销毁实现。

**Pages 只有静态测试币试玩。** Cloudflare Workers + D1 后台已部署：登录、余额、金元宝、游戏记录由服务器保存，推荐接口已发布。真实充值、提现与真实游戏仍关闭；托管合约尚未部署，试玩账户不产生推荐返佣。

## 开发

进入 source/game，安装 Node 22.13+ 和 Foundry（forge/anvil），运行 npm ci。

- npm test：应用及本地EVM联调测试。
- npm run contracts:test：合约测试。
- npm run dev：本地游戏与API。
- npm run build：构建 Sites 后端和页面。
- npm run cf:deploy：构建并部署 Cloudflare 后台；首次需按部署说明配置账户和数据库。
- sh scripts/deploy-pages.sh：同步静态试玩和源码。

[Cloudflare部署说明](source/game/docs/Cloudflare部署.md) · [托管与返佣部署说明](source/game/docs/托管合约与推荐返佣.md)

当前普通净返还率77%，销毁9.3%；直推15%和间推5%均按下注本金计算。两级均发放时，理论奖池留存为−6.3%，真实资金开放前需确认经济参数。

开发配置示例默认关闭真实资金。仓库不含钱包私钥、实际环境配置或玩家数据库。
`);
console.log('Prepared static Pages build and ' + files.length + ' source files; no push performed.');
