import { existsSync } from "node:fs";
import { resolve } from "node:path";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { AppConfig } from "../config/env";
import type { PlaidItemService } from "../plaid/item-service";
import { parsePlaidError } from "../plaid/errors";
import type { PlaidWebhookService } from "../plaid/webhook-service";
import { HttpError } from "../http/errors";
import type pg from "pg";
import { registerAuth } from "./auth";
import { registerRoutes } from "./routes";

export async function buildServer(input: {
  config: AppConfig;
  pool: pg.Pool;
  itemService: PlaidItemService;
  webhookService: PlaidWebhookService;
  serveStatic?: boolean;
}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: input.config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers.plaid-verification",
          "res.headers.set-cookie",
          "*.access_token",
          "*.public_token",
          "*.secret"
        ],
        censor: "[REDACTED]"
      }
    },
    bodyLimit: 256 * 1024
  });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
      request.rawBody = raw;
      try {
        done(null, JSON.parse(raw.toString("utf8")));
      } catch (error) {
        const parseError = error as Error & {
          statusCode?: number;
          code?: string;
        };
        parseError.statusCode = 400;
        parseError.code = "FST_ERR_CTP_INVALID_JSON_BODY";
        done(parseError);
      }
    }
  );

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://cdn.plaid.com"],
        frameSrc: ["'self'", "https://*.plaid.com"],
        connectSrc: ["'self'", "https://*.plaid.com"],
        imgSrc: ["'self'", "data:", "https:"],
        styleSrc: ["'self'", "'unsafe-inline'"]
      }
    }
  });
  await app.register(rateLimit, { global: false });
  await registerAuth(app, input.config);

  app.get("/health", async (_request, reply) => {
    try {
      await input.pool.query("SELECT 1");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  await registerRoutes(app, {
    items: input.itemService,
    webhooks: input.webhookService
  });

  if (input.serveStatic !== false) {
    const webRoot = resolve("dist/web");
    if (existsSync(webRoot)) {
      await app.register(staticPlugin, {
        root: webRoot,
        prefix: "/"
      });
      app.setNotFoundHandler((request, reply) => {
        if (
          request.method === "GET" &&
          request.headers.accept?.includes("text/html")
        ) {
          return reply.sendFile("index.html");
        }
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Route not found" }
        });
      });
    }
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
          details: error.issues
        }
      });
    }
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {})
        }
      });
    }
    const frameworkError = error as {
      statusCode?: unknown;
      code?: unknown;
      message?: unknown;
    };
    if (
      typeof frameworkError.statusCode === "number" &&
      frameworkError.statusCode >= 400 &&
      frameworkError.statusCode < 500
    ) {
      return reply.code(frameworkError.statusCode).send({
        error: {
          code:
            typeof frameworkError.code === "string"
              ? frameworkError.code
              : "INVALID_REQUEST",
          message:
            typeof frameworkError.message === "string"
              ? frameworkError.message
              : "Invalid request"
        }
      });
    }

    const plaidError = parsePlaidError(error);
    if (plaidError.errorCode !== "UNKNOWN") {
      request.log.warn({
        plaidError: {
          errorType: plaidError.errorType,
          errorCode: plaidError.errorCode,
          requestId: plaidError.requestId,
          statusCode: plaidError.statusCode
        }
      });
      return reply.code(502).send({
        error: {
          code: plaidError.errorCode,
          message: plaidError.message,
          requestId: plaidError.requestId
        }
      });
    }

    const unknownError =
      error instanceof Error ? error : new Error("Unknown server error");
    request.log.error({
      message: unknownError.message,
      stack: unknownError.stack
    });
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message:
          input.config.nodeEnv === "production"
            ? "Internal server error"
            : unknownError.message
      }
    });
  });

  return app;
}
