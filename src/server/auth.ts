import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config/env";
import { safeStringEqual } from "../security/token-cipher";

const SESSION_COOKIE = "plaid_conn_session";
const SESSION_VALUE = "authenticated-v1";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const loginSchema = z.object({ password: z.string().min(1) });

export async function registerAuth(
  app: FastifyInstance,
  config: AppConfig
): Promise<void> {
  await app.register(cookie, {
    secret: config.sessionSecret,
    hook: "onRequest"
  });

  app.get("/api/auth/session", async (request) => ({
    authenticated: config.authDisabled || isAuthenticated(request)
  }));

  app.post(
    "/api/auth/login",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "5 minutes"
        }
      }
    },
    async (request, reply) => {
      const { password } = loginSchema.parse(request.body);
      if (
        !config.authDisabled &&
        !safeStringEqual(password, config.adminPassword)
      ) {
        return reply.code(401).send({
          error: { code: "INVALID_CREDENTIALS", message: "Invalid password" }
        });
      }

      const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
      reply.setCookie(SESSION_COOKIE, `${SESSION_VALUE}:${expiresAt}`, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: config.publicUrl.startsWith("https://"),
        signed: true,
        maxAge: SESSION_TTL_SECONDS
      });
      return { authenticated: true };
    }
  );

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { authenticated: false };
  });

  app.addHook("preHandler", async (request, reply) => {
    if (
      config.authDisabled ||
      !request.url.startsWith("/api/") ||
      request.url.startsWith("/api/auth/")
    ) {
      return;
    }
    if (!isAuthenticated(request)) {
      return reply.code(401).send({
        error: { code: "UNAUTHENTICATED", message: "Authentication required" }
      });
    }
  });
}

function isAuthenticated(request: FastifyRequest): boolean {
  const signed = request.cookies[SESSION_COOKIE];
  if (!signed) return false;
  const result = request.unsignCookie(signed);
  if (!result.valid || !result.value) return false;
  const [value, expiresAt] = result.value.split(":");
  return (
    value === SESSION_VALUE &&
    Number(expiresAt) > Math.floor(Date.now() / 1000)
  );
}
