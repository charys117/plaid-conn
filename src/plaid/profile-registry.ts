import { createHmac, randomUUID } from "node:crypto";
import type pg from "pg";
import type { PlaidApi } from "plaid";
import type { RuntimePlaidProfile } from "../config/profiles";
import { createPlaidClient } from "./client";

export type RegisteredPlaidProfile = RuntimePlaidProfile & {
  id: string;
  webhookRouteToken: string;
  client: PlaidApi;
};

export class PlaidProfileRegistry {
  private readonly byId = new Map<string, RegisteredPlaidProfile>();
  private readonly byWebhookToken = new Map<string, RegisteredPlaidProfile>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly runtimeProfiles: RuntimePlaidProfile[],
    private readonly webhookRouteSecret: string
  ) {}

  async initialize(): Promise<void> {
    const configuredKeys = this.runtimeProfiles.map((profile) => profile.key);
    const orphaned = await this.pool.query<{ profile_key: string }>(
      `SELECT p.profile_key
       FROM connector.plaid_profiles p
       JOIN connector.plaid_items i ON i.profile_id = p.id
       WHERE NOT (p.profile_key = ANY($1::text[]))
         AND i.status <> 'removed'
       LIMIT 1`,
      [configuredKeys]
    );
    const orphanedKey = orphaned.rows[0]?.profile_key;
    if (orphanedKey) {
      throw new Error(
        `Plaid profile ${orphanedKey} still owns Items; restore it in the profile config and remove those Items first`
      );
    }

    await this.pool.query(
      `UPDATE connector.plaid_profiles
       SET enabled = false, updated_at = now()
       WHERE NOT (profile_key = ANY($1::text[]))`,
      [configuredKeys]
    );

    for (const profile of this.runtimeProfiles) {
      const existing = await this.pool.query<{
        id: string;
        environment: string;
        client_id: string;
        item_count: string;
      }>(
        `SELECT
           p.id,
           p.environment,
           p.client_id,
           count(i.id)::text AS item_count
         FROM connector.plaid_profiles p
         LEFT JOIN connector.plaid_items i
           ON i.profile_id = p.id AND i.status <> 'removed'
         WHERE p.profile_key = $1
         GROUP BY p.id`,
        [profile.key]
      );
      const existingProfile = existing.rows[0];
      if (
        existingProfile &&
        Number(existingProfile.item_count) > 0 &&
        (existingProfile.environment !== profile.environment ||
          existingProfile.client_id !== profile.clientId)
      ) {
        throw new Error(
          `Plaid profile ${profile.key} cannot change client_id or environment while it owns active Items`
        );
      }

      const id = randomUUID();
      const result = await this.pool.query<{ id: string }>(
        `INSERT INTO connector.plaid_profiles (
           id, profile_key, display_name, environment, client_id,
           country_codes, language, days_requested, enabled
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (profile_key) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           environment = EXCLUDED.environment,
           client_id = EXCLUDED.client_id,
           country_codes = EXCLUDED.country_codes,
           language = EXCLUDED.language,
           days_requested = EXCLUDED.days_requested,
           enabled = EXCLUDED.enabled,
           updated_at = now()
         RETURNING id`,
        [
          id,
          profile.key,
          profile.displayName,
          profile.environment,
          profile.clientId,
          profile.countryCodes,
          profile.language,
          profile.daysRequested,
          profile.enabled
        ]
      );

      const databaseId = result.rows[0]?.id;
      if (!databaseId) throw new Error(`Unable to register profile ${profile.key}`);

      const webhookRouteToken = createHmac(
        "sha256",
        this.webhookRouteSecret
      )
        .update(profile.key)
        .digest("base64url")
        .slice(0, 32);

      const registered: RegisteredPlaidProfile = {
        ...profile,
        id: databaseId,
        webhookRouteToken,
        client: createPlaidClient(profile)
      };

      this.byId.set(databaseId, registered);
      this.byWebhookToken.set(webhookRouteToken, registered);
    }

    await this.pool.query(
      `UPDATE connector.plaid_items i
       SET status = 'disabled',
           sync_requested_at = null,
           sync_requested_trigger = null,
           updated_at = now()
       FROM connector.plaid_profiles p
       WHERE p.id = i.profile_id
         AND p.enabled = false
         AND i.status <> 'removed'`
    );
    await this.pool.query(
      `UPDATE connector.plaid_items i
       SET status = 'active',
           sync_requested_at = now(),
           sync_requested_trigger = 'recovery',
           next_sync_attempt_at = null,
           updated_at = now()
       FROM connector.plaid_profiles p
       WHERE p.id = i.profile_id
         AND p.enabled = true
         AND i.status = 'disabled'`
    );
  }

  list(): RegisteredPlaidProfile[] {
    return [...this.byId.values()];
  }

  getById(id: string): RegisteredPlaidProfile {
    const profile = this.byId.get(id);
    if (!profile) throw new Error(`Unknown Plaid profile id: ${id}`);
    return profile;
  }

  getByWebhookToken(token: string): RegisteredPlaidProfile | undefined {
    return this.byWebhookToken.get(token);
  }
}
