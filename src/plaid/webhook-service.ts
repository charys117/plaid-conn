import { createHash } from "node:crypto";
import type pg from "pg";
import {
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK
} from "jose";
import { HttpError } from "../http/errors";
import { safeStringEqual } from "../security/token-cipher";
import type {
  PlaidProfileRegistry,
  RegisteredPlaidProfile
} from "./profile-registry";

type WebhookPayload = Record<string, unknown>;

type CachedKey = {
  key: Exclude<Awaited<ReturnType<typeof importJWK>>, Uint8Array>;
  expiresAt: number | null;
};

export class PlaidWebhookService {
  private readonly keyCache = new Map<string, CachedKey>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly profiles: PlaidProfileRegistry
  ) {}

  async handle(input: {
    webhookRouteToken: string;
    verificationHeader: string | undefined;
    rawBody: Buffer;
    payload: WebhookPayload;
  }): Promise<{ duplicate: boolean }> {
    const profile = this.profiles.getByWebhookToken(input.webhookRouteToken);
    if (!profile) {
      throw new HttpError(404, "Webhook route not found", "NOT_FOUND");
    }
    if (!input.verificationHeader) {
      throw new HttpError(
        401,
        "Missing Plaid-Verification header",
        "WEBHOOK_VERIFICATION_FAILED"
      );
    }

    const { kid, payloadHash } = await this.verify(
      profile,
      input.verificationHeader,
      input.rawBody
    );
    if (profile.enabled) {
      await this.applyWebhook(profile, input.payload);
    }

    const sanitized = sanitizeWebhookPayload(input.payload);
    const receipt = await this.pool.query<{ id: string }>(
      `INSERT INTO ops.webhook_receipts (
         profile_id, plaid_item_id, webhook_type, webhook_code,
         verification_kid, payload_sha256, payload, processed_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
       ON CONFLICT (profile_id, payload_sha256) DO NOTHING
       RETURNING id`,
      [
        profile.id,
        stringValue(input.payload.item_id),
        stringValue(input.payload.webhook_type),
        stringValue(input.payload.webhook_code),
        kid,
        payloadHash,
        JSON.stringify(sanitized)
      ]
    );

    const duplicate = !receipt.rows[0];
    if (duplicate) {
      await this.pool.query(
        `UPDATE ops.webhook_receipts
         SET processed_at = now()
         WHERE profile_id = $1
           AND payload_sha256 = $2`,
        [profile.id, payloadHash]
      );
    }
    return { duplicate };
  }

  private async verify(
    profile: RegisteredPlaidProfile,
    token: string,
    rawBody: Buffer
  ): Promise<{ kid: string; payloadHash: string }> {
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw this.verificationError("Invalid verification JWT");
    }
    if (header.alg !== "ES256" || typeof header.kid !== "string") {
      throw this.verificationError("Unexpected webhook signing algorithm");
    }

    const key = await this.getVerificationKey(profile, header.kid);
    let claims: Awaited<ReturnType<typeof jwtVerify>>["payload"];
    try {
      claims = (await jwtVerify(token, key, { algorithms: ["ES256"] })).payload;
    } catch {
      throw this.verificationError("Webhook signature is invalid");
    }

    if (typeof claims.iat !== "number") {
      throw this.verificationError("Webhook JWT is missing iat");
    }
    const ageSeconds = Math.floor(Date.now() / 1000) - claims.iat;
    if (ageSeconds < -30 || ageSeconds > 300) {
      throw this.verificationError("Webhook JWT is outside the allowed time window");
    }

    const payloadHash = createHash("sha256").update(rawBody).digest("hex");
    const claimedHash = claims.request_body_sha256;
    if (
      typeof claimedHash !== "string" ||
      !safeStringEqual(payloadHash, claimedHash)
    ) {
      throw this.verificationError("Webhook body hash does not match");
    }

    return { kid: header.kid, payloadHash };
  }

  private async getVerificationKey(
    profile: RegisteredPlaidProfile,
    kid: string
  ): Promise<Exclude<Awaited<ReturnType<typeof importJWK>>, Uint8Array>> {
    const cached = this.keyCache.get(kid);
    const now = Math.floor(Date.now() / 1000);
    if (cached && (cached.expiresAt === null || cached.expiresAt > now)) {
      return cached.key;
    }

    const response = await profile.client.webhookVerificationKeyGet({
      key_id: kid
    });
    const plaidKey = response.data.key;
    if (
      plaidKey.alg !== "ES256" ||
      plaidKey.kty !== "EC" ||
      plaidKey.crv !== "P-256"
    ) {
      throw this.verificationError("Plaid returned an unexpected JWK");
    }

    const imported = await importJWK(
      {
        alg: plaidKey.alg,
        crv: plaidKey.crv,
        kid: plaidKey.kid,
        kty: plaidKey.kty,
        use: plaidKey.use,
        x: plaidKey.x,
        y: plaidKey.y
      } satisfies JWK,
      "ES256"
    );
    if (imported instanceof Uint8Array) {
      throw this.verificationError("Plaid returned a symmetric webhook key");
    }
    this.keyCache.set(kid, {
      key: imported,
      expiresAt: plaidKey.expired_at
    });
    return imported;
  }

  private async applyWebhook(
    profile: RegisteredPlaidProfile,
    payload: WebhookPayload
  ): Promise<void> {
    const plaidItemId = stringValue(payload.item_id);
    if (!plaidItemId) return;

    const webhookType = stringValue(payload.webhook_type);
    const webhookCode = stringValue(payload.webhook_code);

    if (
      webhookType === "TRANSACTIONS" &&
      webhookCode === "SYNC_UPDATES_AVAILABLE"
    ) {
      await this.requestItemSync(profile.id, plaidItemId, "webhook");
      return;
    }

    if (
      webhookType === "ITEM" &&
      ["PENDING_EXPIRATION", "PENDING_DISCONNECT"].includes(webhookCode ?? "")
    ) {
      const expiration =
        stringValue(payload.consent_expiration_time) ??
        stringValue(payload.disconnect_time);
      await this.pool.query(
        `UPDATE connector.plaid_items
         SET consent_expiration_at =
               COALESCE($3::timestamptz, consent_expiration_at),
             updated_at = now()
         WHERE profile_id = $1
           AND plaid_item_id = $2
           AND status NOT IN ('disabled', 'removed')`,
        [profile.id, plaidItemId, expiration]
      );
      return;
    }

    if (webhookType === "ITEM" && webhookCode === "LOGIN_REPAIRED") {
      await this.pool.query(
        `UPDATE connector.plaid_items
         SET status = 'active',
             sync_requested_at = now(),
             sync_requested_trigger = 'recovery',
             next_sync_attempt_at = null,
             sync_failure_count = 0,
             last_error_code = null,
             last_error_message = null,
             updated_at = now()
         WHERE profile_id = $1
           AND plaid_item_id = $2
           AND status NOT IN ('disabled', 'removed')`,
        [profile.id, plaidItemId]
      );
      return;
    }

    if (
      webhookType === "ITEM" &&
      ["ERROR", "USER_PERMISSION_REVOKED", "USER_ACCOUNT_REVOKED"].includes(
        webhookCode ?? ""
      )
    ) {
      await this.requestItemSync(profile.id, plaidItemId, "webhook");
    }
  }

  private async requestItemSync(
    profileId: string,
    plaidItemId: string,
    trigger: "webhook"
  ): Promise<void> {
    await this.pool.query(
      `UPDATE connector.plaid_items
       SET sync_requested_at = now(),
           sync_requested_trigger = COALESCE(sync_requested_trigger, $3),
           next_sync_attempt_at = null,
           updated_at = now()
       WHERE profile_id = $1
         AND plaid_item_id = $2
         AND status IN ('active', 'error', 'syncing')`,
      [profileId, plaidItemId, trigger]
    );
  }

  private verificationError(message: string): HttpError {
    return new HttpError(
      401,
      message,
      "WEBHOOK_VERIFICATION_FAILED"
    );
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function sanitizeWebhookPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeWebhookPayload);
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (
      normalized.includes("access_token") ||
      normalized.includes("public_token") ||
      normalized === "secret" ||
      normalized === "link_token"
    ) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = sanitizeWebhookPayload(nested);
    }
  }
  return result;
}
