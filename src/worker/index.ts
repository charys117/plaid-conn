import pino from "pino";
import { loadAppConfig } from "../config/env";
import { loadPlaidProfiles } from "../config/profiles";
import { runMigrations } from "../db/migrations";
import { createPool } from "../db/pool";
import { parsePlaidError } from "../plaid/errors";
import { PlaidProfileRegistry } from "../plaid/profile-registry";
import { PlaidSyncService } from "../plaid/sync-service";
import { TokenCipher } from "../security/token-cipher";

const config = loadAppConfig();
const logger = pino({
  level: config.logLevel,
  redact: {
    paths: ["*.access_token", "*.public_token", "*.secret"],
    censor: "[REDACTED]"
  }
});
const pool = createPool(config.databaseUrl);
let stopping = false;

const shutdown = (signal: string) => {
  logger.info({ signal }, "Worker shutdown requested");
  stopping = true;
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

try {
  await runMigrations(pool, config.migrationsDir);
  const runtimeProfiles = await loadPlaidProfiles(config.plaidProfilesFile);
  const profiles = new PlaidProfileRegistry(
    pool,
    runtimeProfiles,
    config.webhookRouteSecret
  );
  await profiles.initialize();
  const sync = new PlaidSyncService(
    pool,
    profiles,
    new TokenCipher(config.tokenEncryptionKey),
    config
  );
  await sync.recoverInterruptedRuns();
  let nextRecoveryCheck = Date.now() + 60_000;

  logger.info(
    {
      profileCount: profiles.list().length,
      pollIntervalMs: config.syncPollIntervalMs,
      reconcileMinutes: config.syncReconcileIntervalMinutes
    },
    "Plaid sync worker started"
  );

  while (!stopping) {
    if (Date.now() >= nextRecoveryCheck) {
      await sync.recoverInterruptedRuns();
      nextRecoveryCheck = Date.now() + 60_000;
    }
    const dueItems = await sync.findDueItems();
    if (dueItems.length === 0) {
      await wait(config.syncPollIntervalMs);
      continue;
    }

    let madeProgress = false;
    for (const item of dueItems) {
      if (stopping) break;
      try {
        const completed = await sync.syncItem(item.id, item.trigger);
        if (completed) {
          madeProgress = true;
          logger.info(
            { itemId: item.id, trigger: item.trigger },
            "Item sync completed"
          );
        }
      } catch (error) {
        madeProgress = true;
        const parsed = parsePlaidError(error);
        logger.warn(
          {
            itemId: item.id,
            trigger: item.trigger,
            errorCode: parsed.errorCode,
            requestId: parsed.requestId,
            message: parsed.message
          },
          "Item sync failed"
        );
      }
    }
    if (!madeProgress && !stopping) {
      await wait(config.syncPollIntervalMs);
    }
  }
} catch (error) {
  logger.fatal({ message: (error as Error).message }, "Worker failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
