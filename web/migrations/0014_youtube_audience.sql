-- Unknown until Google's videos.list returns status.madeForKids, including
-- for videos uploaded before this migration. Never infer it from the insert.
ALTER TABLE youtube_clips ADD COLUMN madeForKids INTEGER;
