-- The hosted app (clips.zabimaru.me): who signed in, which bucket is theirs,
-- and what the app knows about their clips. Self-hosted apps don't use D1.

CREATE TABLE users (
  id TEXT PRIMARY KEY,          -- the Cloudflare user ID
  email TEXT NOT NULL,
  created INTEGER NOT NULL
);

-- Sessions are random IDs; only their SHA-256 is stored.
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);

-- One bucket per user. The key only works for that bucket. Its secret and
-- OBS's upload token are encrypted with CREDS_KEY version key_version.
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  bucket TEXT NOT NULL,
  access_key_id TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_by_app INTEGER NOT NULL,  -- 1 when automatic setup made the bucket
  obs_token_hash TEXT NOT NULL,  -- SHA-256 of OBS's upload token
  obs_token_enc TEXT NOT NULL,   -- the token, to show it again in setup
  obs_seen INTEGER,
  settings TEXT,
  last_cleanup INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE INDEX tenants_by_cleanup ON tenants (last_cleanup);

-- Automatic storage setups in progress, one per user at a time.
CREATE TABLE setups (
  user_id TEXT PRIMARY KEY,
  started INTEGER NOT NULL
);

CREATE TABLE thumbs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  duration REAL NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  v TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  expires INTEGER,
  etag TEXT  -- the shared recording; a replaced file doesn't inherit the link
);
CREATE INDEX shares_by_clip ON shares (tenant_id, key);

-- Uploads in progress. A key is reserved here before its upload starts, so
-- two saves at once never land on the same name.
CREATE TABLE uploads (
  upload_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX uploads_by_key ON uploads (tenant_id, key);
