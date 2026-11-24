-- Shares pin the thumbnail too, so a replaced thumbnail never shows on an
-- old link. Shares without a pinned recording can't be trusted: turn them off.
ALTER TABLE shares ADD COLUMN thumb_etag TEXT;
DELETE FROM shares WHERE etag IS NULL OR etag = '';

-- Clean-up only starts in a bucket you connected yourself once you pick the
-- lengths in Settings, since it may hold clips the app never saw.
ALTER TABLE tenants ADD COLUMN cleanup_on INTEGER NOT NULL DEFAULT 1;
UPDATE tenants SET cleanup_on = 0 WHERE created_by_app = 0;

-- When each bucket's clean-up is due next. A failing bucket backs off, so
-- it can't keep the others waiting.
ALTER TABLE tenants ADD COLUMN next_cleanup INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN cleanup_failures INTEGER NOT NULL DEFAULT 0;
DROP INDEX tenants_by_cleanup;
CREATE INDEX tenants_by_next_cleanup ON tenants (next_cleanup);

-- What a failed automatic setup made and couldn't remove, so it can be
-- found and deleted. IDs only, never key values.
CREATE TABLE leftovers (
  user_id TEXT NOT NULL,
  account TEXT NOT NULL,
  bucket TEXT,
  token_id TEXT,
  created INTEGER NOT NULL
);
