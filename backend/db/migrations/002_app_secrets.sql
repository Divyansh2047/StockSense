-- Server-generated secrets (for example the session signing key when JWT_SECRET is
-- not provided). Read only by the owner connection at boot, never by tenant requests.
CREATE TABLE app_secrets (
  name        TEXT        PRIMARY KEY,
  value       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_secrets FORCE ROW LEVEL SECURITY;
-- no policy for app.bypass: only an explicit owner-scoped read can see it
CREATE POLICY boot_only ON app_secrets USING (current_setting('app.secrets', true) = 'on')
  WITH CHECK (current_setting('app.secrets', true) = 'on');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stocksense_tenant') THEN
    REVOKE ALL ON app_secrets FROM stocksense_tenant;
  END IF;
END $$;
