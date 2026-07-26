import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  Products,
  type CountryCode,
  type LinkTokenCreateRequest
} from "plaid";
import type { AppConfig } from "../config/env";
import { conflict, notFound } from "../http/errors";
import {
  plaidTokenAssociatedData,
  TokenCipher
} from "../security/token-cipher";
import { parsePlaidError } from "./errors";
import type {
  PlaidProfileRegistry,
  RegisteredPlaidProfile
} from "./profile-registry";

export type LinkAccountMetadata = {
  id?: string | null;
  name?: string | null;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
};

export type LinkSuccessMetadata = {
  institution?: {
    institution_id?: string | null;
    name?: string | null;
  } | null;
  accounts?: LinkAccountMetadata[];
};

type ItemSecretRow = {
  id: string;
  profile_id: string;
  plaid_item_id: string;
  access_token_encrypted: string | null;
  status: string;
};

export class PlaidItemService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly profiles: PlaidProfileRegistry,
    private readonly cipher: TokenCipher,
    private readonly config: AppConfig
  ) {}

  async listProfiles(): Promise<unknown[]> {
    return this.profiles.list().map((profile) => ({
      id: profile.id,
      displayName: profile.displayName,
      environment: profile.environment,
      countryCodes: profile.countryCodes,
      daysRequested: profile.daysRequested,
      enabled: profile.enabled
    }));
  }

  async listItems(): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT
         i.id,
         i.profile_id AS "profileId",
         i.institution_name AS "institutionName",
         i.status,
         i.consent_expiration_at AS "consentExpirationAt",
         i.last_sync_succeeded_at AS "lastSyncSucceededAt",
         i.last_error_code AS "lastErrorCode",
         i.last_error_message AS "lastErrorMessage",
         COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', a.id,
               'name', a.name,
               'mask', a.mask,
               'type', a.type,
               'subtype', a.subtype,
               'currency', COALESCE(a.iso_currency_code, a.unofficial_currency_code),
               'currentBalance', a.current_balance::text,
               'hidden', a.hidden
             )
             ORDER BY a.name
           ) FILTER (WHERE a.id IS NOT NULL),
           '[]'::jsonb
         ) AS accounts
       FROM connector.plaid_items i
       JOIN connector.plaid_profiles p ON p.id = i.profile_id
       LEFT JOIN finance.accounts a ON a.item_id = i.id AND a.active = true
       WHERE i.status <> 'removed'
       GROUP BY i.id, p.display_name
       ORDER BY p.display_name, i.created_at DESC`
    );
    return result.rows;
  }

  async createLinkToken(profileId: string): Promise<{
    linkToken: string;
    sessionId: string;
    expiration: string;
  }> {
    const profile = this.profiles.getById(profileId);
    if (!profile.enabled) {
      throw conflict("This Plaid profile is disabled");
    }

    const request: LinkTokenCreateRequest = {
      user: { client_user_id: `owner-${profile.key}` },
      client_name: this.config.plaidClientName,
      products: [Products.Transactions],
      country_codes: profile.countryCodes as CountryCode[],
      language: profile.language,
      webhook: `${this.config.publicUrl}/webhooks/plaid/${profile.webhookRouteToken}`,
      transactions: { days_requested: profile.daysRequested },
      ...(profile.redirectUri ? { redirect_uri: profile.redirectUri } : {})
    };

    const response = await profile.client.linkTokenCreate(request);
    const sessionId = randomUUID();
    await this.pool.query(
      `INSERT INTO connector.link_sessions (
         id, profile_id, mode, expires_at
       ) VALUES ($1, $2, 'create', $3)`,
      [sessionId, profile.id, response.data.expiration]
    );

    return {
      linkToken: response.data.link_token,
      sessionId,
      expiration: response.data.expiration
    };
  }

  async createUpdateLinkToken(itemId: string): Promise<{
    linkToken: string;
    sessionId: string;
    expiration: string;
  }> {
    const item = await this.getItemSecret(itemId);
    const profile = this.profiles.getById(item.profile_id);
    if (!profile.enabled) {
      throw conflict("This Plaid profile is disabled");
    }
    const accessToken = this.decryptAccessToken(item, profile);
    const response = await profile.client.linkTokenCreate({
      user: { client_user_id: `owner-${profile.key}` },
      client_name: this.config.plaidClientName,
      country_codes: profile.countryCodes as CountryCode[],
      language: profile.language,
      access_token: accessToken,
      ...(profile.redirectUri ? { redirect_uri: profile.redirectUri } : {})
    });
    const sessionId = randomUUID();

    await this.pool.query(
      `INSERT INTO connector.link_sessions (
         id, profile_id, mode, item_id, expires_at
       ) VALUES ($1, $2, 'update', $3, $4)`,
      [sessionId, profile.id, item.id, response.data.expiration]
    );

    return {
      linkToken: response.data.link_token,
      sessionId,
      expiration: response.data.expiration
    };
  }

  async exchangePublicToken(input: {
    sessionId: string;
    publicToken: string;
    metadata: LinkSuccessMetadata;
    allowDuplicate: boolean;
  }): Promise<{ itemId: string; institutionName: string | null }> {
    const session = await this.pool.query<{
      id: string;
      profile_id: string;
      expires_at: Date;
      consumed_at: Date | null;
      mode: string;
    }>(
      `SELECT id, profile_id, expires_at, consumed_at, mode
       FROM connector.link_sessions
       WHERE id = $1`,
      [input.sessionId]
    );
    const linkSession = session.rows[0];
    if (!linkSession) throw notFound("Link session not found");
    if (linkSession.mode !== "create") throw conflict("Not a create Link session");
    if (linkSession.consumed_at) throw conflict("Link session was already consumed");
    if (linkSession.expires_at.getTime() <= Date.now()) {
      throw conflict("Link session expired");
    }

    const profile = this.profiles.getById(linkSession.profile_id);
    if (!profile.enabled) {
      throw conflict("This Plaid profile is disabled");
    }
    if (!input.allowDuplicate) {
      const duplicate = await this.findPossibleDuplicate(
        profile.id,
        input.metadata
      );
      if (duplicate) {
        throw conflict(
          "A connection with matching institution and account details already exists",
          { duplicate }
        );
      }
    }

    const exchange = await profile.client.itemPublicTokenExchange({
      public_token: input.publicToken
    });
    const accessToken = exchange.data.access_token;
    const plaidItemId = exchange.data.item_id;
    const itemId = randomUUID();

    try {
      const encrypted = this.cipher.encrypt(
        accessToken,
        plaidTokenAssociatedData(profile.key, plaidItemId)
      );
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query(
          `INSERT INTO connector.plaid_items (
             id, profile_id, plaid_item_id, institution_id, institution_name,
             access_token_encrypted, status, consent_expiration_at,
             sync_requested_at, sync_requested_trigger
           )
           SELECT $1, p.id, $3, $4, $5, $6, 'active', $7, now(), 'initial'
           FROM connector.plaid_profiles p
           WHERE p.id = $2
             AND p.enabled = true
           RETURNING id`,
          [
            itemId,
            profile.id,
            plaidItemId,
            input.metadata.institution?.institution_id ?? null,
            input.metadata.institution?.name ?? null,
            encrypted,
            null
          ]
        );
        if (!inserted.rowCount) {
          throw conflict("This Plaid profile was disabled during Link");
        }
        await client.query(
          `UPDATE connector.link_sessions
           SET consumed_at = now()
           WHERE id = $1`,
          [input.sessionId]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      return {
        itemId,
        institutionName: input.metadata.institution?.name ?? null
      };
    } catch (error) {
      try {
        await profile.client.itemRemove({ access_token: accessToken });
      } catch {
        // Preserve the original failure. Plaid request IDs are surfaced by the caller.
      }
      throw error;
    }
  }

  async markUpdateComplete(sessionId: string): Promise<void> {
    const result = await this.pool.query<{ id: string }>(
      `WITH claimed AS (
         UPDATE connector.link_sessions s
         SET consumed_at = now()
         FROM connector.plaid_items i, connector.plaid_profiles p
         WHERE s.id = $1
           AND s.mode = 'update'
           AND s.item_id = i.id
           AND p.id = i.profile_id
           AND p.enabled = true
           AND i.status NOT IN ('disabled', 'removed')
           AND i.access_token_encrypted IS NOT NULL
           AND s.consumed_at IS NULL
           AND s.expires_at > now()
         RETURNING s.item_id
       )
       UPDATE connector.plaid_items i
       SET status = 'active',
           sync_requested_at = now(),
           sync_requested_trigger = 'recovery',
           next_sync_attempt_at = null,
           sync_failure_count = 0,
           last_error_code = null,
           last_error_message = null,
           updated_at = now()
       FROM claimed
       WHERE i.id = claimed.item_id
       RETURNING i.id`,
      [sessionId]
    );
    if (!result.rows[0]) {
      throw conflict("Update Link session is invalid or expired");
    }
  }

  async requestSync(itemId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE connector.plaid_items
       SET sync_requested_at = now(),
           sync_requested_trigger = 'manual',
           next_sync_attempt_at = null,
           updated_at = now()
       WHERE id = $1
         AND status IN ('active', 'error', 'syncing')
       RETURNING id`,
      [itemId]
    );
    if (!result.rowCount) throw notFound("Syncable Item not found");
  }

  async setAccountHidden(accountId: string, hidden: boolean): Promise<void> {
    const result = await this.pool.query(
      `UPDATE finance.accounts
       SET hidden = $2, updated_at = now()
       WHERE id = $1
       RETURNING id`,
      [accountId, hidden]
    );
    if (!result.rowCount) throw notFound("Account not found");
  }

  async removeItem(itemId: string): Promise<void> {
    const lockClient = await this.pool.connect();
    try {
      await lockClient.query(
        "SELECT pg_advisory_lock(hashtextextended($1, 0))",
        [itemId]
      );
      const item = await this.getItemSecret(itemId);
      const profile = this.profiles.getById(item.profile_id);
      const accessToken = this.decryptAccessToken(item, profile);

      try {
        await profile.client.itemRemove({ access_token: accessToken });
      } catch (error) {
        const parsed = parsePlaidError(error);
        if (parsed.errorCode !== "ITEM_NOT_FOUND") throw error;
      }

      await this.pool.query(
        `UPDATE connector.plaid_items
         SET status = 'removed',
             access_token_encrypted = null,
             sync_requested_at = null,
             sync_requested_trigger = null,
             removed_at = now(),
             updated_at = now()
         WHERE id = $1`,
        [itemId]
      );
    } finally {
      await lockClient.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [itemId]
      );
      lockClient.release();
    }
  }

  private async getItemSecret(itemId: string): Promise<ItemSecretRow> {
    const result = await this.pool.query<ItemSecretRow>(
      `SELECT id, profile_id, plaid_item_id, access_token_encrypted, status
       FROM connector.plaid_items
       WHERE id = $1`,
      [itemId]
    );
    const item = result.rows[0];
    if (!item || item.status === "removed") throw notFound("Item not found");
    return item;
  }

  private decryptAccessToken(
    item: ItemSecretRow,
    profile: RegisteredPlaidProfile
  ): string {
    if (!item.access_token_encrypted) {
      throw conflict("Item no longer has an active access token");
    }
    return this.cipher.decrypt(
      item.access_token_encrypted,
      plaidTokenAssociatedData(profile.key, item.plaid_item_id)
    );
  }

  private async findPossibleDuplicate(
    profileId: string,
    metadata: LinkSuccessMetadata
  ): Promise<unknown | undefined> {
    const institutionId = metadata.institution?.institution_id;
    const accounts = metadata.accounts ?? [];
    if (!institutionId || accounts.length === 0) return undefined;

    const result = await this.pool.query<{
      id: string;
      institution_name: string | null;
      name: string;
      mask: string | null;
    }>(
      `SELECT i.id, i.institution_name, a.name, a.mask
       FROM connector.plaid_items i
       JOIN finance.accounts a ON a.item_id = i.id
       WHERE i.profile_id = $1
         AND i.institution_id = $2
         AND i.status <> 'removed'`,
      [profileId, institutionId]
    );

    const match = result.rows.find((existing) =>
      accounts.some(
        (account) =>
          account.name === existing.name &&
          (account.mask ?? null) === existing.mask
      )
    );
    if (!match) return undefined;

    return {
      itemId: match.id,
      institutionName: match.institution_name,
      accountName: match.name,
      mask: match.mask
    };
  }
}
