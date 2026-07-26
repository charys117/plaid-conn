import { z } from "zod";
import { config as loadDotEnv } from "dotenv";

loadDotEnv({ quiet: true });

const booleanFromString = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  PUBLIC_URL: z.string().url(),
  PLAID_CLIENT_NAME: z.string().min(1).default("Personal Card Connector"),
  PLAID_PROFILES_FILE: z.string().min(1).default("./config/plaid-profiles.json"),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  WEBHOOK_ROUTE_SECRET: z.string().min(32),
  ADMIN_PASSWORD: z.string().min(8),
  AUTH_DISABLED: booleanFromString.default(false),
  SYNC_POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(5000),
  SYNC_RECONCILE_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(240),
  SYNC_MAX_BACKOFF_MINUTES: z.coerce.number().int().min(1).default(360),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  MIGRATIONS_DIR: z.string().min(1).default("./migrations")
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  publicUrl: string;
  plaidClientName: string;
  plaidProfilesFile: string;
  tokenEncryptionKey: Buffer;
  sessionSecret: string;
  webhookRouteSecret: string;
  adminPassword: string;
  authDisabled: boolean;
  syncPollIntervalMs: number;
  syncReconcileIntervalMinutes: number;
  syncMaxBackoffMinutes: number;
  logLevel: string;
  migrationsDir: string;
};

export function loadDatabaseConfig(
  source: NodeJS.ProcessEnv = process.env
): Pick<AppConfig, "databaseUrl" | "migrationsDir"> {
  const parsed = envSchema
    .pick({ DATABASE_URL: true, MIGRATIONS_DIR: true })
    .parse(source);
  return {
    databaseUrl: parsed.DATABASE_URL,
    migrationsDir: parsed.MIGRATIONS_DIR
  };
}

export function loadAppConfig(
  source: NodeJS.ProcessEnv = process.env
): AppConfig {
  const parsed = envSchema.parse(source);
  const encryptionKey = Buffer.from(parsed.TOKEN_ENCRYPTION_KEY, "base64");

  if (encryptionKey.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key"
    );
  }
  if (parsed.NODE_ENV === "production" && parsed.AUTH_DISABLED) {
    throw new Error("AUTH_DISABLED cannot be true in production");
  }
  if (
    parsed.NODE_ENV === "production" &&
    !parsed.PUBLIC_URL.startsWith("https://")
  ) {
    throw new Error("PUBLIC_URL must use HTTPS in production");
  }
  if (
    parsed.NODE_ENV === "production" &&
    (parsed.ADMIN_PASSWORD.length < 16 || parsed.ADMIN_PASSWORD === "change-me")
  ) {
    throw new Error(
      "ADMIN_PASSWORD must be at least 16 characters and not use the example value in production"
    );
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    publicUrl: parsed.PUBLIC_URL.replace(/\/+$/, ""),
    plaidClientName: parsed.PLAID_CLIENT_NAME,
    plaidProfilesFile: parsed.PLAID_PROFILES_FILE,
    tokenEncryptionKey: encryptionKey,
    sessionSecret: parsed.SESSION_SECRET,
    webhookRouteSecret: parsed.WEBHOOK_ROUTE_SECRET,
    adminPassword: parsed.ADMIN_PASSWORD,
    authDisabled: parsed.AUTH_DISABLED,
    syncPollIntervalMs: parsed.SYNC_POLL_INTERVAL_MS,
    syncReconcileIntervalMinutes: parsed.SYNC_RECONCILE_INTERVAL_MINUTES,
    syncMaxBackoffMinutes: parsed.SYNC_MAX_BACKOFF_MINUTES,
    logLevel: parsed.LOG_LEVEL,
    migrationsDir: parsed.MIGRATIONS_DIR
  };
}
