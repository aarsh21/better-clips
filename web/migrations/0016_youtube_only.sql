-- Better Clips no longer stores files or manages playback cuts.
DROP TABLE bucket_moves;
DROP TABLE uploads;
DROP TABLE shares;
DROP TABLE thumbs;
DROP TABLE setups;
DROP TABLE leftovers;
DROP TABLE tenants;
ALTER TABLE youtube_clips DROP COLUMN start;
ALTER TABLE youtube_clips DROP COLUMN end;
