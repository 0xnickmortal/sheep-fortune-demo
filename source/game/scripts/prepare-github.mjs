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

[打开游戏站点](https://dapp.yangnian.xyz/) · [手机界面](https://0xnickmortal.github.io/sheep-fortune-demo/)

仓库根目录是 GitHub Pages 手机界面，钱包操作前往游戏站点；完整前端、后端、托管合约及测试源码在 [source/game](source/game)。

本次包含“我的账户 → 邀请好友”、直推15%/间推5%返佣、托管充值、签名提现及批量销毁实现。

Cloudflare Workers + D1 已接入真实托管合约，200万初始奖池及游戏税收入已对账；提供充值、提现、自动到账核对、过期返还和管理员钱包白名单管理。现在向所有完成钱包签名登录的用户开放充值、提现和下注，不再要求在四钱包名单内。白名单仅保留其原有规则与权益，管理员权限保持独立。Pages不结算本地余额，玩家页面保留补偿规则、结算差额及历史记录，下注金额固定为500、1,000、2,000和5,000。返佣由后台正常入账，玩家手动刷新页面或明细查看；页面空闲时不再每15秒轮询余额。玩家页面不包含运营管理入口，后台由管理员通过单独地址访问。

[本次接入与操作说明](source/game/docs/充值提现与白名单接入_20260918.md)

## 开发

进入 source/game，安装 Node 22.13+ 和 Foundry（forge/anvil），运行 npm ci。

- npm test：应用及本地EVM联调测试。
- npm run contracts:test：合约测试。
- npm run dev：本地游戏与API。
- npm run build：构建 Sites 后端和页面。
- npm run cf:deploy：构建并部署 Cloudflare 后台；首次需按部署说明配置账户和数据库。
- sh scripts/deploy-pages.sh：同步手机界面和源码。

[Cloudflare部署说明](source/game/docs/Cloudflare部署.md) · [托管与返佣部署说明](source/game/docs/托管合约与推荐返佣.md)

普通基础表净返还率77%，销毁9.3%；直推15%和间推5%均按下注本金计算。当前版本独立保留大额下注保护：达到可用余额50%不出0倍，五把之后仍有效。账户前5把出现0倍或0.5倍时，下一把由玩家自由选择下注档位，并匹配净盈利最接近前局损失的现有盈利倍率；允许差额、不结转。第5把产生的补偿在第6把兑现，之后不再产生新补偿。启用后整体返还率取决于下注行为，不能继续按固定77%理解；详情见 [前五把补偿与固定档位](source/game/docs/前五把补偿与固定档位_20260918.md)。

自定义域名 https://dapp.yangnian.xyz/ 已启用，并通过 HTTPS 首页与后台接口验证；与原 Workers 地址共用后台和数据库。

开发配置示例默认关闭真实资金。仓库不含钱包私钥、服务端密钥或玩家数据库。
`);
console.log('Prepared static Pages build and ' + files.length + ' source files; no push performed.');
