import { loadAppConfig } from "../config/env";
import { loadPlaidProfiles } from "../config/profiles";
import { runMigrations } from "../db/migrations";
import { createPool } from "../db/pool";
import { PlaidItemService } from "../plaid/item-service";
import { PlaidProfileRegistry } from "../plaid/profile-registry";
import { PlaidWebhookService } from "../plaid/webhook-service";
import { TokenCipher } from "../security/token-cipher";
import { buildServer } from "./app";

const config = loadAppConfig();
const pool = createPool(config.databaseUrl);

await runMigrations(pool, config.migrationsDir);
const runtimeProfiles = await loadPlaidProfiles(config.plaidProfilesFile);
const profiles = new PlaidProfileRegistry(
  pool,
  runtimeProfiles,
  config.webhookRouteSecret
);
await profiles.initialize();

const cipher = new TokenCipher(config.tokenEncryptionKey);
const itemService = new PlaidItemService(pool, profiles, cipher, config);
const webhookService = new PlaidWebhookService(pool, profiles);
const app = await buildServer({
  config,
  pool,
  itemService,
  webhookService
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ message: (error as Error).message }, "Server failed to start");
  await pool.end();
  process.exit(1);
}
