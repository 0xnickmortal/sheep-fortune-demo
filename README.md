# 羊年大吉

[打开游戏站点](https://sheep-fortune-game.lingolayer.workers.dev/) · [手机界面](https://0xnickmortal.github.io/sheep-fortune-demo/)

仓库根目录是 GitHub Pages 手机界面，钱包操作前往游戏站点；完整前端、后端、托管合约及测试源码在 [source/game](source/game)。

本次包含“我的账户 → 邀请好友”、直推15%/间推5%返佣、托管充值、签名提现及批量销毁实现。

Cloudflare Workers + D1 已接入真实托管合约，200万初始奖池及游戏税收入已对账；提供充值、提现、自动到账核对、过期返还和管理员钱包白名单管理。现在向所有完成钱包签名登录的用户开放充值、提现和下注，不再要求在四钱包名单内。白名单仅保留其原有规则与权益，管理员权限保持独立。Pages不结算本地余额，玩家页面已移除测试入口、概率表及大额补偿的记录、提示和玩法段落，后台补偿结算和审计记录保留。玩家页面不包含运营管理入口，后台由管理员通过单独地址访问。

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

普通基础表净返还率77%，销毁9.3%；直推15%和间推5%均按下注本金计算。已启用大额下注保护：达到可用余额50%不出0倍，抽中0.5倍后下一局按新下注额补偿，每钱包累计最多3次，最高10倍且差额不延续。启用后整体返还率取决于下注行为，不能继续按固定77%理解；详情见 [保护与额度说明](source/game/docs/大额下注保护_三次额度_20260918.md)。

自定义域名 dapp.yangnian.xyz 已配置，DNS/HTTPS生效前入口继续使用现有Workers地址。

开发配置示例默认关闭真实资金。仓库不含钱包私钥、服务端密钥或玩家数据库。
