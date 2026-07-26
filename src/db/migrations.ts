import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type pg from "pg";

const MIGRATION_LOCK_ID = 7_160_461_103;

export async function runMigrations(
  pool: pg.Pool,
  migrationsDir: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query("CREATE SCHEMA IF NOT EXISTS connector");
    await client.query(`
      CREATE TABLE IF NOT EXISTS connector.schema_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(resolve(migrationsDir)))
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();

    for (const filename of files) {
      const sql = await readFile(resolve(migrationsDir, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM connector.schema_migrations WHERE filename = $1",
        [filename]
      );

      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== checksum) {
          throw new Error(`Applied migration changed: ${filename}`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO connector.schema_migrations (filename, checksum) VALUES ($1, $2)",
          [filename, checksum]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    client.release();
  }
}
