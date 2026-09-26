-- StockSense initial schema.
--
-- Stock model (borrowed from how Odoo thinks about inventory):
--   * locations are either internal (belong to a warehouse, hold stock) or virtual
--     (vendors, customers, inventory adjustment) which only ever appear as the
--     other side of a move.
--   * stock_quants holds the on-hand and reserved quantity of a product at an
--     internal location. It is the only place current stock lives.
--   * stock_moves is the append-only ledger. Every validated operation writes one
--     row per product line, so "what happened and where it went" is always
--     answerable.

-- Tenancy: every signup creates its own company (workspace). All business rows carry
-- company_id, filled from the per-request setting app.company_id, and row-level
-- security hides every other company's rows from the application role. Composite
-- foreign keys (company_id, id) make it impossible to point at another company's
-- product, location or partner even by guessing an id.

CREATE FUNCTION app_company() RETURNS BIGINT LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.company_id', true), '')::bigint $$;
CREATE FUNCTION app_bypass() RETURNS BOOLEAN LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.bypass', true), '') = 'on' $$;

CREATE TABLE companies (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  is_sandbox  BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE user_role AS ENUM ('manager', 'staff');
CREATE TYPE location_type AS ENUM ('internal', 'vendor', 'customer', 'inventory');
CREATE TYPE operation_type AS ENUM ('receipt', 'delivery', 'internal', 'adjustment');
CREATE TYPE operation_status AS ENUM ('draft', 'waiting', 'ready', 'done', 'canceled');
CREATE TYPE partner_kind AS ENUM ('vendor', 'customer', 'both');

-- ---------------------------------------------------------------- users & auth
CREATE TABLE users (
  company_id BIGINT NOT NULL DEFAULT app_company() REFERENCES companies (id) ON DELETE CASCADE,
  id             BIGSERIAL PRIMARY KEY,
  login_id       TEXT        NOT NULL CHECK (char_length(login_id) BETWEEN 6 AND 12),
  email          TEXT        NOT NULL CHECK (position('@' IN email) > 1),
  name           TEXT        NOT NULL DEFAULT '',
  password_hash  TEXT        NOT NULL,
  role           user_role   NOT NULL DEFAULT 'manager',
  token_version  INTEGER     NOT NULL DEFAULT 0,
  -- sign-in is blocked until the address is confirmed (code or link)
  email_verified_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- login ids and emails identify a person across the whole service
CREATE UNIQUE INDEX users_login_id_uq ON users (lower(login_id));
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE UNIQUE INDEX users_company_id_uq ON users (company_id, id);
CREATE INDEX users_company_idx ON users (company_id);

CREATE TABLE password_resets (
  company_id BIGINT NOT NULL DEFAULT app_company() REFERENCES companies (id) ON DELETE CASCADE,
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT,
  otp_hash    TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER     NOT NULL DEFAULT 0,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id, created_at DESC);
CREATE UNIQUE INDEX password_resets_token_uq ON password_resets (token_hash) WHERE token_hash IS NOT NULL;

-- One row per verification email: a 6-digit code (short lived, attempt limited) and a
-- link token (longer lived, single use). Only HMACs are stored.
CREATE TABLE email_verifications (
  id               BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL DEFAULT app_company() REFERENCES companies (id) ON DELETE CASCADE,
  user_id          BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email            TEXT        NOT NULL,
  code_hash        TEXT        NOT NULL,
  token_hash       TEXT        NOT NULL,
  code_expires_at  TIMESTAMPTZ NOT NULL,
  link_expires_at  TIMESTAMPTZ NOT NULL,
  attempts         INTEGER     NOT NULL DEFAULT 0,
  used_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_verifications_user_idx ON email_verifications (user_id, created_at DESC);
CREATE UNIQUE INDEX email_verifications_token_uq ON email_verifications (token_hash);

-- ---------------------------------------------------------------- warehouses & locations
CREATE TABLE warehouses (
  company_id BIGINT NOT NULL DEFAULT app_company() REFERENCES companies (id) ON DELETE CASCADE,
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT        NOT NULL CHECK (char_length(name) > 0),
  short_code  TEXT        NOT NULL CHECK (short_code ~ '^[A-Za-z0-9]{1,8}$'),
  address     TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX warehouses_short_code_uq ON warehouses (company_id, upper(short_code));
CREATE UNIQUE INDEX warehouses_company_id_uq ON warehouses (company_id, id);

CREATE TABLE locations (
  company_id BIGINT NOT NULL DEFAULT app_company() REFERENCES companies (id) ON DELETE CASCADE,
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT          NOT NULL CHECK (char_length(name) > 0),
  short_code    TEXT          NOT NULL CHECK (short_code ~ '^[A-Za-z0-9_-]{1,16}$'),
  warehouse_id  BIGINT,
  type          location_type NOT NULL DEFAULT 'internal',
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- internal locations always belong to a warehouse, virtual ones never do
  CONSTRAINT locations_warehouse_ck CHECK ((type = 'internal') = (warehouse_id IS NOT NULL)),
  CONSTRAINT locations_warehouse_fk FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses (company_id, id)
);
CREATE UNIQUE INDEX locations_code_uq ON locations (warehouse_id, upper(short_code)) WHERE warehouse_id IS NOT NULL;
CREATE UNIQUE INDEX locations_virtual_type_uq ON locations (company_id, type) WHERE type <> 'internal';
CREATE UNIQUE INDEX locations_company_id_uq ON locations (company_id, id);
-- The three virtual locations (Vendors, Customers, Inventory adjustment) are created
-- with each company, see createCompany() in src/modules/auth/company.ts.

-- ---------------------------------------------------------------- catalog
CREATE TABLE categories (
  company_id BIGINT NOT NULL DEFAULT app_company() REFERENCES companies (id) ON DELETE CASCADE,
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT        NOT NULL CHECK (char_length(name) > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_name_uq ON categories (company_id, lower(name));
CREATE UNIQUE INDEX categories_company_id_uq ON categories (company_id, id);

CREATE TABLE products (
  company_id BIGINT NOT NULL DEFAULT app_company() REFERENCES companies (id) ON DELETE CASCADE,
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT          NOT NULL CHECK (char_length(name) > 0),
  sku          TEXT          NOT NULL CHECK (sku ~ '^[A-Za-z0-9._-]{1,32}$'),
  category_id  BIGINT,
  uom          TEXT          NOT NULL DEFAULT 'Units',
  unit_cost    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  -- reordering rule: alert at or below min, replenish up to max
  reorder_min  NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (reorder_min >= 0),
  reorder_max  NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (reorder_max >= 0),
  archived     BOOLEAN       NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT products_category_fk FOREIGN KEY (company_id, category_id) REFERENCES categories (company_id, id) ON DELETE SET NULL (category_id)
);
CREATE UNIQUE INDEX products_sku_uq ON products (company_id, upper(sku));
CREATE UNIQUE INDEX products_company_id_uq ON products (company_id, id);
CREATE INDEX products_category_idx ON products (category_id);
CREATE INDEX products_name_idx ON products (lower(name));

-- ---------------------------------------------------------------- partners (vendors / customers)
CREATE TABLE partners (
  company_id BIGINT NOT NULL DEFAULT app_company() REFERENCES companies (id) ON DELETE CASCADE,
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT         NOT NULL CHECK (char_length(name) > 0),
  kind        partner_kind NOT NULL DEFAULT 'both',
  email       TEXT         NOT NULL DEFAULT '',
  phone       TEXT         NOT NULL DEFAULT '',
  address     TEXT         NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX partners_name_uq ON partners (company_id, lower(name));
CREATE UNIQUE INDEX partners_company_id_uq ON partners (company_id, id);

-- ---------------------------------------------------------------- stock
CREATE TABLE stock_quants (
  company_id BIGINT NOT NULL DEFAULT app_company() REFERENCES companies (id) ON DELETE CASCADE,
  product_id   BIGINT        NOT NULL,
  location_id  BIGINT        NOT NULL,
  quantity     NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reserved     NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, location_id),
  CONSTRAINT stock_quants_reserved_ck CHECK (reserved <= quantity),
  CONSTRAINT stock_quants_product_fk FOREIGN KEY (company_id, product_id) REFERENCES products (company_id, id),
  CONSTRAINT stock_quants_location_fk FOREIGN KEY (company_id, location_id) REFERENCES locations (company_id, id)
);
CREATE INDEX stock_quants_location_idx ON stock_quants (location_id);

-- ---------------------------------------------------------------- operations (pickings)
CREATE TABLE operations (
  company_id BIGINT NOT NULL DEFAULT app_company() REFERENCES companies (id) ON DELETE CASCADE,
  id                  BIGSERIAL PRIMARY KEY,
  reference           TEXT             NOT NULL,
  type                operation_type   NOT NULL,
  status              operation_status NOT NULL DEFAULT 'draft',
  warehouse_id        BIGINT           NOT NULL,
  partner_id          BIGINT,
  source_location_id  BIGINT           NOT NULL,
  dest_location_id    BIGINT           NOT NULL,
  scheduled_date      DATE             NOT NULL DEFAULT CURRENT_DATE,
  responsible_id      BIGINT,
  delivery_address    TEXT             NOT NULL DEFAULT '',
  notes               TEXT             NOT NULL DEFAULT '',
  created_by          BIGINT,
  validated_by        BIGINT,
  validated_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),
  CONSTRAINT operations_locations_ck CHECK (source_location_id <> dest_location_id),
  CONSTRAINT operations_warehouse_fk FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses (company_id, id),
  CONSTRAINT operations_partner_fk FOREIGN KEY (company_id, partner_id) REFERENCES partners (company_id, id) ON DELETE SET NULL (partner_id),
  CONSTRAINT operations_source_fk FOREIGN KEY (company_id, source_location_id) REFERENCES locations (company_id, id),
  CONSTRAINT operations_dest_fk FOREIGN KEY (company_id, dest_location_id) REFERENCES locations (company_id, id),
  CONSTRAINT operations_responsible_fk FOREIGN KEY (company_id, responsible_id) REFERENCES users (company_id, id) ON DELETE SET NULL (responsible_id),
  CONSTRAINT operations_created_by_fk FOREIGN KEY (company_id, created_by) REFERENCES users (company_id, id) ON DELETE SET NULL (created_by),
  CONSTRAINT operations_validated_by_fk FOREIGN KEY (company_id, validated_by) REFERENCES users (company_id, id) ON DELETE SET NULL (validated_by)
);
CREATE UNIQUE INDEX operations_reference_uq ON operations (company_id, reference);
CREATE UNIQUE INDEX operations_company_id_uq ON operations (company_id, id);
CREATE INDEX operations_type_status_idx ON operations (type, status);
CREATE INDEX operations_scheduled_idx ON operations (scheduled_date);
CREATE INDEX operations_warehouse_idx ON operations (warehouse_id);

CREATE TABLE operation_lines (
  company_id BIGINT NOT NULL DEFAULT app_company() REFERENCES companies (id) ON DELETE CASCADE,
  id                BIGSERIAL PRIMARY KEY,
  operation_id      BIGINT        NOT NULL,
  product_id        BIGINT        NOT NULL,
  -- demand for receipts / deliveries / transfers; counted quantity for adjustments
  quantity          NUMERIC(14,3) NOT NULL CHECK (quantity >= 0),
  reserved          NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  -- adjustments only: what the system held when the count was validated
  system_quantity   NUMERIC(14,3),
  position          INTEGER       NOT NULL DEFAULT 0,
  CONSTRAINT operation_lines_product_uq UNIQUE (operation_id, product_id),
  CONSTRAINT operation_lines_operation_fk FOREIGN KEY (company_id, operation_id) REFERENCES operations (company_id, id) ON DELETE CASCADE,
  CONSTRAINT operation_lines_product_fk FOREIGN KEY (company_id, product_id) REFERENCES products (company_id, id)
);
CREATE INDEX operation_lines_product_idx ON operation_lines (product_id);

-- Per-warehouse running numbers for references like WH/IN/0001.
CREATE TABLE sequences (
  company_id BIGINT NOT NULL DEFAULT app_company() REFERENCES companies (id) ON DELETE CASCADE,
  warehouse_id  BIGINT  NOT NULL,
  code          TEXT    NOT NULL,
  next_value    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (warehouse_id, code),
  CONSTRAINT sequences_warehouse_fk FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses (company_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- the ledger
CREATE TABLE stock_moves (
  company_id BIGINT NOT NULL DEFAULT app_company() REFERENCES companies (id) ON DELETE CASCADE,
  id                BIGSERIAL PRIMARY KEY,
  operation_id      BIGINT,
  reference         TEXT           NOT NULL,
  kind              operation_type NOT NULL,
  product_id        BIGINT         NOT NULL,
  from_location_id  BIGINT         NOT NULL,
  to_location_id    BIGINT         NOT NULL,
  quantity          NUMERIC(14,3)  NOT NULL CHECK (quantity > 0),
  unit_cost         NUMERIC(14,2)  NOT NULL DEFAULT 0,
  partner_id        BIGINT,
  user_id           BIGINT,
  done_at           TIMESTAMPTZ    NOT NULL DEFAULT now(),
  CONSTRAINT stock_moves_operation_fk FOREIGN KEY (company_id, operation_id) REFERENCES operations (company_id, id) ON DELETE SET NULL (operation_id),
  CONSTRAINT stock_moves_product_fk FOREIGN KEY (company_id, product_id) REFERENCES products (company_id, id),
  CONSTRAINT stock_moves_from_fk FOREIGN KEY (company_id, from_location_id) REFERENCES locations (company_id, id),
  CONSTRAINT stock_moves_to_fk FOREIGN KEY (company_id, to_location_id) REFERENCES locations (company_id, id),
  CONSTRAINT stock_moves_partner_fk FOREIGN KEY (company_id, partner_id) REFERENCES partners (company_id, id) ON DELETE SET NULL (partner_id),
  CONSTRAINT stock_moves_user_fk FOREIGN KEY (company_id, user_id) REFERENCES users (company_id, id) ON DELETE SET NULL (user_id)
);
CREATE INDEX stock_moves_done_at_idx ON stock_moves (company_id, done_at DESC);
CREATE INDEX stock_moves_product_idx ON stock_moves (product_id, done_at DESC);
CREATE INDEX stock_moves_reference_idx ON stock_moves (reference);
CREATE INDEX stock_moves_from_idx ON stock_moves (from_location_id);
CREATE INDEX stock_moves_to_idx ON stock_moves (to_location_id);

-- keep updated_at honest
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER warehouses_touch BEFORE UPDATE ON warehouses FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER locations_touch BEFORE UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER products_touch BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER operations_touch BEFORE UPDATE ON operations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER stock_quants_touch BEFORE UPDATE ON stock_quants FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER companies_touch BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------- row-level security
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'password_resets', 'email_verifications', 'warehouses', 'locations', 'categories', 'products', 'partners',
                           'stock_quants', 'operations', 'operation_lines', 'sequences', 'stock_moves'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_bypass() OR company_id = app_company())'
                   ' WITH CHECK (app_bypass() OR company_id = app_company())', t);
  END LOOP;
END $$;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON companies USING (app_bypass() OR id = app_company())
  WITH CHECK (app_bypass() OR id = app_company());

-- Superusers ignore row-level security, so when migrations run as one (for example the
-- default user of the postgres Docker image) the app switches to this plain role for
-- every connection. See src/db/pool.ts.
DO $$
BEGIN
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stocksense_tenant') THEN
      CREATE ROLE stocksense_tenant NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
    GRANT USAGE ON SCHEMA public TO stocksense_tenant;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stocksense_tenant;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stocksense_tenant;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stocksense_tenant;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO stocksense_tenant;
  END IF;
END $$;
