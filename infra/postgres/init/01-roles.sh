#!/usr/bin/env bash
set -euo pipefail

: "${POSTGRES_DB:=lomi}"
: "${POSTGRES_USER:=postgres}"
: "${POSTGRES_MIGRATOR_PASSWORD:=dev-migrator}"
: "${POSTGRES_APP_PASSWORD:=dev-app}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v db_name="$POSTGRES_DB" \
  -v migrator_pw="$POSTGRES_MIGRATOR_PASSWORD" \
  -v app_pw="$POSTGRES_APP_PASSWORD" <<'EOSQL'
SELECT set_config('app.init_migrator_pw', :'migrator_pw', false);
SELECT set_config('app.init_app_pw', :'app_pw', false);

DO $$
DECLARE
  v_migrator_pw text := current_setting('app.init_migrator_pw');
  v_app_pw text := current_setting('app.init_app_pw');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrator') THEN
    EXECUTE format('CREATE ROLE migrator LOGIN PASSWORD %L', v_migrator_pw);
  ELSE
    EXECUTE format('ALTER ROLE migrator WITH LOGIN PASSWORD %L', v_migrator_pw);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    EXECUTE format('CREATE ROLE app LOGIN PASSWORD %L', v_app_pw);
  ELSE
    EXECUTE format('ALTER ROLE app WITH LOGIN PASSWORD %L', v_app_pw);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maintainer') THEN
    CREATE ROLE maintainer NOLOGIN;
  END IF;
END
$$;

ALTER DATABASE :"db_name" OWNER TO migrator;
ALTER SCHEMA public OWNER TO migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO migrator, app;
GRANT USAGE, CREATE ON SCHEMA public TO migrator;
GRANT USAGE ON SCHEMA public TO app;
EOSQL
