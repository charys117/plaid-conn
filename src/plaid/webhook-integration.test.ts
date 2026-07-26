import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import type {
  PlaidProfileRegistry,
  RegisteredPlaidProfile
} from "./profile-registry";
import { PlaidWebhookService } from "./webhook-service";

describe("PlaidWebhookService delivery handling", () => {
  it("applies identical verified payloads every time while deduplicating audit rows", async () => {
    const database = await webhookDatabase();
    try {
      const service = webhookService(database);
      const payload = {
        webhook_type: "TRANSACTIONS",
        webhook_code: "SYNC_UPDATES_AVAILABLE",
        item_id: "item-1"
      };

      await expect(handle(service, payload)).resolves.toEqual({
        duplicate: false
      });
      await database.query(
        `UPDATE connector.plaid_items
         SET sync_requested_at = '2000-01-01', sync_requested_trigger = null`
      );
      await expect(handle(service, payload)).resolves.toEqual({
        duplicate: true
      });

      const item = await database.query<{
        requested: boolean;
        sync_requested_trigger: string;
      }>(
        `SELECT sync_requested_at > '2000-01-01' AS requested,
                sync_requested_trigger
         FROM connector.plaid_items`
      );
      expect(item.rows[0]).toEqual({
        requested: true,
        sync_requested_trigger: "webhook"
      });
      const receipts = await database.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM ops.webhook_receipts
         WHERE processed_at IS NOT NULL`
      );
      expect(receipts.rows[0]?.count).toBe(1);
    } finally {
      await database.close();
    }
  });

  it("does not poison a retry when applying the first delivery fails", async () => {
    const database = await webhookDatabase();
    try {
      const service = webhookService(database);
      const apply = vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary database failure"))
        .mockResolvedValueOnce(undefined);
      (
        service as unknown as {
          applyWebhook: typeof apply;
        }
      ).applyWebhook = apply;
      const payload = {
        webhook_type: "TRANSACTIONS",
        webhook_code: "SYNC_UPDATES_AVAILABLE",
        item_id: "item-1"
      };

      await expect(handle(service, payload)).rejects.toThrow(/temporary/);
      const beforeRetry = await database.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM ops.webhook_receipts"
      );
      expect(beforeRetry.rows[0]?.count).toBe(0);

      await expect(handle(service, payload)).resolves.toEqual({
        duplicate: false
      });
      expect(apply).toHaveBeenCalledTimes(2);
    } finally {
      await database.close();
    }
  });
});

async function webhookDatabase(): Promise<PGlite> {
  const database = await PGlite.create();
  for (const filename of [
    "migrations/001_initial.sql",
    "migrations/002_remove_config_fingerprint.sql"
  ]) {
    await database.exec(await readFile(resolve(filename), "utf8"));
  }
  await database.exec(`
    INSERT INTO connector.plaid_profiles (
      id, profile_key, display_name, environment, client_id,
      country_codes, language, days_requested, enabled
    ) VALUES (
      '10000000-0000-4000-8000-000000000001',
      'primary', 'Primary', 'sandbox', 'client',
      ARRAY['US'], 'en', 730, true
    );
    INSERT INTO connector.plaid_items (
      id, profile_id, plaid_item_id, access_token_encrypted, status
    ) VALUES (
      '20000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001',
      'item-1', 'encrypted', 'active'
    );
  `);
  return database;
}

function webhookService(database: PGlite): PlaidWebhookService {
  const profile = {
    id: "10000000-0000-4000-8000-000000000001",
    enabled: true
  } as RegisteredPlaidProfile;
  const registry = {
    getByWebhookToken: () => profile
  } as unknown as PlaidProfileRegistry;
  const pool = {
    query: (text: string, values?: unknown[]) =>
      database.query(text, values as never[] | undefined)
  };
  const service = new PlaidWebhookService(pool as never, registry);
  (
    service as unknown as {
      verify: () => Promise<{ kid: string; payloadHash: string }>;
    }
  ).verify = vi.fn().mockResolvedValue({
    kid: "verification-key",
    payloadHash: "same-payload-hash"
  });
  return service;
}

function handle(
  service: PlaidWebhookService,
  payload: Record<string, unknown>
): Promise<{ duplicate: boolean }> {
  return service.handle({
    webhookRouteToken: "route",
    verificationHeader: "verified",
    rawBody: Buffer.from(JSON.stringify(payload)),
    payload
  });
}
