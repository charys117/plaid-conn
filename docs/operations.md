# 运维说明

## 健康检查

`GET /health` 会检查 API 进程和 PostgreSQL 连接：

```json
{"status":"ok"}
```

Worker 状态通过 `ops.sync_runs` 和 `connector.plaid_items` 检查。长时间处于
`syncing` 的运行会在 15 分钟后被 Worker 标记为中断并重新排队。

## 常见状态

### `login_required`

通常对应 `ITEM_LOGIN_REQUIRED`。在前端点击“重新认证”，完成 Plaid Link
update mode。成功后 Item 会以 `recovery` 原因重新同步。

`PENDING_EXPIRATION` 和 `PENDING_DISCONNECT` 会记录预期到期时间，但不会在
连接仍可同步时提前把 Item 置为 `login_required`。

### `error`

Worker 使用指数退避重试，最大等待时间由
`SYNC_MAX_BACKOFF_MINUTES` 控制。查看：

```sql
SELECT *
FROM ops.sync_runs
WHERE status = 'failed'
ORDER BY started_at DESC
LIMIT 20;
```

Plaid `request_id` 会保存在 `ops.sync_runs.plaid_request_id`，可用于 Plaid
Dashboard/Support 排查。

### Webhook 未收到

确认：

- `PUBLIC_URL` 是 Plaid 可访问的 HTTPS 地址。
- Profile 的 `redirectUri` 和部署域名已在 Plaid Dashboard 登记。
- 反向代理允许 `POST /webhooks/plaid/*`，且保留
  `Plaid-Verification` header 和原始 body。
- `WEBHOOK_ROUTE_SECRET` 没有被意外更换。

即使 Webhook 丢失，周期性同步仍会从持久化 cursor 补齐数据。同步时应用也会
检查 Item 的 Webhook URL，并尝试更新为当前地址。

## 凭证轮换

### Plaid secret

更新 Profile 指向的 secret 环境变量或文件，同时重启 `app` 和 `worker`。

### access token 加密密钥

不要直接更换 `TOKEN_ENCRYPTION_KEY`；旧 access token 会无法解密。当前版本
没有在线密钥轮换命令。需要轮换时应：

1. 备份数据库。
2. 在维护窗口使用旧密钥解密、使用新密钥重新加密全部 Item token。
3. 原子更新数据库后再重启服务。

### Webhook route secret

更换后 Webhook URL 会变化。周期性同步会自动把每个 Item 更新到新 URL，但
切换期间仍应保留 Worker 运行，确保补偿同步。

## 备份与恢复

示例备份：

```bash
pg_dump --format=custom --file=plaid-conn.dump "$DATABASE_URL"
```

示例恢复到空数据库：

```bash
pg_restore --clean --if-exists --no-owner --dbname="$RESTORE_DATABASE_URL" plaid-conn.dump
```

数据库备份包含交易明细和加密 access token，必须按敏感财务数据保护。恢复后
仍需要原 `TOKEN_ENCRYPTION_KEY` 才能继续同步。

## 从早期 Compose 数据卷升级

`docker/postgres-init.sh` 只会在全新 PostgreSQL 数据目录上运行。若现有数据卷
创建于引入 `plaid_app` 账号之前，应先备份，再使用数据库管理员手工创建该账号并
把应用数据库 owner 改为 `plaid_app`；也可以在确认备份可恢复后重建数据卷。仅
修改 `.env` 不会对已有数据卷重新执行初始化脚本。

## Item 移除

界面中的“移除”会：

1. 获取与同步相同的 Item advisory lock。
2. 调用 Plaid `/item/remove`。
3. 清空本地加密 access token。
4. 保留账户、交易、余额快照和同步审计。

如需物理删除历史数据，应在单独备份后通过维护 SQL 完成；应用不会自动清除。
