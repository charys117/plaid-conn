CREATE SCHEMA IF NOT EXISTS connector;
CREATE SCHEMA IF NOT EXISTS finance;
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE connector.plaid_profiles (
  id uuid PRIMARY KEY,
  profile_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  client_id text NOT NULL,
  country_codes text[] NOT NULL,
  language text NOT NULL,
  days_requested integer NOT NULL CHECK (days_requested BETWEEN 1 AND 730),
  enabled boolean NOT NULL DEFAULT true,
  config_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (profile_key ~ '^[a-z][a-z0-9_-]{0,63}$')
);

CREATE TABLE connector.plaid_items (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES connector.plaid_profiles(id),
  plaid_item_id text NOT NULL,
  institution_id text,
  institution_name text,
  access_token_encrypted text,
  sync_cursor text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'syncing', 'login_required', 'error', 'disabled', 'removed')),
  consent_expiration_at timestamptz,
  sync_requested_at timestamptz,
  sync_requested_trigger text
    CHECK (sync_requested_trigger IN ('initial', 'webhook', 'scheduled', 'manual', 'recovery')),
  next_sync_attempt_at timestamptz,
  sync_failure_count integer NOT NULL DEFAULT 0,
  last_sync_started_at timestamptz,
  last_sync_succeeded_at timestamptz,
  last_plaid_update_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  UNIQUE (profile_id, plaid_item_id)
);

CREATE INDEX plaid_items_profile_status_idx
  ON connector.plaid_items (profile_id, status);
CREATE INDEX plaid_items_sync_due_idx
  ON connector.plaid_items (
    COALESCE(sync_requested_at, last_sync_succeeded_at, created_at),
    next_sync_attempt_at
  )
  WHERE status IN ('active', 'error');

CREATE TABLE connector.link_sessions (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES connector.plaid_profiles(id),
  mode text NOT NULL CHECK (mode IN ('create', 'update')),
  item_id uuid REFERENCES connector.plaid_items(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX link_sessions_expiry_idx
  ON connector.link_sessions (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE finance.accounts (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES connector.plaid_items(id),
  plaid_account_id text NOT NULL,
  persistent_account_id text,
  name text NOT NULL,
  official_name text,
  mask text,
  type text NOT NULL,
  subtype text,
  iso_currency_code text,
  unofficial_currency_code text,
  current_balance numeric(20, 6),
  available_balance numeric(20, 6),
  credit_limit numeric(20, 6),
  hidden boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  raw_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, plaid_account_id)
);

CREATE INDEX accounts_item_idx ON finance.accounts (item_id);
CREATE INDEX accounts_type_idx ON finance.accounts (type, subtype);

CREATE TABLE ops.sync_runs (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES connector.plaid_items(id),
  trigger text NOT NULL CHECK (trigger IN ('initial', 'webhook', 'scheduled', 'manual', 'recovery')),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  cursor_before text,
  cursor_after text,
  added_count integer NOT NULL DEFAULT 0,
  modified_count integer NOT NULL DEFAULT 0,
  removed_count integer NOT NULL DEFAULT 0,
  page_count integer NOT NULL DEFAULT 0,
  plaid_request_id text,
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX sync_runs_item_started_idx
  ON ops.sync_runs (item_id, started_at DESC);
CREATE INDEX sync_runs_status_started_idx
  ON ops.sync_runs (status, started_at DESC);

CREATE TABLE finance.transactions (
  id bigserial PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES connector.plaid_items(id),
  account_id uuid NOT NULL REFERENCES finance.accounts(id),
  plaid_transaction_id text NOT NULL,
  amount numeric(20, 6) NOT NULL,
  iso_currency_code text,
  unofficial_currency_code text,
  transaction_date date NOT NULL,
  authorized_date date,
  transaction_datetime timestamptz,
  authorized_datetime timestamptz,
  name text NOT NULL,
  merchant_name text,
  original_description text,
  payment_channel text,
  pending boolean NOT NULL,
  pending_transaction_id text,
  category_primary text,
  category_detailed text,
  category_confidence text,
  website text,
  logo_url text,
  location jsonb,
  counterparties jsonb,
  raw_payload jsonb NOT NULL,
  removed_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, plaid_transaction_id)
);

CREATE INDEX transactions_date_idx
  ON finance.transactions (transaction_date DESC)
  WHERE removed_at IS NULL;
CREATE INDEX transactions_account_date_idx
  ON finance.transactions (account_id, transaction_date DESC)
  WHERE removed_at IS NULL;
CREATE INDEX transactions_item_date_idx
  ON finance.transactions (item_id, transaction_date DESC)
  WHERE removed_at IS NULL;
CREATE INDEX transactions_category_date_idx
  ON finance.transactions (category_primary, transaction_date DESC)
  WHERE removed_at IS NULL;
CREATE INDEX transactions_merchant_date_idx
  ON finance.transactions (merchant_name, transaction_date DESC)
  WHERE removed_at IS NULL;
CREATE INDEX transactions_pending_idx
  ON finance.transactions (pending, transaction_date DESC)
  WHERE removed_at IS NULL;

CREATE TABLE finance.account_balance_snapshots (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES finance.accounts(id),
  sync_run_id uuid NOT NULL REFERENCES ops.sync_runs(id),
  observed_at timestamptz NOT NULL DEFAULT now(),
  current_balance numeric(20, 6),
  available_balance numeric(20, 6),
  credit_limit numeric(20, 6),
  iso_currency_code text,
  unofficial_currency_code text,
  UNIQUE (account_id, sync_run_id)
);

CREATE INDEX account_balance_snapshots_account_time_idx
  ON finance.account_balance_snapshots (account_id, observed_at DESC);

CREATE TABLE ops.webhook_receipts (
  id bigserial PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES connector.plaid_profiles(id),
  plaid_item_id text,
  webhook_type text,
  webhook_code text,
  verification_kid text NOT NULL,
  payload_sha256 text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (profile_id, payload_sha256)
);

CREATE INDEX webhook_receipts_item_time_idx
  ON ops.webhook_receipts (plaid_item_id, received_at DESC);

COMMENT ON COLUMN finance.transactions.amount IS
  'Original Plaid amount: positive means money leaving the account; negative means money entering it.';
COMMENT ON COLUMN finance.transactions.removed_at IS
  'Set when Plaid reports this transaction in the removed collection. Null means currently active.';
COMMENT ON COLUMN connector.plaid_items.sync_cursor IS
  'Item-level /transactions/sync cursor. Updated only after a complete page set commits.';
