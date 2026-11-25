ALTER TABLE youtube_codes ADD COLUMN challenge TEXT;
ALTER TABLE youtube_clips ADD COLUMN nextSync INTEGER NOT NULL DEFAULT 0;
ALTER TABLE youtube_clips ADD COLUMN misses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE youtube_clips ADD COLUMN pendingTitle TEXT;
ALTER TABLE youtube_clips ADD COLUMN pendingDescription TEXT;
ALTER TABLE youtube_clips ADD COLUMN pendingPrivacy TEXT;
ALTER TABLE youtube_clips ADD COLUMN editLease INTEGER NOT NULL DEFAULT 0;
CREATE INDEX youtube_sync_due ON youtube_clips(user_id,nextSync) WHERE videoId IS NOT NULL;
