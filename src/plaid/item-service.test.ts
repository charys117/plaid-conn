import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config/env";
import { TokenCipher } from "../security/token-cipher";
import { PlaidItemService } from "./item-service";

describe("PlaidItemService update completion", () => {
  it("atomically claims the session and refuses disabled Profiles", async () => {
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
          'item-1', 'encrypted', 'login_required'
        );
        INSERT INTO connector.link_sessions (
          id, profile_id, mode, item_id, expires_at
        ) VALUES (
          '30000000-0000-4000-8000-000000000003',
          '10000000-0000-4000-8000-000000000001',
          'update', '20000000-0000-4000-8000-000000000002',
          now() + interval '1 hour'
        );
      `);
      const pool = {
        query: (text: string, values?: unknown[]) =>
          database.query(text, values as never[] | undefined)
      };
      const service = new PlaidItemService(
        pool as never,
        {} as never,
        new TokenCipher(randomBytes(32)),
        {} as AppConfig
      );

      await expect(
        service.markUpdateComplete(
          "30000000-0000-4000-8000-000000000003"
        )
      ).resolves.toBeUndefined();
      const restored = await database.query<{
        status: string;
        consumed: boolean;
      }>(
        `SELECT i.status, s.consumed_at IS NOT NULL AS consumed
         FROM connector.plaid_items i
         JOIN connector.link_sessions s ON s.item_id = i.id`
      );
      expect(restored.rows[0]).toEqual({
        status: "active",
        consumed: true
      });

      await database.exec(`
        UPDATE connector.plaid_profiles SET enabled = false;
        UPDATE connector.plaid_items SET status = 'disabled';
        UPDATE connector.link_sessions SET consumed_at = null;
      `);
      await expect(
        service.markUpdateComplete(
          "30000000-0000-4000-8000-000000000003"
        )
      ).rejects.toThrow(/invalid or expired/);
      const disabled = await database.query<{ consumed: boolean }>(
        `SELECT consumed_at IS NOT NULL AS consumed
         FROM connector.link_sessions`
      );
      expect(disabled.rows[0]?.consumed).toBe(false);
    } finally {
      await database.close();
    }
  });
});
