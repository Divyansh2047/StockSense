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

CREATE TYPE user_role AS ENUM ('manager', 'staff');
CREATE TYPE location_type AS ENUM ('internal', 'vendor', 'customer', 'inventory');
CREATE TYPE operation_type AS ENUM ('receipt', 'delivery', 'internal', 'adjustment');
CREATE TYPE operation_status AS ENUM ('draft', 'waiting', 'ready', 'done', 'canceled');
CREATE TYPE partner_kind AS ENUM ('vendor', 'customer', 'both');

-- ---------------------------------------------------------------- users & auth
CREATE TABLE users (
  id             BIGSERIAL PRIMARY KEY,
  login_id       TEXT        NOT NULL CHECK (char_length(login_id) BETWEEN 6 AND 12),
  email          TEXT        NOT NULL CHECK (position('@' IN email) > 1),
  name           TEXT        NOT NULL DEFAULT '',
  password_hash  TEXT        NOT NULL,
  role           user_role   NOT NULL DEFAULT 'manager',
  token_version  INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_login_id_uq ON users (lower(login_id));
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE password_resets (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  otp_hash    TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER     NOT NULL DEFAULT 0,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id, created_at DESC);

-- ---------------------------------------------------------------- warehouses & locations
CREATE TABLE warehouses (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT        NOT NULL CHECK (char_length(name) > 0),
  short_code  TEXT        NOT NULL CHECK (short_code ~ '^[A-Za-z0-9]{1,8}$'),
  address     TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX warehouses_short_code_uq ON warehouses (upper(short_code));

CREATE TABLE locations (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT          NOT NULL CHECK (char_length(name) > 0),
  short_code    TEXT          NOT NULL CHECK (short_code ~ '^[A-Za-z0-9_-]{1,16}$'),
  warehouse_id  BIGINT        REFERENCES warehouses (id) ON DELETE RESTRICT,
  type          location_type NOT NULL DEFAULT 'internal',
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- internal locations always belong to a warehouse, virtual ones never do
  CONSTRAINT locations_warehouse_ck CHECK ((type = 'internal') = (warehouse_id IS NOT NULL))
);
CREATE UNIQUE INDEX locations_code_uq ON locations (warehouse_id, upper(short_code)) WHERE warehouse_id IS NOT NULL;
CREATE UNIQUE INDEX locations_virtual_type_uq ON locations (type) WHERE type <> 'internal';

-- The three virtual locations every installation needs.
INSERT INTO locations (name, short_code, type) VALUES
  ('Vendors', 'Vendors', 'vendor'),
  ('Customers', 'Customers', 'customer'),
  ('Inventory adjustment', 'Adjustment', 'inventory');

-- ---------------------------------------------------------------- catalog
CREATE TABLE categories (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT        NOT NULL CHECK (char_length(name) > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_name_uq ON categories (lower(name));

CREATE TABLE products (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT          NOT NULL CHECK (char_length(name) > 0),
  sku          TEXT          NOT NULL CHECK (sku ~ '^[A-Za-z0-9._-]{1,32}$'),
  category_id  BIGINT        REFERENCES categories (id) ON DELETE SET NULL,
  uom          TEXT          NOT NULL DEFAULT 'Units',
  unit_cost    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  -- reordering rule: alert at or below min, replenish up to max
  reorder_min  NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (reorder_min >= 0),
  reorder_max  NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (reorder_max >= 0),
  archived     BOOLEAN       NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_sku_uq ON products (upper(sku));
CREATE INDEX products_category_idx ON products (category_id);
CREATE INDEX products_name_idx ON products (lower(name));

-- ---------------------------------------------------------------- partners (vendors / customers)
CREATE TABLE partners (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT         NOT NULL CHECK (char_length(name) > 0),
  kind        partner_kind NOT NULL DEFAULT 'both',
  email       TEXT         NOT NULL DEFAULT '',
  phone       TEXT         NOT NULL DEFAULT '',
  address     TEXT         NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX partners_name_uq ON partners (lower(name));

-- ---------------------------------------------------------------- stock
CREATE TABLE stock_quants (
  product_id   BIGINT        NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  location_id  BIGINT        NOT NULL REFERENCES locations (id) ON DELETE RESTRICT,
  quantity     NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reserved     NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, location_id),
  CONSTRAINT stock_quants_reserved_ck CHECK (reserved <= quantity)
);
CREATE INDEX stock_quants_location_idx ON stock_quants (location_id);

-- ---------------------------------------------------------------- operations (pickings)
CREATE TABLE operations (
  id                  BIGSERIAL PRIMARY KEY,
  reference           TEXT             NOT NULL,
  type                operation_type   NOT NULL,
  status              operation_status NOT NULL DEFAULT 'draft',
  warehouse_id        BIGINT           NOT NULL REFERENCES warehouses (id) ON DELETE RESTRICT,
  partner_id          BIGINT           REFERENCES partners (id) ON DELETE SET NULL,
  source_location_id  BIGINT           NOT NULL REFERENCES locations (id) ON DELETE RESTRICT,
  dest_location_id    BIGINT           NOT NULL REFERENCES locations (id) ON DELETE RESTRICT,
  scheduled_date      DATE             NOT NULL DEFAULT CURRENT_DATE,
  responsible_id      BIGINT           REFERENCES users (id) ON DELETE SET NULL,
  delivery_address    TEXT             NOT NULL DEFAULT '',
  notes               TEXT             NOT NULL DEFAULT '',
  created_by          BIGINT           REFERENCES users (id) ON DELETE SET NULL,
  validated_by        BIGINT           REFERENCES users (id) ON DELETE SET NULL,
  validated_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),
  CONSTRAINT operations_locations_ck CHECK (source_location_id <> dest_location_id)
);
CREATE UNIQUE INDEX operations_reference_uq ON operations (reference);
CREATE INDEX operations_type_status_idx ON operations (type, status);
CREATE INDEX operations_scheduled_idx ON operations (scheduled_date);
CREATE INDEX operations_warehouse_idx ON operations (warehouse_id);

CREATE TABLE operation_lines (
  id                BIGSERIAL PRIMARY KEY,
  operation_id      BIGINT        NOT NULL REFERENCES operations (id) ON DELETE CASCADE,
  product_id        BIGINT        NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  -- demand for receipts / deliveries / transfers; counted quantity for adjustments
  quantity          NUMERIC(14,3) NOT NULL CHECK (quantity >= 0),
  reserved          NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  -- adjustments only: what the system held when the count was validated
  system_quantity   NUMERIC(14,3),
  position          INTEGER       NOT NULL DEFAULT 0,
  CONSTRAINT operation_lines_product_uq UNIQUE (operation_id, product_id)
);
CREATE INDEX operation_lines_product_idx ON operation_lines (product_id);

-- Per-warehouse running numbers for references like WH/IN/0001.
CREATE TABLE sequences (
  warehouse_id  BIGINT  NOT NULL REFERENCES warehouses (id) ON DELETE CASCADE,
  code          TEXT    NOT NULL,
  next_value    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (warehouse_id, code)
);

-- ---------------------------------------------------------------- the ledger
CREATE TABLE stock_moves (
  id                BIGSERIAL PRIMARY KEY,
  operation_id      BIGINT         REFERENCES operations (id) ON DELETE SET NULL,
  reference         TEXT           NOT NULL,
  kind              operation_type NOT NULL,
  product_id        BIGINT         NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  from_location_id  BIGINT         NOT NULL REFERENCES locations (id) ON DELETE RESTRICT,
  to_location_id    BIGINT         NOT NULL REFERENCES locations (id) ON DELETE RESTRICT,
  quantity          NUMERIC(14,3)  NOT NULL CHECK (quantity > 0),
  unit_cost         NUMERIC(14,2)  NOT NULL DEFAULT 0,
  partner_id        BIGINT         REFERENCES partners (id) ON DELETE SET NULL,
  user_id           BIGINT         REFERENCES users (id) ON DELETE SET NULL,
  done_at           TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE INDEX stock_moves_done_at_idx ON stock_moves (done_at DESC);
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
