# Cloudflare 后台部署

后台使用 Cloudflare Workers，数据库使用 D1；同一 Worker 同时提供手机页面及 `/api/*`，无需跨站 Cookie 或放宽跨域策略。GitHub Pages 仍为独立静态试玩。

## 本次配置

- 地址：https://sheep-fortune-game.lingolayer.workers.dev/
- 发布日期：2026-09-18；规则版本：`server-wheel-77-v13-20260917`。
- Wrangler 配置：项目根目录 `wrangler.json`。
- 数据库绑定：`DB`；名称：`sheep-fortune-game-db`；创建位置偏好：APAC。
- 独立构建：`npm run build:cloudflare`，不依赖 Sites 托管配置。
- `LIVE_PAYMENTS_ENABLED=false`：测试币可玩，真实币充值、转盘及提现保持关闭。
- 已部署的推荐接口保留“钱包参加至少一局后才能生成邀请码”的规则。测试币不产生真实推荐返佣；后台部署成功不等于真实返佣已开放。
- 公开 Worker 不信任外部请求的 `oai-authenticated-user-*` 头，试玩会话通过服务端 Cookie 隔离。
- 本机管理密钥保存在被 Git 忽略的 `.data/cloudflare-ops.key`（仅本机用户可读写），线上保存为 Workers Secret；自动上传时不要在密钥末尾附加换行。

## 发布步骤

1. `npm ci`，`npx wrangler login`，`npx wrangler whoami` 确认账户。
2. 新账户需执行 `npx wrangler d1 create sheep-fortune-game-db --location apac`，将返回的数据库 ID 与账户 ID 配入 `wrangler.json`；已有库不可重复创建。
3. `npm test`。
4. `npm run cf:migrate`：按顺序应用已有的 Drizzle SQL 文件，Wrangler 记录已应用迁移；升级前先备份。
5. `npm run cf:deploy`。
6. 管理密钥通过 `npx wrangler secret put OPS_AUTH_KEY` 写入，至少32个随机字符；不得写入 Git 或前端。
7. `node scripts/smoke-backend.mjs https://实际发布域名`。本脚本仅用于真实资金关闭的环境，创建少量试玩记录及未充值测试钱包。设置 `OPS_KEY_FILE` 后会同时检查服务端账本。

## 验证和后续

`GET /api/health` 返回数据库可用性、真实资金开关、规则版本。会话、余额、游戏记录、金元宝及推荐关系均存入 D1。

真实资金启用还需配置托管合约、RPC 与服务端签名人并完成链上充值提现验证。此部署不包含主网合约发布，不改概率、销毁或返佣比例，也未承诺100人同时结算的性能；上线人数扩大前应对云端同一奖池写入进行压测。
