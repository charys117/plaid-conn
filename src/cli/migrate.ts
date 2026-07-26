import { loadDatabaseConfig } from "../config/env";
import { runMigrations } from "../db/migrations";
import { createPool } from "../db/pool";

const config = loadDatabaseConfig();
const pool = createPool(config.databaseUrl);

try {
  await runMigrations(pool, config.migrationsDir);
  process.stdout.write("Migrations are up to date.\n");
} finally {
  await pool.end();
}
