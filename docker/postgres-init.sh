#!/bin/sh
set -eu

psql \
  --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=app_password="$APP_DATABASE_PASSWORD" \
  --set=db_name="$POSTGRES_DB" <<'SQL'
CREATE ROLE plaid_app LOGIN PASSWORD :'app_password';
ALTER DATABASE :"db_name" OWNER TO plaid_app;
SQL
