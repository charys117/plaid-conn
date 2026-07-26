import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import type { RuntimePlaidProfile } from "../config/profiles";
import { PlaidProfileRegistry } from "./profile-registry";

describe("PlaidProfileRegistry", () => {
  it("refuses to orphan Items when a Profile is removed from config", async () => {
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
          'item-1', 'encrypted', 'active'
        );
      `);
      const registry = new PlaidProfileRegistry(
        {
          query: (text: string, values?: unknown[]) =>
            database.query(text, values as never[] | undefined)
        } as never,
        [{ key: "other" } as RuntimePlaidProfile],
        "w".repeat(32)
      );

      await expect(registry.initialize()).rejects.toThrow(
        /still owns Items/
      );
    } finally {
      await database.close();
    }
  });
});
