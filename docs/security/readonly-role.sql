-- kz_pgw_ro: read-only Postgres role for kz-pgw-mcp users (staging cluster kz-api-global).
-- Replaces handing out the kz-api app role (pg_write_all_data, CREATEROLE, CREATEDB).
--
-- Run as an admin (rds_superuser or owner "kz-api") with psql:
--   psql "host=<PGHOST> dbname=postgres user=<admin>" -v pw="'<new password>'" -f readonly-role.sql
--
-- Part 1 runs once. Part 2 runs in EVERY kz-* database (privileges are per database).
-- Safe to re-run. Re-running Part 1 just re-sets the same password.
-- Run as "kz-api" (table owner) or rds_superuser: GRANT on its tables and
-- ALTER DEFAULT PRIVILEGES FOR ROLE "kz-api" need one of those.

\set ON_ERROR_STOP on

-- ===== Part 1: role (once per cluster) =====

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kz_pgw_ro') THEN
    CREATE ROLE kz_pgw_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 20;
  END IF;
END $$;

ALTER ROLE kz_pgw_ro PASSWORD :pw;
-- Belt and braces: every session starts read-only, short timeouts.
ALTER ROLE kz_pgw_ro SET default_transaction_read_only = on;
ALTER ROLE kz_pgw_ro SET statement_timeout = '30s';
ALTER ROLE kz_pgw_ro SET lock_timeout = '2s';
ALTER ROLE kz_pgw_ro SET idle_in_transaction_session_timeout = '60s';

-- ===== Part 2: grants (repeat per database) =====
-- \connect kz-tpg1   then run below; repeat for kz-ttg1, kz-tig1, kz-tco, kz-tpk1, kz-tph1, kz-tth1,
-- kz-tbd1, kz-tgg, kz-tpe, kz-api. Skip kz_monitoring, kz-gameboy unless needed.


DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO kz_pgw_ro', current_database()); END $$;
GRANT USAGE ON SCHEMA public TO kz_pgw_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO kz_pgw_ro;
-- New tables created by the app (migrations, pg_partman partitions) are readable too.
ALTER DEFAULT PRIVILEGES FOR ROLE "kz-api" IN SCHEMA public GRANT SELECT ON TABLES TO kz_pgw_ro;

-- Hide secret columns. Column grants are additive, so drop the table grant and
-- re-grant every column except the hidden one. Joins on the other columns keep working.
DO $$
DECLARE
  hidden CONSTANT text[][] := ARRAY[
    ['credential',      'secret'],  -- password hashes, AES-encrypted TOTP secrets
    ['fundingProvider', 'config'],  -- PGW merchant keys
    ['smsProvider',     'config'],  -- SMS provider keys
    ['passwordRequest', 'code'],    -- password reset codes
    ['platformInvite',  'token']    -- staff invite tokens
  ];
  t text;
  c text;
  cols text;
BEGIN
  FOR i IN 1 .. array_length(hidden, 1) LOOP
    t := hidden[i][1];
    c := hidden[i][2];
    CONTINUE WHEN to_regclass(format('public.%I', t)) IS NULL;
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = t AND column_name <> c;
    EXECUTE format('REVOKE SELECT ON public.%I FROM kz_pgw_ro', t);
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO kz_pgw_ro', cols, t);
  END LOOP;
END $$;

-- ===== Check (run as kz_pgw_ro) =====
-- SELECT pg_has_role('pg_write_all_data', 'MEMBER');            -- false
-- SELECT has_table_privilege('"fundingTx"', 'INSERT,UPDATE');   -- false
-- SELECT has_column_privilege('credential', 'secret', 'SELECT'); -- false
-- SELECT count(*) FROM "fundingTx";                             -- works
-- Or: npx -y @valoquang/kz-pgw-mcp doctor                        -- prints "db role: read-only"
