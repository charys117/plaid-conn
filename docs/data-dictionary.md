# 数据字典

本项目不提供展示层。SQL 消费方应直接查询 `finance` schema，并通过
`connector.plaid_items` 和 `connector.plaid_profiles` 获取 Profile、机构和
Item 维度。

## 关系

```text
connector.plaid_profiles
  └─ connector.plaid_items
       ├─ finance.accounts
       │    └─ finance.account_balance_snapshots
       ├─ finance.transactions
       └─ ops.sync_runs
```

## `connector.plaid_profiles`

一套 Plaid 开发者凭证及环境的元数据。

重要字段：

- `profile_key`：稳定、可读的本地标识。
- `environment`：`sandbox` 或 `production`。
- `client_id`：用于检测配置漂移；Plaid secret 永不写入数据库。
- `country_codes`、`language`、`days_requested`：Link 初始化参数。
- `enabled`：禁用后其 Item 不再进入 Worker 调度。

## `connector.plaid_items`

一次金融机构登录连接。

重要字段：

- `profile_id`：使用哪套 Plaid 凭证。
- `plaid_item_id`：Plaid Item ID。
- `access_token_encrypted`：AES-256-GCM 密文，不能提供给 SQL 消费方。
- `sync_cursor`：Item 级 `/transactions/sync` cursor。
- `status`：`active`、`syncing`、`login_required`、`error`、`disabled`、
  `removed`。
- `sync_requested_at`、`sync_requested_trigger`：Worker 调度信号。
- `last_sync_succeeded_at`：本地成功提交时间。
- `last_plaid_update_at`：Plaid 最近成功访问机构的时间。
- `last_error_code`、`last_error_message`：最近一次同步或 Item 错误。

移除 Item 时会调用 Plaid `/item/remove`，清空本地 access token，并保留已同步
的历史财务数据。

## `finance.accounts`

Plaid Item 下的账户。

- `plaid_account_id`：Plaid Account ID。
- `persistent_account_id`：Plaid 可用时提供的跨 Item 稳定标识。
- `type`、`subtype`：例如 `credit / credit card`。
- `current_balance`、`available_balance`、`credit_limit`：最近缓存余额。
- `hidden`：供查询方决定是否展示；不影响同步。
- `active`：本次 `/accounts/get` 是否仍返回该账户。
- `raw_payload`：最近一次完整 Plaid Account JSON。

普通 Transactions/Accounts 返回的余额可能是缓存值，不应当作实时余额。

## `finance.transactions`

标准化交易数据。

- `plaid_transaction_id`：Item 内唯一。
- `amount`：`numeric(20,6)`；正数为流出，负数为流入。
- `transaction_date`：交易入账日或 pending 发生日。
- `authorized_date`：授权日期，可用时更接近实际消费日期。
- `pending`、`pending_transaction_id`：pending 与 posted 关联信息。
- `category_primary`、`category_detailed`、`category_confidence`：
  Plaid Personal Finance Category。
- `removed_at`：Plaid 将交易报告为 removed 时设置。
- `raw_payload`：最近一次完整 Plaid Transaction JSON。

查询当前交易：

```sql
SELECT *
FROM finance.transactions
WHERE removed_at IS NULL;
```

查询消费时不要对不同币种直接求和：

```sql
SELECT
  iso_currency_code,
  date_trunc('month', transaction_date)::date AS month,
  sum(amount) FILTER (WHERE amount > 0) AS spending,
  sum(-amount) FILTER (WHERE amount < 0) AS inflow_or_refund
FROM finance.transactions
WHERE removed_at IS NULL
  AND pending = false
GROUP BY iso_currency_code, month
ORDER BY month;
```

## `finance.account_balance_snapshots`

每次成功同步时的账户余额快照。通过 `sync_run_id` 可追溯采集批次。

## `ops.sync_runs`

同步审计记录：

- `trigger`：`initial`、`webhook`、`scheduled`、`manual`、`recovery`。
- `status`：`running`、`succeeded`、`failed`、`skipped`。
- `cursor_before`、`cursor_after`。
- `added_count`、`modified_count`、`removed_count`、`page_count`。
- `plaid_request_id`、错误码和错误消息。

## `ops.webhook_receipts`

已验证 Webhook 的审计回执。payload 会递归移除 token/secret 字段。相同
Profile 和 body SHA-256 共用一条回执，但每次已验证投递仍会重新执行幂等的状态
更新，避免一次中途失败导致后续重试被错误跳过。

SQL 消费账号通常不需要访问 `connector.link_sessions`、
`connector.plaid_items.access_token_encrypted` 或 `ops.webhook_receipts`。
