import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config/env";
import { TokenCipher } from "../security/token-cipher";
import { PlaidItemService } from "./item-service";
import type {
  PlaidProfileRegistry,
  RegisteredPlaidProfile
} from "./profile-registry";
import { PlaidSyncService } from "./sync-service";

describe("PlaidSyncService database integration", () => {
  it("atomically persists accounts, transactions, snapshots, and the terminal cursor", async () => {
    const database = await PGlite.create();
    try {
      await database.exec(
        await readFile(resolve("migrations/001_initial.sql"), "utf8")
      );
      await database.exec(
        await readFile(
          resolve("migrations/002_remove_config_fingerprint.sql"),
          "utf8"
        )
      );

      const profileId = "10000000-0000-4000-8000-000000000001";
      const itemId = "20000000-0000-4000-8000-000000000002";
      const plaidItemId = "item-sandbox-integration";
      const profileKey = "integration";
      const cipher = new TokenCipher(randomBytes(32));
      const encryptedToken = cipher.encrypt(
        "access-sandbox-integration",
        `plaid-access-token:${profileKey}:${plaidItemId}`
      );

      await database.query(
        `INSERT INTO connector.plaid_profiles (
           id, profile_key, display_name, environment, client_id,
           country_codes, language, days_requested, enabled
         ) VALUES ($1, $2, 'Integration', 'sandbox', 'client-id',
           ARRAY['US'], 'en', 730, true)`,
        [profileId, profileKey]
      );
      await database.query(
        `INSERT INTO connector.plaid_items (
           id, profile_id, plaid_item_id, institution_id, institution_name,
           access_token_encrypted, status, sync_requested_at,
           sync_requested_trigger
         ) VALUES ($1, $2, $3, 'ins_test', 'Test Bank', $4, 'active',
           now(), 'initial')`,
        [itemId, profileId, plaidItemId, encryptedToken]
      );

      const account = {
        account_id: "account-integration",
        persistent_account_id: "persistent-integration",
        name: "Rewards Card",
        official_name: "Rewards Credit Card",
        mask: "4242",
        type: "credit",
        subtype: "credit card",
        balances: {
          current: 123.45,
          available: 876.55,
          limit: 1000,
          iso_currency_code: "USD",
          unofficial_currency_code: null
        }
      };
      const transaction = {
        account_id: account.account_id,
        transaction_id: "transaction-integration",
        amount: 42.5,
        iso_currency_code: "USD",
        unofficial_currency_code: null,
        date: "2026-07-24",
        authorized_date: "2026-07-23",
        datetime: "2026-07-24T12:00:00Z",
        authorized_datetime: "2026-07-23T12:00:00Z",
        name: "COFFEE SHOP",
        merchant_name: "Coffee Shop",
        original_description: "COFFEE SHOP 001",
        payment_channel: "in store",
        pending: false,
        pending_transaction_id: null,
        personal_finance_category: {
          primary: "FOOD_AND_DRINK",
          detailed: "FOOD_AND_DRINK_COFFEE",
          confidence_level: "VERY_HIGH"
        },
        location: {},
        counterparties: [],
        payment_meta: {},
        account_owner: null,
        transaction_code: null
      };
      const expectedWebhook =
        "https://connector.example/webhooks/plaid/webhook-route";
      const client = {
        transactionsSync: vi.fn().mockResolvedValue({
          data: {
            transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
            accounts: [account],
            added: [transaction],
            modified: [],
            removed: [],
            next_cursor: "terminal-cursor",
            has_more: false,
            request_id: "request-sync"
          }
        }),
        accountsGet: vi.fn().mockImplementation(async () => {
          // Simulate a webhook arriving while this sync is in flight.
          await database.query(
            `UPDATE connector.plaid_items
             SET sync_requested_at = now(),
                 sync_requested_trigger = 'webhook'
             WHERE id = $1`,
            [itemId]
          );
          return {
            data: {
              accounts: [account],
              item: {
                item_id: plaidItemId,
                institution_id: "ins_test",
                institution_name: "Test Bank Updated",
                consent_expiration_time: null
              },
              request_id: "request-accounts"
            }
          };
        }),
        itemGet: vi.fn().mockResolvedValue({
          data: {
            item: { webhook: expectedWebhook },
            status: {
              transactions: {
                last_successful_update: "2026-07-25T00:00:00Z"
              }
            },
            request_id: "request-item"
          }
        }),
        itemWebhookUpdate: vi.fn()
      };
      const profile = {
        id: profileId,
        key: profileKey,
        enabled: true,
        webhookRouteToken: "webhook-route",
        client
      } as unknown as RegisteredPlaidProfile;
      const profiles = {
        getById: () => profile
      } as unknown as PlaidProfileRegistry;

      const pool = pglitePool(database);
      const service = new PlaidSyncService(
        pool as never,
        profiles,
        cipher,
        {
          publicUrl: "https://connector.example",
          syncMaxBackoffMinutes: 60
        } as AppConfig
      );

      await expect(service.syncItem(itemId, "initial")).resolves.toBe(true);

      const storedItem = await database.query<{
        sync_cursor: string;
        status: string;
        institution_name: string;
        sync_requested_trigger: string | null;
      }>(
        `SELECT sync_cursor, status, institution_name, sync_requested_trigger
         FROM connector.plaid_items
         WHERE id = $1`,
        [itemId]
      );
      expect(storedItem.rows[0]).toMatchObject({
        sync_cursor: "terminal-cursor",
        status: "active",
        institution_name: "Test Bank Updated",
        sync_requested_trigger: "webhook"
      });

      const storedTransactions = await database.query<{
        plaid_transaction_id: string;
        amount: string;
        category_primary: string;
        removed_at: string | null;
      }>(
        `SELECT plaid_transaction_id, amount::text, category_primary, removed_at
         FROM finance.transactions`
      );
      expect(storedTransactions.rows).toEqual([
        {
          plaid_transaction_id: "transaction-integration",
          amount: "42.500000",
          category_primary: "FOOD_AND_DRINK",
          removed_at: null
        }
      ]);

      const counts = await database.query<{
        snapshots: number;
        successful_runs: number;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM finance.account_balance_snapshots) AS snapshots,
           (SELECT count(*)::integer FROM ops.sync_runs WHERE status = 'succeeded') AS successful_runs`
      );
      expect(counts.rows[0]).toEqual({
        snapshots: 1,
        successful_runs: 1
      });
      expect(client.itemWebhookUpdate).not.toHaveBeenCalled();

      const itemService = new PlaidItemService(
        pool as never,
        profiles,
        cipher,
        {
          plaidClientName: "Integration",
          publicUrl: "https://connector.example"
        } as AppConfig
      );
      const listedItems = (await itemService.listItems()) as Array<{
        institutionName: string;
        accounts: Array<{ name: string; currentBalance: string }>;
      }>;
      expect(listedItems[0]).toMatchObject({
        institutionName: "Test Bank Updated",
        accounts: [
          {
            name: "Rewards Card",
            currentBalance: "123.450000"
          }
        ]
      });
    } finally {
      await database.close();
    }
  });

  it("records backoff instead of hot-looping when an access token cannot be decrypted", async () => {
    const database = await PGlite.create();
    try {
      await database.exec(
        await readFile(resolve("migrations/001_initial.sql"), "utf8")
      );
      await database.exec(
        await readFile(
          resolve("migrations/002_remove_config_fingerprint.sql"),
          "utf8"
        )
      );
      const profileId = "30000000-0000-4000-8000-000000000003";
      const itemId = "40000000-0000-4000-8000-000000000004";
      const plaidItemId = "item-bad-key";
      const encrypted = new TokenCipher(randomBytes(32)).encrypt(
        "access-token",
        `plaid-access-token:bad-key:${plaidItemId}`
      );
      await database.query(
        `INSERT INTO connector.plaid_profiles (
           id, profile_key, display_name, environment, client_id,
           country_codes, language, days_requested, enabled
         ) VALUES ($1, 'bad-key', 'Bad key', 'sandbox', 'client-id',
           ARRAY['US'], 'en', 730, true)`,
        [profileId]
      );
      await database.query(
        `INSERT INTO connector.plaid_items (
           id, profile_id, plaid_item_id, access_token_encrypted, status,
           sync_requested_at, sync_requested_trigger
         ) VALUES ($1, $2, $3, $4, 'active', now(), 'manual')`,
        [itemId, profileId, plaidItemId, encrypted]
      );

      const profile = {
        id: profileId,
        key: "bad-key",
        enabled: true,
        client: {}
      } as unknown as RegisteredPlaidProfile;
      const service = new PlaidSyncService(
        pglitePool(database) as never,
        { getById: () => profile } as unknown as PlaidProfileRegistry,
        new TokenCipher(randomBytes(32)),
        { syncMaxBackoffMinutes: 60 } as AppConfig
      );

      await expect(service.syncItem(itemId, "manual")).rejects.toThrow();
      const state = await database.query<{
        status: string;
        next_sync_attempt_at: string | null;
        sync_requested_at: string | null;
        run_status: string;
      }>(
        `SELECT i.status, i.next_sync_attempt_at, i.sync_requested_at,
                r.status AS run_status
         FROM connector.plaid_items i
         JOIN ops.sync_runs r ON r.item_id = i.id
         WHERE i.id = $1`,
        [itemId]
      );
      expect(state.rows[0]).toMatchObject({
        status: "error",
        run_status: "failed"
      });
      expect(state.rows[0]?.next_sync_attempt_at).not.toBeNull();
      expect(state.rows[0]?.sync_requested_at).not.toBeNull();
    } finally {
      await database.close();
    }
  });
});

function pglitePool(database: PGlite) {
  const client = {
    query: (text: string, values?: unknown[]) =>
      database.query(text, values as never[] | undefined),
    release: () => undefined
  };
  return {
    query: client.query,
    connect: async () => client
  };
}
