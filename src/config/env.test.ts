import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadAppConfig } from "./env";

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://example/test",
    PUBLIC_URL: "http://localhost:3000/",
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    SESSION_SECRET: "s".repeat(32),
    WEBHOOK_ROUTE_SECRET: "w".repeat(32),
    ADMIN_PASSWORD: "correct-horse",
    AUTH_DISABLED: "false"
  };
}

describe("loadAppConfig", () => {
  it("parses booleans correctly and normalizes the public URL", () => {
    const config = loadAppConfig(validEnvironment());
    expect(config.authDisabled).toBe(false);
    expect(config.publicUrl).toBe("http://localhost:3000");
    expect(config.tokenEncryptionKey).toHaveLength(32);
  });

  it("rejects an invalid token encryption key", () => {
    expect(() =>
      loadAppConfig({
        ...validEnvironment(),
        TOKEN_ENCRYPTION_KEY: Buffer.from("too-short").toString("base64")
      })
    ).toThrow(/32-byte/);
  });

  it("rejects weak administrator credentials in production", () => {
    expect(() =>
      loadAppConfig({
        ...validEnvironment(),
        NODE_ENV: "production",
        PUBLIC_URL: "https://connector.example",
        ADMIN_PASSWORD: "change-me"
      })
    ).toThrow(/ADMIN_PASSWORD/);
  });
});
