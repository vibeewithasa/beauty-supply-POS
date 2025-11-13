-- Enums
DO $$ BEGIN
  CREATE TYPE role AS ENUM ('admin', 'vendor');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE product_status AS ENUM ('active', 'inactive');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE inventory_type AS ENUM ('IN', 'OUT', 'ADJUST', 'DELETE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE cash_movement_type AS ENUM ('IN', 'OUT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('cash', 'card');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE cash_session_status AS ENUM ('open', 'closed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Users
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  pin_hash TEXT NOT NULL,
  role role NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Products
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  price NUMERIC(12,2) NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  barcode VARCHAR(128),
  category VARCHAR(128),
  status product_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Inventory movements
CREATE TABLE IF NOT EXISTS inventory_movements (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  type inventory_type NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Deleted products log
CREATE TABLE IF NOT EXISTS deleted_products_log (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  deleted_by INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  deleted_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Price changes
CREATE TABLE IF NOT EXISTS price_changes (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  old_price NUMERIC(12,2) NOT NULL,
  new_price NUMERIC(12,2) NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Cash sessions
CREATE TABLE IF NOT EXISTS cash_sessions (
  id SERIAL PRIMARY KEY,
  opened_by INTEGER NOT NULL REFERENCES users(id),
  opened_at TIMESTAMP NOT NULL DEFAULT NOW(),
  initial_amount NUMERIC(12,2) NOT NULL,
  status cash_session_status NOT NULL DEFAULT 'open',
  closed_by INTEGER,
  closed_at TIMESTAMP,
  expected_total NUMERIC(12,2),
  real_total NUMERIC(12,2)
);

-- Cash movements
CREATE TABLE IF NOT EXISTS cash_movements (
  id SERIAL PRIMARY KEY,
  cash_session_id INTEGER NOT NULL REFERENCES cash_sessions(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  type cash_movement_type NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Sales
CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  cashier_id INTEGER NOT NULL REFERENCES users(id),
  cash_session_id INTEGER NOT NULL REFERENCES cash_sessions(id),
  total NUMERIC(12,2) NOT NULL,
  payment_method payment_method NOT NULL,
  card_auth_code VARCHAR(128),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Sale items
CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  subtotal NUMERIC(12,2) NOT NULL
);

-- Returns
CREATE TABLE IF NOT EXISTS returns (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount NUMERIC(12,2) NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Return items
CREATE TABLE IF NOT EXISTS return_items (
  id SERIAL PRIMARY KEY,
  return_id INTEGER NOT NULL REFERENCES returns(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL
);
