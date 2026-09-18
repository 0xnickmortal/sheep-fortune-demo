# 羊年大吉

[打开游戏站点](https://sheep-fortune-game.lingolayer.workers.dev/) · [手机界面](https://0xnickmortal.github.io/sheep-fortune-demo/)

仓库根目录是 GitHub Pages 手机界面，钱包操作前往游戏站点；完整前端、后端、托管合约及测试源码在 [source/game](source/game)。

本次包含“我的账户 → 邀请好友”、直推15%/间推5%返佣、托管充值、签名提现及批量销毁实现。

Cloudflare Workers + D1 已接入真实托管合约，200万初始奖池及游戏税收入已对账；提供充值、提现、自动到账核对、过期返还和管理员钱包白名单管理。当前仅项目管理员可做真实资金验收，公开充提仍关闭。Pages不结算本地余额，玩家页面已移除测试入口和概率表。

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

当前普通净返还率77%，销毁9.3%；直推15%和间推5%均按下注本金计算。两级均发放时，理论奖池留存为−6.3%，真实资金开放前需确认经济参数。

开发配置示例默认关闭真实资金。仓库不含钱包私钥、服务端密钥或玩家数据库。
