import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PlaidItemService } from "../plaid/item-service";
import type { PlaidWebhookService } from "../plaid/webhook-service";

const uuidParam = z.object({ id: z.string().uuid() });
const profileParam = z.object({ profileId: z.string().uuid() });
const webhookParam = z.object({ token: z.string().min(16).max(128) });

const metadataSchema = z.object({
  institution: z
    .object({
      institution_id: z.string().nullable().optional(),
      name: z.string().nullable().optional()
    })
    .nullable()
    .optional(),
  accounts: z
    .array(
      z.object({
        id: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
        mask: z.string().nullable().optional(),
        type: z.string().nullable().optional(),
        subtype: z.string().nullable().optional()
      })
    )
    .optional()
});

const exchangeSchema = z.object({
  sessionId: z.string().uuid(),
  publicToken: z.string().min(1),
  metadata: metadataSchema.default({}),
  allowDuplicate: z.boolean().default(false)
});

const updateCompleteSchema = z.object({ sessionId: z.string().uuid() });
const accountVisibilitySchema = z.object({ hidden: z.boolean() });

export async function registerRoutes(
  app: FastifyInstance,
  services: {
    items: PlaidItemService;
    webhooks: PlaidWebhookService;
  }
): Promise<void> {
  app.get("/api/profiles", async () => ({
    profiles: await services.items.listProfiles()
  }));

  app.get("/api/items", async () => ({
    items: await services.items.listItems()
  }));

  app.post("/api/profiles/:profileId/link-token", async (request, reply) => {
    const { profileId } = profileParam.parse(request.params);
    const result = await services.items.createLinkToken(profileId);
    return reply.code(201).send(result);
  });

  app.post("/api/link/exchange", async (request, reply) => {
    const input = exchangeSchema.parse(request.body);
    const item = await services.items.exchangePublicToken(input);
    return reply.code(201).send(item);
  });

  app.post("/api/items/:id/update-link-token", async (request) => {
    const { id } = uuidParam.parse(request.params);
    return services.items.createUpdateLinkToken(id);
  });

  app.post("/api/link/update-complete", async (request) => {
    const { sessionId } = updateCompleteSchema.parse(request.body);
    await services.items.markUpdateComplete(sessionId);
    return { accepted: true };
  });

  app.post("/api/items/:id/sync", async (request, reply) => {
    const { id } = uuidParam.parse(request.params);
    await services.items.requestSync(id);
    return reply.code(202).send({ accepted: true });
  });

  app.delete("/api/items/:id", async (request, reply) => {
    const { id } = uuidParam.parse(request.params);
    await services.items.removeItem(id);
    return reply.code(204).send();
  });

  app.patch("/api/accounts/:id", async (request) => {
    const { id } = uuidParam.parse(request.params);
    const { hidden } = accountVisibilitySchema.parse(request.body);
    await services.items.setAccountHidden(id, hidden);
    return { updated: true };
  });

  app.post("/webhooks/plaid/:token", async (request) => {
    const { token } = webhookParam.parse(request.params);
    if (!request.rawBody || !request.body || typeof request.body !== "object") {
      throw new Error("Webhook raw body is unavailable");
    }

    return services.webhooks.handle({
      webhookRouteToken: token,
      verificationHeader: headerValue(
        request.headers["plaid-verification"]
      ),
      rawBody: request.rawBody,
      payload: request.body as Record<string, unknown>
    });
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
