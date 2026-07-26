import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AccountBase } from "plaid";

export async function upsertAccounts(
  client: pg.PoolClient,
  itemId: string,
  accounts: AccountBase[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  for (const account of accounts) {
    const id = randomUUID();
    const row = await client.query<{ id: string }>(
      `INSERT INTO finance.accounts (
         id, item_id, plaid_account_id, persistent_account_id,
         name, official_name, mask, type, subtype,
         iso_currency_code, unofficial_currency_code,
         current_balance, available_balance, credit_limit, raw_payload
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15::jsonb
       )
       ON CONFLICT (item_id, plaid_account_id) DO UPDATE SET
         persistent_account_id = EXCLUDED.persistent_account_id,
         name = EXCLUDED.name,
         official_name = EXCLUDED.official_name,
         mask = EXCLUDED.mask,
         type = EXCLUDED.type,
         subtype = EXCLUDED.subtype,
         iso_currency_code = EXCLUDED.iso_currency_code,
         unofficial_currency_code = EXCLUDED.unofficial_currency_code,
         current_balance = EXCLUDED.current_balance,
         available_balance = EXCLUDED.available_balance,
         credit_limit = EXCLUDED.credit_limit,
         active = true,
         raw_payload = EXCLUDED.raw_payload,
         updated_at = now()
       RETURNING id`,
      [
        id,
        itemId,
        account.account_id,
        account.persistent_account_id ?? null,
        account.name,
        account.official_name,
        account.mask,
        account.type,
        account.subtype,
        account.balances.iso_currency_code,
        account.balances.unofficial_currency_code,
        account.balances.current,
        account.balances.available,
        account.balances.limit,
        JSON.stringify(account)
      ]
    );
    const databaseId = row.rows[0]?.id;
    if (!databaseId) {
      throw new Error(`Failed to upsert Plaid account ${account.account_id}`);
    }
    result.set(account.account_id, databaseId);
  }

  return result;
}
