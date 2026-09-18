# Cloudflare 后台部署

后台使用 Cloudflare Workers，数据库使用 D1；同一 Worker 同时提供手机页面及 `/api/*`，无需跨站 Cookie 或放宽跨域策略。GitHub Pages 仍为独立静态试玩。

首页统一使用 GitHub 上的“红运当头”界面：`public/red/index.html` 是共同模板，服务端构建由 `scripts/frontend-entry.mjs` 处理入口链接并生成根目录首页；本地预览同样使用此模板。Cloudflare 继续调用真实后台 API，不带 GitHub 静态试玩的本地结算标记。

## 本次配置

- 游戏域名：https://dapp.yangnian.xyz/
- 原始入口：https://sheep-fortune-game.lingolayer.workers.dev/（保留）
- 发布日期：2026-09-18；规则版本：`server-wheel-77-v13-20260917`。
- Wrangler 配置：项目根目录 `wrangler.json`。
- 数据库绑定：`DB`；名称：`sheep-fortune-game-db`；创建位置偏好：APAC。
- 独立构建：`npm run build:cloudflare`，不依赖 Sites 托管配置。
- `LIVE_PAYMENTS_ENABLED=false`：公开真实币充值、转盘及提现关闭。`PAYMENTS_VALIDATION_ENABLED=true` 时管理员及服务端固定名单内仍启用白名单的地址可操作；名单通过 `PAYMENTS_VALIDATION_WALLETS` secret 配置。
- 已部署的推荐接口保留“钱包参加至少一局后才能生成邀请码”的规则。测试币不产生真实推荐返佣；后台部署成功不等于真实返佣已开放。
- 公开 Worker 不信任外部请求的 `oai-authenticated-user-*` 头，试玩会话通过服务端 Cookie 隔离。
- 本机管理密钥保存在被 Git 忽略的 `.data/cloudflare-ops.key`（仅本机用户可读写），线上保存为 Workers Secret；自动上传时不要在密钥末尾附加换行。

## 发布步骤

`dapp.yangnian.xyz` 通过 Cloudflare Dashboard 的 Worker Custom Domain 绑定至现有 `sheep-fortune-game`，同一 D1 数据库继续保存玩家余额和推荐关系。域名托管于 Namecheap，DNS 由 Cloudflare 管理（`kate.ns.cloudflare.com` / `major.ns.cloudflare.com`）；区域 ID 为 `74d3401fa652ce45b6d3caa38c69f946`。

域名绑定由 Dashboard 管理，`wrangler.json` 不声明 `routes`。当前锁定的 Wrangler 4.134.0 在无自定义域名配置时不会重写远程 Custom Domains；后续增加 `routes` 或升级部署工具时需同时保留这个绑定，并在发布后检查新域名的 `/api/health`。首次在新域名访问需重新连接钱包签名，账户按钱包地址识别，无需重新充值。邀请链接使用当前页面域名；GitHub 静态页面跳转到新域名时保留有效的 `ref` 参数。

1. `npm ci`，`npx wrangler login`，`npx wrangler whoami` 确认账户。
2. 新账户需执行 `npx wrangler d1 create sheep-fortune-game-db --location apac`，将返回的数据库 ID 与账户 ID 配入 `wrangler.json`；已有库不可重复创建。
3. `npm test`。
4. `npm run cf:migrate`：按顺序应用已有的 Drizzle SQL 文件，Wrangler 记录已应用迁移；升级前先备份。
5. `npm run cf:deploy`。
6. 管理密钥通过 `npx wrangler secret put OPS_AUTH_KEY` 写入，至少32个随机字符；不得写入 Git 或前端。
7. `node scripts/smoke-backend.mjs https://实际发布域名`。本脚本仅用于真实资金关闭的环境，创建少量试玩记录及未充值测试钱包。设置 `OPS_KEY_FILE` 后会同时检查服务端账本。

## 验证和后续

`GET /api/health` 返回数据库可用性、真实资金开关、规则版本。会话、余额、游戏记录、金元宝及推荐关系均存入 D1。

钱包连接统一检查 BSC 主网（56 / 0x38）。其他网络自动发起切链请求；4902 未添加网络时，使用 BNB Chain 官方 RPC 请求添加，再检查并切换。只有确认网络、账户正确才签名登录，拒绝或切换未生效会停止流程。手机钱包仍需用户确认弹窗。已登录时换到其他链会暂停新操作，并提供切回 BSC 的按钮；正式账户写操作、充值与提现交易提交前也重新核对网络和钱包。

真实资金启用还需配置托管合约、RPC 与服务端签名人并完成链上充值提现验证。此部署不包含主网合约发布，不改概率、销毁或返佣比例，也未承诺100人同时结算的性能；上线人数扩大前应对云端同一奖池写入进行压测。
