import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

describe("initial database migration", () => {
  it("creates the connector, finance, and ops data model with key constraints", async () => {
    const database = await PGlite.create();
    try {
      for (const filename of [
        "migrations/001_initial.sql",
        "migrations/002_remove_config_fingerprint.sql"
      ]) {
        await database.exec(await readFile(resolve(filename), "utf8"));
      }

      const tables = await database.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema, table_name
         FROM information_schema.tables
         WHERE table_schema IN ('connector', 'finance', 'ops')`
      );
      expect(tables.rows).toEqual(
        expect.arrayContaining([
          { table_schema: "connector", table_name: "plaid_profiles" },
          { table_schema: "connector", table_name: "plaid_items" },
          { table_schema: "finance", table_name: "transactions" },
          { table_schema: "ops", table_name: "sync_runs" }
        ])
      );

      await expect(
        database.exec(`
          INSERT INTO connector.plaid_profiles (
            id, profile_key, display_name, environment, client_id,
            country_codes, language, days_requested, enabled
          ) VALUES (
            '00000000-0000-0000-0000-000000000001',
            'invalid key', 'Invalid', 'sandbox', 'client',
            ARRAY['US'], 'en', 730, true
          )
        `)
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});
