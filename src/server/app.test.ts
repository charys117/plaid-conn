import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../config/env";
import { buildServer } from "./app";

const servers: Array<Awaited<ReturnType<typeof buildServer>>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("server authentication", () => {
  it("protects APIs and accepts the configured administrator password", async () => {
    const config = {
      nodeEnv: "test",
      logLevel: "silent",
      publicUrl: "http://localhost:3000",
      sessionSecret: "s".repeat(32),
      adminPassword: "correct-password",
      authDisabled: false,
      tokenEncryptionKey: randomBytes(32)
    } as AppConfig;
    const server = await buildServer({
      config,
      pool: { query: async () => ({ rows: [] }) } as never,
      itemService: {
        listProfiles: async () => [],
        listItems: async () => []
      } as never,
      webhookService: {} as never,
      serveStatic: false
    });
    servers.push(server);

    const denied = await server.inject({ method: "GET", url: "/api/profiles" });
    expect(denied.statusCode).toBe(401);

    const login = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "correct-password" }
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers["set-cookie"];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const allowed = await server.inject({
      method: "GET",
      url: "/api/profiles",
      headers: { cookie: cookie! }
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ profiles: [] });

    const expired = await server.inject({
      method: "GET",
      url: "/api/profiles",
      headers: {
        cookie: `plaid_conn_session=${server.signCookie("authenticated-v1:1")}`
      }
    });
    expect(expired.statusCode).toBe(401);
  });

  it("preserves framework 4xx responses for invalid request bodies", async () => {
    const config = {
      nodeEnv: "test",
      logLevel: "silent",
      publicUrl: "http://localhost:3000",
      sessionSecret: "s".repeat(32),
      adminPassword: "correct-password",
      authDisabled: false,
      tokenEncryptionKey: randomBytes(32)
    } as AppConfig;
    const server = await buildServer({
      config,
      pool: { query: async () => ({ rows: [] }) } as never,
      itemService: {} as never,
      webhookService: {} as never,
      serveStatic: false
    });
    servers.push(server);

    const malformed = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{\"password\":"
    });
    expect(malformed.statusCode).toBe(400);

    const unsupported = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/xml" },
      payload: "<password>test</password>"
    });
    expect(unsupported.statusCode).toBe(415);

    const oversized = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "x".repeat(300_000) }
    });
    expect(oversized.statusCode).toBe(413);
  });
});
