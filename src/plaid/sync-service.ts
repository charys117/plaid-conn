import { randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  AccountBase,
  RemovedTransaction,
  Transaction
} from "plaid";
import type { AppConfig } from "../config/env";
import { upsertAccounts } from "../db/accounts";
import {
  plaidTokenAssociatedData,
  TokenCipher
} from "../security/token-cipher";
import { isLoginRequired, parsePlaidError } from "./errors";
import type {
  PlaidProfileRegistry,
  RegisteredPlaidProfile
} from "./profile-registry";

export type SyncTrigger =
  | "initial"
  | "webhook"
  | "scheduled"
  | "manual"
  | "recovery";

type SyncItemRow = {
  id: string;
  profile_id: string;
  plaid_item_id: string;
  access_token_encrypted: string;
  sync_cursor: string | null;
  sync_failure_count: number;
};

type CollectedSync = {
  added: Transaction[];
  modified: Transaction[];
  removed: RemovedTransaction[];
  cursor: string;
  pages: number;
  requestId?: string;
};

const MAX_PAGES = 100;
const MAX_MUTATION_RESTARTS = 5;

export class PlaidSyncService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly profiles: PlaidProfileRegistry,
    private readonly cipher: TokenCipher,
    private readonly config: AppConfig
  ) {}

  async recoverInterruptedRuns(): Promise<void> {
    await this.pool.query(
      `DELETE FROM connector.link_sessions
       WHERE COALESCE(consumed_at, expires_at) < now() - interval '7 days'`
    );
    await this.pool.query(
      `UPDATE ops.sync_runs
       SET status = 'failed',
           error_code = 'WORKER_INTERRUPTED',
           error_message = 'Worker stopped before the sync completed',
           finished_at = now()
       WHERE status = 'running'
         AND started_at < now() - interval '15 minutes'`
    );
    await this.pool.query(
      `UPDATE connector.plaid_items
       SET status = 'error',
           sync_requested_at = COALESCE(sync_requested_at, now()),
           sync_requested_trigger = COALESCE(sync_requested_trigger, 'recovery'),
           next_sync_attempt_at = now(),
           last_error_code = 'WORKER_INTERRUPTED',
           last_error_message = 'Previous sync was interrupted',
           updated_at = now()
       WHERE status = 'syncing'
         AND last_sync_started_at < now() - interval '15 minutes'`
    );
  }

  async findDueItems(limit = 10): Promise<
    Array<{ id: string; trigger: SyncTrigger }>
  > {
    const result = await this.pool.query<{
      id: string;
      sync_requested_trigger: SyncTrigger | null;
    }>(
      `SELECT i.id, i.sync_requested_trigger
       FROM connector.plaid_items i
       JOIN connector.plaid_profiles p ON p.id = i.profile_id
       WHERE p.enabled = true
         AND i.status IN ('active', 'error')
         AND i.access_token_encrypted IS NOT NULL
         AND (i.next_sync_attempt_at IS NULL OR i.next_sync_attempt_at <= now())
         AND (
           i.sync_requested_at IS NOT NULL
           OR i.last_sync_succeeded_at IS NULL
           OR i.last_sync_succeeded_at <=
             now() - make_interval(mins => $1::integer)
         )
       ORDER BY
         i.sync_requested_at NULLS LAST,
         i.last_sync_succeeded_at NULLS FIRST,
         i.created_at
       LIMIT $2`,
      [this.config.syncReconcileIntervalMinutes, limit]
    );

    return result.rows.map((row) => ({
      id: row.id,
      trigger: row.sync_requested_trigger ?? "scheduled"
    }));
  }

  async syncItem(itemId: string, trigger: SyncTrigger): Promise<boolean> {
    const lockClient = await this.pool.connect();
    let locked = false;

    try {
      const lock = await lockClient.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [itemId]
      );
      locked = lock.rows[0]?.locked ?? false;
      if (!locked) return false;

      const item = await this.loadItem(itemId);
      const runId = randomUUID();

      await lockClient.query("BEGIN");
      try {
        const started = await lockClient.query<{ id: string }>(
          `UPDATE connector.plaid_items i
           SET status = 'syncing',
               last_sync_started_at = now(),
               sync_requested_at = null,
               sync_requested_trigger = null,
               updated_at = now()
           FROM connector.plaid_profiles p
           WHERE i.id = $1
             AND p.id = i.profile_id
             AND p.enabled = true
             AND i.status IN ('active', 'error', 'syncing')
           RETURNING i.id`,
          [itemId]
        );
        if (!started.rows[0]) {
          await lockClient.query("ROLLBACK");
          return false;
        }
        await lockClient.query(
          `INSERT INTO ops.sync_runs (
             id, item_id, trigger, status, cursor_before
           ) VALUES ($1, $2, $3, 'running', $4)`,
          [runId, itemId, trigger, item.sync_cursor]
        );
        await lockClient.query("COMMIT");
      } catch (error) {
        await lockClient.query("ROLLBACK");
        throw error;
      }

      try {
        const profile = this.profiles.getById(item.profile_id);
        if (!profile.enabled) {
          throw new Error(`Plaid profile ${profile.key} is disabled`);
        }
        const accessToken = this.cipher.decrypt(
          item.access_token_encrypted,
          plaidTokenAssociatedData(profile.key, item.plaid_item_id)
        );
        const collected = await this.fetchAllPages(
          profile,
          accessToken,
          item.sync_cursor
        );
        const accountSnapshot = await profile.client.accountsGet({
          access_token: accessToken
        });
        let lastPlaidUpdate: string | null = null;

        try {
          const itemStatus = await profile.client.itemGet({
            access_token: accessToken
          });
          lastPlaidUpdate =
            itemStatus.data.status?.transactions?.last_successful_update ?? null;
          const expectedWebhook =
            `${this.config.publicUrl}/webhooks/plaid/${profile.webhookRouteToken}`;
          if (itemStatus.data.item.webhook !== expectedWebhook) {
            await profile.client.itemWebhookUpdate({
              access_token: accessToken,
              webhook: expectedWebhook
            });
          }
        } catch {
          // Status freshness is useful metadata but must not invalidate transaction data.
        }

        await this.commitCollectedSync({
          runId,
          itemId,
          collected,
          accounts: accountSnapshot.data.accounts,
          lastPlaidUpdate,
          institutionId: accountSnapshot.data.item.institution_id ?? null,
          institutionName: accountSnapshot.data.item.institution_name ?? null,
          consentExpirationAt:
            accountSnapshot.data.item.consent_expiration_time ?? null
        });
        return true;
      } catch (error) {
        await this.recordFailure(runId, item, trigger, error);
        throw error;
      }
    } finally {
      if (locked) {
        await lockClient.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [itemId]
        );
      }
      lockClient.release();
    }
  }

  private async fetchAllPages(
    profile: RegisteredPlaidProfile,
    accessToken: string,
    startingCursor: string | null
  ): Promise<CollectedSync> {
    let mutationRestarts = 0;

    for (;;) {
      let cursor = startingCursor ?? undefined;
      const added: Transaction[] = [];
      const modified: Transaction[] = [];
      const removed: RemovedTransaction[] = [];
      let pages = 0;
      let requestId: string | undefined;

      try {
        for (;;) {
          pages += 1;
          if (pages > MAX_PAGES) {
            throw new Error(`Transactions sync exceeded ${MAX_PAGES} pages`);
          }

          const response = await profile.client.transactionsSync({
            access_token: accessToken,
            ...(cursor !== undefined ? { cursor } : {}),
            count: 500,
            options: { include_original_description: true }
          });
          const page = response.data;
          added.push(...page.added);
          modified.push(...page.modified);
          removed.push(...page.removed);
          cursor = page.next_cursor;
          requestId = page.request_id;

          if (!page.has_more) {
            return {
              added,
              modified,
              removed,
              cursor: page.next_cursor,
              pages,
              ...(requestId ? { requestId } : {})
            };
          }
        }
      } catch (error) {
        const parsed = parsePlaidError(error);
        if (
          parsed.errorCode !==
            "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" ||
          mutationRestarts >= MAX_MUTATION_RESTARTS
        ) {
          throw error;
        }
        mutationRestarts += 1;
      }
    }
  }

  private async commitCollectedSync(input: {
    runId: string;
    itemId: string;
    collected: CollectedSync;
    accounts: AccountBase[];
    lastPlaidUpdate: string | null;
    institutionId: string | null;
    institutionName: string | null;
    consentExpirationAt: string | null;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE finance.accounts
         SET active = false, updated_at = now()
         WHERE item_id = $1`,
        [input.itemId]
      );
      const accountIds = await upsertAccounts(
        client,
        input.itemId,
        input.accounts
      );

      const existingAccounts = await client.query<{
        id: string;
        plaid_account_id: string;
      }>(
        `SELECT id, plaid_account_id
         FROM finance.accounts
         WHERE item_id = $1`,
        [input.itemId]
      );
      for (const account of existingAccounts.rows) {
        accountIds.set(account.plaid_account_id, account.id);
      }

      for (const transaction of input.collected.added) {
        await this.upsertTransaction(
          client,
          input.itemId,
          accountIds,
          transaction
        );
      }
      for (const transaction of input.collected.modified) {
        await this.upsertTransaction(
          client,
          input.itemId,
          accountIds,
          transaction
        );
      }
      for (const transaction of input.collected.removed) {
        await client.query(
          `UPDATE finance.transactions
           SET removed_at = COALESCE(removed_at, now()),
               updated_at = now()
           WHERE item_id = $1
             AND plaid_transaction_id = $2`,
          [input.itemId, transaction.transaction_id]
        );
      }

      for (const account of input.accounts) {
        const accountId = accountIds.get(account.account_id);
        if (!accountId) continue;
        await client.query(
          `INSERT INTO finance.account_balance_snapshots (
             account_id, sync_run_id, current_balance, available_balance,
             credit_limit, iso_currency_code, unofficial_currency_code
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (account_id, sync_run_id) DO NOTHING`,
          [
            accountId,
            input.runId,
            account.balances.current,
            account.balances.available,
            account.balances.limit,
            account.balances.iso_currency_code,
            account.balances.unofficial_currency_code
          ]
        );
      }

      await client.query(
        `UPDATE connector.plaid_items
         SET sync_cursor = $2,
             status = CASE
               WHEN status = 'syncing' THEN 'active'
               ELSE status
             END,
             institution_id = $4,
             institution_name = $5,
             consent_expiration_at = $6,
             next_sync_attempt_at = CASE
               WHEN status = 'syncing' THEN null
               ELSE next_sync_attempt_at
             END,
             sync_failure_count = CASE
               WHEN status = 'syncing' THEN 0
               ELSE sync_failure_count
             END,
             last_sync_succeeded_at = now(),
             last_plaid_update_at = COALESCE($3::timestamptz, last_plaid_update_at),
             last_error_code = CASE
               WHEN status = 'syncing' THEN null
               ELSE last_error_code
             END,
             last_error_message = CASE
               WHEN status = 'syncing' THEN null
               ELSE last_error_message
             END,
             updated_at = now()
         WHERE id = $1`,
        [
          input.itemId,
          input.collected.cursor,
          input.lastPlaidUpdate,
          input.institutionId,
          input.institutionName,
          input.consentExpirationAt
        ]
      );
      await client.query(
        `UPDATE ops.sync_runs
         SET status = 'succeeded',
             cursor_after = $2,
             added_count = $3,
             modified_count = $4,
             removed_count = $5,
             page_count = $6,
             plaid_request_id = $7,
             finished_at = now()
         WHERE id = $1`,
        [
          input.runId,
          input.collected.cursor,
          input.collected.added.length,
          input.collected.modified.length,
          input.collected.removed.length,
          input.collected.pages,
          input.collected.requestId ?? null
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async upsertTransaction(
    client: pg.PoolClient,
    itemId: string,
    accountIds: Map<string, string>,
    transaction: Transaction
  ): Promise<void> {
    const accountId = accountIds.get(transaction.account_id);
    if (!accountId) {
      throw new Error(
        `Transaction ${transaction.transaction_id} references unknown account ${transaction.account_id}`
      );
    }

    const category = transaction.personal_finance_category;
    await client.query(
      `INSERT INTO finance.transactions (
         item_id, account_id, plaid_transaction_id, amount,
         iso_currency_code, unofficial_currency_code,
         transaction_date, authorized_date,
         transaction_datetime, authorized_datetime,
         name, merchant_name, original_description, payment_channel,
         pending, pending_transaction_id,
         category_primary, category_detailed, category_confidence,
         website, logo_url, location, counterparties, raw_payload
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19,
         $20, $21, $22::jsonb, $23::jsonb, $24::jsonb
       )
       ON CONFLICT (item_id, plaid_transaction_id) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         amount = EXCLUDED.amount,
         iso_currency_code = EXCLUDED.iso_currency_code,
         unofficial_currency_code = EXCLUDED.unofficial_currency_code,
         transaction_date = EXCLUDED.transaction_date,
         authorized_date = EXCLUDED.authorized_date,
         transaction_datetime = EXCLUDED.transaction_datetime,
         authorized_datetime = EXCLUDED.authorized_datetime,
         name = EXCLUDED.name,
         merchant_name = EXCLUDED.merchant_name,
         original_description = EXCLUDED.original_description,
         payment_channel = EXCLUDED.payment_channel,
         pending = EXCLUDED.pending,
         pending_transaction_id = EXCLUDED.pending_transaction_id,
         category_primary = EXCLUDED.category_primary,
         category_detailed = EXCLUDED.category_detailed,
         category_confidence = EXCLUDED.category_confidence,
         website = EXCLUDED.website,
         logo_url = EXCLUDED.logo_url,
         location = EXCLUDED.location,
         counterparties = EXCLUDED.counterparties,
         raw_payload = EXCLUDED.raw_payload,
         removed_at = null,
         updated_at = now()`,
      [
        itemId,
        accountId,
        transaction.transaction_id,
        transaction.amount,
        transaction.iso_currency_code,
        transaction.unofficial_currency_code,
        transaction.date,
        transaction.authorized_date,
        transaction.datetime,
        transaction.authorized_datetime,
        transaction.name,
        transaction.merchant_name ?? null,
        transaction.original_description ?? null,
        transaction.payment_channel,
        transaction.pending,
        transaction.pending_transaction_id,
        category?.primary ?? null,
        category?.detailed ?? null,
        category?.confidence_level ?? null,
        transaction.website ?? null,
        transaction.logo_url ?? null,
        JSON.stringify(transaction.location),
        JSON.stringify(transaction.counterparties ?? []),
        JSON.stringify(transaction)
      ]
    );
  }

  private async loadItem(itemId: string): Promise<SyncItemRow> {
    const result = await this.pool.query<SyncItemRow>(
      `SELECT
         i.id, i.profile_id, i.plaid_item_id, i.access_token_encrypted,
         i.sync_cursor, i.sync_failure_count
       FROM connector.plaid_items i
       JOIN connector.plaid_profiles p ON p.id = i.profile_id
       WHERE i.id = $1
         AND p.enabled = true
         AND i.status IN ('active', 'error', 'syncing')
         AND i.access_token_encrypted IS NOT NULL`,
      [itemId]
    );
    const item = result.rows[0];
    if (!item) throw new Error(`Syncable Item not found: ${itemId}`);
    return item;
  }

  private async recordFailure(
    runId: string,
    item: SyncItemRow,
    trigger: SyncTrigger,
    error: unknown
  ): Promise<void> {
    const parsed = parsePlaidError(error);
    const nextFailureCount = item.sync_failure_count + 1;
    const backoffMinutes = Math.min(
      2 ** Math.min(nextFailureCount, 16),
      this.config.syncMaxBackoffMinutes
    );
    const status = isLoginRequired(parsed) ? "login_required" : "error";

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE connector.plaid_items
         SET status = $2,
             sync_failure_count = $3,
             next_sync_attempt_at = CASE
               WHEN $2 = 'login_required' THEN null
               ELSE now() + make_interval(mins => $4::integer)
             END,
             sync_requested_at = COALESCE(sync_requested_at, now()),
             sync_requested_trigger = COALESCE(sync_requested_trigger, $7),
             last_error_code = $5,
             last_error_message = $6,
             updated_at = now()
         WHERE id = $1`,
        [
          item.id,
          status,
          nextFailureCount,
          backoffMinutes,
          parsed.errorCode,
          parsed.message.slice(0, 2000),
          trigger
        ]
      );
      await client.query(
        `UPDATE ops.sync_runs
         SET status = 'failed',
             error_code = $2,
             error_message = $3,
             plaid_request_id = $4,
             finished_at = now()
         WHERE id = $1`,
        [
          runId,
          parsed.errorCode,
          parsed.message.slice(0, 2000),
          parsed.requestId ?? null
        ]
      );
      await client.query("COMMIT");
    } catch (recordError) {
      await client.query("ROLLBACK");
      throw new AggregateError(
        [error, recordError],
        "Sync failed and failure state could not be recorded"
      );
    } finally {
      client.release();
    }
  }

}
