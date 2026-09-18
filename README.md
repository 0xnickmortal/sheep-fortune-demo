# 羊年大吉

[打开游戏站点](https://sheep-fortune-game.lingolayer.workers.dev/) · [手机界面](https://0xnickmortal.github.io/sheep-fortune-demo/)

仓库根目录是 GitHub Pages 手机界面，钱包操作前往 Cloudflare 游戏站点；完整前端、后端、托管合约及测试源码在 [source/game](source/game)。

本次包含“我的账户 → 邀请好友”、直推15%/间推5%返佣、托管充值、签名提现及批量销毁实现。

页面已移除测试入口、奖项说明块和概率表；仅显示钱包账户资产。GitHub Pages 不再使用浏览器本地余额结算。Cloudflare Workers + D1 提供游戏后台，真实充值提现仍按线上开关控制，本次界面更新不启用真实资金。

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
