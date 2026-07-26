# Plaid Connector

一个面向个人使用的 Plaid → PostgreSQL 连接器。它支持配置多套 Plaid
Trial/Production 凭证（Profile），每套凭证连接多个 Plaid Item，并持续把账户、余额和
Transactions 增量同步到 PostgreSQL。

本项目只负责连接管理和数据入库，不包含 Grafana、dashboard、datasource
provisioning 或查询代理。

## 能力

- 多 Plaid Profile，每个 Profile 使用独立 `client_id`、`secret` 和环境。
- 每个 Profile 下连接多个 Item。
- Plaid Link 创建连接和 update mode 重新认证。
- access token 使用 AES-256-GCM 加密后入库，Plaid secret 不进入数据库。
- `/transactions/sync` Item 级 cursor、完整分页、原子提交。
- `added`、`modified`、`removed` 幂等处理。
- `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` 整轮重试。
- 签名 Webhook、手动同步和周期性补偿同步。
- 账户、交易、余额快照、同步审计和原始 JSON 数据。
- 单管理员配置前端。

## 架构

```text
Browser ──> Fastify API ──> PostgreSQL
   │              │
   └─ Plaid Link  └─ Link token / token exchange / Item management

Plaid webhook ──> Fastify API ──> mark Item due
Worker ──> Plaid Transactions API ──> PostgreSQL
```

`app` 和 `worker` 使用相同代码和 Profile 配置。PostgreSQL 不需要暴露公网端口。

## 快速开始

要求：

- Node.js 22 或更高版本
- pnpm 10 或更高版本
- PostgreSQL 15 或更高版本，或者 Docker Compose
- Plaid Dashboard 中的 Sandbox 凭证

复制配置：

```bash
cp .env.example .env
cp config/plaid-profiles.example.json config/plaid-profiles.json
```

生成三个独立的应用 secret，并写入 `.env`：

```bash
openssl rand -base64 32
```

分别用于 `TOKEN_ENCRYPTION_KEY`、`SESSION_SECRET` 和
`WEBHOOK_ROUTE_SECRET`。其中 `TOKEN_ENCRYPTION_KEY` 必须是 base64 编码的
32 字节值。另行设置：

- `ADMIN_PASSWORD`：强管理员密码。
- `POSTGRES_PASSWORD`：PostgreSQL 初始化管理员 `plaid_admin` 的密码。
- `APP_DATABASE_PASSWORD`：应用数据库账号 `plaid_app` 的独立密码。
- `PLAID_PRIMARY_CLIENT_ID`、`PLAID_PRIMARY_SECRET`：Plaid Dashboard 凭证。

两个数据库密码均建议使用 `openssl rand -hex 24` 生成。Compose 不会把
PostgreSQL 端口暴露到宿主机；`plaid_admin` 只用于初始化，应用和 Worker 使用
非超级用户 `plaid_app`。

使用 Docker Compose：

```bash
docker compose up --build
```

然后访问 `http://localhost:3000`。

示例配置默认适用于 Compose，`PUBLIC_URL` 和 Profile `redirectUri` 都是
`http://localhost:3000`。本地前后端分开开发时使用：

```bash
pnpm install
pnpm migrate
pnpm dev
```

开发页面默认位于 `http://localhost:5173`，API 位于
`http://localhost:3000`。此时应将 `.env` 的 `PUBLIC_URL` 改为
`http://localhost:5173`，并把 Profile `redirectUri` 改为
`http://localhost:5173/oauth-return`。

## 配置多个 Plaid Profile

`config/plaid-profiles.json` 只保存凭证引用，不保存 secret：

```json
{
  "profiles": [
    {
      "key": "primary",
      "displayName": "Primary Trial",
      "environment": "sandbox",
      "clientIdEnv": "PLAID_PRIMARY_CLIENT_ID",
      "secretEnv": "PLAID_PRIMARY_SECRET",
      "countryCodes": ["US"],
      "language": "en",
      "redirectUri": "http://localhost:3000/oauth-return",
      "daysRequested": 730,
      "enabled": true
    },
    {
      "key": "secondary",
      "displayName": "Secondary Trial",
      "environment": "sandbox",
      "clientIdEnv": "PLAID_SECONDARY_CLIENT_ID",
      "secretEnv": "PLAID_SECONDARY_SECRET",
      "countryCodes": ["US"],
      "language": "en",
      "redirectUri": "http://localhost:3000/oauth-return",
      "daysRequested": 730,
      "enabled": true
    }
  ]
}
```

也可用 `clientIdFile` 和 `secretFile` 指向 Docker/Kubernetes
挂载的 secret 文件。每个凭证只能选择环境变量或文件中的一种来源。

修改 Profile 后重启 `app` 和 `worker`。已有 Item 的 Profile 不允许更改
`client_id` 或 `environment`；如需切换，先在界面中移除原 Item，再建立新
Profile/Item。Profile 的 Plaid secret 可以原地轮换。不要直接从配置文件删除
仍有 Item 的 Profile；应先设置 `enabled: false`，移除其 Item 后再删除配置。

## Plaid Dashboard 配置

- Sandbox 与 Production Profile 必须分开配置。
- `redirectUri` 必须加入对应 Plaid Team 的 Allowed redirect URIs。
- Production 的 `PUBLIC_URL` 和 `redirectUri` 必须使用 HTTPS。
- Webhook URL 由应用生成，不需要手工拼接。应用会在同步时检查并修复 Item
  上登记的 Webhook URL。
- 本地地址无法接收 Plaid 云端 Webhook，但定时补偿同步仍然工作。

## 同步语义

每个 Item 只维护一个 cursor，不按 Account 拆分。

一次同步会：

1. 获取 PostgreSQL advisory lock，保证同一 Item 不会并发同步或删除。
2. 从数据库中读取旧 cursor。
3. 以 `count=500` 调用 `/transactions/sync`，直到 `has_more=false`。
4. 获取完整账户快照和 Item 状态。
5. 在同一个数据库事务中写账户、交易、余额快照、最终 cursor 和同步审计。
6. 只有事务提交后，旧 cursor 才会被替换。

Webhook 只把 Item 标记为待同步并快速返回，不在 HTTP 请求中执行完整同步。
Worker 默认每 5 秒检查任务，每 240 分钟对所有 Item 做一次补偿同步。

手动“立即同步”只读取 Plaid 已经准备好的增量，不调用可能单独计费的
`/transactions/refresh`。

## 数据库

主要 schema：

- `connector`：Profile、Item、Link session、加密 access token、cursor。
- `finance`：Account、Transaction、余额快照。
- `ops`：同步运行记录和 Webhook 回执。

详细字段和查询入口见 [数据字典](docs/data-dictionary.md)。

Plaid 金额原样存储：

- 正数：资金流出，例如信用卡消费。
- 负数：资金流入，例如退款、还款或存款。

`removed_at IS NULL` 表示交易当前有效。`hidden` 只是账户的查询提示标记，
不会删除或停止该账户的数据同步。

## 常用命令

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm migrate
pnpm dev
pnpm start
pnpm start:worker
```

## 容器镜像

GitHub Actions 会在 `main`、`v*` tag 和手动触发时构建镜像，并在非 PR 事件中
发布到：

```text
ghcr.io/<github-owner>/plaid-conn:latest
```

分支、tag 和 commit SHA 也会生成对应标签。首次发布后，如需匿名拉取镜像，请在
GitHub Package 设置中将其可见性设为 Public。

测试包含：

- token 加密和 AAD 防串换。
- 多 Profile 配置加载。
- 分页 cursor 和 mutation 整轮重试。
- Webhook payload 脱敏。
- API 登录保护。
- 使用嵌入式 PostgreSQL 执行完整迁移并验证约束。

## 生产部署

上线前至少完成：

- 使用随机、独立的三个应用 secret。
- 使用随机、独立的数据库管理员密码和应用数据库密码。
- 将配置 UI 放在 VPN、访问代理或受保护的 HTTPS 域名后。
- 只公开应用端口，不公开 PostgreSQL。
- Plaid Production Profile 使用 HTTPS redirect URI。
- PostgreSQL 数据卷和备份均加密。
- 定期执行 `pg_dump`，并在独立数据库中验证恢复。
- 将 `LOG_LEVEL` 设为 `info` 或更高；日志禁止记录 token 和 Plaid secret。

Compose 默认只将应用绑定到 `127.0.0.1`。Production 应由 HTTPS 反向代理转发
到该端口；设置 `PUBLIC_URL=https://...` 只声明外部 URL，不会让应用自身启用
TLS。Grafana 应使用单独的只读 PostgreSQL 账号，并仅授予所需 schema/table 的
读取权限。

更多故障恢复说明见 [运维说明](docs/operations.md)。
