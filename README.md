# 羊年大吉

[打开手机试玩](https://0xnickmortal.github.io/sheep-fortune-demo/)

仓库根目录是 GitHub Pages 静态试玩页面；完整前端、后端、托管合约及测试源码在 [source/game](source/game)。

本次包含“我的账户 → 邀请好友”、直推15%/间推5%返佣、托管充值、签名提现及批量销毁实现。

**Pages 只有测试币试玩，不运行数据库或后台签名服务，不开放真实充值、提现和推荐返佣。** 正式托管合约尚未部署；后端需单独配置和部署。

## 开发

进入 source/game，安装 Node 22.13+ 和 Foundry（forge/anvil），运行 npm ci。

- npm test：应用及本地EVM联调测试。
- npm run contracts:test：合约测试。
- npm run dev：本地游戏与API。
- npm run build：构建后端和页面。
- sh scripts/deploy-pages.sh：同步静态试玩和源码。

[托管与返佣部署说明](source/game/docs/托管合约与推荐返佣.md)

当前普通净返还率77%，销毁9.3%；直推15%和间推5%均按下注本金计算。两级均发放时，理论奖池留存为−6.3%，真实资金开放前需确认经济参数。

开发配置示例默认关闭真实资金。仓库不含钱包私钥、实际环境配置或玩家数据库。
